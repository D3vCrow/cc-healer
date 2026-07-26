// Cross-file index builder for knowledge-base (KB) tier scans.
//
// Reads INDEX.md from the scan target dir and extracts every markdown link
// target that points at a KB doc. The knowledge-index-orphan check consumes the
// set via CheckContext to answer "is this doc reachable from the index?".
//
// INDEX.md is the sole source by design. The workspace KB rule makes it the
// contract ("always add a one-line entry to knowledge/INDEX.md after saving").
// INDEX-headline.md is a derived recent-entries subset — unioning it in would
// mask a doc that made the headline view but never landed in the full index.
//
// Missing index file → empty set; the consumer self-guards on empty.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KnowledgeIndex } from './checks/types.js';

// Markdown link pattern, capturing the path portion. The path must end in `.md`
// to be considered a KB-doc reference.
//
// The link text allows one level of balanced brackets: CommonMark permits them,
// and index entries really do use them (a title naming Unity's `[CliCommand]`
// attribute). A flat `[^\]]*` stops at the inner `]`, never reaches the `](`,
// and silently drops the link — which surfaced as a false-positive orphan on
// 2026-07-26, the first day this check ran.
const MD_LINK = /\[(?:[^[\]]|\[[^[\]]*\])*\]\(([^)]+\.md)\)/g;

// Git tracks the index as lowercase `index.md`; Windows' case-insensitive
// filesystem hides the mismatch until cc-healer runs on a case-sensitive one
// (CI, WSL). Probe both spellings rather than assuming either.
const INDEX_NAMES = ['INDEX.md', 'index.md'] as const;

export async function buildKnowledgeIndex(target: string): Promise<KnowledgeIndex> {
  for (const name of INDEX_NAMES) {
    const indexed = await extractRefs(join(target, name));
    if (indexed.size > 0) return { indexed };
  }
  return { indexed: new Set() };
}

async function extractRefs(filePath: string): Promise<Set<string>> {
  const set = new Set<string>();
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return set; // file absent → empty set; consumer self-guards on size 0
  }
  for (const match of content.matchAll(MD_LINK)) {
    const raw = match[1];
    if (!raw) continue;
    const path = normalize(raw);
    set.add(path); // knowledge-root-relative form (research/foo.md)
    const slash = path.lastIndexOf('/');
    if (slash !== -1) set.add(path.slice(slash + 1)); // basename fallback (foo.md)
  }
  return set;
}

// Backslashes → forward slashes, drop a leading `./`, and strip a leading
// `knowledge/` so an index entry written workspace-relative compares equal to
// the scan's knowledge-root-relative display path.
function normalize(raw: string): string {
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  return p.startsWith('knowledge/') ? p.slice('knowledge/'.length) : p;
}

// Cross-file index builder for memory-tier scans.
//
// Reads MEMORY.md (hot tier) and DEEP-INDEX.md (deep tier) from the scan
// target dir, extracts markdown link targets, and produces two sets of
// linked filenames. Cross-file memory checks (parity, feedback-in-hot-tier)
// consume the indexes via CheckContext.
//
// Missing index files are treated as empty sets — the consumer checks
// self-guard when both sets are empty (no indexes present in this dir).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MemoryIndexes } from './checks/types.js';

// Standard markdown link pattern, capturing the path portion. The path must
// end in `.md` to be considered a memory-file reference.
const MD_LINK = /\[[^\]]*\]\(([^)]+\.md)\)/g;

export async function buildMemoryIndexes(target: string): Promise<MemoryIndexes> {
  const [hot, deep] = await Promise.all([
    extractLinkedFilenames(join(target, 'MEMORY.md')),
    extractLinkedFilenames(join(target, 'DEEP-INDEX.md')),
  ]);
  return { hot, deep };
}

async function extractLinkedFilenames(filePath: string): Promise<Set<string>> {
  const set = new Set<string>();
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return set; // file absent → empty set; consumers self-guard on (hot=∅ ∧ deep=∅)
  }
  for (const match of content.matchAll(MD_LINK)) {
    const path = match[1];
    if (!path) continue;
    // Strip any directory prefix — only same-dir filename matters for parity.
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const filename = slash === -1 ? path : path.slice(slash + 1);
    set.add(filename);
  }
  return set;
}

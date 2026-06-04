// Fixer for `memory-refs-resolve` findings.
//
// The check flags a `supersedes` / `superseded_by` / `related` ref that exists
// at neither candidate root (sibling memory file OR workspace-relative). Three
// real-world shapes drive the three outcomes:
//   1. bare date-ref  `2026-04-25-foo.md`            → lives in knowledge/<sub>/  → PROPOSE prefix
//   2. partial path   `discoveries/2026-04-17-x.md`  → missing knowledge/ prefix  → PROPOSE prefix
//   3. date-suffix    `cache-burn-spike-2026-05-24.md` → real file is date-PREFIX → PROPOSE flip
//   4. cross-tier     `../../../…/memory/feedback_x.md` (broken rel path)         → PROPOSE bare memory name
//   5. dangling ref   `feedback_evidence_over_agreement.md` (no such file)         → NEEDS-HUMAN
//
// Resolution searches knowledge/ + docs/ for the ref's basename. A unique hit
// becomes a textual replacement to the workspace-relative path (forward slashes)
// — exactly the form `memoryRefsResolve` accepts (join(workspaceRoot, ref) exists).
// Three deterministic fallbacks fire only when the ref does not resolve as written:
// (a) a date-SUFFIX basename (`<stem>-<date>.md`) re-searched as date-PREFIX
// (`<date>-<stem>.md`), the workspace convention; (b) the basename under the Rook
// memory dir (when opts.memoryDir is set), proposed as a BARE memory name — the
// cross-tier form knowledgeRefCandidates resolves; (c) a basename written without
// the `.md` extension retried with `.md` appended (against both roots). Zero hits =
// dangling (create/rename/remove). Multiple = ambiguous. Both left for a human.

import { readdir } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import type { Fixer, FixProposal, Unfixable } from './types.js';

// Frontmatter message shape from memoryRefsResolve: `<field> references missing file: <ref>`.
const REF_MSG = /^(\w+) references missing file: (.+)$/;

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // root absent (e.g. no docs/) — skip silently
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, base, out);
    } else if (e.isFile() && e.name === base) {
      out.push(full);
    }
  }
}

/** Absolute paths under `roots` whose basename equals `base`. */
async function findByBasename(roots: string[], base: string): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) await walk(root, base, out);
  return out;
}

// Date-SUFFIX → date-PREFIX flip: `cache-burn-spike-2026-05-24.md` →
// `2026-05-24-cache-burn-spike.md`. Returns null when the basename is not in the
// `<stem>-<YYYY-MM-DD>.md` shape, so date-prefix and undated names never flip.
const DATE_SUFFIX = /^(.+)-(\d{4}-\d{2}-\d{2})\.md$/;
function flipDateSuffix(base: string): string | null {
  const m = DATE_SUFFIX.exec(base);
  return m ? `${m[2]}-${m[1]}.md` : null;
}

export const fixRefsResolve: Fixer = async (issues, { target, workspaceRoot, memoryDir }) => {
  const proposals: FixProposal[] = [];
  const unfixable: Unfixable[] = [];
  // Only these subtrees hold legitimate ref targets; searching the whole repo
  // would risk matching build artifacts or unrelated files of the same name.
  const searchRoots = [join(workspaceRoot, 'knowledge'), join(workspaceRoot, 'docs')];

  for (const issue of issues) {
    const m = REF_MSG.exec(issue.message);
    if (!m) {
      unfixable.push({
        file: issue.file,
        check: issue.check,
        detail: issue.message,
        reason: 'could not parse ref from finding message',
      });
      continue;
    }
    const field = m[1]!;
    const ref = m[2]!;
    // Resolution chain — each step runs only if the prior found nothing:
    //   ws     basename as written, under knowledge/ + docs/          → workspace-relative
    //   flip   date flipped to front (`foo-<date>` → `<date>-foo`)    → workspace-relative
    //   memory basename under the Rook memory dir (cross-tier ref)    → BARE memory name
    //   +.md   no-extension basename retried with `.md` (ws or memory) → as the step that hit
    // `mode` records which fired so the proposal renders the right path form + reason.
    let matches = await findByBasename(searchRoots, basename(ref));
    let mode: 'ws' | 'flip' | 'memory' = 'ws';
    if (matches.length === 0) {
      const alt = flipDateSuffix(basename(ref));
      if (alt) {
        const altMatches = await findByBasename(searchRoots, alt);
        if (altMatches.length > 0) {
          matches = altMatches;
          mode = 'flip';
        }
      }
    }
    if (matches.length === 0 && memoryDir) {
      const memMatches = await findByBasename([memoryDir], basename(ref));
      if (memMatches.length > 0) {
        matches = memMatches;
        mode = 'memory';
      }
    }
    if (matches.length === 0 && !basename(ref).endsWith('.md')) {
      // Ref written without the `.md` extension — retry with it appended, against
      // knowledge/ + docs/ first (workspace-relative), then the memory dir (bare).
      const withMd = `${basename(ref)}.md`;
      matches = await findByBasename(searchRoots, withMd);
      if (matches.length > 0) {
        mode = 'ws';
      } else if (memoryDir) {
        const memMatches = await findByBasename([memoryDir], withMd);
        if (memMatches.length > 0) {
          matches = memMatches;
          mode = 'memory';
        }
      }
    }

    if (matches.length === 1) {
      // Memory files live outside workspaceRoot, so a workspace-relative path can't
      // express them; knowledgeRefCandidates resolves a bare memory basename, so
      // that is the form proposed for a cross-tier hit.
      const newText =
        mode === 'memory'
          ? basename(matches[0]!)
          : relative(workspaceRoot, matches[0]!).replace(/\\/g, '/');
      const reason =
        mode === 'memory'
          ? `resolve ${field} ref (cross-tier memory) → ${newText}`
          : mode === 'flip'
            ? `resolve ${field} ref (date-suffix → date-prefix) → ${newText}`
            : `resolve ${field} ref → ${newText}`;
      proposals.push({
        file: issue.file,
        filePath: join(target, issue.file),
        check: issue.check,
        field,
        oldText: ref,
        newText,
        reason,
      });
    } else if (matches.length === 0) {
      unfixable.push({
        file: issue.file,
        check: issue.check,
        detail: `${field}: ${ref}`,
        reason: 'target not found under knowledge/ or docs/ — dangling (create target, rename, or remove)',
      });
    } else {
      const rels = matches.map((p) => relative(workspaceRoot, p).replace(/\\/g, '/'));
      unfixable.push({
        file: issue.file,
        check: issue.check,
        detail: `${field}: ${ref}`,
        reason: `ambiguous — ${matches.length} candidates: ${rels.join(', ')}`,
      });
    }
  }

  return { proposals, unfixable };
};

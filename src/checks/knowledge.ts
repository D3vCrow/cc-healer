// Knowledge-base tier checks (KB tier).
//
// Retargets the proven verify-by-past + refs-resolve primitives (src/checks/
// common.ts) at the workspace knowledge base (knowledge/ — research/, decisions/,
// discoveries/, _inbox/, dormant/). KB docs carry { title, date, source, status,
// tags, related, supersedes, [verify_by, superseded_by] } frontmatter, which
// differs from Rook memory in two ways that matter here:
//
//   - verify_by is OPTIONAL (memory requires it). verify-by-past self-skips when
//     absent, so a doc with no re-verify date never flags — only docs that opted
//     into a date and let it lapse do.
//   - ref fields use a looser, mixed convention than memory's bare-sibling norm:
//     bare sibling, workspace-relative (knowledge/…, docs/…), knowledge-root-
//     relative (research/…, decisions/… without the knowledge/ prefix), `~/…`
//     home-relative, and cross-tier bare memory names (feedback_*.md, audit_*.md).
//     knowledgeRefCandidates probes all of those roots so a naive port doesn't
//     false-positive flood and bury the genuinely-broken refs.
//
// No required-fields / type / source-shape checks here — those encode Rook-memory
// contracts the KB doesn't share. Index reachability IS shared, though in a
// one-index form (INDEX.md) rather than memory's two-tier parity: see
// knowledgeIndexOrphan at the bottom of this file.

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { Check } from './types.js';
import {
  checkRefsResolve,
  checkVerifyByPast,
  type RefCandidateResolver,
} from './common.js';

// Mirror cli.ts: a leading `~` expands to the home dir (`~/.claude/…` refs).
function expandTilde(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

// Derive the Rook memory dir for this workspace from workspaceRoot, mirroring the
// Claude Code project-slug naming (C:\Users\you\proj → C--Users-you-proj). Lets a KB
// doc reference a memory file by bare name (e.g. feedback_glob_path_prefix.md).
function memoryRoot(workspaceRoot: string): string {
  const slug = workspaceRoot.replace(/^([A-Za-z]):/, '$1-').replace(/[\\/]/g, '-');
  return join(homedir(), '.claude', 'projects', slug, 'memory');
}

/**
 * KB-tier ref resolver. A ref resolves if it exists at ANY candidate:
 *   - the expanded `~` path (home-relative refs into ~/.claude/…)
 *   - itself, if absolute (drive-letter C:/… or POSIX absolute)
 *   - sibling / `../`-relative against the doc's own dir
 *   - workspace-relative against workspaceRoot (knowledge/…, docs/…)
 *   - knowledge-root-relative (research/…, decisions/… without the knowledge/ prefix)
 *   - the Rook memory dir, for a bare memory name (feedback_*.md)
 *   - the memory dir's parent, for a memory/-prefixed ref (memory/feedback_*.md)
 * Permissive by design — extra roots only reduce false positives; a genuinely
 * missing ref matches nowhere and still flags (e.g. a wrong-basename ref).
 */
export const knowledgeRefCandidates: RefCandidateResolver = (ref, dir, ctx) => {
  // KB `related:` entries sometimes carry an inline annotation after the path
  // (`foo.md (Rook)`, `foo.md (baseline — …)`). A path has no spaces, so the
  // real ref is the first whitespace-delimited token — resolve against that.
  // The unstripped ref is still what checkRefsResolve reports on a miss.
  const path = ref.trim().split(/\s+/)[0] || ref;
  if (path.startsWith('~')) return [expandTilde(path)];
  if (isAbsolute(path)) return [path];
  const mem = memoryRoot(ctx.workspaceRoot);
  return [
    join(dir, path),
    join(ctx.workspaceRoot, path),
    join(ctx.workspaceRoot, 'knowledge', path),
    join(mem, path),
    join(dirname(mem), path),
  ];
};

/**
 * `verify_by` (optional in the KB) past today → info. Reuses the memory-tier
 * staleness logic verbatim; no audit_* exemption (the KB has no such files).
 */
export const knowledgeVerifyByPast: Check = (ctx) =>
  checkVerifyByPast(ctx, 'knowledge-verify-by-past');

/**
 * `supersedes` / `superseded_by` / `related` filenames must resolve at some
 * candidate path (see knowledgeRefCandidates) → warn on the genuinely missing.
 */
export const knowledgeRefsResolve: Check = (ctx) =>
  checkRefsResolve(ctx, 'knowledge-refs-resolve', knowledgeRefCandidates);

// --- Cross-file check: index reachability -------------------------------
//
// Consumes CheckContext.knowledgeIndex, populated once per scan by
// buildKnowledgeIndex (src/knowledge-indexes.ts). Self-skips when the index is
// absent (non-KB scan) or empty (no INDEX.md at the target), mirroring the
// memory-tier cross-file guards.
//
// Ported from mattpocock/dictionary-of-ai-coding's generate-readme.ts orphan
// gate: every dictionary/*.md must be referenced by Curriculum.md or the build
// fails. Same contract here, one tier up — INDEX.md is what a session reads
// first, so a doc missing from it is a doc Claude will never find.
// Vet: knowledge/research/2026-07-26-vet-dictionary-of-ai-coding.md

// Subtrees that hold non-entry files and are indexed by convention: no.
//   tools/   — generated Obsidian vault (claude-map); 125 files, 0 indexed
//   _inbox/  — auto-extracted fragments awaiting weekly review
//   dormant/ — parked items; the dormant sweep owns them, not INDEX.md
// Scoped to this check only — the staleness/ref checks still run everywhere.
const NON_ENTRY_DIRS = new Set(['tools', '_inbox', 'dormant']);

// Root-level index + append-only ledger files. These ARE the index / the log,
// so they are never index entries themselves.
const INDEX_AND_LEDGER_FILES = new Set([
  'INDEX.md',
  'index.md',
  'INDEX-headline.md',
  'log.md',
  '_yours_log.md',
]);

/**
 * Every KB doc must be linked from INDEX.md. Unlinked → orphaned: the doc
 * exists on disk but no session that starts from the index can reach it.
 * Severity: warn (not error) while the pre-existing backlog burns down —
 * promote to 'error' once a clean run is reachable.
 */
export const knowledgeIndexOrphan: Check = (ctx) => {
  if (!ctx.knowledgeIndex) return []; // not a knowledge-tier scan
  if (ctx.knowledgeIndex.indexed.size === 0) return []; // no INDEX.md present

  const rel = ctx.file.replace(/\\/g, '/');
  const firstSlash = rel.indexOf('/');
  if (firstSlash === -1) {
    if (INDEX_AND_LEDGER_FILES.has(rel)) return [];
  } else if (NON_ENTRY_DIRS.has(rel.slice(0, firstSlash))) {
    return [];
  }

  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (ctx.knowledgeIndex.indexed.has(rel) || ctx.knowledgeIndex.indexed.has(base)) return [];

  return [
    {
      severity: 'warn',
      check: 'knowledge-index-orphan',
      file: ctx.file,
      message: `${ctx.file} is orphaned — no entry in INDEX.md, so a session that starts from the index cannot reach it`,
    },
  ];
};

export const knowledgeChecks: ReadonlyArray<Check> = [
  knowledgeVerifyByPast,
  knowledgeRefsResolve,
  knowledgeIndexOrphan,
];

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
// No required-fields / type / source-shape / index-parity checks here — those
// encode Rook-memory contracts the KB doesn't share. Phase 1B scope is the two
// staleness/integrity gates only.

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

// Derive the Rook memory dir for this workspace from devcrowRoot, mirroring the
// Claude Code project-slug naming (F:\DevCrow\Dev → F--DevCrow-Dev). Lets a KB
// doc reference a memory file by bare name (e.g. feedback_glob_path_prefix.md).
function memoryRoot(devcrowRoot: string): string {
  const slug = devcrowRoot.replace(/^([A-Za-z]):/, '$1-').replace(/[\\/]/g, '-');
  return join(homedir(), '.claude', 'projects', slug, 'memory');
}

/**
 * KB-tier ref resolver. A ref resolves if it exists at ANY candidate:
 *   - the expanded `~` path (home-relative refs into ~/.claude/…)
 *   - itself, if absolute (drive-letter C:/… or POSIX absolute)
 *   - sibling / `../`-relative against the doc's own dir
 *   - workspace-relative against devcrowRoot (knowledge/…, docs/…)
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
  const mem = memoryRoot(ctx.devcrowRoot);
  return [
    join(dir, path),
    join(ctx.devcrowRoot, path),
    join(ctx.devcrowRoot, 'knowledge', path),
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

export const knowledgeChecks: ReadonlyArray<Check> = [
  knowledgeVerifyByPast,
  knowledgeRefsResolve,
];

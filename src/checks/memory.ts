// Memory-tier checks (Tier 2).
//
// Implements §"Tier 2: memory files" of docs/cc-healer-v1-spec.md. Operates on
// Rook v2 memory files (~/.claude/projects/<slug>/memory/) which have frontmatter
// shape: { name, description, type, source, verify_by, [supersedes, superseded_by,
// related] }.
//
// Phase 1 complete — 9 Tier 2 checks live:
//   - 6 within-file: required-fields, type-known, source-shape,
//     verify-by-shape, verify-by-past, refs-resolve.
//   - 2 cross-file: index-parity, feedback-in-hot-tier (both consume
//     CheckContext.indexes built once per scan by buildMemoryIndexes).
//   - 1 hot-tier shape: hot-tier-entry-shape (MEMORY.md-only line-length gate
//     per docs/superpowers/specs/2026-05-17-memory-index-trim-and-gate-design.md §4).

import { isAbsolute, join } from 'node:path';

import type { Issue } from '../types.js';
import type { Check } from './types.js';
import {
  VERIFY_BY_DATE_SHAPE,
  checkRefsResolve,
  checkVerifyByPast,
  type RefCandidateResolver,
} from './common.js';

const REQUIRED_FIELDS = ['name', 'description', 'type', 'source', 'verify_by'] as const;

const KNOWN_TYPES = new Set(['user', 'feedback', 'project', 'reference', 'pattern', 'failure']);

// `source: YYYY-MM-DD <text>` — date prefix + at least one non-whitespace char in the trigger text.
const SOURCE_SHAPE = /^\d{4}-\d{2}-\d{2}\s+\S/;

// --- Implemented (Phase 1) ----------------------------------------------

/**
 * Each of name / description / type / source / verify_by must be present.
 * Severity: error.
 * Source: cc-healer V1 spec Tier 2 row "frontmatter present".
 */
export const memoryRequiredFields: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  if (Object.keys(ctx.parsed.data).length === 0) return []; // not a memory file at all
  const issues: Issue[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in ctx.parsed.data)) {
      issues.push({
        severity: 'error',
        check: 'memory-required-fields',
        file: ctx.file,
        message: `frontmatter missing required field: ${field}`,
      });
    }
  }
  return issues;
};

/**
 * `type` must be one of user / feedback / project / reference / pattern / failure.
 * Severity: error.
 * Source: cc-healer V1 spec Tier 2 row "type is one of {known set}".
 */
export const memoryTypeKnown: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  const type = ctx.parsed.data.type;
  if (type === undefined) return []; // memoryRequiredFields owns the missing case
  if (typeof type !== 'string') {
    return [
      {
        severity: 'error',
        check: 'memory-type-known',
        file: ctx.file,
        message: `type field is not a string (got ${typeof type})`,
      },
    ];
  }
  if (!KNOWN_TYPES.has(type)) {
    const known = Array.from(KNOWN_TYPES).join(' | ');
    return [
      {
        severity: 'error',
        check: 'memory-type-known',
        file: ctx.file,
        message: `type ${JSON.stringify(type)} not in known set (${known})`,
      },
    ];
  }
  return [];
};

/**
 * `source` matches `YYYY-MM-DD <text>` shape.
 * Severity: warn.
 * Source: cc-healer V1 spec Tier 2 row "source matches YYYY-MM-DD <text> shape".
 */
export const memorySourceShape: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  if (Object.keys(ctx.parsed.data).length === 0) return [];
  const source = ctx.parsed.data.source;
  if (source === undefined) return []; // memoryRequiredFields owns the missing case
  if (typeof source !== 'string') {
    return [
      {
        severity: 'warn',
        check: 'memory-source-shape',
        file: ctx.file,
        message: `source field is not a string (got ${typeof source})`,
      },
    ];
  }
  if (!SOURCE_SHAPE.test(source)) {
    return [
      {
        severity: 'warn',
        check: 'memory-source-shape',
        file: ctx.file,
        message: `source ${JSON.stringify(source)} doesn't match \`YYYY-MM-DD <text>\` shape`,
      },
    ];
  }
  return [];
};

/**
 * `verify_by` is `YYYY-MM-DD` or `stable`.
 * Severity: warn.
 * Source: cc-healer V1 spec Tier 2 row "verify_by is YYYY-MM-DD or stable".
 */
export const memoryVerifyByShape: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  if (Object.keys(ctx.parsed.data).length === 0) return [];
  const verifyBy = ctx.parsed.data.verify_by;
  if (verifyBy === undefined) return []; // memoryRequiredFields owns the missing case
  if (typeof verifyBy !== 'string') {
    return [
      {
        severity: 'warn',
        check: 'memory-verify-by-shape',
        file: ctx.file,
        message: `verify_by field is not a string (got ${typeof verifyBy})`,
      },
    ];
  }
  if (verifyBy !== 'stable' && !VERIFY_BY_DATE_SHAPE.test(verifyBy)) {
    return [
      {
        severity: 'warn',
        check: 'memory-verify-by-shape',
        file: ctx.file,
        message: `verify_by ${JSON.stringify(verifyBy)} is not \`stable\` or \`YYYY-MM-DD\``,
      },
    ];
  }
  return [];
};

/**
 * `verify_by` past today (if not `stable`).
 * Severity: info.
 * Source: cc-healer V1 spec Tier 2 row "verify_by past today (if not stable)".
 * Shared body lives in common.checkVerifyByPast; this wrapper adds the memory-only
 * exemption: audit_* files are historical logs — a past verify_by is expected
 * (they archive, they aren't re-verified) per the Rook stale-scan rule.
 */
export const memoryVerifyByPast: Check = (ctx) => {
  if (ctx.file.startsWith('audit_')) return [];
  return checkVerifyByPast(ctx, 'memory-verify-by-past');
};

/**
 * Memory-tier ref resolver: a sibling memory file (bare name) OR a
 * workspace-relative path (knowledge/…, docs/…) against devcrowRoot. Absolute
 * refs probe themselves only.
 */
const memoryRefCandidates: RefCandidateResolver = (ref, dir, ctx) =>
  isAbsolute(ref) ? [ref] : [join(dir, ref), join(ctx.devcrowRoot, ref)];

/**
 * Each filename in `supersedes` / `superseded_by` / `related` must resolve at
 * some candidate path (see memoryRefCandidates). Accepts a single string or an
 * array; only flags refs that exist nowhere.
 * Severity: warn.
 * Source: cc-healer V1 spec Tier 2 row "supersedes/superseded_by/related filenames exist".
 */
export const memoryRefsResolve: Check = (ctx) =>
  checkRefsResolve(ctx, 'memory-refs-resolve', memoryRefCandidates);

// --- Cross-file checks (Phase 1 step 2b) --------------------------------
//
// Both consume CheckContext.indexes, populated once per scan by
// buildMemoryIndexes (src/memory-indexes.ts). When indexes are undefined
// (skill-tier scan) or both sets are empty (no MEMORY.md / DEEP-INDEX.md
// in the target dir), these checks self-skip to avoid false-positive
// avalanches on non-Rook directories.

/**
 * File must be linked from exactly one of MEMORY.md or DEEP-INDEX.md.
 * Linked from BOTH → double-listed (audit-trail-confusing).
 * Linked from NEITHER → orphaned (no tier classification).
 * Severity: error.
 * Source: cc-healer V1 spec Tier 2 row "file linked from exactly one of
 * MEMORY.md or DEEP-INDEX.md".
 */
export const memoryIndexParity: Check = (ctx) => {
  if (!ctx.indexes) return []; // not a memory-tier scan
  if (ctx.indexes.hot.size === 0 && ctx.indexes.deep.size === 0) return []; // no indexes present
  // Index files themselves are the indexes — not memory entries — so they're never in either set by design.
  if (ctx.file === 'MEMORY.md' || ctx.file === 'DEEP-INDEX.md') return [];
  const inHot = ctx.indexes.hot.has(ctx.file);
  const inDeep = ctx.indexes.deep.has(ctx.file);
  if (inHot && inDeep) {
    return [
      {
        severity: 'error',
        check: 'memory-index-parity',
        file: ctx.file,
        message: `${ctx.file} is linked from BOTH MEMORY.md and DEEP-INDEX.md (must be exactly one)`,
      },
    ];
  }
  if (!inHot && !inDeep) {
    return [
      {
        severity: 'error',
        check: 'memory-index-parity',
        file: ctx.file,
        message: `${ctx.file} is orphaned — linked from neither MEMORY.md nor DEEP-INDEX.md`,
      },
    ];
  }
  return [];
};

/**
 * Files with `type: feedback` should appear only in MEMORY.md (hot tier),
 * never DEEP-INDEX.md. Behavior rule: feedback never demotes to deep.
 * Severity: warn.
 * Source: cc-healer V1 spec Tier 2 row "feedback type appears only in MEMORY.md".
 */
export const memoryFeedbackInHotTier: Check = (ctx) => {
  if (!ctx.indexes) return []; // not a memory-tier scan
  if (ctx.indexes.hot.size === 0 && ctx.indexes.deep.size === 0) return []; // no indexes present
  if (!ctx.parsed.ok) return [];
  if (Object.keys(ctx.parsed.data).length === 0) return [];
  const type = ctx.parsed.data.type;
  if (type !== 'feedback') return [];
  if (ctx.indexes.deep.has(ctx.file)) {
    return [
      {
        severity: 'warn',
        check: 'memory-feedback-in-hot-tier',
        file: ctx.file,
        message: `feedback-type entries should appear only in MEMORY.md, but ${ctx.file} is linked from DEEP-INDEX.md`,
      },
    ];
  }
  return [];
};

// --- Hot-tier shape check (Phase 1 step 5) ------------------------------
//
// MEMORY.md is the Rook v2 hot tier, always loaded into every Claude Code
// session. Spec contract: each index entry ≤150 chars. Un-gated, the shape
// rotted into 88% bloat by 2026-05-17 audit. Phase 1 (manual trim 2026-05-18)
// paid the debt; this check keeps the post-trim state from drifting back.

// Entry shape: `- [Title](file.md) — hook`. Bare list-item check that excludes
// section headers, top-of-file frontmatter-style block, and blockquotes.
const HOT_TIER_ENTRY_SHAPE = /^- \[.*\]\(.*\.md\)/;
const HOT_TIER_MAX_CHARS = 150;

/**
 * MEMORY.md entries (hot tier, always-loaded) must be ≤150 chars to bound
 * session context cost. Severity: warn (quality contract, not correctness —
 * over-length parses fine, just inflates every-session token spend).
 * Skip-list: section headers (^##, ^###), top-of-file block before first
 * ## heading, blockquotes (^> ). Fires only on MEMORY.md; DEEP-INDEX.md is
 * out of scope for Phase 2 per design spec §4.4.
 * Source: docs/superpowers/specs/2026-05-17-memory-index-trim-and-gate-design.md §4.
 */
export const memoryHotTierEntryShape: Check = (ctx) => {
  if (ctx.file !== 'MEMORY.md') return [];
  const issues: Issue[] = [];
  const lines = ctx.content.split(/\r?\n/);
  let inFrontmatterBlock = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith('## ') || line.startsWith('### ')) {
      inFrontmatterBlock = false;
      continue;
    }
    if (inFrontmatterBlock) continue;
    if (line.startsWith('> ')) continue;
    if (!HOT_TIER_ENTRY_SHAPE.test(line)) continue;
    if (line.length > HOT_TIER_MAX_CHARS) {
      issues.push({
        severity: 'warn',
        check: 'memory-hot-tier-entry-shape',
        file: ctx.file,
        line: i + 1,
        message: `entry exceeds ${HOT_TIER_MAX_CHARS} chars (${line.length} chars)`,
      });
    }
  }
  return issues;
};

// --- Registry -----------------------------------------------------------

export const memoryChecks: ReadonlyArray<Check> = [
  memoryRequiredFields,
  memoryTypeKnown,
  memorySourceShape,
  memoryVerifyByShape,
  memoryVerifyByPast,
  memoryRefsResolve,
  memoryIndexParity,
  memoryFeedbackInHotTier,
  memoryHotTierEntryShape,
];

// Memory-tier checks (Tier 2).
//
// Implements §"Tier 2: memory files" of docs/cc-healer-v1-spec.md. Operates on
// Rook v2 memory files (~/.claude/projects/<slug>/memory/) which have frontmatter
// shape: { name, description, type, source, verify_by, [supersedes, superseded_by,
// related] }.
//
// Phase 1 / V0:
//   - 2 checks implemented: required-fields, type-known
//   - 6 stubs returning [] — implement when needed.
//
// Cross-file checks (index parity, feedback-only-in-MEMORY) need a scan-level
// build pass that doesn't yet exist; deferred to a separate infra step.

import type { Issue } from '../types.js';
import type { Check } from './types.js';

const REQUIRED_FIELDS = ['name', 'description', 'type', 'source', 'verify_by'] as const;

const KNOWN_TYPES = new Set(['user', 'feedback', 'project', 'reference', 'pattern', 'failure']);

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

// --- Phase 1 stubs (per spec Tier 2 table) ------------------------------

/**
 * `source` matches `YYYY-MM-DD <text>` shape.
 * Severity: warn.
 */
export const memorySourceShape: Check = (_ctx) => {
  return [];
};

/**
 * `verify_by` is `YYYY-MM-DD` or `stable`.
 * Severity: warn.
 */
export const memoryVerifyByShape: Check = (_ctx) => {
  return [];
};

/**
 * `verify_by` past today (if not `stable`).
 * Severity: info.
 */
export const memoryVerifyByPast: Check = (_ctx) => {
  return [];
};

/**
 * `supersedes` / `superseded_by` / `related` filenames exist in same dir.
 * Severity: warn.
 * Note: needs fs.access — implement async when wired up.
 */
export const memoryRefsResolve: Check = (_ctx) => {
  return [];
};

/**
 * File linked from exactly one of MEMORY.md or DEEP-INDEX.md.
 * Severity: error.
 * Note: cross-file — needs a scan-level index pass.
 */
export const memoryIndexParity: Check = (_ctx) => {
  return [];
};

/**
 * `feedback` type entries appear only in MEMORY.md (never DEEP-INDEX).
 * Severity: warn.
 * Note: cross-file — needs a scan-level index pass.
 */
export const memoryFeedbackInHotTier: Check = (_ctx) => {
  return [];
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
];

// Skill-tier checks (Tier 1).
//
// Implements §2 ("Consumer shape — what /_audit-skills does") of the locked design at
// docs/handoffs/2026-04-19-audit-skills-design.md (workspace-internal).
//
// Phase 0 / V0:
//   - 2 checks implemented: yaml-parses, description-present
//   - 7 stubs returning [] — Phase 1 implements with TDD per the design's severity table.
//
// Each check is self-guarded: callers can run them unconditionally and trust each
// to return [] when its precondition isn't met (e.g. parsed.ok is false for checks
// that need a parsed frontmatter).

import type { Issue } from '../types.js';
import type { Check } from './types.js';

// --- Implemented (Phase 0) ----------------------------------------------

export const yamlParses: Check = (ctx) => {
  if (ctx.parsed.ok) return [];
  return ctx.parsed.errors.map((err) => ({
    severity: 'error' as const,
    check: 'yaml-parses',
    file: ctx.file,
    message: err,
  }));
};

export const descriptionPresent: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  if (Object.keys(ctx.parsed.data).length === 0) return []; // no frontmatter → not a skill, separate concern
  if ('description' in ctx.parsed.data) return [];
  return [
    {
      severity: 'error',
      check: 'description-present',
      file: ctx.file,
      message: 'frontmatter missing required field: description',
    },
  ];
};

// --- Phase 1 stubs ------------------------------------------------------
// Each stub mirrors a row in the locked design §2 severity table. Phase 1
// implements; this scaffolding makes the registry wireable now.

/**
 * If a `devcrow:` block exists, `devcrow.tier` must be set to 'light' or 'heavy'.
 * Severity: error.
 * Source: locked design §2 row "Required namespace fields present".
 */
export const devcrowTierSet: Check = (_ctx) => {
  return [];
};

/**
 * Each entry in `devcrow.requires.binaries` must resolve via `where`/`which`.
 * Severity: warn.
 * Source: locked design §2 row "Declared binary resolvable".
 * Note: Phase 1 will need an async variant — subprocess call.
 */
export const declaredBinaryResolvable: Check = (_ctx) => {
  return [];
};

/**
 * Each entry in `devcrow.requires.env` must be set in `process.env`.
 * Severity: warn.
 * Source: locked design §2 row "Declared env var set".
 */
export const declaredEnvSet: Check = (_ctx) => {
  return [];
};

/**
 * `Spec:` / `Shared patterns:` references in the body must resolve at cwd
 * or under `F:/DevCrow/Dev/`.
 * Severity: warn.
 * Source: locked design §2 row "File refs in body resolve".
 * Note: Phase 1 will need an async variant — `fs.access`.
 */
export const fileRefsResolve: Check = (_ctx) => {
  return [];
};

/**
 * `description` field must be ≤ 200 characters.
 * Severity: warn.
 * Source: locked design §2 row "Description within threshold".
 */
export const descriptionLength: Check = (_ctx) => {
  return [];
};

/**
 * Skill missing `devcrow:` block — migration backlog signal.
 * Severity: info.
 * Source: locked design §2 row "Legacy skill (no devcrow: block)".
 */
export const legacyNoDevcrow: Check = (_ctx) => {
  return [];
};

/**
 * If `devcrow.verify_by` is a YYYY-MM-DD date past today, surface info.
 * Severity: info.
 * Source: locked design §2 row "verify_by past today (if present)".
 */
export const verifyByPast: Check = (_ctx) => {
  return [];
};

// --- Registry -----------------------------------------------------------

export const skillChecks: ReadonlyArray<Check> = [
  yamlParses,
  descriptionPresent,
  devcrowTierSet,
  declaredBinaryResolvable,
  declaredEnvSet,
  fileRefsResolve,
  descriptionLength,
  legacyNoDevcrow,
  verifyByPast,
];

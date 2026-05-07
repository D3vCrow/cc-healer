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

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Issue } from '../types.js';
import type { Check } from './types.js';

const execAsync = promisify(exec);

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
export const devcrowTierSet: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  const dc = ctx.parsed.data.devcrow;
  if (typeof dc !== 'object' || dc === null) return [];
  const tier = (dc as Record<string, unknown>).tier;
  if (tier === undefined) {
    return [
      {
        severity: 'error',
        check: 'devcrow-tier-set',
        file: ctx.file,
        message: 'devcrow.tier missing (values: light | heavy)',
      },
    ];
  }
  if (tier !== 'light' && tier !== 'heavy') {
    return [
      {
        severity: 'error',
        check: 'devcrow-tier-set',
        file: ctx.file,
        message: `devcrow.tier value ${JSON.stringify(tier)} (expected: light | heavy)`,
      },
    ];
  }
  return [];
};

/**
 * Each entry in `devcrow.requires.binaries` must resolve via `where`/`which`.
 * Severity: warn.
 * Source: locked design §2 row "Declared binary resolvable".
 */
async function isBinaryOnPath(name: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execAsync(`${cmd} ${name}`);
    return true;
  } catch {
    return false;
  }
}

export const declaredBinaryResolvable: Check = async (ctx) => {
  if (!ctx.parsed.ok) return [];
  const dc = ctx.parsed.data.devcrow;
  if (typeof dc !== 'object' || dc === null) return [];
  const requires = (dc as Record<string, unknown>).requires;
  if (typeof requires !== 'object' || requires === null) return [];
  const binList = (requires as Record<string, unknown>).binaries;
  if (!Array.isArray(binList)) return [];
  const issues: Issue[] = [];
  for (const name of binList) {
    if (typeof name !== 'string') continue;
    const found = await isBinaryOnPath(name);
    if (!found) {
      issues.push({
        severity: 'warn',
        check: 'declared-binary-resolvable',
        file: ctx.file,
        message: `devcrow.requires.binaries: '${name}' not on PATH`,
      });
    }
  }
  return issues;
};

/**
 * Each entry in `devcrow.requires.env` must be set (non-empty) in ctx.env.
 * Severity: warn.
 * Source: locked design §2 row "Declared env var set".
 */
export const declaredEnvSet: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  const dc = ctx.parsed.data.devcrow;
  if (typeof dc !== 'object' || dc === null) return [];
  const requires = (dc as Record<string, unknown>).requires;
  if (typeof requires !== 'object' || requires === null) return [];
  const envList = (requires as Record<string, unknown>).env;
  if (!Array.isArray(envList)) return [];
  const issues: Issue[] = [];
  for (const name of envList) {
    if (typeof name !== 'string') continue;
    const val = ctx.env[name];
    if (val === undefined || val === '') {
      issues.push({
        severity: 'warn',
        check: 'declared-env-set',
        file: ctx.file,
        message: `devcrow.requires.env: '${name}' not set`,
      });
    }
  }
  return issues;
};

/**
 * `Spec:` / `Shared patterns:` references in the body must resolve at cwd
 * or under `F:/DevCrow/Dev/`.
 * Severity: warn.
 * Source: locked design §2 row "File refs in body resolve".
 *
 * Real-world body shapes observed in ~/.claude/commands/:
 *   Spec: docs/superpowers/specs/foo.md §4.3
 *   Spec: `F:/DevCrow/Dev/docs/claude-output-conventions.md` (Rook quality line)
 *   Shared patterns: docs/superpowers/reference/foo.md §3.1–§3.7
 * Path token = first whitespace-delimited fragment after the colon, with a
 * leading/trailing backtick stripped. Section refs (§…, paren tails) are dropped.
 */
const REF_LINE = /^(?:Spec|Shared patterns):\s+(\S+)/gm;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export const fileRefsResolve: Check = async (ctx) => {
  if (!ctx.parsed.ok) return [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const match of ctx.parsed.body.matchAll(REF_LINE)) {
    const raw = match[1];
    if (!raw) continue;
    // Strip wrapping backticks.
    const path = raw.replace(/^`+|`+$/g, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const candidates = isAbsolute(path)
      ? [path]
      : [join(ctx.cwd, path), join(ctx.devcrowRoot, path)];
    let resolved = false;
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      issues.push({
        severity: 'warn',
        check: 'file-refs-resolve',
        file: ctx.file,
        message: `body ref '${path}' does not exist at cwd or ${ctx.devcrowRoot}`,
      });
    }
  }
  return issues;
};

/**
 * `description` field must be ≤ 200 characters.
 * Severity: warn.
 * Source: locked design §2 row "Description within threshold".
 */
export const descriptionLength: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  const desc = ctx.parsed.data.description;
  if (typeof desc !== 'string') return [];
  if (desc.length <= 200) return [];
  return [
    {
      severity: 'warn',
      check: 'description-length',
      file: ctx.file,
      message: `description is ${desc.length} chars (max 200)`,
    },
  ];
};

/**
 * Skill missing `devcrow:` block — migration backlog signal.
 * Severity: info.
 * Source: locked design §2 row "Legacy skill (no devcrow: block)".
 */
export const legacyNoDevcrow: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  if (Object.keys(ctx.parsed.data).length === 0) return []; // not a skill at all
  if ('devcrow' in ctx.parsed.data) return [];
  return [
    {
      severity: 'info',
      check: 'legacy-no-devcrow',
      file: ctx.file,
      message: 'no devcrow: block — migration backlog',
    },
  ];
};

/**
 * If `devcrow.verify_by` is a YYYY-MM-DD date past today, surface info.
 * Severity: info.
 * Source: locked design §2 row "verify_by past today (if present)".
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const verifyByPast: Check = (ctx) => {
  if (!ctx.parsed.ok) return [];
  const dc = ctx.parsed.data.devcrow;
  if (typeof dc !== 'object' || dc === null) return [];
  const vb = (dc as Record<string, unknown>).verify_by;
  if (typeof vb !== 'string') return [];
  if (vb === 'stable') return [];
  if (!ISO_DATE.test(vb)) return []; // format-validity is a separate concern
  if (vb >= ctx.today) return [];    // ISO YYYY-MM-DD compares lexicographically
  return [
    {
      severity: 'info',
      check: 'verify-by-past',
      file: ctx.file,
      message: `devcrow.verify_by ${vb} is past today (${ctx.today})`,
    },
  ];
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

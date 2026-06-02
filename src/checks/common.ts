// Shared check primitives reused across tiers.
//
// The verify-by-past staleness gate and the refs-resolve existence gate are
// identical in spirit across the memory tier (Rook v2 files) and the knowledge
// tier (knowledge/ KB docs): same field semantics (`verify_by`, plus the
// supersedes / superseded_by / related ref triad), but a different display name
// and — for refs — different resolution roots. These primitives hold the proven
// logic once; each tier wraps them with its own check name and candidate
// resolver, so reuse stays DRY and the two tiers can never drift apart.

import { access } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Issue } from '../types.js';
import type { CheckContext } from './types.js';

// `verify_by: YYYY-MM-DD` (the alternative `stable` is handled here; malformed
// values are owned by a tier's verify-by-shape check, not this one).
export const VERIFY_BY_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Emit an info issue when a well-formed `verify_by` date is strictly before
 * `ctx.today`. `stable`, non-strings, and malformed values self-skip (a tier's
 * shape check owns the malformed case). YYYY-MM-DD lexicographic compare is
 * correct — ISO 8601 sorts as text. The caller supplies the check name so the
 * report names the tier (`memory-verify-by-past` vs `knowledge-verify-by-past`).
 */
export function checkVerifyByPast(ctx: CheckContext, checkName: string): Issue[] {
  if (!ctx.parsed.ok) return [];
  if (Object.keys(ctx.parsed.data).length === 0) return [];
  const verifyBy = ctx.parsed.data.verify_by;
  if (typeof verifyBy !== 'string') return []; // shape check owns non-strings
  if (verifyBy === 'stable') return [];
  if (!VERIFY_BY_DATE_SHAPE.test(verifyBy)) return []; // shape check owns malformed
  if (verifyBy < ctx.today) {
    return [
      {
        severity: 'info',
        check: checkName,
        file: ctx.file,
        message: `verify_by ${verifyBy} is past today (${ctx.today})`,
      },
    ];
  }
  return [];
}

/**
 * Given a ref string and the scanned file's own directory, return the candidate
 * absolute paths to probe. The ref resolves if ANY candidate exists. Tiers
 * differ only in their roots: memory probes sibling + workspace; knowledge also
 * probes the knowledge root and the Rook memory dir, and expands `~`. Extra
 * roots only ever reduce false positives — a genuinely missing ref still
 * matches nowhere and flags.
 */
export type RefCandidateResolver = (ref: string, dir: string, ctx: CheckContext) => string[];

/**
 * Warn when a filename in `supersedes` / `superseded_by` / `related` resolves
 * at NO candidate path. Accepts a single string or an array per field; empty /
 * non-string entries are skipped. The caller supplies the check name and the
 * candidate resolver, so each tier keeps its own resolution roots without
 * duplicating the field-walking loop.
 */
export async function checkRefsResolve(
  ctx: CheckContext,
  checkName: string,
  resolveCandidates: RefCandidateResolver,
): Promise<Issue[]> {
  if (!ctx.parsed.ok) return [];
  if (Object.keys(ctx.parsed.data).length === 0) return [];
  const dir = dirname(ctx.filePath);
  const issues: Issue[] = [];
  const fields = [
    { key: 'supersedes', value: ctx.parsed.data.supersedes },
    { key: 'superseded_by', value: ctx.parsed.data.superseded_by },
    { key: 'related', value: ctx.parsed.data.related },
  ];
  for (const { key, value } of fields) {
    if (value === undefined) continue;
    const refs = Array.isArray(value) ? value : [value];
    for (const ref of refs) {
      if (typeof ref !== 'string' || ref.length === 0) continue;
      const candidates = resolveCandidates(ref, dir, ctx);
      let resolved = false;
      for (const candidate of candidates) {
        try {
          await access(candidate);
          resolved = true;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!resolved) {
        issues.push({
          severity: 'warn',
          check: checkName,
          file: ctx.file,
          message: `${key} references missing file: ${ref}`,
        });
      }
    }
  }
  return issues;
}

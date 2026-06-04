// Fix-engine entry point (Layer-2 v2 — the "propose" half of the harness).
//
// proposeFixes() turns a CheckReport into reviewable PROPOSALS + NEEDS-HUMAN
// residue by dispatching each check kind to its registered Fixer. applyProposals()
// is the separate, explicit write step — gated behind the CLI's --write flag so
// autonomous runs stay propose-only (autonomy 1a: memory content is the user's).

import { readFile, writeFile } from 'node:fs/promises';
import type { CheckReport } from '../types.js';
import type { FixProposal, FixResult, Fixer, FixerOpts } from './types.js';
import { fixRefsResolve } from './refsResolve.js';

export type { FixProposal, Unfixable, FixResult } from './types.js';

// Registry keyed by check name. Adding a fixer (skill-footer drafting,
// verify-by refresh, …) is a one-line entry — the orchestrator stays untouched.
// fixRefsResolve is tier-agnostic (basename search over knowledge/ + docs/), so
// the same fixer serves both the memory tier and the knowledge tier.
const FIXERS: Record<string, Fixer> = {
  'memory-refs-resolve': fixRefsResolve,
  'knowledge-refs-resolve': fixRefsResolve,
};

export async function proposeFixes(report: CheckReport, opts: FixerOpts): Promise<FixResult> {
  const byCheck = new Map<string, typeof report.issues>();
  for (const issue of report.issues) {
    const arr = byCheck.get(issue.check) ?? [];
    arr.push(issue);
    byCheck.set(issue.check, arr);
  }

  const result: FixResult = { proposals: [], unfixable: [] };
  for (const [check, fixer] of Object.entries(FIXERS)) {
    const issues = byCheck.get(check);
    if (!issues || issues.length === 0) continue;
    const r = await fixer(issues, opts);
    result.proposals.push(...r.proposals);
    result.unfixable.push(...r.unfixable);
  }
  return result;
}

/**
 * Replace `oldText` with `newText` only inside the frontmatter block (between
 * the first `---` line and the next). Body prose — including [[wikilinks]] that
 * may share the filename — is never touched. Returns content unchanged if there
 * is no frontmatter or no match.
 */
export function replaceInFrontmatter(content: string, oldText: string, newText: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content; // trim() also strips a leading BOM
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return content;
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.includes(oldText)) {
      lines[i] = line.split(oldText).join(newText);
    }
  }
  return lines.join('\n');
}

/** Apply proposals to disk, one write per file. Returns per-file edit counts. */
export async function applyProposals(
  proposals: FixProposal[],
): Promise<{ filePath: string; applied: number }[]> {
  const byFile = new Map<string, FixProposal[]>();
  for (const p of proposals) {
    const arr = byFile.get(p.filePath) ?? [];
    arr.push(p);
    byFile.set(p.filePath, arr);
  }

  const summary: { filePath: string; applied: number }[] = [];
  for (const [filePath, props] of byFile) {
    let content = await readFile(filePath, 'utf-8');
    let applied = 0;
    for (const p of props) {
      const next = replaceInFrontmatter(content, p.oldText, p.newText);
      if (next !== content) {
        content = next;
        applied++;
      }
    }
    if (applied > 0) await writeFile(filePath, content, 'utf-8');
    summary.push({ filePath, applied });
  }
  return summary;
}

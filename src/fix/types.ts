// Fix-engine shapes (Layer-2 v2). A fixer consumes the Issues of one check
// kind and returns auto-resolvable PROPOSALS plus the residue it cannot safely
// resolve (NEEDS-HUMAN). Propose-only is the default contract: nothing here
// writes — the CLI applies separately, behind --write (autonomy 1a gate).

import type { Issue } from '../types.js';

/**
 * A single safe, reviewable edit: replace `oldText` with `newText` inside the
 * frontmatter of `filePath`. Kept textual (not a structured YAML rewrite) so it
 * is style-agnostic — preserves whatever list/scalar shape the file already uses.
 */
export interface FixProposal {
  file: string; // display basename
  filePath: string; // absolute path to the file to edit
  check: string; // originating check name
  field: string; // frontmatter key the ref lives under (related / supersedes / …)
  oldText: string; // exact substring to replace (the broken ref)
  newText: string; // its workspace-relative resolution
  reason: string; // one-line human label for the Decision Card
}

/**
 * A finding the fixer deliberately declined to auto-resolve. Surfaced verbatim
 * so a human can decide (create target / rename / remove / disambiguate).
 */
export interface Unfixable {
  file: string;
  check: string;
  detail: string; // the ref or message the fixer could not resolve
  reason: string; // why it was left for a human
}

export interface FixResult {
  proposals: FixProposal[];
  unfixable: Unfixable[];
}

export interface FixerOpts {
  target: string; // the scanned dir (memory dir) — abs
  workspaceRoot: string; // workspace root, search base for resolution
  // Rook memory dir — fallback search root for cross-tier refs (a KB doc pointing
  // at a memory file). A hit here proposes a BARE memory name. Optional: when
  // omitted (non-knowledge tiers, most unit tests) no cross-tier resolution runs.
  memoryDir?: string;
}

/**
 * A fixer receives every Issue of its registered check kind at once (lets it
 * batch file reads / workspace walks) and returns proposals + residue.
 */
export type Fixer = (issues: Issue[], opts: FixerOpts) => Promise<FixResult>;

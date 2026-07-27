// Untrusted-output scrub (CWE-150: improper neutralization of escape sequences).
//
// Every tier scans content cc-healer does not control: the skills tier reads
// ~/.claude/commands where `npx skills add <owner>/<repo>` installs third-party
// markdown (skills.sh has no review, signing, or checksum gate — its "Security
// Audits" badge never blocks an install), and the memory/knowledge/plugins tiers
// read files any prior session or tool may have written. Check messages
// interpolate values from that content verbatim — frontmatter fields, [[refs]],
// YAML parser errors, symlink targets — and printReport/printFixReport hand them
// to console.log. Without this scrub, a hostile value carrying terminal escapes
// can forge the linter's own report: erase its ERROR line, print a fake CLEAN,
// or move the cursor. Scrubbing at the render boundary covers every finding,
// present and future, instead of patching each interpolation site.
//
// Deliberately NOT applied to --json output or to fix proposals fed to
// applyProposals: JSON.stringify already escapes ESC (0x1b < 0x20), and a
// scrubbed oldText would no longer byte-match the file it must patch.
//
// Vetted 2026-07-27: knowledge/research/2026-07-27-vet-skills-sh.md
// (pattern lifted from vercel-labs/skills src/sanitize.ts; same regexes as
// ~/.claude/tools/hat-override-lint/check.py scrub()).

const ESC_SEQ = new RegExp(
  '\\x1b\\[[0-?]*[ -/]*[@-~]' + // CSI  (colour, cursor move, erase)
    '|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?' + // OSC  (hyperlink, window title)
    '|\\x1b[P^_][^\\x1b]*(?:\\x1b\\\\)?' + // DCS / PM / APC
    '|\\x1b[@-Z\\\\-_]', // simple two-char ESC
  'g',
);

// All C0 (incl. \n \r \t — a finding renders as one line, so an embedded newline
// would let a value inject fake result lines) + DEL + C1.
const CTRL = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Strip terminal escape sequences and raw control chars from any string that
 * reaches stdout. Applied to every printed path and finding message.
 */
export function scrub(s: unknown): string {
  return String(s).replace(ESC_SEQ, '').replace(CTRL, '');
}

// Skill identity registry — alias-aware resolution for rename-tolerance.
//
// When a skill file is renamed (e.g. `_yours.md` → `__yours.md`), other files
// that reference it by id (plugin manifests, MEMORY.md links, slash-command
// invocations in skill bodies) become stale. The alias map provides a
// forwarding layer so checks resolve old ids to canonical ids before
// validating reference targets — silent-skill-loss-on-rename guard.
//
// Pattern lifted from nexu-io/open-design `apps/daemon/src/skills.ts:18-37`
// (vetted 2026-05-08, GREEN). See
// knowledge/research/2026-05-08-vet-nexu-io-open-design.md § "Steal-worthy #2".

import { basename } from 'node:path';

/**
 * Maps deprecated skill ids to their current canonical id. Add an entry here
 * when a skill is renamed so external references continue to resolve.
 *
 * Single-hop only by design — A→B→C resolution requires an explicit A→C entry,
 * not chained A→B + B→C. Keeps the behavior trivially predictable.
 *
 * Frozen to prevent accidental runtime mutation.
 */
export const SKILL_ID_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Example future entry:
  // 'old-name': 'new-name',
});

/**
 * Returns the canonical skill id, walking the alias map once. Identity-passes
 * through if no alias entry exists. The optional `aliases` parameter exists
 * for tests; production callers should rely on the default.
 */
export function resolveSkillId(
  id: string,
  aliases: Readonly<Record<string, string>> = SKILL_ID_ALIASES,
): string {
  return aliases[id] ?? id;
}

/**
 * Derive a skill id from a `.md` filename. Strips any leading directory
 * components and the `.md` extension. Filename-based today; if SKILL.md-style
 * packaged skills arrive, this needs updating.
 */
export function skillIdFromFilename(filename: string): string {
  const base = basename(filename);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  SKILL_ID_ALIASES,
  resolveSkillId,
  skillIdFromFilename,
} from '../src/skills/registry.ts';

// --- SKILL_ID_ALIASES --------------------------------------------------

test('SKILL_ID_ALIASES is frozen', () => {
  assert.equal(Object.isFrozen(SKILL_ID_ALIASES), true);
});

// --- resolveSkillId ----------------------------------------------------

test('resolveSkillId: id with no alias entry → identity passthrough', () => {
  assert.equal(resolveSkillId('_yours'), '_yours');
});

test('resolveSkillId: empty string → empty string', () => {
  assert.equal(resolveSkillId(''), '');
});

test('resolveSkillId: injected alias map forwards old → canonical', () => {
  const aliases = Object.freeze({ 'old-name': 'new-name' });
  assert.equal(resolveSkillId('old-name', aliases), 'new-name');
});

test('resolveSkillId: injected alias map identity-passes unknown ids', () => {
  const aliases = Object.freeze({ 'old-name': 'new-name' });
  assert.equal(resolveSkillId('unrelated', aliases), 'unrelated');
});

test('resolveSkillId: single-hop only (A→B→C requires explicit A→C)', () => {
  // Documents the semantic: chained aliases are NOT auto-resolved.
  const aliases = Object.freeze({ a: 'b', b: 'c' });
  assert.equal(resolveSkillId('a', aliases), 'b');
  assert.equal(resolveSkillId('b', aliases), 'c');
});

// --- skillIdFromFilename ----------------------------------------------

test('skillIdFromFilename: bare basename .md → strips extension', () => {
  assert.equal(skillIdFromFilename('_yours.md'), '_yours');
});

test('skillIdFromFilename: POSIX path → strips dir + extension', () => {
  assert.equal(skillIdFromFilename('/Users/x/.claude/commands/_yours.md'), '_yours');
});

test('skillIdFromFilename: Windows path → strips dir + extension', () => {
  assert.equal(skillIdFromFilename('C:\\Users\\x\\.claude\\commands\\_yours.md'), '_yours');
});

test('skillIdFromFilename: filename without .md → returns basename as-is', () => {
  assert.equal(skillIdFromFilename('SKILL'), 'SKILL');
});

test('skillIdFromFilename: bare extension `.md` → empty id (degenerate)', () => {
  assert.equal(skillIdFromFilename('.md'), '');
});

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../src/parser/frontmatter.ts';
import {
  yamlParses,
  descriptionPresent,
  devcrowTierSet,
  declaredBinaryResolvable,
  declaredEnvSet,
  fileRefsResolve,
  descriptionLength,
  legacyNoDevcrow,
  verifyByPast,
  skillChecks,
} from '../src/checks/skills.ts';
import type { CheckContext } from '../src/checks/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'skills');

async function loadFixture(name: string): Promise<CheckContext> {
  const filePath = join(FIXTURES, name);
  const content = await readFile(filePath, 'utf-8');
  return {
    file: name,
    filePath,
    parsed: parseFrontmatter(content),
    content,
  };
}

// --- parser smoke -------------------------------------------------------

test('parser: clean fixture yields parsed frontmatter with description', async () => {
  const ctx = await loadFixture('clean.md');
  assert.equal(ctx.parsed.ok, true);
  assert.equal(ctx.parsed.data.description, 'A clean example skill that passes all V0 + Phase 1 checks');
});

test('parser: broken-yaml fixture surfaces unterminated frontmatter', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.equal(ctx.parsed.ok, false);
  assert.equal(ctx.parsed.errors.length >= 1, true);
  assert.match(ctx.parsed.errors.join(' '), /unterminated|closing/i);
});

test('parser: legacy fixture has no devcrow block in data', async () => {
  const ctx = await loadFixture('legacy.md');
  assert.equal(ctx.parsed.ok, true);
  assert.equal('devcrow' in ctx.parsed.data, false);
});

// --- yaml-parses (impl) -------------------------------------------------

test('yamlParses: clean fixture → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(yamlParses(ctx), []);
});

test('yamlParses: broken-yaml fixture → 1 error issue', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  const issues = yamlParses(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'yaml-parses');
  assert.equal(issues[0]?.file, 'broken-yaml.md');
});

// --- description-present (impl) ----------------------------------------

test('descriptionPresent: clean fixture → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(descriptionPresent(ctx), []);
});

test('descriptionPresent: missing-description fixture → 1 error issue', async () => {
  const ctx = await loadFixture('missing-description.md');
  const issues = descriptionPresent(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'description-present');
});

test('descriptionPresent: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  // When parse fails, descriptionPresent returns [] — yamlParses owns that error.
  assert.deepEqual(descriptionPresent(ctx), []);
});

// --- description-length (impl) -----------------------------------------

test('descriptionLength: clean fixture (≤200 chars) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(descriptionLength(ctx), []);
});

test('descriptionLength: oversized fixture (>200 chars) → 1 warn issue', async () => {
  const ctx = await loadFixture('oversized-description.md');
  const issues = descriptionLength(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'description-length');
  assert.match(issues[0]?.message ?? '', /chars/);
});

test('descriptionLength: missing-description (no field) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('missing-description.md');
  // When description is absent, descriptionLength returns [] — description-present owns that error.
  assert.deepEqual(descriptionLength(ctx), []);
});

test('descriptionLength: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(descriptionLength(ctx), []);
});

// --- Phase 1 stubs: registry sanity ------------------------------------
// Remaining stubs must return [] regardless of input until Phase 1 implements them.

const stubs = [
  ['devcrowTierSet', devcrowTierSet],
  ['declaredBinaryResolvable', declaredBinaryResolvable],
  ['declaredEnvSet', declaredEnvSet],
  ['fileRefsResolve', fileRefsResolve],
  ['legacyNoDevcrow', legacyNoDevcrow],
  ['verifyByPast', verifyByPast],
] as const;

for (const [name, check] of stubs) {
  test(`stub: ${name} returns [] on every fixture`, async () => {
    for (const fixture of [
      'clean.md',
      'broken-yaml.md',
      'missing-description.md',
      'oversized-description.md',
      'devcrow-block-valid.md',
      'legacy.md',
      'stale-verify-by.md',
    ]) {
      const ctx = await loadFixture(fixture);
      assert.deepEqual(check(ctx), [], `${name} on ${fixture}`);
    }
  });
}

// --- registry shape -----------------------------------------------------

test('skillChecks registry contains all 9 checks', () => {
  assert.equal(skillChecks.length, 9);
});

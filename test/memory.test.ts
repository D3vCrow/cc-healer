import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../src/parser/frontmatter.ts';
import {
  memoryRequiredFields,
  memoryTypeKnown,
  memorySourceShape,
  memoryVerifyByShape,
  memoryVerifyByPast,
  memoryRefsResolve,
  memoryIndexParity,
  memoryFeedbackInHotTier,
  memoryChecks,
} from '../src/checks/memory.ts';
import type { CheckContext } from '../src/checks/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'memory');

// Mirrors skills.test.ts — pinned today + empty env keep the runner deterministic.
const TEST_TODAY = '2026-05-06';
const TEST_ENV: Record<string, string | undefined> = {};
const TEST_CWD = process.cwd();
const TEST_DEVCROW_ROOT = 'F:/DevCrow/Dev';

async function loadFixture(
  name: string,
  opts?: {
    today?: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
    devcrowRoot?: string;
  },
): Promise<CheckContext> {
  const filePath = join(FIXTURES, name);
  const content = await readFile(filePath, 'utf-8');
  return {
    file: name,
    filePath,
    parsed: parseFrontmatter(content),
    content,
    today: opts?.today ?? TEST_TODAY,
    env: opts?.env ?? TEST_ENV,
    cwd: opts?.cwd ?? TEST_CWD,
    devcrowRoot: opts?.devcrowRoot ?? TEST_DEVCROW_ROOT,
  };
}

// --- parser smoke -------------------------------------------------------

test('parser: clean memory fixture yields parsed frontmatter with type=project', async () => {
  const ctx = await loadFixture('clean.md');
  assert.equal(ctx.parsed.ok, true);
  assert.equal(ctx.parsed.data.type, 'project');
});

test('parser: broken-yaml memory fixture surfaces unterminated frontmatter', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.equal(ctx.parsed.ok, false);
  assert.equal(ctx.parsed.errors.length >= 1, true);
  assert.match(ctx.parsed.errors.join(' '), /unterminated|closing/i);
});

// --- memory-required-fields (impl) -------------------------------------

test('memoryRequiredFields: clean fixture (all 5 fields) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(memoryRequiredFields(ctx), []);
});

test('memoryRequiredFields: missing-required (only name+description) → 3 errors', async () => {
  const ctx = await loadFixture('missing-required.md');
  const issues = memoryRequiredFields(ctx);
  assert.equal(issues.length, 3);
  assert.equal(issues.every((i) => i.severity === 'error'), true);
  assert.equal(issues.every((i) => i.check === 'memory-required-fields'), true);
  const messages = issues.map((i) => i.message).join(' ');
  assert.match(messages, /type/);
  assert.match(messages, /source/);
  assert.match(messages, /verify_by/);
});

test('memoryRequiredFields: invalid-type (all 5 fields, just bogus type value) → 0 issues', async () => {
  const ctx = await loadFixture('invalid-type.md');
  assert.deepEqual(memoryRequiredFields(ctx), []);
});

test('memoryRequiredFields: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(memoryRequiredFields(ctx), []);
});

// --- memory-type-known (impl) ------------------------------------------

test('memoryTypeKnown: clean fixture (type=project) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(memoryTypeKnown(ctx), []);
});

test('memoryTypeKnown: invalid-type (type=bogus) → 1 error', async () => {
  const ctx = await loadFixture('invalid-type.md');
  const issues = memoryTypeKnown(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'memory-type-known');
  assert.match(issues[0]?.message ?? '', /bogus/);
});

test('memoryTypeKnown: missing-required (no type field) → 0 issues (memory-required-fields owns)', async () => {
  const ctx = await loadFixture('missing-required.md');
  assert.deepEqual(memoryTypeKnown(ctx), []);
});

test('memoryTypeKnown: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(memoryTypeKnown(ctx), []);
});

// --- Phase 1 stubs: every stub returns [] on every fixture --------------

const stubs: ReadonlyArray<readonly [string, (ctx: CheckContext) => unknown]> = [
  ['memorySourceShape', memorySourceShape],
  ['memoryVerifyByShape', memoryVerifyByShape],
  ['memoryVerifyByPast', memoryVerifyByPast],
  ['memoryRefsResolve', memoryRefsResolve],
  ['memoryIndexParity', memoryIndexParity],
  ['memoryFeedbackInHotTier', memoryFeedbackInHotTier],
];

for (const [name, check] of stubs) {
  test(`stub: ${name} returns [] on every fixture`, async () => {
    for (const fixture of ['clean.md', 'broken-yaml.md', 'missing-required.md', 'invalid-type.md']) {
      const ctx = await loadFixture(fixture);
      assert.deepEqual(check(ctx), [], `${name} on ${fixture}`);
    }
  });
}

// --- registry shape -----------------------------------------------------

test('memoryChecks registry contains all 8 checks', () => {
  assert.equal(memoryChecks.length, 8);
});

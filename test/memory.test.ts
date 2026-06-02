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
  memoryHotTierEntryShape,
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

test('parser: block-style sequence under a key parses as a string array (regression: 79/176 silent skip)', () => {
  const content = [
    '---',
    'name: Test',
    'description: d',
    'type: project',
    'source: 2026-04-22 x',
    'verify_by: 2026-05-22',
    'related:',
    '  - feedback_bounded_exploration.md',
    '  - pattern_hook_chain_collapse.md',
    'originSessionId: abc',
    '---',
    'body',
  ].join('\n');
  const parsed = parseFrontmatter(content);
  assert.equal(parsed.ok, true, `block sequence should parse cleanly, got: ${parsed.errors.join('; ')}`);
  assert.deepEqual(parsed.data.related, [
    'feedback_bounded_exploration.md',
    'pattern_hook_chain_collapse.md',
  ]);
  // Scalar after the block sequence must re-attach at root indent, not the list.
  assert.equal(parsed.data.originSessionId, 'abc');
  assert.equal(parsed.data.verify_by, '2026-05-22');
});

test('parser: block sequence nested under an object key (metadata wrapper) parses', () => {
  const content = [
    '---',
    'name: Test',
    'metadata:',
    '  node_type: memory',
    '  related:',
    '    - a.md',
    '    - b.md',
    '---',
    'body',
  ].join('\n');
  const parsed = parseFrontmatter(content);
  assert.equal(parsed.ok, true, `nested block sequence errors: ${parsed.errors.join('; ')}`);
  const meta = parsed.data.metadata as Record<string, unknown>;
  assert.equal(meta.node_type, 'memory');
  assert.deepEqual(meta.related, ['a.md', 'b.md']);
});

test('parser: flow array still parses (no regression from block-sequence support)', () => {
  const parsed = parseFrontmatter('---\nname: T\nrelated: [a.md, b.md]\n---\nbody');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data.related, ['a.md', 'b.md']);
});

test('memoryVerifyByPast: fires on a block-sequence file with past verify_by (end-to-end of the parser fix)', () => {
  const content = [
    '---',
    'name: Stale',
    'description: d',
    'type: project',
    'source: 2026-04-22 x',
    'verify_by: 2026-04-01',
    'related:',
    '  - feedback_bounded_exploration.md',
    '---',
    'body',
  ].join('\n');
  const ctx: CheckContext = {
    file: 'stale.md',
    filePath: join(FIXTURES, 'stale.md'),
    parsed: parseFrontmatter(content),
    content,
    today: '2026-05-01',
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: TEST_DEVCROW_ROOT,
  };
  const issues = memoryVerifyByPast(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.check, 'memory-verify-by-past');
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

// --- memory-source-shape (impl) ----------------------------------------

test('memorySourceShape: clean fixture (YYYY-MM-DD + text) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(memorySourceShape(ctx), []);
});

test('memorySourceShape: bad-source fixture (no date prefix) → 1 warn', async () => {
  const ctx = await loadFixture('bad-source.md');
  const issues = memorySourceShape(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'memory-source-shape');
  assert.match(issues[0]?.message ?? '', /no date prefix here/);
});

test('memorySourceShape: missing-required (no source field) → 0 issues (required-fields owns)', async () => {
  const ctx = await loadFixture('missing-required.md');
  assert.deepEqual(memorySourceShape(ctx), []);
});

test('memorySourceShape: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(memorySourceShape(ctx), []);
});

// --- memory-verify-by-shape (impl) -------------------------------------

test('memoryVerifyByShape: clean fixture (YYYY-MM-DD) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(memoryVerifyByShape(ctx), []);
});

test('memoryVerifyByShape: verify-by-stable (stable) → 0 issues', async () => {
  const ctx = await loadFixture('verify-by-stable.md');
  assert.deepEqual(memoryVerifyByShape(ctx), []);
});

test('memoryVerifyByShape: bad-verify-by (verify_by=soon) → 1 warn', async () => {
  const ctx = await loadFixture('bad-verify-by.md');
  const issues = memoryVerifyByShape(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'memory-verify-by-shape');
  assert.match(issues[0]?.message ?? '', /soon/);
});

test('memoryVerifyByShape: missing-required (no verify_by) → 0 issues (required-fields owns)', async () => {
  const ctx = await loadFixture('missing-required.md');
  assert.deepEqual(memoryVerifyByShape(ctx), []);
});

// --- memory-verify-by-past (impl) --------------------------------------

test('memoryVerifyByPast: clean fixture (verify_by=2027-01-01 future) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(memoryVerifyByPast(ctx), []);
});

test('memoryVerifyByPast: verify-by-stable → 0 issues', async () => {
  const ctx = await loadFixture('verify-by-stable.md');
  assert.deepEqual(memoryVerifyByPast(ctx), []);
});

test('memoryVerifyByPast: verify-by-past (2025-01-01 < 2026-05-06) → 1 info', async () => {
  const ctx = await loadFixture('verify-by-past.md');
  const issues = memoryVerifyByPast(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'info');
  assert.equal(issues[0]?.check, 'memory-verify-by-past');
  assert.match(issues[0]?.message ?? '', /2025-01-01.*2026-05-06/);
});

test('memoryVerifyByPast: verify-by-past with today pinned to before that date → 0 issues', async () => {
  const ctx = await loadFixture('verify-by-past.md', { today: '2024-12-01' });
  assert.deepEqual(memoryVerifyByPast(ctx), []);
});

test('memoryVerifyByPast: bad-verify-by (verify_by=soon) → 0 issues (shape check owns malformed)', async () => {
  const ctx = await loadFixture('bad-verify-by.md');
  assert.deepEqual(memoryVerifyByPast(ctx), []);
});

test('memoryVerifyByPast: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(memoryVerifyByPast(ctx), []);
});

test('memoryVerifyByPast: audit_* file with past verify_by → 0 issues (historical, exempt)', () => {
  const content = [
    '---',
    'name: A',
    'description: d',
    'type: project',
    'source: 2026-05-01 weekly audit',
    'verify_by: 2025-01-01',
    '---',
    'body',
  ].join('\n');
  const ctx: CheckContext = {
    file: 'audit_weekly_2026-05-01.md',
    filePath: join(FIXTURES, 'audit_weekly_2026-05-01.md'),
    parsed: parseFrontmatter(content),
    content,
    today: TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: TEST_DEVCROW_ROOT,
  };
  // verify_by 2025-01-01 is well past TEST_TODAY, but audit_* is exempt.
  assert.deepEqual(memoryVerifyByPast(ctx), []);
});

// --- memory-refs-resolve (impl, async) ---------------------------------

test('memoryRefsResolve: clean fixture (no ref fields) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(await memoryRefsResolve(ctx), []);
});

test('memoryRefsResolve: good-ref (supersedes resolves to clean.md) → 0 issues', async () => {
  const ctx = await loadFixture('good-ref.md');
  assert.deepEqual(await memoryRefsResolve(ctx), []);
});

test('memoryRefsResolve: bad-ref (supersedes points to missing file) → 1 warn', async () => {
  const ctx = await loadFixture('bad-ref.md');
  const issues = await memoryRefsResolve(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'memory-refs-resolve');
  assert.match(issues[0]?.message ?? '', /supersedes/);
  assert.match(issues[0]?.message ?? '', /does-not-exist\.md/);
});

test('memoryRefsResolve: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(await memoryRefsResolve(ctx), []);
});

test('memoryRefsResolve: workspace-relative ref (skills/clean.md under devcrowRoot) resolves → 0 issues', async () => {
  const content = [
    '---',
    'name: T',
    'description: d',
    'type: project',
    'source: 2026-04-22 x',
    'verify_by: 2027-01-01',
    'related: [skills/clean.md]',
    '---',
    'body',
  ].join('\n');
  const ctx: CheckContext = {
    file: 'inline.md',
    filePath: join(FIXTURES, 'inline.md'),
    parsed: parseFrontmatter(content),
    content,
    today: TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: join(HERE, 'fixtures'),
  };
  // skills/clean.md exists under test/fixtures (the skills-tier fixture set),
  // so a workspace-relative ref must resolve even though it isn't a sibling.
  assert.deepEqual(await memoryRefsResolve(ctx), []);
});

test('memoryRefsResolve: workspace-relative ref that exists nowhere → 1 warn', async () => {
  const content = [
    '---',
    'name: T',
    'description: d',
    'type: project',
    'source: 2026-04-22 x',
    'verify_by: 2027-01-01',
    'related: [knowledge/research/does-not-exist-xyz.md]',
    '---',
    'body',
  ].join('\n');
  const ctx: CheckContext = {
    file: 'inline.md',
    filePath: join(FIXTURES, 'inline.md'),
    parsed: parseFrontmatter(content),
    content,
    today: TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: join(HERE, 'fixtures'),
  };
  const issues = await memoryRefsResolve(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.check, 'memory-refs-resolve');
  assert.match(issues[0]?.message ?? '', /does-not-exist-xyz/);
});

// --- memory-index-parity (impl, cross-file) ----------------------------

import type { MemoryIndexes } from '../src/checks/types.ts';

async function loadWithIndexes(name: string, indexes: MemoryIndexes): Promise<CheckContext> {
  const ctx = await loadFixture(name);
  return { ...ctx, indexes };
}

test('memoryIndexParity: file in MEMORY.md only → 0 issues', async () => {
  const ctx = await loadWithIndexes('clean.md', {
    hot: new Set(['clean.md']),
    deep: new Set(['other.md']),
  });
  assert.deepEqual(memoryIndexParity(ctx), []);
});

test('memoryIndexParity: file in DEEP-INDEX.md only → 0 issues', async () => {
  const ctx = await loadWithIndexes('clean.md', {
    hot: new Set(['other.md']),
    deep: new Set(['clean.md']),
  });
  assert.deepEqual(memoryIndexParity(ctx), []);
});

test('memoryIndexParity: file in BOTH indexes → 1 error (double-listed)', async () => {
  const ctx = await loadWithIndexes('clean.md', {
    hot: new Set(['clean.md']),
    deep: new Set(['clean.md']),
  });
  const issues = memoryIndexParity(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'memory-index-parity');
  assert.match(issues[0]?.message ?? '', /BOTH/);
});

test('memoryIndexParity: file in NEITHER → 1 error (orphan)', async () => {
  const ctx = await loadWithIndexes('clean.md', {
    hot: new Set(['other.md']),
    deep: new Set(['another.md']),
  });
  const issues = memoryIndexParity(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'memory-index-parity');
  assert.match(issues[0]?.message ?? '', /orphan/);
});

test('memoryIndexParity: no indexes provided → 0 issues (skill-tier scan)', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(memoryIndexParity(ctx), []);
});

test('memoryIndexParity: both indexes empty → 0 issues (no MEMORY/DEEP-INDEX in dir)', async () => {
  const ctx = await loadWithIndexes('clean.md', {
    hot: new Set(),
    deep: new Set(),
  });
  assert.deepEqual(memoryIndexParity(ctx), []);
});

test('memoryIndexParity: MEMORY.md itself → 0 issues (index file, not a memory entry)', async () => {
  // MEMORY.md never appears in its own hot index (it IS the hot index).
  // Without self-guard, this would misfire as "orphaned" once the runner stops skipping it.
  const ctx = await loadWithIndexes('clean.md', {
    hot: new Set(['other.md']),
    deep: new Set(['another.md']),
  });
  const ctxAsMemoryMd: CheckContext = { ...ctx, file: 'MEMORY.md' };
  assert.deepEqual(memoryIndexParity(ctxAsMemoryMd), []);
});

test('memoryIndexParity: DEEP-INDEX.md itself → 0 issues (index file, not a memory entry)', async () => {
  const ctx = await loadWithIndexes('clean.md', {
    hot: new Set(['other.md']),
    deep: new Set(['another.md']),
  });
  const ctxAsDeepIndex: CheckContext = { ...ctx, file: 'DEEP-INDEX.md' };
  assert.deepEqual(memoryIndexParity(ctxAsDeepIndex), []);
});

// --- memory-feedback-in-hot-tier (impl, cross-file) --------------------

test('memoryFeedbackInHotTier: feedback fixture in hot tier → 0 issues', async () => {
  const ctx = await loadWithIndexes('feedback-clean.md', {
    hot: new Set(['feedback-clean.md']),
    deep: new Set(['something_else.md']),
  });
  assert.deepEqual(memoryFeedbackInHotTier(ctx), []);
});

test('memoryFeedbackInHotTier: feedback fixture in DEEP-INDEX → 1 warn', async () => {
  const ctx = await loadWithIndexes('feedback-clean.md', {
    hot: new Set(['something_else.md']),
    deep: new Set(['feedback-clean.md']),
  });
  const issues = memoryFeedbackInHotTier(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'memory-feedback-in-hot-tier');
  assert.match(issues[0]?.message ?? '', /MEMORY\.md/);
});

test('memoryFeedbackInHotTier: non-feedback fixture in DEEP-INDEX → 0 issues (only feedback gates)', async () => {
  const ctx = await loadWithIndexes('clean.md', {
    hot: new Set(),
    deep: new Set(['clean.md']),
  });
  assert.deepEqual(memoryFeedbackInHotTier(ctx), []);
});

test('memoryFeedbackInHotTier: no indexes → 0 issues (skill-tier scan)', async () => {
  const ctx = await loadFixture('feedback-clean.md');
  assert.deepEqual(memoryFeedbackInHotTier(ctx), []);
});

test('memoryFeedbackInHotTier: broken-yaml → 0 issues (self-guarded)', async () => {
  const ctx = await loadWithIndexes('broken-yaml.md', {
    hot: new Set(['broken-yaml.md']),
    deep: new Set(),
  });
  assert.deepEqual(memoryFeedbackInHotTier(ctx), []);
});

// --- memory-hot-tier-entry-shape (impl) --------------------------------
//
// Filename-gated: fires only on MEMORY.md. We override ctx.file via spread
// so fixtures can have any name on disk but present as MEMORY.md to the check.

async function loadAsMemoryMd(name: string): Promise<CheckContext> {
  const ctx = await loadFixture(name);
  return { ...ctx, file: 'MEMORY.md' };
}

test('memoryHotTierEntryShape: clean MEMORY.md fixture (all entries ≤150) → 0 issues', async () => {
  const ctx = await loadAsMemoryMd('hot-tier-clean.md');
  assert.deepEqual(memoryHotTierEntryShape(ctx), []);
});

test('memoryHotTierEntryShape: oversized fixture → 2 warns (skip-list excludes top-of-file + blockquote)', async () => {
  const ctx = await loadAsMemoryMd('hot-tier-oversized.md');
  const issues = memoryHotTierEntryShape(ctx);
  assert.equal(issues.length, 2);
  assert.equal(issues.every((i) => i.severity === 'warn'), true);
  assert.equal(issues.every((i) => i.check === 'memory-hot-tier-entry-shape'), true);
  assert.equal(issues.every((i) => i.file === 'MEMORY.md'), true);
  assert.equal(issues.every((i) => typeof i.line === 'number'), true);
  assert.equal(issues.every((i) => /exceeds 150 chars \(\d+ chars\)/.test(i.message)), true);
});

test('memoryHotTierEntryShape: oversized fixture line numbers correspond to section entries (not top-of-file or blockquote)', async () => {
  const ctx = await loadAsMemoryMd('hot-tier-oversized.md');
  const issues = memoryHotTierEntryShape(ctx);
  // Fixture layout: top-of-file oversized at L5, section entry at L9, blockquote at L12, sub-section entry at L15.
  // Only L9 and L15 should fire (top-of-file + blockquote skipped).
  const lines = issues.map((i) => i.line).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(lines, [9, 15]);
});

test('memoryHotTierEntryShape: non-MEMORY.md file → 0 issues (self-guarded)', async () => {
  // ctx.file = 'clean.md' (not MEMORY.md) — check returns early.
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(memoryHotTierEntryShape(ctx), []);
});

// --- registry shape -----------------------------------------------------

test('memoryChecks registry contains all 9 checks', () => {
  assert.equal(memoryChecks.length, 9);
});

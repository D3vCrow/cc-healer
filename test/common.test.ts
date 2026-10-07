import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRefsResolve, isNetworkPath } from '../src/checks/common.ts';
import type { CheckContext } from '../src/checks/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// The host sits under the reserved `.invalid` TLD (RFC 2606): it can never
// resolve, so a regression that probes these paths again reaches no real machine.
const UNC_REF = String.raw`\\cc-healer-test.invalid\share\note.md`;
const SLASH_REF = '//cc-healer-test.invalid/share/note.md';

function ctxWith(data: Record<string, unknown>): CheckContext {
  return {
    file: 'note.md',
    filePath: join(HERE, 'fixtures', 'note.md'),
    parsed: { ok: true, data, errors: [], body: '' },
    content: '',
    today: '2026-05-06',
    env: {},
    cwd: process.cwd(),
    workspaceRoot: 'C:/workspace',
  };
}

// --- isNetworkPath ------------------------------------------------------

test('isNetworkPath: network shares and device namespaces → true', () => {
  for (const p of [
    UNC_REF,
    SLASH_REF,
    String.raw`\\?\UNC\server\share\a.md`,
    String.raw`\\.\pipe\name`,
    String.raw`/\server\share\a.md`,
    String.raw`\/server/share/a.md`,
  ]) {
    assert.equal(isNetworkPath(p), true, p);
  }
});

test('isNetworkPath: local and relative paths → false', () => {
  for (const p of [
    String.raw`C:\Users\x\a.md`,
    'C:/Users/x/a.md',
    '/usr/lib/a.md',
    'docs/a.md',
    './a.md',
    String.raw`..\a.md`,
    'a.md',
    '',
  ]) {
    assert.equal(isNetworkPath(p), false, p);
  }
});

// --- checkRefsResolve: network paths are reported, never probed ----------

test('checkRefsResolve: a ref that only resolves to a network path → 1 warn, not probed', async () => {
  const ctx = ctxWith({ related: [UNC_REF, SLASH_REF] });
  // The resolver hands the ref through untouched, as the memory and knowledge
  // tiers do for an absolute ref.
  const issues = await checkRefsResolve(ctx, 'test-refs-resolve', (ref) => [ref]);
  assert.equal(issues.length, 2);
  for (const issue of issues) {
    assert.equal(issue.severity, 'warn');
    assert.equal(issue.check, 'test-refs-resolve');
    assert.match(issue.message, /network or device path; not probed/);
    assert.doesNotMatch(issue.message, /missing file/);
  }
});

test('checkRefsResolve: a network candidate beside an existing local one → 0 issues', async () => {
  const ctx = ctxWith({ related: 'package.json' });
  const issues = await checkRefsResolve(ctx, 'test-refs-resolve', (ref) => [
    UNC_REF,
    join(process.cwd(), ref),
  ]);
  assert.deepEqual(issues, []);
});

test('checkRefsResolve: a missing local ref still reads as missing', async () => {
  const ctx = ctxWith({ related: 'bogus-path-XYZ-does-not-exist.md' });
  const issues = await checkRefsResolve(ctx, 'test-refs-resolve', (ref) => [join(process.cwd(), ref)]);
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /references missing file/);
});

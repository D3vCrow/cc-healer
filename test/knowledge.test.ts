import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../src/parser/frontmatter.ts';
import {
  knowledgeVerifyByPast,
  knowledgeRefsResolve,
  knowledgeChecks,
} from '../src/checks/knowledge.ts';
import type { CheckContext } from '../src/checks/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// fixtures/fix mirrors a workspace root: it holds knowledge/research, knowledge/
// discoveries, and docs/handoffs subtrees — enough to exercise every KB resolver
// root deterministically without touching the real workspace.
const FIX_ROOT = join(HERE, 'fixtures', 'fix');

const TEST_TODAY = '2026-06-02';
const TEST_ENV: Record<string, string | undefined> = {};
const TEST_CWD = process.cwd();

// Build a ctx from inline frontmatter. filePath defaults to a decisions/ doc so
// `../`-relative refs resolve against a real fixture subtree; devcrowRoot is the
// fixture workspace root so knowledge-root / workspace-relative refs resolve too.
function ctxFrom(
  frontmatter: string[],
  opts?: { filePath?: string; today?: string },
): CheckContext {
  const content = ['---', ...frontmatter, '---', 'body'].join('\n');
  return {
    file: 'inline.md',
    filePath: opts?.filePath ?? join(FIX_ROOT, 'knowledge', 'decisions', 'inline.md'),
    parsed: parseFrontmatter(content),
    content,
    today: opts?.today ?? TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: FIX_ROOT,
  };
}

// --- knowledge-verify-by-past ------------------------------------------

test('knowledgeVerifyByPast: past date → 1 info with knowledge-verify-by-past', () => {
  const issues = knowledgeVerifyByPast(ctxFrom(['title: T', 'verify_by: 2026-05-01']));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'info');
  assert.equal(issues[0]?.check, 'knowledge-verify-by-past');
  assert.match(issues[0]?.message ?? '', /2026-05-01.*2026-06-02/);
});

test('knowledgeVerifyByPast: stable → 0 issues', () => {
  assert.deepEqual(knowledgeVerifyByPast(ctxFrom(['title: T', 'verify_by: stable'])), []);
});

test('knowledgeVerifyByPast: future date → 0 issues', () => {
  assert.deepEqual(knowledgeVerifyByPast(ctxFrom(['title: T', 'verify_by: 2027-01-01'])), []);
});

test('knowledgeVerifyByPast: verify_by absent → 0 issues (optional in the KB)', () => {
  // KB docs are not required to carry verify_by; a doc without one never flags.
  assert.deepEqual(knowledgeVerifyByPast(ctxFrom(['title: T', 'status: decided'])), []);
});

test('knowledgeVerifyByPast: malformed verify_by → 0 issues (shape check owns)', () => {
  assert.deepEqual(knowledgeVerifyByPast(ctxFrom(['title: T', 'verify_by: soon'])), []);
});

test('knowledgeVerifyByPast: no frontmatter → 0 issues (self-guarded)', () => {
  const ctx: CheckContext = {
    file: 'inline.md',
    filePath: join(FIX_ROOT, 'inline.md'),
    parsed: parseFrontmatter('no frontmatter here'),
    content: 'no frontmatter here',
    today: TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: FIX_ROOT,
  };
  assert.deepEqual(knowledgeVerifyByPast(ctx), []);
});

test('knowledgeVerifyByPast: no audit_* exemption (unlike memory) — audit-named KB doc still flags', () => {
  // The KB has no audit_* convention; the memory-only exemption must NOT leak here.
  const issues = knowledgeVerifyByPast(
    ctxFrom(['title: T', 'verify_by: 2026-05-01'], {
      filePath: join(FIX_ROOT, 'knowledge', 'decisions', 'audit_something.md'),
    }),
  );
  assert.equal(issues.length, 1);
});

// --- knowledge-refs-resolve --------------------------------------------

test('knowledgeRefsResolve: no ref fields → 0 issues', async () => {
  assert.deepEqual(await knowledgeRefsResolve(ctxFrom(['title: T'])), []);
});

test('knowledgeRefsResolve: workspace-relative ref resolves → 0 issues', async () => {
  const issues = await knowledgeRefsResolve(
    ctxFrom(['title: T', 'related: [knowledge/research/2026-01-01-foo.md]']),
  );
  assert.deepEqual(issues, []);
});

test('knowledgeRefsResolve: knowledge-root-relative ref (no knowledge/ prefix) resolves → 0 issues', async () => {
  // research/… without the leading knowledge/ — the KB-specific candidate root.
  const issues = await knowledgeRefsResolve(
    ctxFrom(['title: T', 'related: [research/2026-01-01-foo.md]']),
  );
  assert.deepEqual(issues, []);
});

test('knowledgeRefsResolve: sibling ../-relative ref resolves → 0 issues', async () => {
  // From knowledge/decisions/inline.md, ../research/2026-01-01-foo.md is a real file.
  const issues = await knowledgeRefsResolve(
    ctxFrom(['title: T', 'related: [../research/2026-01-01-foo.md]']),
  );
  assert.deepEqual(issues, []);
});

test('knowledgeRefsResolve: docs/ workspace-relative ref resolves → 0 issues', async () => {
  const issues = await knowledgeRefsResolve(
    ctxFrom(['title: T', 'related: [docs/handoffs/2026-01-03-baz.md]']),
  );
  assert.deepEqual(issues, []);
});

test('knowledgeRefsResolve: inline annotation after the path is stripped before resolving → 0 issues', async () => {
  // `foo.md (note)` — the annotation must not break resolution of foo.md.
  const issues = await knowledgeRefsResolve(
    ctxFrom(['title: T', 'related:', '  - research/2026-01-01-foo.md (baseline — not re-audited)']),
  );
  assert.deepEqual(issues, []);
});

test('knowledgeRefsResolve: dangling ref (exists at no candidate) → 1 warn', async () => {
  const issues = await knowledgeRefsResolve(
    ctxFrom(['title: T', 'related: [research/does-not-exist-xyz.md]']),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'knowledge-refs-resolve');
  assert.match(issues[0]?.message ?? '', /does-not-exist-xyz/);
});

test('knowledgeRefsResolve: tilde ref to a missing path → 1 warn (exercises ~ expansion)', async () => {
  const issues = await knowledgeRefsResolve(
    ctxFrom(['title: T', 'related: [~/.claude/cc-healer-nonexistent-xyz.md]']),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.check, 'knowledge-refs-resolve');
});

test('knowledgeRefsResolve: supersedes + superseded_by + related all scanned', async () => {
  const issues = await knowledgeRefsResolve(
    ctxFrom([
      'title: T',
      'supersedes: [research/missing-a.md]',
      'superseded_by: research/missing-b.md',
      'related: [research/2026-01-01-foo.md, research/missing-c.md]',
    ]),
  );
  // foo.md resolves; the three missing refs flag, one per field.
  assert.equal(issues.length, 3);
  const fields = issues.map((i) => i.message.split(' ')[0]).sort();
  assert.deepEqual(fields, ['related', 'superseded_by', 'supersedes']);
});

test('knowledgeRefsResolve: broken-yaml → 0 issues (self-guarded)', async () => {
  const ctx: CheckContext = {
    file: 'inline.md',
    filePath: join(FIX_ROOT, 'inline.md'),
    parsed: parseFrontmatter('---\nrelated: [x.md]\nbody-no-close'),
    content: '---\nrelated: [x.md]\nbody-no-close',
    today: TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: FIX_ROOT,
  };
  assert.deepEqual(await knowledgeRefsResolve(ctx), []);
});

// --- registry ----------------------------------------------------------

test('knowledgeChecks registry contains both checks', () => {
  assert.equal(knowledgeChecks.length, 2);
});

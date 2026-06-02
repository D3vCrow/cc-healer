import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixRefsResolve } from '../src/fix/refsResolve.ts';
import { proposeFixes, replaceInFrontmatter, applyProposals } from '../src/fix/index.ts';
import type { Issue, CheckReport } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// Fixture workspace: knowledge/research, knowledge/discoveries, docs/handoffs.
const FIX_ROOT = join(HERE, 'fixtures', 'fix');
const TARGET = join(HERE, 'fixtures', 'memory'); // any memory dir; only used to build filePath

function refIssue(file: string, message: string): Issue {
  return { severity: 'warn', check: 'memory-refs-resolve', file, message };
}

// --- fixRefsResolve: resolution outcomes ---------------------------------

test('fixRefsResolve: bare date-ref unique under knowledge/research → proposal with prefixed path', async () => {
  const issues = [refIssue('mem.md', 'related references missing file: 2026-01-01-foo.md')];
  const { proposals, unfixable } = await fixRefsResolve(issues, { target: TARGET, devcrowRoot: FIX_ROOT });
  assert.equal(unfixable.length, 0);
  assert.equal(proposals.length, 1);
  const p = proposals[0]!;
  assert.equal(p.field, 'related');
  assert.equal(p.oldText, '2026-01-01-foo.md');
  assert.equal(p.newText, 'knowledge/research/2026-01-01-foo.md');
  assert.equal(p.filePath, join(TARGET, 'mem.md'));
});

test('fixRefsResolve: discoveries/ partial path → repaired to knowledge/discoveries/', async () => {
  const issues = [refIssue('mem.md', 'related references missing file: discoveries/2026-01-02-bar.md')];
  const { proposals } = await fixRefsResolve(issues, { target: TARGET, devcrowRoot: FIX_ROOT });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]!.oldText, 'discoveries/2026-01-02-bar.md');
  assert.equal(proposals[0]!.newText, 'knowledge/discoveries/2026-01-02-bar.md');
});

test('fixRefsResolve: target living under docs/ resolves there, not just knowledge/', async () => {
  const issues = [refIssue('mem.md', 'supersedes references missing file: 2026-01-03-baz.md')];
  const { proposals } = await fixRefsResolve(issues, { target: TARGET, devcrowRoot: FIX_ROOT });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]!.field, 'supersedes');
  assert.equal(proposals[0]!.newText, 'docs/handoffs/2026-01-03-baz.md');
});

test('fixRefsResolve: no such file anywhere → unfixable (dangling), no proposal', async () => {
  const issues = [refIssue('mem.md', 'related references missing file: 2026-09-09-nope.md')];
  const { proposals, unfixable } = await fixRefsResolve(issues, { target: TARGET, devcrowRoot: FIX_ROOT });
  assert.equal(proposals.length, 0);
  assert.equal(unfixable.length, 1);
  assert.match(unfixable[0]!.reason, /dangling/);
});

test('fixRefsResolve: same basename in two roots → unfixable (ambiguous), not guessed', async () => {
  const issues = [refIssue('mem.md', 'related references missing file: dup-target.md')];
  const { proposals, unfixable } = await fixRefsResolve(issues, { target: TARGET, devcrowRoot: FIX_ROOT });
  assert.equal(proposals.length, 0);
  assert.equal(unfixable.length, 1);
  assert.match(unfixable[0]!.reason, /ambiguous/);
});

test('fixRefsResolve: unparseable message → unfixable, never throws', async () => {
  const issues = [refIssue('mem.md', 'totally different message shape')];
  const { proposals, unfixable } = await fixRefsResolve(issues, { target: TARGET, devcrowRoot: FIX_ROOT });
  assert.equal(proposals.length, 0);
  assert.equal(unfixable.length, 1);
  assert.match(unfixable[0]!.reason, /could not parse/);
});

// --- proposeFixes: dispatch only registered checks -----------------------

test('proposeFixes: ignores issues with no registered fixer (e.g. verify-by-past)', async () => {
  const report: CheckReport = {
    scanned: 1,
    withFrontmatter: 1,
    parseFailures: 0,
    durationMs: 0,
    issues: [
      refIssue('mem.md', 'related references missing file: 2026-01-01-foo.md'),
      { severity: 'warn', check: 'memory-verify-by-past', file: 'mem.md', message: 'stale' },
    ],
  };
  const { proposals } = await proposeFixes(report, { target: TARGET, devcrowRoot: FIX_ROOT });
  assert.equal(proposals.length, 1); // only the refs-resolve finding produced a proposal
});

// --- replaceInFrontmatter: scope safety ----------------------------------

test('replaceInFrontmatter: rewrites the frontmatter ref but leaves body prose alone', () => {
  const content = [
    '---',
    'name: T',
    'related:',
    '  - 2026-01-01-foo.md',
    '---',
    'See 2026-01-01-foo.md in the body — must stay bare.',
  ].join('\n');
  const out = replaceInFrontmatter(content, '2026-01-01-foo.md', 'knowledge/research/2026-01-01-foo.md');
  const lines = out.split('\n');
  assert.equal(lines[3], '  - knowledge/research/2026-01-01-foo.md');
  assert.equal(lines[5], 'See 2026-01-01-foo.md in the body — must stay bare.');
});

test('replaceInFrontmatter: flow-array form rewritten in place', () => {
  const out = replaceInFrontmatter(
    '---\nrelated: [2026-01-01-foo.md]\n---\nbody',
    '2026-01-01-foo.md',
    'knowledge/research/2026-01-01-foo.md',
  );
  assert.equal(out, '---\nrelated: [knowledge/research/2026-01-01-foo.md]\n---\nbody');
});

test('replaceInFrontmatter: no frontmatter → content returned unchanged', () => {
  const content = 'plain line with 2026-01-01-foo.md and no fences';
  assert.equal(replaceInFrontmatter(content, '2026-01-01-foo.md', 'x'), content);
});

// --- applyProposals: write path ------------------------------------------

test('applyProposals: writes the resolved ref to disk, body untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cch-fix-'));
  try {
    const filePath = join(dir, 'mem.md');
    await writeFile(
      filePath,
      '---\nname: T\nrelated: [2026-01-01-foo.md]\n---\nbody keeps 2026-01-01-foo.md\n',
      'utf-8',
    );
    const summary = await applyProposals([
      {
        file: 'mem.md',
        filePath,
        check: 'memory-refs-resolve',
        field: 'related',
        oldText: '2026-01-01-foo.md',
        newText: 'knowledge/research/2026-01-01-foo.md',
        reason: 'test',
      },
    ]);
    assert.equal(summary[0]!.applied, 1);
    const after = await readFile(filePath, 'utf-8');
    assert.match(after, /related: \[knowledge\/research\/2026-01-01-foo\.md\]/);
    assert.match(after, /body keeps 2026-01-01-foo\.md/); // body line untouched
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

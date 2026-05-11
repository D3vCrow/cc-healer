import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { parseFrontmatter } from '../src/parser/frontmatter.ts';
import {
  pluginInstallRegistryConsistent,
  pluginSkillRefsExist,
  pluginScheduleSkillRefsExist,
  pluginSymlinksResolve,
  pluginChecks,
} from '../src/checks/plugins.ts';
import type { CheckContext, PluginIndex } from '../src/checks/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'plugins');

const TEST_TODAY = '2026-05-11';
const TEST_ENV: Record<string, string | undefined> = {};
const TEST_CWD = process.cwd();
const TEST_DEVCROW_ROOT = 'F:/DevCrow/Dev';

async function loadFixture(
  relPath: string,
  opts?: {
    today?: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
    devcrowRoot?: string;
    pluginIndex?: PluginIndex;
    contentOverride?: string;
    fileOverride?: string;  // override ctx.file (basename) — registry tests need this since
                             // production scanner sets file='installed_plugins.json' but fixtures
                             // use suffixed names to disambiguate test cases on disk.
  },
): Promise<CheckContext> {
  const filePath = join(FIXTURES, relPath);
  const content = opts?.contentOverride ?? (await readFile(filePath, 'utf-8'));
  const defaultFile = relPath.replace(/\\/g, '/').split('/').pop() ?? relPath;
  return {
    file: opts?.fileOverride ?? defaultFile,
    filePath,
    parsed: parseFrontmatter(content),
    content,
    today: opts?.today ?? TEST_TODAY,
    env: opts?.env ?? TEST_ENV,
    cwd: opts?.cwd ?? TEST_CWD,
    devcrowRoot: opts?.devcrowRoot ?? TEST_DEVCROW_ROOT,
    ...(opts?.pluginIndex ? { pluginIndex: opts.pluginIndex } : {}),
  };
}

// --- Check 1: plugin-install-registry-consistent ------------------------

test('pluginInstallRegistryConsistent: non-registry file (different basename) → 0 issues (self-guard)', async () => {
  const ctx = await loadFixture('skill-no-plugin-refs.md');
  assert.deepEqual(await pluginInstallRegistryConsistent(ctx), []);
});

test('pluginInstallRegistryConsistent: clean registry with existing installPath → 0 issues', async () => {
  // Substitute the placeholder with an actually-existing path (the fixtures dir itself).
  const raw = await readFile(join(FIXTURES, 'installed_plugins-clean.json'), 'utf-8');
  const content = raw.replace('FIXTURE_DIR_PLACEHOLDER', FIXTURES.replace(/\\/g, '/'));
  const ctx = await loadFixture('installed_plugins-clean.json', {
    contentOverride: content,
    fileOverride: 'installed_plugins.json',
  });
  const issues = await pluginInstallRegistryConsistent(ctx);
  assert.deepEqual(issues, []);
});

test('pluginInstallRegistryConsistent: broken installPath → 1 error', async () => {
  const ctx = await loadFixture('installed_plugins-broken-path.json', {
    fileOverride: 'installed_plugins.json',
  });
  const issues = await pluginInstallRegistryConsistent(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'plugin-install-registry-consistent');
  assert.match(issues[0]?.message ?? '', /phantom-plugin@nowhere-marketplace/);
  assert.match(issues[0]?.message ?? '', /does not exist/);
});

test('pluginInstallRegistryConsistent: malformed JSON → 1 error', async () => {
  const ctx = await loadFixture('installed_plugins-malformed.json', {
    fileOverride: 'installed_plugins.json',
  });
  const issues = await pluginInstallRegistryConsistent(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.match(issues[0]?.message ?? '', /not valid JSON/);
});

test('pluginInstallRegistryConsistent: bad shape (missing plugins object) → 1 error', async () => {
  const ctx = await loadFixture('installed_plugins-bad-shape.json', {
    fileOverride: 'installed_plugins.json',
  });
  const issues = await pluginInstallRegistryConsistent(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.match(issues[0]?.message ?? '', /unexpected registry shape/);
});

// --- Check 2: plugin-skill-refs-exist ------------------------------------

test('pluginSkillRefsExist: no pluginIndex → 0 issues (self-guard)', async () => {
  const ctx = await loadFixture('skill-with-plugin-refs.md');
  assert.deepEqual(pluginSkillRefsExist(ctx), []);
});

test('pluginSkillRefsExist: pluginIndex present, no devcrow.requires.plugins → 0 issues', async () => {
  const idx: PluginIndex = { installedIds: new Set(['anything@somewhere']) };
  const ctx = await loadFixture('skill-no-plugin-refs.md', { pluginIndex: idx });
  assert.deepEqual(pluginSkillRefsExist(ctx), []);
});

test('pluginSkillRefsExist: 1 of 2 declared plugins not in installedIds → 1 warn', async () => {
  const idx: PluginIndex = {
    installedIds: new Set(['installed-plugin@some-marketplace']),
  };
  const ctx = await loadFixture('skill-with-plugin-refs.md', { pluginIndex: idx });
  const issues = pluginSkillRefsExist(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'plugin-skill-refs-exist');
  assert.match(issues[0]?.message ?? '', /missing-plugin@some-marketplace/);
});

test('pluginSkillRefsExist: all declared plugins in installedIds → 0 issues', async () => {
  const idx: PluginIndex = {
    installedIds: new Set([
      'installed-plugin@some-marketplace',
      'missing-plugin@some-marketplace',
    ]),
  };
  const ctx = await loadFixture('skill-with-plugin-refs.md', { pluginIndex: idx });
  assert.deepEqual(pluginSkillRefsExist(ctx), []);
});

// --- Check 3: plugin-schedule-skill-refs-exist ---------------------------

test('pluginScheduleSkillRefsExist: non-SKILL.md file → 0 issues (self-guard)', async () => {
  const ctx = await loadFixture('skill-no-plugin-refs.md');
  assert.deepEqual(pluginScheduleSkillRefsExist(ctx), []);
});

test('pluginScheduleSkillRefsExist: SKILL.md NOT under scheduled-tasks/ → 0 issues (self-guard)', async () => {
  // Build a synthetic ctx with file=SKILL.md but filePath outside scheduled-tasks/.
  const ctx: CheckContext = {
    file: 'SKILL.md',
    filePath: '/some/random/path/SKILL.md',
    parsed: parseFrontmatter('---\nname: Foo\ndescription: bar\n---\n'),
    content: '---\nname: Foo\ndescription: bar\n---\n',
    today: TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: TEST_DEVCROW_ROOT,
  };
  assert.deepEqual(pluginScheduleSkillRefsExist(ctx), []);
});

test('pluginScheduleSkillRefsExist: valid scheduled-task SKILL.md → 0 issues', async () => {
  const ctx = await loadFixture('scheduled-tasks/sample-task/SKILL.md');
  assert.deepEqual(pluginScheduleSkillRefsExist(ctx), []);
});

test('pluginScheduleSkillRefsExist: SKILL.md missing description field → 1 warn', async () => {
  const ctx = await loadFixture('scheduled-tasks/no-desc-task/SKILL.md');
  const issues = pluginScheduleSkillRefsExist(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'plugin-schedule-skill-refs-exist');
  assert.match(issues[0]?.message ?? '', /description/);
});

test('pluginScheduleSkillRefsExist: SKILL.md with no frontmatter at all → 1 warn', async () => {
  const ctx = await loadFixture('scheduled-tasks/no-frontmatter-task/SKILL.md');
  const issues = pluginScheduleSkillRefsExist(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.match(issues[0]?.message ?? '', /no frontmatter/);
});

// --- Check 4: plugin-symlinks-resolve ------------------------------------

test('pluginSymlinksResolve: regular file (not a symlink) → 0 issues (self-guard)', async () => {
  const ctx = await loadFixture('symlink-target.md');
  assert.deepEqual(await pluginSymlinksResolve(ctx), []);
});

test('pluginSymlinksResolve: lstat fails (path missing) → 0 issues (self-guard)', async () => {
  const ctx: CheckContext = {
    file: 'nonexistent.md',
    filePath: join(FIXTURES, 'does-not-exist-12345.md'),
    parsed: { ok: true, data: {}, errors: [], body: '' },
    content: '',
    today: TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    devcrowRoot: TEST_DEVCROW_ROOT,
  };
  assert.deepEqual(await pluginSymlinksResolve(ctx), []);
});

// Symlink creation on Windows requires either Developer Mode enabled or admin
// rights. Tests below detect the capability up-front and gracefully report skip
// state. Each test creates its own symlink in a tmpdir scratch path, exercises
// the check, then cleans up.

async function canCreateSymlinks(): Promise<{ ok: boolean; reason?: string }> {
  const probe = join(tmpdir(), `cc-healer-symlink-probe-${process.pid}-${Date.now()}`);
  const linkPath = `${probe}.link`;
  try {
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, 'tgt.txt'), 'hello', 'utf-8');
    await symlink(join(probe, 'tgt.txt'), linkPath, 'file');
    await rm(linkPath, { force: true });
    await rm(probe, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    try { await rm(probe, { recursive: true, force: true }); } catch { /* swallow */ }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

test('pluginSymlinksResolve: valid symlink to non-empty file → 0 issues', async (t) => {
  const cap = await canCreateSymlinks();
  if (!cap.ok) {
    t.skip(`symlink creation unavailable (${cap.reason ?? 'unknown'}); enable Windows Developer Mode to run`);
    return;
  }
  const scratch = join(tmpdir(), `cc-healer-test-symlinks-${process.pid}-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  const target = join(scratch, 'target.md');
  const linkPath = join(scratch, 'link.md');
  await writeFile(target, '---\nname: x\ndescription: y\n---\n', 'utf-8');
  try {
    await symlink(target, linkPath, 'file');
    const ctx: CheckContext = {
      file: 'link.md',
      filePath: linkPath,
      parsed: { ok: true, data: {}, errors: [], body: '' },
      content: '',
      today: TEST_TODAY,
      env: TEST_ENV,
      cwd: TEST_CWD,
      devcrowRoot: TEST_DEVCROW_ROOT,
    };
    assert.deepEqual(await pluginSymlinksResolve(ctx), []);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('pluginSymlinksResolve: dangling symlink (target does not exist) → 1 error', async (t) => {
  const cap = await canCreateSymlinks();
  if (!cap.ok) {
    t.skip(`symlink creation unavailable (${cap.reason ?? 'unknown'})`);
    return;
  }
  const scratch = join(tmpdir(), `cc-healer-test-symlinks-${process.pid}-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  const missingTarget = join(scratch, 'absent-target.md');
  const linkPath = join(scratch, 'dangling.md');
  try {
    await symlink(missingTarget, linkPath, 'file');
    const ctx: CheckContext = {
      file: 'dangling.md',
      filePath: linkPath,
      parsed: { ok: true, data: {}, errors: [], body: '' },
      content: '',
      today: TEST_TODAY,
      env: TEST_ENV,
      cwd: TEST_CWD,
      devcrowRoot: TEST_DEVCROW_ROOT,
    };
    const issues = await pluginSymlinksResolve(ctx);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.severity, 'error');
    assert.equal(issues[0]?.check, 'plugin-symlinks-resolve');
    assert.match(issues[0]?.message ?? '', /target does not exist/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('pluginSymlinksResolve: symlink to empty file → 1 error', async (t) => {
  const cap = await canCreateSymlinks();
  if (!cap.ok) {
    t.skip(`symlink creation unavailable (${cap.reason ?? 'unknown'})`);
    return;
  }
  const scratch = join(tmpdir(), `cc-healer-test-symlinks-${process.pid}-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  const emptyTarget = join(scratch, 'empty-target.md');
  const linkPath = join(scratch, 'link-to-empty.md');
  await writeFile(emptyTarget, '', 'utf-8'); // 0 bytes
  try {
    await symlink(emptyTarget, linkPath, 'file');
    const ctx: CheckContext = {
      file: 'link-to-empty.md',
      filePath: linkPath,
      parsed: { ok: true, data: {}, errors: [], body: '' },
      content: '',
      today: TEST_TODAY,
      env: TEST_ENV,
      cwd: TEST_CWD,
      devcrowRoot: TEST_DEVCROW_ROOT,
    };
    const issues = await pluginSymlinksResolve(ctx);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.severity, 'error');
    assert.match(issues[0]?.message ?? '', /empty|0 bytes/i);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// --- Registry shape -----------------------------------------------------

test('pluginChecks registry contains all 4 checks', () => {
  assert.equal(pluginChecks.length, 4);
});

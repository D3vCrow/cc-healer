import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  settingsParses,
  settingsHookPathsExist,
  settingsHookExecutable,
  settingsPermissionShadow,
  settingsSchemaKeys,
  settingsRuleOfTwoParked,
  settingsChecks,
  scanSettings,
  type SettingsContext,
} from '../src/checks/settings.ts';

const TEST_TODAY = '2026-06-03';

// Build a settings context from an already-parsed JSON value. platform/cwd are
// injectable so the POSIX-only exec-bit check and relative-path resolution are
// testable on any host.
function ctx(
  json: unknown,
  opts?: { platform?: NodeJS.Platform; cwd?: string; home?: string },
): SettingsContext {
  return {
    file: 'settings.json',
    filePath: '/virtual/settings.json',
    content: JSON.stringify(json),
    json,
    cwd: opts?.cwd ?? process.cwd(),
    platform: opts?.platform ?? process.platform,
    today: TEST_TODAY,
    home: opts?.home,
  };
}

function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cc-healer-settings-'));
}

// --- Check 1: settings-parses ------------------------------------------

test('settingsParses: valid JSON → 0 issues', () => {
  assert.deepEqual(settingsParses('{"env":{}}', 'settings.json'), []);
});

test('settingsParses: invalid JSON → 1 error with settings-parses', () => {
  const issues = settingsParses('{ not json ', 'settings.json');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'settings-parses');
  assert.match(issues[0]?.message ?? '', /not valid JSON/);
});

test('settingsParses: leading UTF-8 BOM is tolerated → 0 issues (Windows editors prepend it)', () => {
  assert.deepEqual(settingsParses('﻿{"env":{}}', 'settings.json'), []);
});

// --- Check 5: settings-schema-keys -------------------------------------

test('settingsSchemaKeys: all known keys → 0 issues', () => {
  assert.deepEqual(settingsSchemaKeys(ctx({ env: {}, permissions: {}, hooks: {}, model: 'x' })), []);
});

test("settingsSchemaKeys: Chris's real top-level keys all validate clean (generous allowlist)", () => {
  // The exact key set from the real ~/.claude/settings.json — must not cry wolf on it.
  const real = {
    env: {},
    attribution: { commit: '' },
    permissions: {},
    hooks: {},
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    skipDangerousModePermissionPrompt: true,
    agentPushNotifEnabled: false,
    skipWorkflowUsageWarning: true,
  };
  assert.deepEqual(settingsSchemaKeys(ctx(real)), []);
});

test('settingsSchemaKeys: unknown key → 1 warn naming the key', () => {
  const issues = settingsSchemaKeys(ctx({ env: {}, permisions: {} }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'settings-schema-keys');
  assert.match(issues[0]?.message ?? '', /permisions/);
});

test('settingsSchemaKeys: multiple unknown keys → one warn each', () => {
  const issues = settingsSchemaKeys(ctx({ foo: 1, bar: 2 }));
  assert.equal(issues.length, 2);
});

test('settingsSchemaKeys: non-object JSON (array) → 0 issues (self-guard)', () => {
  assert.deepEqual(settingsSchemaKeys(ctx([1, 2, 3])), []);
});

// --- Check 4: settings-permission-shadow -------------------------------

test('settingsPermissionShadow: no permissions block → 0 issues', () => {
  assert.deepEqual(settingsPermissionShadow(ctx({ env: {} })), []);
});

test('settingsPermissionShadow: disjoint allow/deny/ask → 0 issues', () => {
  const json = {
    permissions: {
      deny: ['Read(.env)', 'Read(./secrets/**)'],
      ask: ['mcp__unity__execute'],
    },
  };
  assert.deepEqual(settingsPermissionShadow(ctx(json)), []);
});

test('settingsPermissionShadow: same rule in allow + deny → 1 warn', () => {
  const json = { permissions: { allow: ['Read(x)'], deny: ['Read(x)'] } };
  const issues = settingsPermissionShadow(ctx(json));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'settings-permission-shadow');
  assert.match(issues[0]?.message ?? '', /allow \+ deny/);
});

test('settingsPermissionShadow: rule in all three lists → 1 warn listing all', () => {
  const json = { permissions: { allow: ['Bash(x)'], deny: ['Bash(x)'], ask: ['Bash(x)'] } };
  const issues = settingsPermissionShadow(ctx(json));
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /allow \+ deny \+ ask/);
});

test('settingsPermissionShadow: non-string entries ignored', () => {
  const json = { permissions: { allow: [123, { x: 1 }], deny: [123] } };
  assert.deepEqual(settingsPermissionShadow(ctx(json)), []);
});

// --- Check 2: settings-hook-paths-exist --------------------------------

test('settingsHookPathsExist: missing file → error; env-var → info; real + bare → silent', async () => {
  const dir = await makeTempDir();
  try {
    const real = join(dir, 'real-hook.py');
    await writeFile(real, 'print(1)\n');
    const missing = join(dir, 'gone.py');
    const json = {
      hooks: {
        PreToolUse: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: `python ${real}` }, // real file → silent
              { type: 'command', command: `python ${missing}` }, // missing → error
              { type: 'command', command: 'clauditor hook pre-tool-use' }, // bare PATH binary → silent
              { type: 'command', command: 'python ${CLAUDE_DIR}/x.py' }, // env var → info
            ],
          },
        ],
      },
    };
    const issues = await settingsHookPathsExist(ctx(json));
    const errors = issues.filter((i) => i.severity === 'error');
    const infos = issues.filter((i) => i.severity === 'info');
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /gone\.py/);
    assert.equal(infos.length, 1);
    assert.match(infos[0]?.message ?? '', /unexpanded variable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settingsHookPathsExist: interpreter + arg and quoted-path-with-args both resolve a real file → silent', async () => {
  const dir = await makeTempDir();
  try {
    const real = join(dir, 'p.py');
    await writeFile(real, 'x\n');
    const json = {
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: `node ${real}` },
              { type: 'command', command: `python "${real}" --latest-session` },
            ],
          },
        ],
      },
    };
    assert.deepEqual(await settingsHookPathsExist(ctx(json)), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settingsHookPathsExist: direct missing .cmd path (no interpreter) → error', async () => {
  const json = {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'C:/nope/rule_of_two.cmd' }] }] },
  };
  const issues = await settingsHookPathsExist(ctx(json, { platform: 'win32' }));
  assert.equal(issues.filter((i) => i.severity === 'error').length, 1);
});

test('settingsHookPathsExist: no hooks block → 0 issues', async () => {
  assert.deepEqual(await settingsHookPathsExist(ctx({ env: {} })), []);
});

// --- Check 3: settings-hook-executable ---------------------------------

test('settingsHookExecutable: win32 → 0 issues (no POSIX exec bit)', async () => {
  const json = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'C:/x/y.cmd' }] }] } };
  assert.deepEqual(await settingsHookExecutable(ctx(json, { platform: 'win32' })), []);
});

test('settingsHookExecutable: posix + missing file → 0 issues (missing is paths-exist concern)', async () => {
  const json = {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/tmp/cc-healer-missing-xyz.sh' }] }] },
  };
  assert.deepEqual(await settingsHookExecutable(ctx(json, { platform: 'linux' })), []);
});

// --- scanSettings (integration) ----------------------------------------

test('scanSettings: nonexistent file → scanned 0, no issues', async () => {
  const r = await scanSettings(join(tmpdir(), 'cc-healer-no-such-settings-xyz.json'));
  assert.equal(r.scanned, 0);
  assert.deepEqual(r.issues, []);
});

test('scanSettings: invalid JSON → scanned 1, parseFailures 1, single settings-parses error', async () => {
  const dir = await makeTempDir();
  try {
    const f = join(dir, 'settings.json');
    await writeFile(f, '{ not valid json ');
    const r = await scanSettings(f);
    assert.equal(r.scanned, 1);
    assert.equal(r.parseFailures, 1);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0]?.check, 'settings-parses');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanSettings: full file exercises schema-keys + permission-shadow + hook-paths-exist together', async () => {
  const dir = await makeTempDir();
  try {
    const f = join(dir, 'settings.json');
    const missingHook = join(dir, 'gone.py');
    const settings = {
      env: {},
      foobar_typo: 1, // → settings-schema-keys warn
      permissions: { allow: ['Read(x)'], deny: ['Read(x)'] }, // → settings-permission-shadow warn
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `python ${missingHook}` }] }] }, // → paths error
    };
    await writeFile(f, JSON.stringify(settings, null, 2));
    const r = await scanSettings(f);
    assert.equal(r.scanned, 1);
    assert.equal(r.parseFailures, 0);
    const checks = r.issues.map((i) => i.check);
    assert.ok(checks.includes('settings-schema-keys'), 'expected a schema-keys warn');
    assert.ok(checks.includes('settings-permission-shadow'), 'expected a permission-shadow warn');
    assert.ok(checks.includes('settings-hook-paths-exist'), 'expected a hook-paths-exist error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Check 6: settings-rule-of-two-parked ------------------------------

// Build a fake home containing .claude/rule_of_two_tools.yaml with the given body.
// Omit `body` to leave the registry absent.
async function fakeHome(body?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'cc-healer-r2-'));
  if (body !== undefined) {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'rule_of_two_tools.yaml'), body);
  }
  return home;
}

const R2_HOOK = {
  hooks: {
    PreToolUse: [
      { matcher: '', hooks: [{ type: 'command', command: 'C:/Users/x/.claude/hooks/rule_of_two_pretool.cmd' }] },
    ],
  },
};

const NO_R2_HOOK = {
  hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'clauditor hook stop' }] }] },
};

test('settingsRuleOfTwoParked: no rule_of_two hook registered → 0 issues (silent for non-adopters)', async () => {
  const home = await fakeHome('enforce: false\n');
  try {
    assert.deepEqual(await settingsRuleOfTwoParked(ctx(NO_R2_HOOK, { home })), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('settingsRuleOfTwoParked: enforce: true, no template header → 0 issues', async () => {
  const home = await fakeHome('# live registry\nenforce: true\n\ntools:\n  mcp__x__y: {U: false}\n');
  try {
    assert.deepEqual(await settingsRuleOfTwoParked(ctx(R2_HOOK, { home })), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('settingsRuleOfTwoParked: enforce: false → 1 warn (the live DevCrow state)', async () => {
  const home = await fakeHome('# live registry\nenforce: false\n');
  try {
    const issues = await settingsRuleOfTwoParked(ctx(R2_HOOK, { home }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.check, 'settings-rule-of-two-parked');
    assert.equal(issues[0]?.severity, 'warn');
    assert.match(issues[0]?.message ?? '', /dry-run/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('settingsRuleOfTwoParked: enforce: false + seed-template header → 2 warns', async () => {
  const home = await fakeHome(
    '# Rule-of-Two flag registry — seed template.\n# Copy to ~/.claude/… and review before going live.\nenforce: false\n',
  );
  try {
    const issues = await settingsRuleOfTwoParked(ctx(R2_HOOK, { home }));
    assert.equal(issues.length, 2);
    assert.ok(issues.every((i) => i.check === 'settings-rule-of-two-parked'));
    assert.ok(issues.some((i) => /dry-run/.test(i.message)));
    assert.ok(issues.some((i) => /seed-template header/.test(i.message)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('settingsRuleOfTwoParked: commented-out enforce line does not count as the key', async () => {
  const home = await fakeHome('# enforce: true  <- example only\ntools:\n  mcp__x__y: {U: false}\n');
  try {
    const issues = await settingsRuleOfTwoParked(ctx(R2_HOOK, { home }));
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.message ?? '', /no top-level 'enforce:' key/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('settingsRuleOfTwoParked: registry file missing → 1 warn', async () => {
  const home = await fakeHome();
  try {
    const issues = await settingsRuleOfTwoParked(ctx(R2_HOOK, { home }));
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.message ?? '', /flag registry is missing/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('settingsRuleOfTwoParked: enforce: true but template header left in → 1 warn (header only)', async () => {
  const home = await fakeHome('# seed template — review before going live\nenforce: true\n');
  try {
    const issues = await settingsRuleOfTwoParked(ctx(R2_HOOK, { home }));
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.message ?? '', /seed-template header/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- registry ----------------------------------------------------------

test('settingsChecks registry contains the 5 post-parse checks', () => {
  assert.equal(settingsChecks.length, 5);
});

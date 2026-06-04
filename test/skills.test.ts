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
  neverBlockPresent,
  recommendedNextStepPresent,
  argumentHintPresent,
  skillChecks,
} from '../src/checks/skills.ts';
import type { CheckContext } from '../src/checks/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'skills');

// Pinned to a fixed date so tests stay deterministic regardless of when they run.
// Fixtures use 2025-01-01 for "stale" and 2027-01-01 for "future" relative to this.
const TEST_TODAY = '2026-05-06';

// Empty env by default — tests that need specific vars set must override via opts.env.
// Avoids the real process.env leaking into deterministic checks.
const TEST_ENV: Record<string, string | undefined> = {};

// CWD for fileRefsResolve tests. npm test runs from the cc-healer root so
// process.cwd() points at the package root — that's exactly the resolution
// surface we want body refs in fixtures to test against.
const TEST_CWD = process.cwd();
const TEST_DEVCROW_ROOT = 'F:/DevCrow/Dev';

async function loadFixture(
  name: string,
  opts?: {
    today?: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
    workspaceRoot?: string;
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
    workspaceRoot: opts?.workspaceRoot ?? TEST_DEVCROW_ROOT,
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

// --- devcrow-tier-set (impl) -------------------------------------------

test('devcrowTierSet: clean fixture (tier: light) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(devcrowTierSet(ctx), []);
});

test('devcrowTierSet: devcrow-block-valid (tier: heavy) → 0 issues', async () => {
  const ctx = await loadFixture('devcrow-block-valid.md');
  assert.deepEqual(devcrowTierSet(ctx), []);
});

test('devcrowTierSet: devcrow-tier-missing (no tier field) → 1 error issue', async () => {
  const ctx = await loadFixture('devcrow-tier-missing.md');
  const issues = devcrowTierSet(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'devcrow-tier-set');
  assert.match(issues[0]?.message ?? '', /missing/);
});

test('devcrowTierSet: devcrow-tier-invalid (tier: medium) → 1 error issue', async () => {
  const ctx = await loadFixture('devcrow-tier-invalid.md');
  const issues = devcrowTierSet(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.check, 'devcrow-tier-set');
  assert.match(issues[0]?.message ?? '', /medium/);
});

test('devcrowTierSet: legacy fixture (no devcrow block) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('legacy.md');
  assert.deepEqual(devcrowTierSet(ctx), []);
});

test('devcrowTierSet: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(devcrowTierSet(ctx), []);
});

// --- legacy-no-devcrow (impl) ------------------------------------------

test('legacyNoDevcrow: clean fixture (has devcrow block) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(legacyNoDevcrow(ctx), []);
});

test('legacyNoDevcrow: legacy fixture (no devcrow block) → 1 info issue', async () => {
  const ctx = await loadFixture('legacy.md');
  const issues = legacyNoDevcrow(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'info');
  assert.equal(issues[0]?.check, 'legacy-no-devcrow');
});

test('legacyNoDevcrow: devcrow-block-valid fixture → 0 issues', async () => {
  const ctx = await loadFixture('devcrow-block-valid.md');
  assert.deepEqual(legacyNoDevcrow(ctx), []);
});

test('legacyNoDevcrow: missing-description fixture (no devcrow either) → 1 info issue', async () => {
  // missing-description has frontmatter (just no description), so it's still a skill — and a legacy one.
  const ctx = await loadFixture('missing-description.md');
  const issues = legacyNoDevcrow(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'info');
});

test('legacyNoDevcrow: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(legacyNoDevcrow(ctx), []);
});

// --- verify-by-past (impl) ---------------------------------------------

test('verifyByPast: clean fixture (verify_by 2027-01-01, future) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(verifyByPast(ctx), []);
});

test('verifyByPast: stale-verify-by fixture (verify_by 2025-01-01, past) → 1 info issue', async () => {
  const ctx = await loadFixture('stale-verify-by.md');
  const issues = verifyByPast(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'info');
  assert.equal(issues[0]?.check, 'verify-by-past');
  assert.match(issues[0]?.message ?? '', /2025-01-01/);
});

test('verifyByPast: devcrow-block-valid (verify_by 2027-01-01, future) → 0 issues', async () => {
  const ctx = await loadFixture('devcrow-block-valid.md');
  assert.deepEqual(verifyByPast(ctx), []);
});

test('verifyByPast: legacy fixture (no devcrow block) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('legacy.md');
  assert.deepEqual(verifyByPast(ctx), []);
});

test('verifyByPast: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(verifyByPast(ctx), []);
});

test('verifyByPast: stale fixture treated as future when today is pinned earlier', async () => {
  // Pin today to 2024-01-01: 2025-01-01 is then future, no flag.
  const ctx = await loadFixture('stale-verify-by.md', { today: '2024-01-01' });
  assert.deepEqual(verifyByPast(ctx), []);
});

// --- declared-env-set (impl) -------------------------------------------

test('declaredEnvSet: clean fixture (no requires.env) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(declaredEnvSet(ctx), []);
});

test('declaredEnvSet: devcrow-block-valid (requires.env: [HOME]) with HOME set → 0 issues', async () => {
  const ctx = await loadFixture('devcrow-block-valid.md', { env: { HOME: '/home/user' } });
  assert.deepEqual(declaredEnvSet(ctx), []);
});

test('declaredEnvSet: devcrow-block-valid (requires.env: [HOME]) with empty env → 1 warn', async () => {
  const ctx = await loadFixture('devcrow-block-valid.md');
  const issues = declaredEnvSet(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'declared-env-set');
  assert.match(issues[0]?.message ?? '', /HOME/);
});

test('declaredEnvSet: devcrow-env-required (2 vars) all set → 0 issues', async () => {
  const ctx = await loadFixture('devcrow-env-required.md', {
    env: { BOGUS_TEST_ENV_VAR_A: 'x', BOGUS_TEST_ENV_VAR_B: 'y' },
  });
  assert.deepEqual(declaredEnvSet(ctx), []);
});

test('declaredEnvSet: devcrow-env-required (2 vars) all unset → 2 warns', async () => {
  const ctx = await loadFixture('devcrow-env-required.md');
  const issues = declaredEnvSet(ctx);
  assert.equal(issues.length, 2);
  assert.equal(issues.every((i) => i.severity === 'warn'), true);
});

test('declaredEnvSet: devcrow-env-required (1 of 2 set) → 1 warn for the missing one', async () => {
  const ctx = await loadFixture('devcrow-env-required.md', {
    env: { BOGUS_TEST_ENV_VAR_A: 'x' },
  });
  const issues = declaredEnvSet(ctx);
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /BOGUS_TEST_ENV_VAR_B/);
});

test('declaredEnvSet: devcrow-env-required with empty-string env value → 1 warn (treated as unset)', async () => {
  const ctx = await loadFixture('devcrow-env-required.md', {
    env: { BOGUS_TEST_ENV_VAR_A: '', BOGUS_TEST_ENV_VAR_B: 'y' },
  });
  const issues = declaredEnvSet(ctx);
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /BOGUS_TEST_ENV_VAR_A/);
});

test('declaredEnvSet: legacy fixture (no devcrow block) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('legacy.md');
  assert.deepEqual(declaredEnvSet(ctx), []);
});

test('declaredEnvSet: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(declaredEnvSet(ctx), []);
});

// --- declared-binary-resolvable (impl, async) --------------------------

test('declaredBinaryResolvable: clean fixture (no requires.binaries) → 0 issues', async () => {
  const ctx = await loadFixture('clean.md');
  assert.deepEqual(await declaredBinaryResolvable(ctx), []);
});

test('declaredBinaryResolvable: devcrow-block-valid (requires.binaries: [git, node]) → 0 issues (both must be on PATH for cc-healer to even run)', async () => {
  const ctx = await loadFixture('devcrow-block-valid.md');
  assert.deepEqual(await declaredBinaryResolvable(ctx), []);
});

test('declaredBinaryResolvable: devcrow-bin-required (2 bogus bins) → 2 warns', async () => {
  const ctx = await loadFixture('devcrow-bin-required.md');
  const issues = await declaredBinaryResolvable(ctx);
  assert.equal(issues.length, 2);
  assert.equal(issues.every((i) => i.severity === 'warn'), true);
  assert.equal(issues.every((i) => i.check === 'declared-binary-resolvable'), true);
});

test('declaredBinaryResolvable: legacy fixture (no devcrow block) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('legacy.md');
  assert.deepEqual(await declaredBinaryResolvable(ctx), []);
});

test('declaredBinaryResolvable: broken-yaml (parse failed) → 0 issues (self-guarded)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(await declaredBinaryResolvable(ctx), []);
});

// --- file-refs-resolve (impl, async) -----------------------------------

test('fileRefsResolve: legacy fixture (no Spec / Shared patterns lines) → 0 issues', async () => {
  const ctx = await loadFixture('legacy.md');
  assert.deepEqual(await fileRefsResolve(ctx), []);
});

test('fileRefsResolve: body-with-refs → 1 warn (bogus path; valid + duplicate refs ignored)', async () => {
  const ctx = await loadFixture('body-with-refs.md');
  const issues = await fileRefsResolve(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'file-refs-resolve');
  assert.match(issues[0]?.message ?? '', /bogus-path-XYZ/);
});

test('fileRefsResolve: broken-yaml (parse failed) → 0 issues (self-guarded, no body to scan)', async () => {
  const ctx = await loadFixture('broken-yaml.md');
  assert.deepEqual(await fileRefsResolve(ctx), []);
});

test('fileRefsResolve: refs deduplicate (backtick-wrapped duplicate of valid path counts once)', async () => {
  // body-with-refs.md has the same valid target referenced twice (plain + backtick-wrapped).
  // Second occurrence should not surface a duplicate warn for the bogus one either.
  const ctx = await loadFixture('body-with-refs.md');
  const issues = await fileRefsResolve(ctx);
  // Exactly one issue (for the bogus path); backtick-wrapped valid path doesn't double-count.
  assert.equal(issues.length, 1);
});

// --- Phase 1 stubs: registry sanity ------------------------------------
// (No remaining stubs — all 9 checks are implemented.)

const stubs: ReadonlyArray<readonly [string, (ctx: CheckContext) => unknown]> = [];

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

// --- skill-structure footer checks (Phase 1A) --------------------------
//
// Inline content (no fixture files) — these checks scan body structure, so
// constructing the .md text in-test is clearer than a fixture per case.

function ctxFrom(content: string, file = 'inline.md'): CheckContext {
  return {
    file,
    filePath: join(FIXTURES, file),
    parsed: parseFrontmatter(content),
    content,
    today: TEST_TODAY,
    env: TEST_ENV,
    cwd: TEST_CWD,
    workspaceRoot: TEST_DEVCROW_ROOT,
  };
}

const SKILL_WITH_FOOTERS = [
  '---',
  'description: A skill',
  'argument-hint: "[topic]"',
  '---',
  '',
  'Do the thing with $ARGUMENTS.',
  '',
  '**NEVER**:',
  '- Never skip the thing.',
  '',
  '### Recommended Next Step',
  'Terminal.',
  '',
].join('\n');

// --- never-block-present ------------------------------------------------

test('neverBlockPresent: skill with **NEVER** block → 0 issues', () => {
  assert.deepEqual(neverBlockPresent(ctxFrom(SKILL_WITH_FOOTERS)), []);
});

test('neverBlockPresent: skill without **NEVER** block → 1 warn', () => {
  const content = '---\ndescription: A skill\n---\n\nBody only, no anti-rules.\n';
  const issues = neverBlockPresent(ctxFrom(content));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'never-block-present');
});

test('neverBlockPresent: no frontmatter → 0 issues (not a skill)', () => {
  assert.deepEqual(neverBlockPresent(ctxFrom('Just a plain markdown doc.\n')), []);
});

test('neverBlockPresent: colon-inside form **NEVER:** counts (regression: 4 false positives)', () => {
  const content = '---\ndescription: A skill\n---\n\nBody.\n\n**NEVER:**\n- Never X.\n';
  assert.deepEqual(neverBlockPresent(ctxFrom(content)), []);
});

test('neverBlockPresent: **NEVER** only inside frontmatter does not count (body is scanned)', () => {
  const content = '---\ndescription: "**NEVER** in desc"\n---\n\nNo footer here.\n';
  const issues = neverBlockPresent(ctxFrom(content));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.check, 'never-block-present');
});

// --- recommended-next-step-present --------------------------------------

test('recommendedNextStepPresent: skill with section → 0 issues', () => {
  assert.deepEqual(recommendedNextStepPresent(ctxFrom(SKILL_WITH_FOOTERS)), []);
});

test('recommendedNextStepPresent: skill without section → 1 warn', () => {
  const content = '---\ndescription: A skill\n---\n\nBody only.\n\n**NEVER**:\n- Never X.\n';
  const issues = recommendedNextStepPresent(ctxFrom(content));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'recommended-next-step-present');
});

test('recommendedNextStepPresent: no frontmatter → 0 issues (not a skill)', () => {
  assert.deepEqual(recommendedNextStepPresent(ctxFrom('Plain doc.\n')), []);
});

// --- argument-hint-present ----------------------------------------------

test('argumentHintPresent: $ARGUMENTS + argument-hint → 0 issues', () => {
  assert.deepEqual(argumentHintPresent(ctxFrom(SKILL_WITH_FOOTERS)), []);
});

test('argumentHintPresent: $ARGUMENTS without argument-hint → 1 warn', () => {
  const content = '---\ndescription: A skill\n---\n\nUses $ARGUMENTS but no hint.\n';
  const issues = argumentHintPresent(ctxFrom(content));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warn');
  assert.equal(issues[0]?.check, 'argument-hint-present');
});

test('argumentHintPresent: bracket-style hint (parses as flow array) → 0 issues (regression: live false-positive)', () => {
  const content = '---\ndescription: A skill\nargument-hint: [optional topic hint]\n---\n\nUses $ARGUMENTS.\n';
  assert.deepEqual(argumentHintPresent(ctxFrom(content)), []);
});

test('argumentHintPresent: no $ARGUMENTS → 0 issues (even without hint)', () => {
  const content = '---\ndescription: A skill\n---\n\nNo placeholder here.\n';
  assert.deepEqual(argumentHintPresent(ctxFrom(content)), []);
});

test('argumentHintPresent: empty-string argument-hint with $ARGUMENTS → 1 warn (treated as unset)', () => {
  const content = '---\ndescription: A skill\nargument-hint: ""\n---\n\nUses $ARGUMENTS.\n';
  const issues = argumentHintPresent(ctxFrom(content));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.check, 'argument-hint-present');
});

// --- registry shape -----------------------------------------------------

test('skillChecks registry contains all 12 checks', () => {
  assert.equal(skillChecks.length, 12);
});

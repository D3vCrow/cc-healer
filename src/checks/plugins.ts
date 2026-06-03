// Plugin-tier checks (Tier 4).
//
// Implements §"Tier 4: plugin / install integrity" of docs/cc-healer-v1-spec.md.
// Four checks per spec table:
//   1. plugin-install-registry-consistent — installPath in installed_plugins.json exists
//   2. plugin-skill-refs-exist             — devcrow.requires.plugins all installed
//   3. plugin-schedule-skill-refs-exist    — scheduled-tasks/<name>/SKILL.md has valid skill frontmatter
//   4. plugin-symlinks-resolve             — symlinks under skill/hook trees resolve to non-empty real files
//
// Symlink check rationale: anchored to santifer/career-ops issue #596 (2026-05-07) —
// v1.7.0 of that project shipped a dangling symlink at .claude/skills/career-ops/SKILL.md,
// the project's doctor.mjs (10 checks, none symlink-aware) returned green, and every
// user who ran `node update-system.mjs apply` got a broken skill silently. cc-healer
// must close this gap by default — the point is being the doctor that catches what
// other doctors miss. See knowledge/research/2026-05-08-vet-santifer-career-ops.md
// §"Anti-patterns" #1.
//
// Architecture: each check is per-file and self-guards on its precondition (file basename
// pattern, frontmatter shape, or pluginIndex presence). The runner walks plugin-tier
// files and calls every check on every file unconditionally; misses on precondition
// return [].

import { access, lstat, readFile, readlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename } from 'node:path';

import type { Issue } from '../types.js';
import type { Check, CheckContext, PluginIndex } from './types.js';

const SKILL_REQUIRED_FIELDS = ['description'] as const;

const SCHEDULED_TASKS_SEGMENT = 'scheduled-tasks';

// installPaths in installed_plugins.json are Windows-shaped strings with double
// backslashes (e.g. "C:\\Users\\Christophoros\\.claude\\plugins\\cache\\..."). Node's
// fs.access tolerates either separator on Windows, so no normalization needed.

interface InstalledPluginRecord {
  installPath?: unknown;
}

interface InstalledPluginsRegistry {
  version?: unknown;
  plugins?: Record<string, unknown>;
}

// --- Index builder ------------------------------------------------------

/**
 * Build the plugin-tier cross-file index from `<target>/installed_plugins.json`.
 * installedIds = the registry's `plugins` object keys (each a `<plugin>@<marketplace>`
 * id, e.g. `watch@claude-video`). Consumed by plugin-skill-refs-exist via
 * CheckContext.pluginIndex.
 *
 * A missing registry → empty set (consumer self-guards on absence). A malformed
 * registry → empty set too; plugin-install-registry-consistent owns reporting the
 * parse error, so the index stays silent rather than double-reporting.
 *
 * Mirrors buildMemoryIndexes (src/memory-indexes.ts): one pre-pass per scan, before
 * per-file checks run.
 */
export async function buildPluginIndex(target: string): Promise<PluginIndex> {
  const installedIds = new Set<string>();
  let content: string;
  try {
    content = await readFile(join(target, 'installed_plugins.json'), 'utf-8');
  } catch {
    return { installedIds };
  }
  try {
    const parsed = JSON.parse(content) as InstalledPluginsRegistry;
    if (parsed && typeof parsed.plugins === 'object' && parsed.plugins !== null) {
      for (const id of Object.keys(parsed.plugins)) installedIds.add(id);
    }
  } catch {
    // malformed → empty set; plugin-install-registry-consistent reports the parse error
  }
  return { installedIds };
}

// --- Check 1: plugin-install-registry-consistent ------------------------

/**
 * Each installed plugin record in `installed_plugins.json` must have an
 * `installPath` that exists on disk. Bidirectional consistency (plugin dir
 * present but not in registry) is V1.5 territory — V1 catches the more common
 * "registry claims X is installed but the path is gone" drift.
 * Severity: error.
 * Source: cc-healer V1 spec Tier 4 row "Plugin install registry consistent with installed skill files".
 *
 * Self-guard: fires only when `basename(ctx.file) === 'installed_plugins.json'`.
 */
export const pluginInstallRegistryConsistent: Check = async (ctx) => {
  if (basename(ctx.file) !== 'installed_plugins.json') return [];

  let parsed: InstalledPluginsRegistry;
  try {
    parsed = JSON.parse(ctx.content) as InstalledPluginsRegistry;
  } catch (err) {
    return [
      {
        severity: 'error',
        check: 'plugin-install-registry-consistent',
        file: ctx.file,
        message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  if (typeof parsed !== 'object' || parsed === null || typeof parsed.plugins !== 'object' || parsed.plugins === null) {
    return [
      {
        severity: 'error',
        check: 'plugin-install-registry-consistent',
        file: ctx.file,
        message: `unexpected registry shape: missing top-level 'plugins' object`,
      },
    ];
  }

  const issues: Issue[] = [];
  for (const [pluginId, recordsRaw] of Object.entries(parsed.plugins)) {
    if (!Array.isArray(recordsRaw)) {
      issues.push({
        severity: 'error',
        check: 'plugin-install-registry-consistent',
        file: ctx.file,
        message: `${pluginId}: expected array of install records, got ${typeof recordsRaw}`,
      });
      continue;
    }
    for (let i = 0; i < recordsRaw.length; i++) {
      const record = recordsRaw[i] as InstalledPluginRecord | null | undefined;
      if (typeof record !== 'object' || record === null) {
        issues.push({
          severity: 'error',
          check: 'plugin-install-registry-consistent',
          file: ctx.file,
          message: `${pluginId}[${i}]: install record is not an object`,
        });
        continue;
      }
      if (typeof record.installPath !== 'string' || record.installPath.length === 0) {
        issues.push({
          severity: 'error',
          check: 'plugin-install-registry-consistent',
          file: ctx.file,
          message: `${pluginId}[${i}]: missing or empty installPath`,
        });
        continue;
      }
      try {
        await access(record.installPath);
      } catch {
        issues.push({
          severity: 'error',
          check: 'plugin-install-registry-consistent',
          file: ctx.file,
          message: `${pluginId}[${i}]: installPath '${record.installPath}' does not exist`,
        });
      }
    }
  }
  return issues;
};

// --- Check 2: plugin-skill-refs-exist -----------------------------------

/**
 * If a skill frontmatter declares `devcrow.requires.plugins: [<id>, ...]`, each
 * declared plugin id must appear in `ctx.pluginIndex.installedIds`.
 * Severity: warn.
 * Source: cc-healer V1 spec Tier 4 row "Skill files reference existing plugin".
 *
 * Self-guard:
 *   - pluginIndex undefined  → [] (scanner did not build a plugin index)
 *   - parse failed           → [] (parse-error checks own that)
 *   - no devcrow block       → [] (legacy-no-devcrow owns that)
 *   - no requires.plugins    → [] (nothing to validate)
 *
 * Schema note: the `devcrow.requires.plugins` field is shape-reserved for V1.5.
 * Until skill authors start declaring it, this check is effectively dormant —
 * but the shape is correct and the wiring is in place.
 */
export const pluginSkillRefsExist: Check = (ctx) => {
  if (!ctx.pluginIndex) return [];
  if (!ctx.parsed.ok) return [];
  const dc = ctx.parsed.data.devcrow;
  if (typeof dc !== 'object' || dc === null) return [];
  const requires = (dc as Record<string, unknown>).requires;
  if (typeof requires !== 'object' || requires === null) return [];
  const plugins = (requires as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) return [];

  const issues: Issue[] = [];
  for (const pid of plugins) {
    if (typeof pid !== 'string' || pid.length === 0) continue;
    if (!ctx.pluginIndex.installedIds.has(pid)) {
      issues.push({
        severity: 'warn',
        check: 'plugin-skill-refs-exist',
        file: ctx.file,
        message: `devcrow.requires.plugins: '${pid}' not in installed_plugins.json`,
      });
    }
  }
  return issues;
};

// --- Check 3: plugin-schedule-skill-refs-exist --------------------------

/**
 * Each `scheduled-tasks/<name>/SKILL.md` must be a valid skill (parseable
 * frontmatter with at least a description field). Empty / unparseable / bare
 * scheduled-task entries silently fail at runtime when the scheduler tries to
 * load them — surface here.
 * Severity: warn.
 * Source: cc-healer V1 spec Tier 4 row "Schedule task entries reference valid skills".
 *
 * Self-guard: fires when ctx.filePath contains a `scheduled-tasks/` (or
 * `scheduled-tasks\`) segment AND basename is `SKILL.md`. Other files no-op.
 *
 * Scope note: V1 validates skill-shape only (parseable + description present).
 * Body-reference parsing ("the task body invokes /_foo, does /_foo exist?")
 * is V1.5 — currently a separate Tier 1 concern (file-refs-resolve handles
 * Spec/Shared-patterns lines; arbitrary slash-invocation parsing is broader).
 */
export const pluginScheduleSkillRefsExist: Check = (ctx) => {
  if (basename(ctx.file) !== 'SKILL.md') return [];
  // Cross-platform segment match: scheduled-tasks/<name>/SKILL.md OR scheduled-tasks\<name>\SKILL.md.
  const normalized = ctx.filePath.replace(/\\/g, '/');
  if (!normalized.includes(`/${SCHEDULED_TASKS_SEGMENT}/`)) return [];

  if (!ctx.parsed.ok) {
    return [
      {
        severity: 'warn',
        check: 'plugin-schedule-skill-refs-exist',
        file: ctx.file,
        message: `scheduled-task SKILL.md has unparseable frontmatter (${ctx.parsed.errors.join('; ')})`,
      },
    ];
  }
  if (Object.keys(ctx.parsed.data).length === 0) {
    return [
      {
        severity: 'warn',
        check: 'plugin-schedule-skill-refs-exist',
        file: ctx.file,
        message: `scheduled-task SKILL.md has no frontmatter`,
      },
    ];
  }

  const issues: Issue[] = [];
  for (const field of SKILL_REQUIRED_FIELDS) {
    if (!(field in ctx.parsed.data)) {
      issues.push({
        severity: 'warn',
        check: 'plugin-schedule-skill-refs-exist',
        file: ctx.file,
        message: `scheduled-task SKILL.md missing required field: ${field}`,
      });
    }
  }
  return issues;
};

// --- Check 4: plugin-symlinks-resolve -----------------------------------

/**
 * Any symlink under the scan target must resolve to a non-empty real file.
 * Catches the career-ops #596 failure mode: dangling symlink, doctor returns
 * green, user gets silent broken skill.
 * Severity: error.
 * Source: cc-healer V1 spec Tier 4 row "Symlinks under .claude/skills/**\/*.md
 * and .claude/hooks/** resolve to non-empty files" — anchored to santifer/career-ops#596.
 *
 * Self-guard: fires on every file. If the path is a regular file (not a
 * symlink), returns []. If lstat fails (path doesn't exist), returns [] —
 * file-existence is the scanner's concern.
 *
 * Resolves the link relative to the link's own directory when target is
 * a relative path (the same shape git checkout uses). Surfaces three distinct
 * failure modes: unreadable link, broken target, empty target.
 */
export const pluginSymlinksResolve: Check = async (ctx) => {
  let lst;
  try {
    lst = await lstat(ctx.filePath);
  } catch {
    return [];
  }
  if (!lst.isSymbolicLink()) return [];

  let target: string;
  try {
    target = await readlink(ctx.filePath);
  } catch (err) {
    return [
      {
        severity: 'error',
        check: 'plugin-symlinks-resolve',
        file: ctx.file,
        message: `symlink unreadable: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  const absoluteTarget = isAbsolute(target) ? target : join(dirname(ctx.filePath), target);

  let targetStat;
  try {
    targetStat = await stat(absoluteTarget);
  } catch {
    return [
      {
        severity: 'error',
        check: 'plugin-symlinks-resolve',
        file: ctx.file,
        message: `symlink target does not exist: ${target}`,
      },
    ];
  }
  if (!targetStat.isFile()) {
    return [
      {
        severity: 'error',
        check: 'plugin-symlinks-resolve',
        file: ctx.file,
        message: `symlink target is not a regular file: ${target}`,
      },
    ];
  }
  if (targetStat.size === 0) {
    return [
      {
        severity: 'error',
        check: 'plugin-symlinks-resolve',
        file: ctx.file,
        message: `symlink target is empty (0 bytes): ${target}`,
      },
    ];
  }

  // Defensive double-check: target exists, is a file, has non-zero size. Read
  // first byte to confirm readability (catches permission-denied edge cases).
  try {
    const handle = await readFile(absoluteTarget, { encoding: null });
    if (handle.length === 0) {
      return [
        {
          severity: 'error',
          check: 'plugin-symlinks-resolve',
          file: ctx.file,
          message: `symlink target reads as empty: ${target}`,
        },
      ];
    }
  } catch (err) {
    return [
      {
        severity: 'error',
        check: 'plugin-symlinks-resolve',
        file: ctx.file,
        message: `symlink target unreadable: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
  return [];
};

// --- Registry -----------------------------------------------------------

export const pluginChecks: ReadonlyArray<Check> = [
  pluginInstallRegistryConsistent,
  pluginSkillRefsExist,
  pluginScheduleSkillRefsExist,
  pluginSymlinksResolve,
];

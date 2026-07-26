#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter } from './parser/frontmatter.js';
import { skillChecks, memoryChecks, knowledgeChecks } from './checks/index.js';
import { scanSettings } from './checks/settings.js';
import { pluginChecks, buildPluginIndex } from './checks/plugins.js';
import { buildMemoryIndexes } from './memory-indexes.js';
import { buildKnowledgeIndex } from './knowledge-indexes.js';
import { proposeFixes, applyProposals } from './fix/index.js';
import type {
  Check,
  CheckContext,
  KnowledgeIndex,
  MemoryIndexes,
  PluginIndex,
} from './checks/index.js';
import type { Issue, CheckReport } from './types.js';
import type { FixResult } from './fix/index.js';

const VERSION = '0.0.1';

// Workspace root resolution: explicit `--workspace <dir>` › `CC_HEALER_WORKSPACE`
// env › `process.cwd()`. The root is the second resolution candidate for memory/
// knowledge refs and the search base for the fix-engine (replaced a hardcoded
// workspace literal). Normalized to forward slashes so a cwd-derived root on Windows
// (`C:\X\Y`) is byte-identical to that literal when run from the workspace root —
// keeping project-slug derivation (cwdToProjectSlug) and ref display stable.
function resolveWorkspaceRoot(args: string[]): string {
  const wsIdx = args.indexOf('--workspace');
  const fromFlag = wsIdx !== -1 ? args[wsIdx + 1] : undefined;
  const raw = fromFlag ?? process.env.CC_HEALER_WORKSPACE ?? process.cwd();
  return expandTilde(raw).replace(/\\/g, '/');
}

// Remove `--flag <value>` (the flag plus its following token) from an args list.
// Used to drop `--workspace <dir>` before positional-path detection — its value is
// not dash-prefixed and would otherwise be picked up as the scan target.
function stripFlagWithValue(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag);
  return idx === -1 ? args : [...args.slice(0, idx), ...args.slice(idx + 2)];
}

function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    return p.replace(/^~/, homedir());
  }
  return p;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`cc-healer ${VERSION}
Claude Code workspace health-check.

Usage:
  cc-healer <path>                  scan a dir of .md files (skill checks)
  cc-healer --tier skills [path]    scan ~/.claude/commands (Tier 1, default)
  cc-healer --tier memory [path]    scan ~/.claude/projects/<cwd-slug>/memory (Tier 2, default)
  cc-healer --tier knowledge [path] scan <workspace>/knowledge recursively (KB tier, default)
  cc-healer --tier settings [path]  scan ~/.claude/settings.json (Tier 3, default)
  cc-healer --tier plugins [path]   scan ~/.claude/plugins recursively (Tier 4, default)
  cc-healer --tier <t> --json       emit findings as JSON (machine-readable)
  cc-healer --tier memory --fix     propose fixes for resolvable findings (propose-only)
  cc-healer --tier memory --fix --write   apply the proposed fixes to disk
  cc-healer --workspace <dir> ...   set workspace root for knowledge/cross-ref resolution
  cc-healer --version               print version
  cc-healer --help                  this message

Tiers:
  skills    — Tier 1, ~/.claude/commands (9 checks live)
  memory    — Tier 2, ~/.claude/projects/<slug>/memory (9 checks live)
  knowledge — KB tier, <workspace>/knowledge recursive (3 checks live)
  settings  — Tier 3, ~/.claude/settings.json (5 checks live)
  plugins   — Tier 4, ~/.claude/plugins recursive (4 checks live)

Workspace root (knowledge tier target + cross-tier ref base) resolves as:
  --workspace <dir>  ›  CC_HEALER_WORKSPACE env  ›  process.cwd()
Memory tier default path is derived from process.cwd() (Windows: F:\\X\\Y → F--X-Y).
Run from project root for the defaults to resolve, or pass an explicit path/--workspace.`);
}

type TierConfig = {
  target: string;
  checks: ReadonlyArray<Check>;
  skipFiles?: ReadonlySet<string>;
  skipDirs?: ReadonlySet<string>;       // basenames to not descend into (recursive scans)
  recursive?: boolean;                  // walk sub-directories (default: flat, like memory/skills)
  extraFiles?: ReadonlySet<string>;     // non-.md basenames to also collect (plugins: installed_plugins.json)
  buildIndexes?: (target: string) => Promise<MemoryIndexes>;
  buildKnowledgeIndex?: (target: string) => Promise<KnowledgeIndex>;
  buildPluginIndex?: (target: string) => Promise<PluginIndex>;
  // Single-file tiers (settings) supply their own scan instead of the generic
  // .md-directory scanDir walk. When present, main() calls this and ignores `checks`.
  scan?: (target: string) => Promise<CheckReport>;
};

function cwdToProjectSlug(cwd: string): string {
  // Claude Code project dir naming: drive letter + double-dash + path-with-dashes.
  // C:\Users\you\proj → C--Users-you-proj (also handles forward-slash form).
  return cwd.replace(/^([A-Za-z]):/, '$1-').replace(/[\\/]/g, '-');
}

function resolveTier(tier: string, workspaceRoot: string): TierConfig | null {
  switch (tier) {
    case 'skills':
      return {
        target: expandTilde('~/.claude/commands'),
        checks: skillChecks,
      };
    case 'memory':
      return {
        target: expandTilde(`~/.claude/projects/${cwdToProjectSlug(process.cwd())}/memory`),
        checks: memoryChecks,
        // DEEP-INDEX.md stays skipped (no hot-tier check fires on it per design spec §4.4);
        // MEMORY.md is scanned so memory-hot-tier-entry-shape runs against it (filename-gated).
        skipFiles: new Set(['DEEP-INDEX.md']),
        buildIndexes: buildMemoryIndexes,
      };
    case 'knowledge':
      return {
        target: join(workspaceRoot, 'knowledge'),
        checks: knowledgeChecks,
        recursive: true,
        // raw/ holds immutable user-curated source artifacts (never re-verified);
        // _TEMPLATE.md is a placeholder doc, not a real KB entry.
        skipDirs: new Set(['raw']),
        skipFiles: new Set(['_TEMPLATE.md']),
        buildKnowledgeIndex,
      };
    case 'settings':
      return {
        target: expandTilde('~/.claude/settings.json'),
        checks: [], // unused — single-file tier runs via scan, not scanDir
        scan: scanSettings,
      };
    case 'plugins':
      return {
        target: expandTilde('~/.claude/plugins'),
        checks: pluginChecks,
        recursive: true,
        // marketplaces/ holds catalog clones (~as many .md as cache/) for plugins that
        // aren't installed — out of "install integrity" scope; cache/ is the installed set.
        skipDirs: new Set(['marketplaces']),
        // installed_plugins.json isn't .md but plugin-install-registry-consistent must see it.
        extraFiles: new Set(['installed_plugins.json']),
        buildPluginIndex,
      };
    default:
      return null;
  }
}

// Collect .md files under `target`. Flat by default (one dir — matches the
// memory/skills tiers); when recursive, descends into sub-dirs, skipping any in
// skipDirs and dot-dirs. Returns each file's basename (for skip-list + filename-
// gated checks), absolute path, and a forward-slash path relative to target —
// the display name, which for nested tiers disambiguates e.g. decisions/foo.md
// from discoveries/foo.md. stat (not Dirent) preserves the original
// symlink-following isFile() semantics the flat scan relied on.
async function collectMarkdownFiles(
  target: string,
  opts: {
    recursive?: boolean;
    skipFiles?: ReadonlySet<string>;
    skipDirs?: ReadonlySet<string>;
    extraFiles?: ReadonlySet<string>; // non-.md basenames to also collect (e.g. installed_plugins.json)
  },
): Promise<{ name: string; fullPath: string; relPath: string }[]> {
  const out: { name: string; fullPath: string; relPath: string }[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const fullPath = join(dir, name);
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (name.endsWith('.md') || opts.extraFiles?.has(name)) {
        if (opts.skipFiles?.has(name)) continue;
        let s;
        try {
          s = await stat(fullPath);
        } catch {
          continue;
        }
        if (s.isFile()) out.push({ name, fullPath, relPath });
        continue;
      }
      // Non-.md entry: only relevant when recursing, and only if it's a dir.
      if (!opts.recursive) continue;
      if (opts.skipDirs?.has(name) || name.startsWith('.')) continue;
      let s;
      try {
        s = await stat(fullPath);
      } catch {
        continue;
      }
      if (s.isDirectory()) await walk(fullPath, relPath);
    }
  }

  await walk(target, '');
  return out;
}

async function scanDir(
  target: string,
  opts: {
    checks: ReadonlyArray<Check>;
    workspaceRoot: string;                  // workspace root threaded into CheckContext
    skipFiles?: ReadonlySet<string>;
    skipDirs?: ReadonlySet<string>;
    recursive?: boolean;
    extraFiles?: ReadonlySet<string>;
    buildIndexes?: (target: string) => Promise<MemoryIndexes>;
    buildKnowledgeIndex?: (target: string) => Promise<KnowledgeIndex>;
    buildPluginIndex?: (target: string) => Promise<PluginIndex>;
  },
): Promise<CheckReport> {
  const start = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const cwd = process.cwd();
  const workspaceRoot = opts.workspaceRoot;
  const issues: Issue[] = [];
  let scanned = 0;
  let withFrontmatter = 0;
  let parseFailures = 0;

  const files = await collectMarkdownFiles(target, {
    recursive: opts.recursive,
    skipFiles: opts.skipFiles,
    skipDirs: opts.skipDirs,
    extraFiles: opts.extraFiles,
  });

  // Build cross-file indexes once per scan, before per-file checks. Each no-ops for
  // tiers that don't supply the matching builder: memory → indexes, knowledge →
  // knowledgeIndex, plugins → pluginIndex; skills / settings supply none.
  const indexes = opts.buildIndexes ? await opts.buildIndexes(target) : undefined;
  const knowledgeIndex = opts.buildKnowledgeIndex
    ? await opts.buildKnowledgeIndex(target)
    : undefined;
  const pluginIndex = opts.buildPluginIndex ? await opts.buildPluginIndex(target) : undefined;

  for (const { fullPath, relPath } of files) {
    scanned++;

    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      issues.push({
        severity: 'error',
        check: 'file-readable',
        file: relPath,
        message: 'failed to read file',
      });
      continue;
    }

    const result = parseFrontmatter(content);
    const ctx: CheckContext = {
      file: relPath,
      filePath: fullPath,
      parsed: result,
      content,
      today,
      env: process.env,
      cwd,
      workspaceRoot,
      indexes,
      knowledgeIndex,
      pluginIndex,
    };

    if (!result.ok) {
      parseFailures++;
    } else if (Object.keys(result.data).length > 0) {
      withFrontmatter++;
    }

    for (const check of opts.checks) {
      issues.push(...(await check(ctx)));
    }
  }

  return { scanned, withFrontmatter, parseFailures, issues, durationMs: Date.now() - start };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printReport(target: string, report: CheckReport): void {
  // eslint-disable-next-line no-console
  const log = console.log.bind(console);
  log(`\ncc-healer V0 smoke — scanned ${report.scanned} file(s) in ${target} · ${report.durationMs}ms`);
  log(`  with-frontmatter: ${report.withFrontmatter}`);
  log(`  parse-failures:   ${report.parseFailures}`);

  const errors = report.issues.filter((i) => i.severity === 'error');
  const warns = report.issues.filter((i) => i.severity === 'warn');
  const info = report.issues.filter((i) => i.severity === 'info');

  if (errors.length > 0) {
    log(`\n✖ ERRORS (${errors.length})`);
    for (const i of errors) log(`  ${pad(i.file, 28)} ${i.check}: ${i.message}`);
  }
  if (warns.length > 0) {
    log(`\n⚠ WARNINGS (${warns.length})`);
    for (const i of warns) log(`  ${pad(i.file, 28)} ${i.check}: ${i.message}`);
  }
  if (info.length > 0) {
    log(`\nℹ INFO (${info.length})`);
    for (const i of info) log(`  ${pad(i.file, 28)} ${i.check}: ${i.message}`);
  }
  if (report.scanned > 0 && errors.length + warns.length + info.length === 0) {
    log(`\n✓ CLEAN (no issues detected by V0 checks)`);
  }
  if (report.scanned === 0) {
    log(`\n(no files found at ${target})`);
  }
}

function printFixReport(result: FixResult, wrote: boolean): void {
  // eslint-disable-next-line no-console
  const log = console.log.bind(console);
  const { proposals, unfixable } = result;

  if (proposals.length > 0) {
    const head = wrote
      ? `\n✎ APPLIED (${proposals.length})`
      : `\n✎ PROPOSALS (${proposals.length}) — propose-only; re-run with --write to apply`;
    log(head);
    for (const p of proposals) {
      log(`  ${p.file}  [${p.field}]`);
      log(`    - ${p.oldText}`);
      log(`    + ${p.newText}`);
    }
  }
  if (unfixable.length > 0) {
    log(`\n● NEEDS HUMAN (${unfixable.length}) — cannot auto-resolve`);
    for (const u of unfixable) {
      log(`  ${pad(u.file, 40)} ${u.detail}`);
      log(`    ↳ ${u.reason}`);
    }
  }
  if (proposals.length === 0 && unfixable.length === 0) {
    log(`\n✓ no fixable findings (nothing to propose)`);
  }
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  const workspaceRoot = resolveWorkspaceRoot(rawArgs);
  // Drop `--workspace <dir>` so it isn't mistaken for the positional scan target.
  const args = stripFlagWithValue(rawArgs, '--workspace');
  const asJson = args.includes('--json');
  const doFix = args.includes('--fix');
  const doWrite = args.includes('--write');

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  if (args.includes('--version') || args.includes('-v')) {
    // eslint-disable-next-line no-console
    console.log(`cc-healer ${VERSION}`);
    return 0;
  }

  // Extract --tier <name> + optional positional path. Rest of args ignored.
  const tierIdx = args.indexOf('--tier');
  let tierName: string | null = null;
  let positional: string | null = null;
  if (tierIdx !== -1) {
    tierName = args[tierIdx + 1] ?? null;
    if (!tierName) {
      console.error('cc-healer: --tier requires a name (skills | memory | knowledge | settings | plugins)');
      return 2;
    }
    const remaining = [...args.slice(0, tierIdx), ...args.slice(tierIdx + 2)];
    positional = remaining.find((a) => !a.startsWith('-')) ?? null;
  } else {
    positional = args.find((a) => !a.startsWith('-')) ?? null;
  }

  let config: TierConfig;
  if (tierName !== null) {
    const resolved = resolveTier(tierName, workspaceRoot);
    if (resolved === null) {
      const known = ['skills', 'memory', 'knowledge', 'settings', 'plugins'];
      if (known.includes(tierName)) {
        console.error(`cc-healer: tier "${tierName}" recognized but not yet implemented in this build`);
      } else {
        console.error(`cc-healer: unknown tier "${tierName}" (expected: ${known.join(' | ')})`);
      }
      return 2;
    }
    config = positional ? { ...resolved, target: expandTilde(positional) } : resolved;
  } else {
    if (!positional) {
      printHelp();
      return 0;
    }
    config = { target: expandTilde(positional), checks: skillChecks };
  }

  // Single-file tiers (settings) bring their own scan; the rest walk a .md dir.
  const report = config.scan
    ? await config.scan(config.target)
    : await scanDir(config.target, {
        checks: config.checks,
        workspaceRoot,
        skipFiles: config.skipFiles,
        skipDirs: config.skipDirs,
        recursive: config.recursive,
        extraFiles: config.extraFiles,
        buildIndexes: config.buildIndexes,
        buildKnowledgeIndex: config.buildKnowledgeIndex,
        buildPluginIndex: config.buildPluginIndex,
      });

  // --fix: turn findings into reviewable proposals. Propose-only unless --write
  // is also passed (autonomy 1a — memory content stays human-approved). Exits 0;
  // it is a report, not a gate.
  if (doFix) {
    // Cross-tier ref resolution (KB doc → Rook memory file) is a knowledge-tier
    // concern only; derive the memory dir from the workspace root's project slug
    // (same naming as the memory tier). Other tiers pass undefined → no cross-tier
    // step, so their fixer behaviour stays byte-identical.
    const memoryDir =
      tierName === 'knowledge'
        ? expandTilde(`~/.claude/projects/${cwdToProjectSlug(workspaceRoot)}/memory`)
        : undefined;
    const result = await proposeFixes(report, {
      target: config.target,
      workspaceRoot,
      memoryDir,
    });
    if (doWrite && result.proposals.length > 0) {
      await applyProposals(result.proposals);
    }
    if (asJson) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ target: config.target, wrote: doWrite, ...result }, null, 2));
    } else {
      printFixReport(result, doWrite);
    }
    return 0;
  }

  if (asJson) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ target: config.target, ...report }, null, 2));
  } else {
    printReport(config.target, report);
  }

  return report.issues.filter((i) => i.severity === 'error').length;
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`cc-healer: fatal — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });

// Suppress unused-import warning for basename (used in future phases)
void basename;

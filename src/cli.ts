#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter } from './parser/frontmatter.js';
import { skillChecks, memoryChecks } from './checks/index.js';
import type { Check, CheckContext } from './checks/index.js';
import type { Issue, CheckReport } from './types.js';

const VERSION = '0.0.1';

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
  cc-healer --version               print version
  cc-healer --help                  this message

Tiers (per docs/cc-healer-v1-spec.md):
  skills    — Tier 1, ~/.claude/commands (9 checks live)
  memory    — Tier 2, ~/.claude/projects/<slug>/memory (2 of 8 checks live; rest stubs)
  settings  — Tier 3, ~/.claude/settings.json (not yet)
  plugins   — Tier 4, plugin install registry (not yet)

Memory tier default path is derived from process.cwd() (Windows: F:\\X\\Y → F--X-Y).
Run from project root for the default to resolve, or pass an explicit path.`);
}

type TierConfig = {
  target: string;
  checks: ReadonlyArray<Check>;
  skipFiles?: ReadonlySet<string>;
};

function cwdToProjectSlug(cwd: string): string {
  // Claude Code project dir naming: drive letter + double-dash + path-with-dashes.
  // F:\DevCrow\Dev → F--DevCrow-Dev (also handles forward-slash form).
  return cwd.replace(/^([A-Za-z]):/, '$1-').replace(/[\\/]/g, '-');
}

function resolveTier(tier: string): TierConfig | null {
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
        skipFiles: new Set(['MEMORY.md', 'DEEP-INDEX.md']),
      };
    case 'settings':
    case 'plugins':
      return null; // recognized but not yet implemented
    default:
      return null;
  }
}

async function scanDir(
  target: string,
  opts: { checks: ReadonlyArray<Check>; skipFiles?: ReadonlySet<string> },
): Promise<CheckReport> {
  const start = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const cwd = process.cwd();
  const devcrowRoot = 'F:/DevCrow/Dev';
  const issues: Issue[] = [];
  let scanned = 0;
  let withFrontmatter = 0;
  let parseFailures = 0;

  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    return { scanned: 0, withFrontmatter: 0, parseFailures: 0, issues, durationMs: Date.now() - start };
  }

  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    if (opts.skipFiles?.has(name)) continue;
    const fullPath = join(target, name);
    let s;
    try {
      s = await stat(fullPath);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    scanned++;

    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      issues.push({
        severity: 'error',
        check: 'file-readable',
        file: name,
        message: 'failed to read file',
      });
      continue;
    }

    const result = parseFrontmatter(content);
    const ctx: CheckContext = {
      file: name,
      filePath: fullPath,
      parsed: result,
      content,
      today,
      env: process.env,
      cwd,
      devcrowRoot,
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
  log(`\ncc-healer V0 smoke — scanned ${report.scanned} .md files in ${target} · ${report.durationMs}ms`);
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
    log(`\n(no .md files found at ${target})`);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

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
      console.error('cc-healer: --tier requires a name (skills | memory | settings | plugins)');
      return 2;
    }
    const remaining = [...args.slice(0, tierIdx), ...args.slice(tierIdx + 2)];
    positional = remaining.find((a) => !a.startsWith('-')) ?? null;
  } else {
    positional = args.find((a) => !a.startsWith('-')) ?? null;
  }

  let config: TierConfig;
  if (tierName !== null) {
    const resolved = resolveTier(tierName);
    if (resolved === null) {
      const known = ['skills', 'memory', 'settings', 'plugins'];
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

  const report = await scanDir(config.target, { checks: config.checks, skipFiles: config.skipFiles });
  printReport(config.target, report);

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

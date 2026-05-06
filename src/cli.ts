#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter } from './parser/frontmatter.js';
import { skillChecks } from './checks/index.js';
import type { CheckContext } from './checks/index.js';
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
  cc-healer <path>          scan a directory of .md files
  cc-healer --version       print version
  cc-healer --help          this message

V0 (smoke test): parses frontmatter from each .md file, reports counts.
Phase 1 will add the full check catalog per docs/cc-healer-v1-spec.md.`);
}

async function scanDir(target: string): Promise<CheckReport> {
  const start = Date.now();
  const today = new Date().toISOString().slice(0, 10);
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
    const ctx: CheckContext = { file: name, filePath: fullPath, parsed: result, content, today };

    if (!result.ok) {
      parseFailures++;
    } else if (Object.keys(result.data).length > 0) {
      withFrontmatter++;
    }

    for (const check of skillChecks) {
      issues.push(...check(ctx));
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

  const target = expandTilde(args[0]!);
  const report = await scanDir(target);
  printReport(target, report);

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

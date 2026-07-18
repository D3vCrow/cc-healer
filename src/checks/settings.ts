// Settings & hooks tier checks (Tier 3).
//
// Implements §"Tier 3: settings & hooks" of docs/cc-healer-v1-spec.md. Unlike the
// skill / memory / knowledge / plugin tiers — which walk a *directory* of .md files
// and run per-file frontmatter checks through the generic scanDir/CheckContext flow —
// this tier validates a *single JSON file* (~/.claude/settings.json). So it owns its
// own scan entry point (scanSettings) and its own context shape (SettingsContext)
// rather than shoe-horning JSON into the .md/frontmatter-centric CheckContext.
//
// Five checks per the spec table:
//   1. settings-parses            — file is valid JSON (error; gates checks 2–5)
//   2. settings-hook-paths-exist  — every hook command's script path exists on disk (error)
//   3. settings-hook-executable   — every hook script has the exec bit (warn; POSIX-only)
//   4. settings-permission-shadow — no rule string appears in >1 of allow/deny/ask (warn)
//   5. settings-schema-keys       — top-level keys are in the known CC schema snapshot (warn)
//   6. settings-rule-of-two-parked — a registered Rule-of-Two gate is actually enforcing (warn)
//
// Check 1 is the parse gate (settingsParses + scanSettings short-circuit); checks
// 2–6 are the post-parse content checks exported in `settingsChecks`.
//
// Check 6 is the one check here that reads a file OTHER than settings.json: the gate's
// sidecar flag registry. It is anchored in settings.json (it fires only if the hook is
// registered there), which is why it lives in this tier rather than its own.

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

import type { Issue, CheckReport } from '../types.js';

/**
 * Context every settings-tier content check sees. Built once per scan in
 * scanSettings from the already-parsed JSON. `platform` is injected (defaults to
 * process.platform) so the POSIX-only exec-bit check is unit-testable on Windows.
 */
export interface SettingsContext {
  file: string; // display name, e.g. 'settings.json'
  filePath: string; // absolute path to the settings file
  content: string; // raw file content
  json: unknown; // parsed JSON (non-null here; parse failure short-circuits before checks run)
  cwd: string; // base for resolving a relative hook path (hook paths are absolute in practice)
  platform: NodeJS.Platform; // process.platform in production; pinned in tests
  today: string; // YYYY-MM-DD; unused today but mirrors CheckContext for forward 48h-diff work
  home?: string; // homedir() in production; injected in tests so sidecar-config checks are hermetic
}

type SettingsCheck = (ctx: SettingsContext) => Issue[] | Promise<Issue[]>;

// Interpreters that take a script path as their first non-flag argument. Matched
// case-insensitively against the command's first token (basename, exe-suffix stripped).
const INTERPRETERS = new Set<string>([
  'python',
  'python3',
  'py',
  'node',
  'nodejs',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'ruby',
  'deno',
  'npx',
  'tsx',
  'ts-node',
  'uv',
  'uvx',
  'perl',
  'php',
]);

// Extensions that mark a token as a script file even without a path separator.
const SCRIPT_EXTS = ['.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.bash', '.cmd', '.bat', '.ps1', '.rb', '.pl', '.php'];

// Known Claude Code settings.json top-level keys — a snapshot, not an authoritative
// schema. Deliberately GENEROUS: a schema-keys check that cries wolf on the user's own
// working keys is a bad check, so the 80/20 value here is catching typos (`permisions`,
// `hoks`) and stray copy-paste keys. Warn-only by design; update as Claude Code evolves.
const KNOWN_TOP_LEVEL_KEYS = new Set<string>([
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'cleanupPeriodDays',
  'env',
  'includeCoAuthoredBy',
  'permissions',
  'hooks',
  'model',
  'statusLine',
  'outputStyle',
  'forceLoginMethod',
  'forceLoginOrgUUID',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'attribution',
  'sandbox',
  'mcpServers',
  'skipDangerousModePermissionPrompt',
  'agentPushNotifEnabled',
  'skipWorkflowUsageWarning',
  'preferredNotifChannel',
  'disableAllHooks',
  'otelHeadersHelper',
  'alwaysThinkingEnabled',
  'spinnerTipsEnabled',
  'messageIdleNotifThresholdMs',
  'diffTool',
  'vimMode',
  'theme',
  'autoUpdates',
  'verbose',
]);

// Strip a leading UTF-8 BOM. Windows editors (Notepad, some PowerShell writes)
// prepend U+FEFF; JSON.parse rejects it with a cryptic "Unexpected token" error,
// but tolerant config readers ignore it — so cc-healer parses the file the way the
// config consumer does, not the way a naive JSON.parse would. Idempotent.
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// --- Check 1: settings-parses (gate) ------------------------------------

/**
 * The settings file must be valid JSON. Severity: error. On failure, scanSettings
 * returns this issue alone and skips checks 2–5 (they require parsed JSON).
 * Source: cc-healer V1 spec Tier 3 row "settings.json parses".
 */
export function settingsParses(content: string, file: string): Issue[] {
  try {
    JSON.parse(stripBom(content));
    return [];
  } catch (err) {
    return [
      {
        severity: 'error',
        check: 'settings-parses',
        file,
        message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
}

// --- command-string parsing helpers -------------------------------------

// Tokenize a hook command, respecting single/double quotes (e.g. a session-record
// hook quotes its path: `python "C:/…/parse.py" --latest-session`).
function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const tok = m[1] ?? m[2] ?? m[3];
    if (tok !== undefined) tokens.push(tok);
  }
  return tokens;
}

type PathKind = 'file' | 'bare' | 'envvar';

// Does the token look like a filesystem path (vs a bare PATH binary)?
function looksLikePath(tok: string): boolean {
  if (tok.includes('/') || tok.includes('\\')) return true;
  if (/^[A-Za-z]:/.test(tok)) return true; // Windows drive letter
  const lower = tok.toLowerCase();
  return SCRIPT_EXTS.some((e) => lower.endsWith(e));
}

// Contains an unexpanded variable (${VAR}, $VAR, or %VAR%) → can't statically resolve.
function hasUnexpandedVar(tok: string): boolean {
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(tok) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(tok);
}

function classifyToken(tok: string): { kind: PathKind; token: string } {
  if (hasUnexpandedVar(tok)) return { kind: 'envvar', token: tok };
  if (looksLikePath(tok)) return { kind: 'file', token: tok };
  return { kind: 'bare', token: tok };
}

/**
 * Extract the script/binary token a hook command will execute:
 *   - `python C:/…/log.py`           → file token `C:/…/log.py` (interpreter + arg)
 *   - `python "C:/…/x.py" --flag`     → file token `C:/…/x.py` (quoted, args ignored)
 *   - `C:/…/rule.cmd`                 → file token `C:/…/rule.cmd` (direct path)
 *   - `clauditor hook pre-tool-use`   → bare token `clauditor` (PATH binary)
 *   - `python ${CLAUDE_DIR}/x.py`     → envvar token (unresolvable)
 * Returns null for an empty command, or an interpreter invoked with only flags
 * (e.g. `python -V`) where there is no script to check.
 */
function extractScriptToken(command: string): { kind: PathKind; token: string } | null {
  const tokens = tokenizeCommand(command.trim());
  const first = tokens[0];
  if (first === undefined) return null;
  const firstName = basename(first)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');
  if (INTERPRETERS.has(firstName) || INTERPRETERS.has(first.toLowerCase())) {
    const arg = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (arg === undefined) return null; // interpreter with only flags — nothing to check
    return classifyToken(arg);
  }
  return classifyToken(first);
}

// Walk json.hooks → event → entries[] → entry.hooks[] → {command}. Tolerant of any
// malformed sub-shape (returns what it can); shape errors aren't this tier's concern.
function collectHookCommands(json: unknown): Array<{ event: string; command: string }> {
  const out: Array<{ event: string; command: string }> = [];
  if (!json || typeof json !== 'object') return out;
  const hooks = (json as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, entriesRaw] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entriesRaw)) continue;
    for (const entry of entriesRaw) {
      if (!entry || typeof entry !== 'object') continue;
      const hookArr = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(hookArr)) continue;
      for (const h of hookArr) {
        if (!h || typeof h !== 'object') continue;
        const command = (h as Record<string, unknown>).command;
        if (typeof command === 'string' && command.trim().length > 0) {
          out.push({ event, command });
        }
      }
    }
  }
  return out;
}

// Resolve a file-kind hook token to an absolute path for existence checks.
function resolveHookPath(token: string, cwd: string): string {
  const expanded = token.startsWith('~') ? token.replace(/^~/, homedir()) : token;
  return isAbsolute(expanded) ? expanded : join(cwd, expanded);
}

// --- Check 2: settings-hook-paths-exist ---------------------------------

/**
 * Every hook command's script path must exist on disk. Severity: error.
 * Source: cc-healer V1 spec Tier 3 row "All hook script paths exist".
 *
 * Scope by token kind:
 *   - file   → resolve + existence-check → error if missing
 *   - envvar → info (unexpandable ${VAR}/%VAR% — not statically checkable)
 *   - bare   → skip (PATH-resolved binary like `clauditor`; PATH lookup is V1.5)
 */
export const settingsHookPathsExist: SettingsCheck = async (ctx) => {
  const issues: Issue[] = [];
  for (const { event, command } of collectHookCommands(ctx.json)) {
    const extracted = extractScriptToken(command);
    if (!extracted) continue;
    const { kind, token } = extracted;
    if (kind === 'bare') continue;
    if (kind === 'envvar') {
      issues.push({
        severity: 'info',
        check: 'settings-hook-paths-exist',
        file: ctx.file,
        message: `${event}: hook path '${token}' contains an unexpanded variable — existence not statically checkable`,
      });
      continue;
    }
    const resolved = resolveHookPath(token, ctx.cwd);
    try {
      await access(resolved);
    } catch {
      issues.push({
        severity: 'error',
        check: 'settings-hook-paths-exist',
        file: ctx.file,
        message: `${event}: hook script '${token}' does not exist (resolved: ${resolved})`,
      });
    }
  }
  return issues;
};

// --- Check 3: settings-hook-executable ----------------------------------

/**
 * Every existing hook script should carry the exec bit. Severity: warn.
 * Source: cc-healer V1 spec Tier 3 row "All hook scripts are executable".
 *
 * POSIX-only: Windows has no POSIX mode bits (fs.access X_OK there just mirrors
 * read access), so the check would be meaningless / always-green on win32 — it
 * returns [] immediately. Missing files are hook-paths-exist's job, not this one's.
 */
export const settingsHookExecutable: SettingsCheck = async (ctx) => {
  if (ctx.platform === 'win32') return [];
  const issues: Issue[] = [];
  for (const { event, command } of collectHookCommands(ctx.json)) {
    const extracted = extractScriptToken(command);
    if (!extracted || extracted.kind !== 'file') continue;
    const resolved = resolveHookPath(extracted.token, ctx.cwd);
    try {
      await access(resolved); // skip the exec check on files that don't exist
    } catch {
      continue;
    }
    try {
      await access(resolved, constants.X_OK);
    } catch {
      issues.push({
        severity: 'warn',
        check: 'settings-hook-executable',
        file: ctx.file,
        message: `${event}: hook script '${extracted.token}' is not executable (chmod +x needed)`,
      });
    }
  }
  return issues;
};

// --- Check 4: settings-permission-shadow --------------------------------

/**
 * A permission rule string appearing in more than one of allow / deny / ask
 * shadows itself — the lists give conflicting directives for the same pattern.
 * Severity: warn. V1 matches rule strings EXACTLY (deterministic); broad-vs-narrow
 * glob shadowing (a wide allow swallowing a narrow deny) is V1.5 semantic analysis.
 * Source: cc-healer V1 spec Tier 3 row "Permission rules don't shadow each other".
 */
export const settingsPermissionShadow: SettingsCheck = (ctx) => {
  const json = ctx.json;
  if (!json || typeof json !== 'object') return [];
  const perms = (json as Record<string, unknown>).permissions;
  if (!perms || typeof perms !== 'object') return [];
  const lists: Array<'allow' | 'deny' | 'ask'> = ['allow', 'deny', 'ask'];
  const seen = new Map<string, Set<string>>();
  for (const list of lists) {
    const arr = (perms as Record<string, unknown>)[list];
    if (!Array.isArray(arr)) continue;
    for (const rule of arr) {
      if (typeof rule !== 'string') continue;
      let inLists = seen.get(rule);
      if (!inLists) {
        inLists = new Set<string>();
        seen.set(rule, inLists);
      }
      inLists.add(list);
    }
  }
  const issues: Issue[] = [];
  for (const [rule, inLists] of seen) {
    if (inLists.size > 1) {
      const where = lists.filter((l) => inLists.has(l)).join(' + ');
      issues.push({
        severity: 'warn',
        check: 'settings-permission-shadow',
        file: ctx.file,
        message: `permission rule '${rule}' appears in multiple lists (${where}) — they shadow each other`,
      });
    }
  }
  return issues;
};

// --- Check 5: settings-schema-keys --------------------------------------

/**
 * Top-level keys should be in cc-healer's known Claude Code settings schema
 * snapshot. Severity: warn — an unknown key is most often a typo or a stray
 * copy-paste, but may also be a newer key cc-healer doesn't track yet, so the
 * message hedges and the allowlist is deliberately generous (see KNOWN_TOP_LEVEL_KEYS).
 * Source: cc-healer V1 spec Tier 3 row "settings.json keys match current Claude Code schema".
 */
export const settingsSchemaKeys: SettingsCheck = (ctx) => {
  const json = ctx.json;
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  const issues: Issue[] = [];
  for (const key of Object.keys(json as Record<string, unknown>)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      issues.push({
        severity: 'warn',
        check: 'settings-schema-keys',
        file: ctx.file,
        message: `unknown top-level key '${key}' — not in cc-healer's known Claude Code settings schema snapshot; verify it's current (typo, or a newer key cc-healer doesn't track yet)`,
      });
    }
  }
  return issues;
};

// --- Check 6: settings-rule-of-two-parked -------------------------------

// Sidecar config for the Rule-of-Two PreToolUse gate. The hook hardcodes this path.
const RULE_OF_TWO_REGISTRY = ['.claude', 'rule_of_two_tools.yaml'] as const;

// Matched on raw text, not a parsed YAML tree, on purpose: cc-healer ships no YAML
// dependency, and the two facts this check needs (a top-level scalar and the presence
// of a header comment) are exactly the two things a parser would throw away. `^` with
// no leading `#` skips commented-out lines.
const ENFORCE_LINE = /^enforce:[ \t]*(true|false)\b/m;
const TEMPLATE_MARKER = /seed template|before going live/i;

/**
 * A registered Rule-of-Two gate should actually be enforcing. Severity: warn.
 *
 * Fires ONLY when settings.json registers a hook whose command mentions
 * `rule_of_two` — a workspace without the gate gets nothing, so this is silent for
 * everyone who hasn't opted in.
 *
 * Why it exists: the gate ships `enforce: false` in its seed registry, and the hook's
 * contract is "exit 0 on allow/warn/dry-run-reject, non-zero on enforced reject". A
 * registry left at the default therefore emits telemetry and blocks nothing, while
 * still *looking* like live protection from the outside. Observed 2026-07-18: parked
 * 2.5 months, and documented as a blocking hook in DevCrow's own enforcement-tier map
 * before anyone read line 25. See F:/DevCrow/Dev/docs/enforcement-tiers.md.
 *
 * `enforce: false` can be a deliberate observe-mode choice, so this warns rather than
 * errors, and says so in the message.
 */
export const settingsRuleOfTwoParked: SettingsCheck = async (ctx) => {
  const registered = collectHookCommands(ctx.json).some((h) => /rule_of_two/i.test(h.command));
  if (!registered) return [];

  const home = ctx.home ?? homedir();
  const registryPath = join(home, ...RULE_OF_TWO_REGISTRY);

  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf-8');
  } catch {
    return [
      {
        severity: 'warn',
        check: 'settings-rule-of-two-parked',
        file: ctx.file,
        message: `a rule_of_two hook is registered but its flag registry is missing (expected: ${registryPath}) — every tool call falls through unannotated`,
      },
    ];
  }

  const issues: Issue[] = [];
  const enforce = ENFORCE_LINE.exec(stripBom(raw));

  if (!enforce) {
    issues.push({
      severity: 'warn',
      check: 'settings-rule-of-two-parked',
      file: ctx.file,
      message: `rule_of_two registry has no top-level 'enforce:' key (${registryPath}) — the gate cannot be confirmed live`,
    });
  } else if (enforce[1] === 'false') {
    issues.push({
      severity: 'warn',
      check: 'settings-rule-of-two-parked',
      file: ctx.file,
      message: `rule_of_two gate is parked in dry-run: 'enforce: false' in ${registryPath} — rejects emit telemetry and allow the call. Intentional observe-mode is fine; just don't record it as blocking protection`,
    });
  }

  if (TEMPLATE_MARKER.test(stripBom(raw))) {
    issues.push({
      severity: 'warn',
      check: 'settings-rule-of-two-parked',
      file: ctx.file,
      message: `rule_of_two registry still carries its seed-template header (${registryPath}) — it looks unreviewed since it was copied`,
    });
  }

  return issues;
};

// --- Registry + scan entry point ----------------------------------------

/** Post-parse content checks (2–6). Check 1 (parse) is the gate in scanSettings. */
export const settingsChecks: ReadonlyArray<SettingsCheck> = [
  settingsHookPathsExist,
  settingsHookExecutable,
  settingsPermissionShadow,
  settingsSchemaKeys,
  settingsRuleOfTwoParked,
];

/**
 * Scan a single settings JSON file and produce a CheckReport (same shape the .md
 * tiers return, so cli.ts's printReport / --json tail handles it unchanged).
 * A missing file is legitimate (fresh workspace) → scanned: 0, no issues. A parse
 * failure short-circuits to the settings-parses error alone.
 */
export async function scanSettings(target: string): Promise<CheckReport> {
  const start = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const file = basename(target);

  let content: string;
  try {
    content = stripBom(await readFile(target, 'utf-8'));
  } catch {
    return { scanned: 0, withFrontmatter: 0, parseFailures: 0, issues: [], durationMs: Date.now() - start };
  }

  const parseIssues = settingsParses(content, file);
  if (parseIssues.length > 0) {
    return { scanned: 1, withFrontmatter: 0, parseFailures: 1, issues: parseIssues, durationMs: Date.now() - start };
  }

  const ctx: SettingsContext = {
    file,
    filePath: target,
    content,
    json: JSON.parse(content) as unknown,
    cwd: process.cwd(),
    platform: process.platform,
    today,
  };
  const issues: Issue[] = [];
  for (const check of settingsChecks) {
    issues.push(...(await check(ctx)));
  }
  return { scanned: 1, withFrontmatter: 0, parseFailures: 0, issues, durationMs: Date.now() - start };
}

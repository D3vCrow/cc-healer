// Common shape every check sees. Sync checks return Issue[] directly; async
// checks (binary-on-PATH lookups, file-ref existence checks) return a promise.
// The runner awaits both shapes uniformly.

import type { Issue, ParsedFile } from '../types.js';

/**
 * Cross-file index for memory-tier scans. Built once per scan from MEMORY.md
 * (hot tier) and DEEP-INDEX.md (deep tier). Cross-file checks read this to
 * answer "is this file linked from exactly one of the two indexes?".
 *
 * Sets contain bare filenames (basename). Absent for non-memory tier scans.
 */
export interface MemoryIndexes {
  hot: Set<string>;   // filenames linked from MEMORY.md
  deep: Set<string>;  // filenames linked from DEEP-INDEX.md
}

/**
 * Plugin-tier index. Built once per scan from `~/.claude/plugins/installed_plugins.json`.
 * Cross-file checks read this to answer "is plugin <id> installed?".
 *
 * Plugin IDs follow the `<plugin>@<marketplace>` shape used by the registry
 * (e.g. `watch@claude-video`, `superpowers@claude-plugins-official`). Absent
 * for non-plugin tier scans.
 */
export interface PluginIndex {
  installedIds: Set<string>;
}

export interface CheckContext {
  file: string;                                  // display name (basename usually)
  filePath: string;                              // absolute path, used for file-ref resolution
  parsed: ParsedFile;                            // result of parseFrontmatter
  content: string;                               // raw file content, for body scans
  today: string;                                 // YYYY-MM-DD, set once per scan; lets tests pin time deterministically
  env: Record<string, string | undefined>;       // process.env in production; tests pin to controlled subsets
  cwd: string;                                   // process.cwd() in production; used by fileRefsResolve as one of two roots
  devcrowRoot: string;                           // F:/DevCrow/Dev in production; second root for fileRefsResolve
  indexes?: MemoryIndexes;                       // cross-file index for memory tier; undefined for skill-tier scans
  pluginIndex?: PluginIndex;                     // cross-file index for plugin tier; undefined when not plumbed
}

export type Check = (ctx: CheckContext) => Issue[] | Promise<Issue[]>;
export type AsyncCheck = (ctx: CheckContext) => Promise<Issue[]>;

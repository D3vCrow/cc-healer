// Common shape every check sees. Sync checks return Issue[] directly; async
// checks (binary-on-PATH lookups, file-ref existence checks) return a promise.
// The runner awaits both shapes uniformly.

import type { Issue, ParsedFile } from '../types.js';

export interface CheckContext {
  file: string;                                  // display name (basename usually)
  filePath: string;                              // absolute path, used for file-ref resolution
  parsed: ParsedFile;                            // result of parseFrontmatter
  content: string;                               // raw file content, for body scans
  today: string;                                 // YYYY-MM-DD, set once per scan; lets tests pin time deterministically
  env: Record<string, string | undefined>;       // process.env in production; tests pin to controlled subsets
  cwd: string;                                   // process.cwd() in production; used by fileRefsResolve as one of two roots
  devcrowRoot: string;                           // F:/DevCrow/Dev in production; second root for fileRefsResolve
}

export type Check = (ctx: CheckContext) => Issue[] | Promise<Issue[]>;
export type AsyncCheck = (ctx: CheckContext) => Promise<Issue[]>;

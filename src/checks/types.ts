// Common shape every check sees. Sync checks return synchronously; async checks
// (binary-on-PATH lookups, file-ref existence checks) come in Phase 1 once we
// need them. For Phase 0 / V0, all 9 skill-tier checks are sync.

import type { Issue, ParsedFile } from '../types.js';

export interface CheckContext {
  file: string;       // display name (basename usually)
  filePath: string;   // absolute path, used for file-ref resolution
  parsed: ParsedFile; // result of parseFrontmatter
  content: string;    // raw file content, for body scans
}

export type Check = (ctx: CheckContext) => Issue[];
export type AsyncCheck = (ctx: CheckContext) => Promise<Issue[]>;

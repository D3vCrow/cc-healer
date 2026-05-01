export type Severity = 'error' | 'warn' | 'info';

export interface Issue {
  severity: Severity;
  check: string;
  file: string;
  line?: number;
  message: string;
}

export interface FrontmatterParseResult {
  ok: boolean;
  data: Record<string, unknown>;
  errors: string[];
}

export interface ParsedFile extends FrontmatterParseResult {
  body: string;
}

export interface CheckReport {
  scanned: number;
  withFrontmatter: number;
  parseFailures: number;
  issues: Issue[];
  durationMs: number;
}

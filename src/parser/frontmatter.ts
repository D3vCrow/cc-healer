// Frontmatter parser — TypeScript port of skill-forge `validate_skill.py` shape.
// Zero-dependency. Handles the schema shape Claude Code commands and Rook v2 memory files use:
//   key: scalar-value
//   key: [a, b, c]              (flow array)
//   key:                         (nested object opens, indented children below)
//     subkey: subvalue
//     subkey:
//       deepkey: value
//       deepkey: [x, y]
//
//   key:                         (block sequence opens, `- item` children below)
//     - item-a
//     - item-b
//
// NOT a general YAML parser. Specifically does NOT support:
//   - block scalars (| or >)
//   - anchors / aliases / tags
//   - multi-document streams
//   - nested block sequences (a `- ` item that itself contains a `- ` list)
// These shapes don't appear in the workspace's frontmatter; if they're added later,
// extend here and add tests.

import type { FrontmatterParseResult, ParsedFile } from '../types.js';

interface SplitResult {
  frontmatter: string | null;
  body: string;
  ok: boolean;
  error?: string;
}

export function splitFrontmatter(content: string): SplitResult {
  if (!content.startsWith('---')) {
    return { frontmatter: null, body: content, ok: true };
  }
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: null, body: content, ok: false, error: 'leading --- not on its own line' };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: null, body: content, ok: false, error: 'unterminated frontmatter (no closing ---)' };
  }
  return {
    frontmatter: lines.slice(1, endIdx).join('\n'),
    body: lines.slice(endIdx + 1).join('\n'),
    ok: true,
  };
}

// True flow array detection: starts with `[`, ends with `]`, and the inner content
// has no `] [` pattern (which would indicate multiple bracket groups intended as a string).
function isTrueFlowArray(value: string): boolean {
  if (!value.startsWith('[') || !value.endsWith(']')) return false;
  const inner = value.slice(1, -1);
  return !/\]\s+\[/.test(inner);
}

function parseScalar(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function parseFlowArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((s) => parseScalar(s.trim()))
    .filter((s) => s.length > 0);
}

export function parseSimpleYAML(yaml: string): FrontmatterParseResult {
  const errors: string[] = [];
  const root: Record<string, unknown> = {};

  // A frame opened by an empty-value `key:` also records its parent container +
  // key, so a following block sequence (`- item`) can re-attach it as an array.
  type Frame = {
    indent: number;
    container: Record<string, unknown>;
    parent?: Record<string, unknown>;
    key?: string;
    list?: unknown[];
  };
  const stack: Frame[] = [{ indent: -1, container: root }];

  const lines = yaml.split(/\r?\n/);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    if (rawLine === undefined) continue;
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;

    const indentMatch = rawLine.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const trimmed = rawLine.slice(indent);

    // Block-style sequence item (`- value` or bare `-`). Attaches to the nearest
    // enclosing empty-value key, whose child object is converted to an array on
    // the first item seen. Dedent keeps frames strictly shallower than this item.
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      while (stack.length > 1) {
        const t = stack[stack.length - 1];
        if (!t || t.indent >= indent) stack.pop();
        else break;
      }
      const top = stack[stack.length - 1];
      if (!top || top.key === undefined || top.parent === undefined) {
        errors.push(`line ${lineIdx + 1}: sequence item has no parent key`);
        continue;
      }
      if (!top.list) {
        top.list = [];
        top.parent[top.key] = top.list;
      }
      const itemRaw = trimmed === '-' ? '' : trimmed.slice(2).trim();
      if (itemRaw !== '') top.list.push(parseScalar(itemRaw));
      continue;
    }

    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      if (!top || top.indent >= indent) {
        stack.pop();
      } else {
        break;
      }
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      errors.push(`line ${lineIdx + 1}: missing colon`);
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const valueStr = trimmed.slice(colonIdx + 1).trim();

    const top = stack[stack.length - 1];
    if (!top) continue;
    const parent = top.container;

    if (valueStr === '') {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, container: child, parent, key });
    } else if (isTrueFlowArray(valueStr)) {
      parent[key] = parseFlowArray(valueStr);
    } else {
      parent[key] = parseScalar(valueStr);
    }
  }

  return { ok: errors.length === 0, data: root, errors };
}

export function parseFrontmatter(content: string): ParsedFile {
  const split = splitFrontmatter(content);
  if (!split.ok) {
    return {
      ok: false,
      data: {},
      errors: [split.error ?? 'unknown split error'],
      body: split.body,
    };
  }
  if (split.frontmatter === null) {
    return { ok: true, data: {}, errors: [], body: split.body };
  }
  const parsed = parseSimpleYAML(split.frontmatter);
  return { ...parsed, body: split.body };
}

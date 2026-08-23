import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseFrontmatter, parseSimpleYAML } from '../src/parser/frontmatter.ts';

// A flow array wrapped over several physical lines is valid YAML, and both
// prettier and hand-authored vet notes emit it. The parser used to reject every
// continuation line with "missing colon", which made the whole file a parse
// failure — and a parse failure is skipped by every check, so the file's
// verify_by and related: refs went unread with nothing reported. Two live KB
// files were dark this way (research/2026-06-21-vet-caveman.md,
// research/2026-08-15-vet-motion-canvas.md).

test('flow array on one line still parses (regression guard)', () => {
  const r = parseSimpleYAML('tags: [a, b, c]');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.tags, ['a', 'b', 'c']);
});

test('flow array continuing after the key folds to one array', () => {
  const r = parseSimpleYAML('tags: [vet, ai-agent-skill,\n       bsl-1.1, open-core]\nverdict: GREEN');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.tags, ['vet', 'ai-agent-skill', 'bsl-1.1', 'open-core']);
  assert.equal(r.data.verdict, 'GREEN');
});

test('flow array opening on the line below a bare key folds too (prettier shape)', () => {
  const r = parseSimpleYAML('tags:\n  [\n    vet,\n    motion-canvas,\n    ssrf,\n  ]\nverdict: RED');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.tags, ['vet', 'motion-canvas', 'ssrf']);
  assert.equal(r.data.verdict, 'RED');
});

test('a bracket inside a quoted title does not open a fold', () => {
  const r = parseSimpleYAML('title: "Vet: foo [bar] baz"\ndate: 2026-08-23');
  assert.equal(r.ok, true);
  assert.equal(r.data.title, 'Vet: foo [bar] baz');
  assert.equal(r.data.date, '2026-08-23');
});

test('unterminated flow array does not swallow the keys below it', () => {
  // The fold gives up when the brackets never balance and leaves the line alone,
  // so `tags` falls back to the pre-fold behaviour (a scalar string) and — the
  // part that matters — every following key is still read.
  const r = parseSimpleYAML('tags: [a, b,\nverdict: GREEN\nverify_by: 2026-09-22');
  assert.equal(r.data.tags, '[a, b,');
  assert.equal(r.data.verdict, 'GREEN');
  assert.equal(r.data.verify_by, '2026-09-22');
});

test('error line numbers count physical lines, not folded ones', () => {
  // The fold collapses lines 1-2; the bad line is physical line 3.
  const r = parseSimpleYAML('tags: [a,\n       b]\nthis-line-has-no-colon');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['line 3: missing colon']);
});

test('block sequence is untouched by the fold', () => {
  const r = parseSimpleYAML('related:\n  - one.md\n  - two.md');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.related, ['one.md', 'two.md']);
});

test('nested object with a wrapped flow array under it', () => {
  const r = parseSimpleYAML('commands:\n  requires: [node,\n             tsx]\n  re_verify: npm test');
  assert.equal(r.ok, true);
  assert.deepEqual((r.data.commands as Record<string, unknown>).requires, ['node', 'tsx']);
  assert.equal((r.data.commands as Record<string, unknown>).re_verify, 'npm test');
});

test('end-to-end: a file with a wrapped tags array parses and keeps its body', () => {
  const src = '---\ntitle: T\ntags: [a,\n       b]\nverify_by: 2026-09-22\n---\n\n# Heading\n';
  const p = parseFrontmatter(src);
  assert.equal(p.ok, true);
  assert.deepEqual(p.data.tags, ['a', 'b']);
  assert.equal(p.data.verify_by, '2026-09-22');
  assert.match(p.body, /# Heading/);
});

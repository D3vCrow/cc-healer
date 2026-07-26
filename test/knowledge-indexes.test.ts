import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildKnowledgeIndex } from '../src/knowledge-indexes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const KB_DIR = join(HERE, 'fixtures', 'kb-index'); // has INDEX.md
const EMPTY_DIR = join(HERE, 'fixtures', 'memory'); // no INDEX.md here

test('buildKnowledgeIndex: collects plain knowledge-root-relative links', async () => {
  const idx = await buildKnowledgeIndex(KB_DIR);
  assert.equal(idx.indexed.has('research/2026-01-01-foo.md'), true);
});

test('buildKnowledgeIndex: strips a leading knowledge/ prefix', async () => {
  const idx = await buildKnowledgeIndex(KB_DIR);
  assert.equal(idx.indexed.has('research/2026-01-02-bar.md'), true);
  assert.equal(idx.indexed.has('knowledge/research/2026-01-02-bar.md'), false);
});

test('buildKnowledgeIndex: strips a leading ./', async () => {
  const idx = await buildKnowledgeIndex(KB_DIR);
  assert.equal(idx.indexed.has('research/2026-01-03-baz.md'), true);
});

test('buildKnowledgeIndex: normalizes backslash separators', async () => {
  const idx = await buildKnowledgeIndex(KB_DIR);
  assert.equal(idx.indexed.has('research/2026-01-04-qux.md'), true);
});

test('buildKnowledgeIndex: stores a basename alongside each path form', async () => {
  const idx = await buildKnowledgeIndex(KB_DIR);
  assert.equal(idx.indexed.has('2026-01-01-foo.md'), true);
  assert.equal(idx.indexed.has('2026-01-04-qux.md'), true);
});

test('buildKnowledgeIndex: root-level link with no directory segment', async () => {
  const idx = await buildKnowledgeIndex(KB_DIR);
  assert.equal(idx.indexed.has('project-status.md'), true);
});

test('buildKnowledgeIndex: a bare mention is not a link and is not indexed', async () => {
  const idx = await buildKnowledgeIndex(KB_DIR);
  assert.equal(idx.indexed.has('research/2026-01-05-not-a-link.md'), false);
});

test('buildKnowledgeIndex: dir without INDEX.md → empty set', async () => {
  const idx = await buildKnowledgeIndex(EMPTY_DIR);
  assert.equal(idx.indexed.size, 0);
});

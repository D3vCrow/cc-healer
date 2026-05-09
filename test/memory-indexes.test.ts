import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMemoryIndexes } from '../src/memory-indexes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(HERE, 'fixtures', 'scan', 'sample');
const EMPTY_DIR = join(HERE, 'fixtures', 'memory'); // no MEMORY.md or DEEP-INDEX.md here

test('buildMemoryIndexes: sample dir → hot has 3, deep has 3', async () => {
  const idx = await buildMemoryIndexes(SAMPLE_DIR);
  assert.equal(idx.hot.size, 3);
  assert.equal(idx.deep.size, 3);
});

test('buildMemoryIndexes: hot tier collects MEMORY.md links', async () => {
  const idx = await buildMemoryIndexes(SAMPLE_DIR);
  assert.equal(idx.hot.has('project_foo.md'), true);
  assert.equal(idx.hot.has('feedback_bar.md'), true);
  assert.equal(idx.hot.has('user_profile.md'), true);
});

test('buildMemoryIndexes: deep tier collects DEEP-INDEX.md links', async () => {
  const idx = await buildMemoryIndexes(SAMPLE_DIR);
  assert.equal(idx.deep.has('pattern_baz.md'), true);
  assert.equal(idx.deep.has('failure_qux.md'), true);
});

test('buildMemoryIndexes: nested-path link strips dir prefix to basename', async () => {
  const idx = await buildMemoryIndexes(SAMPLE_DIR);
  // DEEP-INDEX.md contains: [Project deep](sub/project_deep.md)
  // Builder must strip `sub/` and store just the basename.
  assert.equal(idx.deep.has('project_deep.md'), true);
  assert.equal(idx.deep.has('sub/project_deep.md'), false);
});

test('buildMemoryIndexes: dir without index files → both sets empty', async () => {
  const idx = await buildMemoryIndexes(EMPTY_DIR);
  assert.equal(idx.hot.size, 0);
  assert.equal(idx.deep.size, 0);
});

test('buildMemoryIndexes: nonexistent dir → both sets empty (graceful)', async () => {
  const idx = await buildMemoryIndexes(join(HERE, 'fixtures', 'this-does-not-exist'));
  assert.equal(idx.hot.size, 0);
  assert.equal(idx.deep.size, 0);
});

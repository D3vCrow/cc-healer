import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectSkillFolderFiles } from '../src/collect-skill-folders.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'skill-folders');

test('collectSkillFolderFiles: returns <name>/SKILL.md one level down only', async () => {
  const files = await collectSkillFolderFiles(FIXTURE, 'skills');
  // reference.md, a folder with no SKILL.md, a dot-folder and a top-level .md are all skipped.
  assert.deepEqual(files.map((f) => f.relPath), ['skills/alpha/SKILL.md']);
  assert.equal(files[0]?.name, 'SKILL.md');
  assert.equal(files[0]?.fullPath, join(FIXTURE, 'alpha', 'SKILL.md'));
});

test('collectSkillFolderFiles: a missing dir yields no files', async () => {
  assert.deepEqual(await collectSkillFolderFiles(join(FIXTURE, 'does-not-exist'), 'skills'), []);
});

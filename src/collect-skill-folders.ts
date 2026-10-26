// Skill folders (`~/.claude/skills/<name>/SKILL.md`) for the skills tier.
//
// Only the SKILL.md one level down counts: reference files beside it
// (pillar-checklist.md and the like) are not skills, and dot-folders are not
// loaded by Claude Code. Kept out of cli.ts, which runs main() on import.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function collectSkillFolderFiles(
  dir: string,
  displayPrefix: string,
): Promise<{ name: string; fullPath: string; relPath: string }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: { name: string; fullPath: string; relPath: string }[] = [];
  for (const folder of names.sort()) {
    if (folder.startsWith('.')) continue;
    const fullPath = join(dir, folder, 'SKILL.md');
    try {
      if (!(await stat(fullPath)).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ name: 'SKILL.md', fullPath, relPath: `${displayPrefix}/${folder}/SKILL.md` });
  }
  return out;
}

---
name: body-with-refs
description: Skill with Spec / Shared patterns body refs to test file-refs-resolve
devcrow:
  tier: light
---

Spec: test/fixtures/skills/body-refs-target.md
Shared patterns: package.json
Spec: bogus-path-XYZ-does-not-exist.md
Spec: `test/fixtures/skills/body-refs-target.md` §extra (duplicate, deduped)

Body content here.

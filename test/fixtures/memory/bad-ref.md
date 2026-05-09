---
name: bad refs
description: supersedes references file that does not exist in the same dir
type: project
source: 2026-05-07 fixture for refs-resolve broken case
verify_by: 2027-01-01
supersedes: [does-not-exist.md]
---

Body. refs-resolve should warn — the supersedes target is not present in fixtures/memory/.

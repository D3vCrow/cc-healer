---
name: devcrow-bin-required
description: Skill declaring required binaries that don't exist on PATH
devcrow:
  tier: light
  requires:
    binaries: [bogus_bin_xyz_abc_cc_healer, another_bogus_qwerty_cc_healer]
    env: []
---

Body. declared-binary-resolvable should warn for each unresolved binary.

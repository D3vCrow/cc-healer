---
name: devcrow-env-required
description: Skill declaring required env vars to be checked
devcrow:
  tier: light
  requires:
    binaries: []
    env: [BOGUS_TEST_ENV_VAR_A, BOGUS_TEST_ENV_VAR_B]
---

Body. declared-env-set check should warn when any listed var is unset.

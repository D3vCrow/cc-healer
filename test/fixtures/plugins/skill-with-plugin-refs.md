---
name: Skill With Plugin Refs
description: Fixture for plugin-skill-refs-exist — declares devcrow.requires.plugins
type: skill
devcrow:
  tier: light
  requires:
    plugins: [installed-plugin@some-marketplace, missing-plugin@some-marketplace]
---

Body. This fixture declares two plugin requirements; one is in the test's
pluginIndex.installedIds set, the other is not. Expected: 1 warn issue.

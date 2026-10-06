---
name: feedback rule with a nested trigger
description: Memory file with type=feedback whose trigger sits under metadata
type: feedback
source: 2026-10-06 fixture for the carrier exemption in memory-feedback-in-hot-tier
verify_by: stable
metadata:
  node_type: memory
  trigger: "hook:example-guard"
---

Body. A writer nested the unknown key under `metadata:`. The check reads it at either depth.

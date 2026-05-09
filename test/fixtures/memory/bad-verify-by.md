---
name: bad verify_by shape
description: verify_by is free-form text not matching YYYY-MM-DD or stable
type: project
source: 2026-05-07 fixture for memory verify-by-shape check
verify_by: soon
---

Body. verify_by must be `YYYY-MM-DD` or exactly `stable`; memoryVerifyByShape should warn.

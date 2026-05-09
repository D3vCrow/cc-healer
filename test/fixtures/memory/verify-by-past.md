---
name: verify_by past today
description: verify_by date 2025-01-01 is well before TEST_TODAY 2026-05-06
type: project
source: 2026-05-07 fixture for memory verify-by-past check
verify_by: 2025-01-01
---

Body. verify_by 2025-01-01 is past TEST_TODAY 2026-05-06; memoryVerifyByPast should emit info.

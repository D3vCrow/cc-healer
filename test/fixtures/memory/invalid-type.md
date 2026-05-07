---
name: invalid type memory entry
description: type field set to a value not in the Rook v2 known set
type: bogus
source: 2026-05-07 fixture for memory type-known check
verify_by: stable
---

Body. type=bogus is not one of user|feedback|project|reference|pattern|failure.

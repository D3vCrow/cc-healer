# GHSA Draft: <One-line summary of the vulnerability>

**Severity:** <Critical | High | Medium | Low> · **CVSS 3.1:** <score> (`<vector>`)
**CWE:** [CWE-XXX — Title](https://cwe.mitre.org/data/definitions/XXX.html)
**Affected versions:** `< X.Y.Z`
**Patched version:** `X.Y.Z`

## Summary

<2-4 sentences. What was the bug, in one paragraph. Cite file paths and a code excerpt if it clarifies the mechanism.>

## Impact

<What can an attacker do? Concrete attack scenarios — be specific. Who is affected (all users, users with X feature flag enabled, users scanning untrusted skill directories, etc.).>

For cc-healer the typical impact axes are:
- Filesystem read-out-of-scope (e.g. symlink traversal escaping the scanned `.claude/` tree)
- Filesystem write-out-of-scope (e.g. cc-healer ever writes during a fix-mode operation)
- Code execution via crafted skill/plugin/hook content (e.g. cc-healer ever evaluates JS/Python from a scanned file)
- Resource exhaustion (e.g. malicious skill structure causing infinite recursion or quadratic blowup)
- Information disclosure in cc-healer's JSON output (e.g. credentials surfaced in error messages)

## Patches

Fixed in **X.Y.Z**:

- <bullet: what changed in code, with file paths>
- <bullet: any default/config changes>
- <bullet: docs or migration notes>

## Workarounds

<For users on affected versions who cannot immediately upgrade. If none, write "None — upgrade immediately." and explain why no workaround exists.>

## References

- Fix PR: [#NNN](https://github.com/D3vCrow/cc-healer/pull/NNN)
- Commit: [`<short-sha>`](https://github.com/D3vCrow/cc-healer/commit/<short-sha>)

## Credit

@<reporter-handle>

---

**Author note (delete before publishing):** Replace every `<placeholder>` and the impact-axes example list with content specific to this advisory. Keep the section ordering identical across advisories — downstream scanners and changelog tooling rely on it.

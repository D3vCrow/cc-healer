# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for a suspected vulnerability.**

Use one of:

- **GitHub Security Advisories (preferred)** — private report form at <https://github.com/D3vCrow/cc-healer/security/advisories/new>. GitHub routes the report to the Maintainer, assigns a GHSA identifier, and keeps you in a private thread until the fix ships. All sensitive details (stack traces, file contents, exploit payloads) stay end-to-end within GitHub's security infrastructure — use this channel whenever possible.
- **Encrypted email (fallback)** — if GitHub is unavailable or the issue cannot be described in the GHSA form, send an encrypted message to `chr.papachristoforou@gmail.com` with subject `cc-healer security`. Encrypt with the Maintainer public key published at <https://github.com/D3vCrow.gpg>; attach your own public key so we can reply encrypted. Plaintext email is accepted only as last resort — prefer GHSA.

Include, at minimum:

- cc-healer version (commit SHA on `main` until npm publish; thereafter `cc-healer --version`).
- The affected surface — CLI command, skill check (Tier 1), memory check (Tier 2), symlink check (Tier 4), `_audit-skills` slash command, hook scaffold, or settings parser.
- A minimal reproduction — prefer one CLI invocation plus the file/directory state required (skill `.md`, memory `.md`, `settings.json`, `hooks.json`, symlink layout).
- Impact, in your own words.

## What we do with it

1. **Acknowledge** within 72 hours (target: 24).
2. **Triage** — confirm reproduction, assign a severity using CVSS 3.1, and give you a rough timeline.
3. **Fix** in a private branch. Draft a GitHub Security Advisory using `.github/security-advisories/_template.md` with the patched version, CWE, CVSS vector, affected versions, and attribution to you (unless you prefer anonymity).
4. **Coordinate disclosure** — agree a disclosure date with you. Default window is 30 days from acknowledgment for straightforward vulnerabilities, up to 90 days for ones that need a deep refactor.
5. **Publish** — release the patched version (npm once V1 ships; until then a tagged commit on `main`), publish the advisory, update `CHANGELOG.md` under a `### Security` section for the release, notify downstream scanners.

## Supported versions

cc-healer is pre-1.0 (Phase 1 dogfood as of 2026-05-09; public V1 OSS target ~2026-07-27).

| Phase | Security fixes? |
|-|-|
| Phase 1 (current) — latest commit on `main` | Yes |
| Phase 0 graduated tags | Critical / High severity only, until V1 ships |
| Pre-Phase-0 commits | No |

At V1 this policy switches to a stated LTS window per `ROADMAP.md`.

## Scope

In scope:

- The `cc-healer` CLI binary — Tier 1 skill checks, Tier 2 memory checks, Tier 4 symlink check, `_audit-skills` slash command, settings/hook parser.
- Filesystem traversal patterns when scanning `.claude/skills/`, `.claude/commands/`, `.claude/memory/`, `.claude/hooks/`, `settings.json`, `settings.local.json`.
- Skill/plugin trust boundaries — how cc-healer behaves when scanning a malicious or malformed third-party skill, plugin, or symlink target.
- The CI workflow under `.github/workflows/` (build/test pipeline; supply-chain shape).

Out of scope:

- Vulnerabilities in the agentskills.io spec itself — report to the spec maintainer.
- Vulnerabilities in third-party skills/plugins that cc-healer scans — report to those project maintainers.
- Tooling that consumes cc-healer's JSON output (tests, scripts, CI integrations) — those are downstream consumers.

## Past advisories

See [`.github/security-advisories/`](./.github/security-advisories) for advisory drafts. Published advisories (with assigned GHSA IDs) live at <https://github.com/D3vCrow/cc-healer/security/advisories>.

## Safe harbor

Good-faith research, reported privately, does not get legal heat from the project. Research targeting third-party deployments of cc-healer is not covered — that's between you and the deployer.

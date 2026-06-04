# cc-healer

> Claude Code workspace health-check CLI — lints skills, memory files, hooks, and settings.

**Status:** Functional. All five deterministic tiers are live — skills, memory, knowledge, settings, plugins — plus a propose-only `--fix` engine for the memory + knowledge tiers.

## Why

Claude Code workspaces drift. Hook scripts go missing, skill frontmatter rots, memory files lose their `verify_by:` dates, settings.json schema shifts between releases. cc-healer catches these before they bite.

Some checks encode specific conventions — Rook-style memory frontmatter (`verify_by:` dates, typed entries) and `devcrow:` skill blocks. A skill that doesn't use them is flagged at `info` severity, never as an error.

Parser shape (`validate_skill.py`) lifted from [skill-forge](https://github.com/AgriciDaniel/skill-forge) (vet 2026-04-26).

## Roadmap

| Phase | Window | What |
|---|---|---|
| **V0 — Scaffolding** | 2026-05-01 → 2026-05-10 | Repo, parser port, smoke CLI |
| **V1 — `/_audit-skills` (internal)** | 2026-05-11 → 2026-06-08 | Full skill-frontmatter linter, JSON output |
| **V2 — Full sweep** | 2026-06-08 → 2026-06-29 | Memory + hooks + settings + plugin checks |
| **V3 — Public OSS** | 2026-06-29 → 2026-07-27 | npm publish + GH release |
| **V4 — Pro pack** | 2026-07-27 → 2026-09-15 | Advanced rules + custom rubrics; pricing TBD |

Verify gate: 2026-08-01.

## Quick start

```bash
npm install
npm run build
node dist/cli.js --help
```

Each tier has a sensible default path — run from your workspace root, or pass an explicit path / `--workspace <dir>`:

```bash
node dist/cli.js --tier skills       # lint ~/.claude/commands
node dist/cli.js --tier memory       # lint the project memory dir
node dist/cli.js --tier settings     # lint ~/.claude/settings.json
node dist/cli.js --tier knowledge --workspace <dir>   # lint <dir>/knowledge
node dist/cli.js --tier memory --json                 # machine-readable findings
node dist/cli.js --tier memory --fix                  # propose fixes (propose-only)
node dist/cli.js --tier memory --fix --write          # apply the proposed fixes
```

The exit code counts errors only — warnings and info never fail a run.

## Architecture

```
src/
├── cli.ts                  # Entry, arg parsing, tier resolution, report output
├── types.ts                # Shared Issue / report types
├── memory-indexes.ts       # Cross-file index for the memory tier
├── parser/
│   └── frontmatter.ts      # Zero-dep frontmatter parser (skill-forge shape)
├── checks/
│   ├── skills.ts           # Tier 1 — skill frontmatter
│   ├── memory.ts           # Tier 2 — Rook memory frontmatter + index parity
│   ├── knowledge.ts        # KB tier — knowledge/ verify-by + ref resolution
│   ├── settings.ts         # Tier 3 — settings.json + hooks
│   └── plugins.ts          # Tier 4 — install integrity
├── skills/
│   └── registry.ts         # Skill-check registry
└── fix/                    # Propose-only --fix engine (memory + knowledge)
    ├── index.ts            # proposeFixes / applyProposals
    └── refsResolve.ts      # Cross-ref resolution fixer
```

## Design principles

- **Deterministic.** No LLM calls. Parses, validates, reports. Fast + free.
- **Zero runtime deps.** TypeScript stdlib only. No YAML library — hand-rolled parser per skill-forge precedent.
- **Read-only by default.** `--fix` proposes only; nothing is written without explicit `--write`.
- **Local-only.** No telemetry. No cloud. All checks run on your machine.
- **Schema additive.** New checks layer in; existing ones don't break.

## License

MIT — by DevCrow.

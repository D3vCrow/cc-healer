# cc-healer

> Claude Code workspace health-check CLI — lints skills, memory files, hooks, and settings.

**Status:** Functional. All five deterministic tiers are live — skills, memory, knowledge, settings, plugins — plus a propose-only `--fix` engine for the memory + knowledge tiers. Built on the locked design at `docs/handoffs/2026-04-19-audit-skills-design.md` (workspace-internal).

## Why

Claude Code workspaces drift. Hook scripts go missing, skill frontmatter rots, memory files lose their `verify_by:` dates, settings.json schema shifts between releases. cc-healer catches these before they bite.

Built on the locked design at `docs/handoffs/2026-04-19-audit-skills-design.md` and the `validate_skill.py` parser shape lifted from [skill-forge](https://github.com/AgriciDaniel/skill-forge) (vet 2026-04-26).

## Roadmap

| Phase | Window | What |
|---|---|---|
| **V0 — Scaffolding** | 2026-05-01 → 2026-05-10 | Repo, parser port, smoke CLI |
| **V1 — `/_audit-skills` (internal)** | 2026-05-11 → 2026-06-08 | Full skill-frontmatter linter, JSON output |
| **V2 — Full sweep** | 2026-06-08 → 2026-06-29 | Memory + hooks + settings + plugin checks |
| **V3 — Public OSS** | 2026-06-29 → 2026-07-27 | npm publish + GH release |
| **V4 — Pro pack ($29)** | 2026-07-27 → 2026-09-15 | Advanced rules + custom rubrics |

Verify gate: 2026-08-01.

## Quick start (V0 smoke)

```bash
npm install
npm run dev -- "$HOME/.claude/commands"     # macOS / Linux / Git Bash
npm run dev -- "%USERPROFILE%/.claude/commands"   # Windows cmd
```

V0 outputs:
- Count of `.md` files scanned
- Count of files with frontmatter
- Errors (parser failures, missing `description`)

That's it for V0. V1 adds the full check catalog from the spec.

## Architecture (V1+)

```
src/
├── cli.ts                  # Entry, arg parsing, output formatting
├── parser/
│   └── frontmatter.ts      # Lifted from skill-forge validate_skill.py shape
├── checks/
│   ├── skills.ts           # Tier 1 — skill frontmatter
│   ├── memory.ts           # Tier 2 — Rook v2 frontmatter + index parity
│   ├── knowledge.ts        # KB tier — knowledge/ verify-by + ref resolution
│   ├── settings.ts         # Tier 3 — settings.json + hooks
│   └── plugins.ts          # Tier 4 — install integrity
└── output/
    ├── text.ts             # Default colored report
    └── json.ts             # --json
```

Full spec: `docs/cc-healer-v1-spec.md` (workspace-internal).

## Design principles

- **Deterministic.** No LLM calls. Parses, validates, reports. Fast + free.
- **Zero runtime deps.** TypeScript stdlib only. No YAML library — hand-rolled parser per skill-forge precedent.
- **Read-only by default.** `--fix` deferred to V2 with explicit safe-set.
- **Local-only.** No telemetry. No cloud. All checks run on your machine.
- **Schema additive.** New checks layer in; existing ones don't break.

## License

MIT — by DevCrow.

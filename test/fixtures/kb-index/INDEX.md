# Knowledge Index (fixture)

Exercises every link form buildKnowledgeIndex has to normalize.

## Research
- [Plain knowledge-root-relative](research/2026-01-01-foo.md) — the common form.
- [Workspace-relative](knowledge/research/2026-01-02-bar.md) — leading `knowledge/` must be stripped.
- [Dot-slash prefixed](./research/2026-01-03-baz.md) — leading `./` must be stripped.
- [Backslash separators](research\2026-01-04-qux.md) — Windows-style path must normalize.
- [Root-level doc](project-status.md) — no directory segment.

## Not links
A bare mention of research/2026-01-05-not-a-link.md must NOT count as indexed.
A non-markdown link like [the repo](https://example.com/x.html) must be ignored.

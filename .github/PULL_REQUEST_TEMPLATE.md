## What & why

<!-- What does this change, and why? Link any issue, e.g. Fixes #123 -->

## Testing

- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] Added/updated tests (every bug fix has a failing-then-passing test)

## Checklist

- [ ] No secrets or real API keys in the diff
- [ ] `src/models.json` not hand-edited (regenerated via `bun run sync:models` if it changed)
- [ ] README updated if user-visible behavior changed
- [ ] `CHANGELOG.md` `[Unreleased]` updated
- [ ] Respects the invariants in `AGENTS.md` (hash discipline, `0600` file, verbatim amounts, privacy boundary)

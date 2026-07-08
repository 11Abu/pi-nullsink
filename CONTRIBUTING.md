# Contributing to pi-nullsink

Thanks for helping improve pi-nullsink — the terminal-native client for
[nullsink](https://nullsink.is). This is a small, focused extension; the bar is **correctness and
honesty** (it moves real money and makes privacy claims), not feature volume.

New to the codebase? Read [`AGENTS.md`](AGENTS.md) for the architecture and invariants, and
[`docs/design.md`](docs/design.md) for the normative design.

## Setup

```sh
bun install
```

Requires [Bun](https://bun.sh). Pi's runtime is Node ≥22; the extension is written to run there.

## The loop

```sh
bun test            # unit tests for the pure cores + a mock-nullsink integration
bun run typecheck   # tsc --noEmit, strict
```

Both must be green before you open a PR — CI runs exactly these on every push and PR.

## How we work

- **Test-driven.** Write a failing test first, make it pass with the minimal change, then refactor.
  **Every bug fix starts with a failing test** that reproduces the bug.
- **Pure cores decide; thin shells execute.** Put decision logic in a pure, tested function
  (`config.ts`, `token.ts`, the `wallet.ts` reducer, `ui/hub-model.ts`) rather than in a shell. See
  the file map in [`AGENTS.md`](AGENTS.md).
- **`src/models.json` is generated — never hand-edit it.** Regenerate and review the diff:
  ```sh
  bun run sync:models
  git diff src/models.json
  ```
- **Respect the invariants** in [`AGENTS.md`](AGENTS.md): hash discipline, the `0600` key file, env
  precedence, verbatim amounts, and the honest privacy boundary. Weakening one needs a very good
  reason and a test.

## Branching & merging

- **`main` is the trunk and is always releasable** — every commit on it must pass CI.
- **Anything beyond a trivial one-line fix goes through a branch and a PR**: features, fixes that
  touch more than one file, removals, doc restructures. Name the branch after the commit type:
  `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>`, `chore/<slug>`. When in doubt,
  branch.
- **Squash-merge on GitHub.** The PR title uses the same `type: summary` style and becomes the
  single commit on `main` — history stays linear, one commit per change. Delete the branch after
  merging and update your checkout with `git pull --ff-only`.
- **Never force-push `main` or rewrite published history.** Fix forward: a revert or a follow-up
  commit.
- **Releases** happen on `main`: bump `package.json`, move `[Unreleased]` into a dated
  `## [x.y.z]` section (and update the compare links), commit, then tag `vx.y.z`.

## Pull requests

- Keep PRs small and focused; describe what changed and why.
- Tests and typecheck pass; add tests for new behavior and for every fix.
- Update the [README](README.md) when user-visible behavior changes, and add a `## [Unreleased]`
  entry to [`CHANGELOG.md`](CHANGELOG.md).
- **Never commit secrets.** No API keys, `.env` files, or real nullsink keys — a key is spendable
  money. Don't paste a real key into code, tests, or a PR.
- Commit messages follow the existing `type: summary` style (`feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`).

## Reporting

- Bugs and ideas → [open an issue](https://github.com/11Abu/pi-nullsink/issues) using a template.
- Security or key-handling concerns → **do not** open a public issue; see [`SECURITY.md`](SECURITY.md).
- By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

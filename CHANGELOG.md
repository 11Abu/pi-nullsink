# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Rewrote the README to lead with what nullsink is and why, added a table of contents, and
  consolidated the privacy sections.

### Added

- A recorded terminal demo (`assets/demo.gif`) with a reproducible `vhs` recipe — `bun run
  demo:record`, driven by `scripts/demo/hub-demo.ts` against the real hub renderer.
- Project documentation and GitHub scaffolding: `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `AGENTS.md`, a `docs/` index, and CI + issue/PR templates.
- The git workflow standard — branch → PR → squash-merge onto a linear `main` — codified in
  `CONTRIBUTING.md` ("Branching & merging") and `AGENTS.md` ("Shipping changes").

### Removed

- **Incognito mode** — the `/nullsink incognito` command, the Settings → Privacy toggle, the
  `always` startup swap, and the `⦿ incognito` status badge. A retired `incognito` key in
  `~/.pi/agent/nullsink.json` is dropped on the next save.
- The README's "Routing through Tor" section — it documented Pi's own `httpProxy` / `HTTP_PROXY`
  support and had no extension code; all extension HTTP still rides Pi's global dispatcher.
- Retired the internal working docs (v0.1 config/UI design, the v0.2 implementation plan, the v0.3
  scoping proposal) from the tree; they remain in git history.

## [0.3.0] — 2026-07-07

### Changed

- Load `src/models.json` at runtime instead of via a static JSON import, so extension hosts that
  transpile modules can no longer silently reject it and kill the extension.
- Split the oversized `index.ts` into `host.ts` (hub side effects) and `commands.ts` (subcommands +
  non-TUI fallbacks), leaving `index.ts` as the wiring shell.
- Cleared the deferred v0.2 hardening items across the token, config, order-watch, and hub cores.

### Added

- Documented routing Pi through Tor via its built-in HTTP proxy support (README → "Routing through
  Tor"), plus `docs/upstream-asks.md` tracking the upstream `.onion` ask.

### Fixed

- Model switching between nullsink providers.
- Paste-input decoding in the hub.

## [0.2.0] — 2026-07-03

Turned the extension from "provider + balance readout" into a full terminal client for nullsink.

### Added

- Native, in-terminal key **mint** — generated locally from the OS CSPRNG, shown once.
- **Top-up wizard** (amount → coin → pay): a half-block QR of the payment URI, the destination
  address, a locked quote with an expiry countdown, and a live order ticker
  (`waiting → confirming n/m → finalizing`).
- **Cross-session order resume** — a pending top-up resumes automatically on the next start, up to a
  24h backstop.
- **Trocador AnonPay** hand-off to pay in any coin; the hand-off carries no key and no hash.
- Full-screen tabbed **hub** (`/nullsink`): Settings · Wallet · Models.
- **Key profiles** — each a named wallet with its own key and pending order.
- **Incognito** mode — stop persisting the session transcript, with `off` / `always` modes.
- Default model + thinking level, per-provider visibility toggles, a session-spend readout and
  warning, a low-balance threshold, and a configurable refresh interval.

### Changed

- Config schema v2 (profiles, pending orders) with automatic migration from v1 and atomic `0600`
  writes.

## [0.1.0] — 2026-07-01

### Added

- Three nullsink providers — `nullsink` (Anthropic Messages), `nullsink-openai`, and
  `nullsink-tinfoil` (OpenAI Chat Completions) — served through nullsink's `/v1` proxy on a single
  bearer key.
- Persistent `0600` config at `~/.pi/agent/nullsink.json` with a guided first-run setup: enter the
  key once and it persists across sessions and shells.
- A live balance status readout under the editor.

[Unreleased]: https://github.com/11Abu/pi-nullsink/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/11Abu/pi-nullsink/releases/tag/v0.3.0
[0.2.0]: https://github.com/11Abu/pi-nullsink/releases/tag/v0.2.0
[0.1.0]: https://github.com/11Abu/pi-nullsink/releases/tag/v0.1.0

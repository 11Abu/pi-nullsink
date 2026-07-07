# AGENTS.md

Orientation for AI agents (and humans) working in this repo. For end-user documentation, read the
[README](README.md); for the normative design, read [`docs/design.md`](docs/design.md).

## What pi-nullsink is

A [Pi coding-agent](https://pi.dev) extension that lets you use frontier **Anthropic**, **OpenAI**,
and **Tinfoil** models through [**nullsink**](https://nullsink.is) — an anonymous, account-less,
crypto-paid metered reverse proxy (no account, no IP logs, no request logs). The extension registers
three providers against nullsink's `/v1` endpoint and brings nullsink's full browser flow into the
terminal: mint a bearer key, fund it with Monero/Bitcoin (live-tracked QR payment), manage wallets,
and change every setting from a full-screen `/nullsink` hub.

It is a **client extension only**. nullsink itself (the service, AGPL-3.0) lives in a separate repo;
this extension talks to it over four public HTTP endpoints and is MIT-licensed.

## Architecture

**Pure cores decide; thin shells execute.** All decision logic lives in pure, side-effect-free,
unit-tested functions. The shells only wire events, do I/O, and render. Preserve this split when you
change anything — if you find yourself adding a branch to a shell, it probably belongs in a core with
a test.

| File | Role | Kind |
| --- | --- | --- |
| `src/index.ts` | Extension entry: event wiring, command + provider registration, timers | shell |
| `src/host.ts` | Hub host — session state, `apply(effects)`, order-watch/balance timers, mint/profile ops | shell |
| `src/commands.ts` | `/nullsink` subcommand handlers + non-TUI dialog/text fallbacks | shell |
| `src/store.ts` | The **only** filesystem writer: `~/.pi/agent/nullsink.json`, atomic, `0600` | shell |
| `src/incognito.ts` | Transcript-persistence control, built on Pi's own session primitives | shell |
| `src/models.ts` | Runtime loader for `models.json` (deliberately not a static JSON import) | shell |
| `src/config.ts` | Endpoint resolution, provider assembly, balance interpretation, renderers | **pure** |
| `src/token.ts` | nullsink token generate / checksum / validate / `sha256` (node:crypto only) | **pure** |
| `src/wallet.ts` | nullsink money API client + the order-watch reducer (reducer is pure) | mixed |
| `src/ui/hub.ts` | `ctx.ui.custom` shell: input → `reduceHub` → effects → re-render | shell |
| `src/ui/hub-model.ts` | Pure hub model: rows, tabs, key reducer, top-up wizard machine | **pure** |
| `src/ui/hub-render.ts` | Pure `(state, data, width, now) → lines`; styling via a `ThemeLike` stub | **pure** |
| `src/ui/layout.ts` | ANSI-aware layout math | **pure** |
| `src/ui/qr.ts` | Terminal QR (half-block unicode via `uqr`) | **pure** |
| `src/models.json` | **Generated** cost + capability catalog — never hand-edit | data |

## Invariants — do not break these

1. **`src/models.json` is generated.** Never hand-edit it. Regenerate with `bun run sync:models`
   (nullsink price snapshot × [models.dev](https://models.dev)) and commit the diff. The script fails
   loudly rather than guessing an unknown model's limits.
2. **Hash discipline.** The raw key goes on the wire **only** to `/balance` and `/v1`. The money
   endpoints (`/buy`, `/order-status`) see `sha256(key)` (lowercase hex) — never the raw key.
3. **The `0600` file holds spendable money.** `store.ts` is the sole writer; keep the mode `0600` and
   the write atomic. Never log, echo, or widen access to the key.
4. **Env precedence.** `NULLSINK_API_KEY` beats the active profile's key; `NULLSINK_BASE_URL` beats
   the saved base URL. Env-only users must never see a setup prompt.
5. **Amounts are verbatim strings.** Never parse, round, or reformat `amount` / `received` /
   `expected` from the wallet API — display exactly as received.
6. **`closed` is ambiguous** (credited, reaped, or never existed). On `closed`, `/balance` is the
   authoritative outcome.
7. **The honest privacy boundary.** Incognito stops the **transcript, and only the transcript** —
   not scrollback, shell history, or file writes. Proxy routing is fail-closed (Pi's single global
   dispatcher covers every request or none). Don't let docs or UI overstate either.
8. **TDD.** Every bug fix starts with a failing test that reproduces it; new pure logic ships with
   unit tests. Token correctness is pinned by recorded cross-implementation vectors.

## Build & test

```sh
bun install
bun test            # unit tests for the pure cores + a mock-nullsink integration
bun run typecheck   # tsc --noEmit (strict)
bun run sync:models # regenerate src/models.json (review the diff before committing)
```

Runtime is Node ≥22 (Pi's host); the repo is developed and tested with [Bun](https://bun.sh). The
only runtime dependency is `uqr` (MIT, zero-dep) for QR matrices.

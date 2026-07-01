# pi-nullsink — persistent config + status UI

Design for adding (A) a persistent, editable config with a guided first-run setup, and (B) an
on/off status readout under the editor. Approved 2026-07-01.

## Goal

The nullsink key is bearer-only and spendable with no refunds. The user should enter it **once**,
have it persist, and edit it any time — never retype it per shell. Surface the balance where they
work; link out to funding (nullsink's own browser+crypto flow) rather than moving money from the CLI.

## Scope

- **In:** guided first-run setup → persist → edit anytime; fields = API key, base URL, display mode;
  balance surfaced + a "top up at nullsink.is" pointer.
- **Out:** performing top-ups. Minting/funding is anonymous crypto in the browser; a CLI can't drive
  it safely. The extension shows balance and links to funding; it never moves money.

## Config store

File `~/.pi/agent/nullsink.json`, mode `0600`:

```json
{ "apiKey": "0sink_…", "baseUrl": "https://nullsink.is", "display": "statusline", "setupDone": true }
```

Resolution precedence (both directions):
- **API key:** `NULLSINK_API_KEY` env → file `apiKey` → none.
- **Base URL:** `NULLSINK_BASE_URL` env → file `baseUrl` → `https://nullsink.is`.
- **Display:** file `display` → `statusline`.

At startup the extension loads the file and, only when the env var is unset, injects the file key
into `process.env.NULLSINK_API_KEY` so pi's per-request resolver (`$NULLSINK_API_KEY`) finds it.
Env always wins; env-only users are unaffected. `setupDone` gates the one-time auto-prompt.

## Security

Key persists plaintext at `~/.pi/agent/nullsink.json`, `0600` (owner-only) — same directory and
trust boundary as pi's own `auth.json`/`secrets/`. Never rendered in full (masked to `0sink_…last4`).
One-time on-save warning that the key is spendable with no refunds. Rejected pi AuthStorage: no
stable extension API to inject a bearer for a custom env-keyed provider; the file+env path is exactly
what pi's resolver already reads.

## First-run guided setup

Trigger: interactive session, no env key, `setupDone` not set. Flow (via `ctx.ui`):
1. Explain: anonymous, account-less, key = money, no refunds.
2. `select`: "I have a key" / "Mint one at nullsink.is (opens browser)" / "Skip for now".
3. On key entry: validate `TOKEN_RE`; on mismatch, confirm "save anyway?".
4. Save (`setupDone: true`), fetch balance, confirm. Skipping also sets `setupDone` so it never nags.
Re-runnable any time via `/nullsink setup`.

## `/nullsink` command surface

`balance` (default) · `models` · `setup` · `config` · `help`.

`config` menu (`select` → `input`):
- **API key** — masked display; validate; write file; update `process.env`; refetch balance.
- **Base URL** — validate URL; write file; **re-register** the 3 providers live (URL is baked into
  model defs, so a re-register is required; post-load `registerProvider` needs no `/reload`).
- **Display mode** — `statusline | widget | both | off`.
- **Clear saved config** — confirm; delete file; unset the env key **only if we injected it**.

## Displays (`display` config)

- `statusline` — footer line via `ctx.ui.setStatus`:
  `nullsink ● $42.50` · `nullsink ⚠ $0.80 · top up` (<$1) · `nullsink ⚠ unfunded` (401) ·
  `nullsink ○ no key · /nullsink setup`.
- `widget` — 2 lines above editor via `ctx.ui.setWidget`: balance line + masked key / `/nullsink config`.
- `both` — set both. `off` — clear both.

## Balance refresh cadence

Fetch on `session_start` (if a key exists), after `/nullsink balance` and config edits, and throttled
after `turn_end` (≥60s since last fetch). All non-blocking with a short timeout; never adds
per-message latency. A `session_shutdown` handler clears any pending timer/state.

## Module layout

- `store.ts` — the `0600` file I/O (read/write/clear), returns a validated `StoredConfig | null`.
- `config.ts` — **pure** additions: `maskKey`, `parseStoredConfig`, `resolveApiKey`/`resolveBaseUrl`
  precedence, `renderStatusLine`, `renderWidget`, `DISPLAY_MODES` + validator. All unit-tested.
- `index.ts` — wiring: startup load/inject, setup flow, config menu, status render + refresh,
  shutdown cleanup.

## Testing

Tester covers the new pure helpers: masking (short/normal/empty), `parseStoredConfig`
(valid/partial/garbage/wrong-types), precedence (env vs file vs default, both fields), display
validation, and every `renderStatusLine`/`renderWidget` state. Live setup/menu/status verified by a
scripted pi run against the mock nullsink.

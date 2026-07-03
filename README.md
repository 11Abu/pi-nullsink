# pi-nullsink

Use frontier **Anthropic**, **OpenAI**, and **Tinfoil** models in the [Pi coding agent](https://pi.dev)
through [**nullsink**](https://nullsink.is) — an anonymous, account-less, crypto-paid metered reverse
proxy. No account, no IP logs, no request logs. You mint a bearer key **in the terminal**, fund it
with Monero or Bitcoin from the same hub, and Pi calls the models through it.

## Install

```sh
pi install npm:pi-nullsink
```

On first launch it runs a short **guided setup** — mint a fresh key **right in the terminal**, paste
one you already have, or skip. No browser required. Your key is saved to `~/.pi/agent/nullsink.json`
(mode `0600`) so you enter it **once** and never again — it persists across sessions and shells.
Re-run any time with `/nullsink setup`.

Then just `/nullsink` — it opens the **hub**, a full-screen tabbed control panel where you mint keys,
top up, switch wallets, and change every setting.

Prefer environment variables? Set one and setup won't prompt (env always wins over the saved file):

```sh
export NULLSINK_API_KEY=0sink_your_key_here
```

Either way: pick a model with `/model` (they appear as **nullsink · Anthropic / OpenAI / Tinfoil**)
and chat as usual. A status line under the editor shows your live balance; check it any time with
`/nullsink`.

## What you get

The extension registers three providers, all authenticated with the same `NULLSINK_API_KEY` and
routed through nullsink's `/v1` proxy:

| Provider | API surface | Models |
| --- | --- | --- |
| `nullsink` | Anthropic Messages | Claude Opus / Sonnet / Haiku / Fable |
| `nullsink-openai` | OpenAI Chat Completions | GPT-5.x, GPT-4.x, o-series |
| `nullsink-tinfoil` | OpenAI Chat Completions (sealed-enclave) | GLM, Kimi, gpt-oss, Llama, Gemma |

The full, current model list is in [`src/models.json`](src/models.json) and via `/nullsink models`.

### The hub

`/nullsink` opens a full-screen, tabbed panel — everything nullsink.is can do, in the terminal:

```
/nullsink ─┬─ ⚙ Settings   Account · Connection · Model · Display · Privacy
           ├─ ◈ Wallet     balance · profiles · top up · mint · pending order
           └─ ▤ Models     every served model, filter-as-you-type, pick a default
```

`tab` / `shift-tab` (or `←→` when no row is being edited) switch tabs; `esc` backs out of an inline
edit or wizard step, then closes. Every change applies live and persists immediately, and the footer
always explains the focused item.

### `/nullsink` commands

Each tab is reachable as a subcommand, so you can skip the hub when you know what you want:

- `/nullsink balance` — remaining USD credit.
- `/nullsink models` — list every served model, grouped by provider.
- `/nullsink setup` — the guided key setup (mint / paste / skip).
- `/nullsink config` — open the hub (same as bare `/nullsink`).
- `/nullsink topup` — fund the active key (amount → coin → pay).
- `/nullsink pay` — reopen the pay screen for a pending order.
- `/nullsink mint` — generate a fresh key locally (shown once).
- `/nullsink incognito` — stop saving this session's transcript.
- `/nullsink help` — the command list.

## Top up from the terminal

nullsink.is's funding flow, rendered natively in the TUI — no browser needed. `/nullsink topup`
(or **◈ Wallet → Top up**) runs a three-step wizard:

1. **Amount** — presets **$10 / $25 / $50 / $100**, or type a custom value. Orders are **$2–$100**.
2. **Coin** — pick a pay rail from nullsink's live `/rails` (cached per session; Monero is always
   available as a fallback).
3. **Pay** — a half-block **QR** of the payment URI, the destination address, the exact amount and
   unit, the locked rate, and an expiry countdown. Send the crypto from your own wallet. Press `[t]`
   to hand off to **Trocador AnonPay** and pay in *any* coin — the destination is locked to this
   order's address and amount, and the hand-off carries **no key and no hash**. `esc` backgrounds the
   order; nullsink keeps watching.

While an order is in flight the status line tickers **`⧗ waiting` → `⧗ confirming n/m` →
`⧗ finalizing`**. The order is saved to your profile, so if you close the terminal mid-confirmation
it **resumes automatically** the next time you start Pi (up to a 24h backstop). When the credit lands
you get a notice and the balance updates; `/nullsink pay` reopens the pay screen for a pending order
at any time.

## Incognito

`/nullsink incognito` stops Pi from **writing the current session's transcript to disk** — it acts on
the session you're in right now, and a `⦿ incognito` badge appears in the status line. The **⚙ Settings
→ Privacy → Incognito** toggle is different: it sets the incognito **mode** for *future* sessions and
does **not** touch the session you're already in. Set it to **`always`** and every *fresh* session
goes incognito automatically at start-up, with a one-time notice.

**The honest boundary.** Incognito covers the **transcript, and only the transcript**. These stay
exactly as they were:

- **Terminal scrollback** — whatever your terminal itself keeps on screen.
- **Shell history** — a one-shot `pi "my prompt"` still lands in your shell's history.
- **Files the agent edits** — real writes to your repo are untouched.

nullsink's own no-account / no-logs model covers the network side. Our config writes — your key and
any pending-order metadata — are *settings*, not transcript, and continue as normal. And a **resumed
session is never silently swapped**: continue an existing session with `always` on and you get a
notice ("resumed session is still being saved; start fresh for incognito") rather than a false
sense of privacy.

## Config & status display

The hub's **⚙ Settings** tab groups every setting under a section rail; changes apply live and
persist immediately. A **profile is a named wallet** — its own key and its own pending order, while
everything else is global — so you can switch, add, rename, or delete profiles in **◈ Wallet**.

| Section | Setting | Default | Notes |
| --- | --- | --- | --- |
| Account | API key | — | masked `0sink_…w4Tz`; paste to replace |
| Account | Low-balance warning | `$1.00` | warn in the status line below this |
| Account | Session spend warning | off | warn once when this session's cost crosses it |
| Connection | Base URL | `https://nullsink.is` | self-hosted forks; re-registers providers live |
| Connection | Anthropic / OpenAI / Tinfoil models | all on | show or hide a provider's models in `/model` |
| Model | Default model | none | applied once at session start |
| Model | Default thinking | off | applied at session start (clamped to the model) |
| Display | Status display | `statusline` | `statusline / widget / both / off` |
| Display | Show session spend | off | append this session's nullsink cost to the readout |
| Display | Refresh interval | `60s` | post-turn balance re-check throttle (min 15) |
| Privacy | Incognito | `off` | `off / always` |

**Environment overrides win.** `NULLSINK_API_KEY` beats the active profile's key and
`NULLSINK_BASE_URL` beats the saved Base URL; when either is set the matching row is shown read-only
with an `(env)` tag, and env-only users never see a setup prompt.

The **balance readout** updates on session start, after balance / config / wallet actions, and
(throttled) after each turn — never adding per-message latency. States: `● $42.50` (funded) ·
`⚠ $0.80 · top up` (below your threshold) · `⚠ unfunded · /nullsink topup` (key set, no confirmed
deposit) · `⚠ balance unavailable` (couldn't reach nullsink) · `○ no key · /nullsink setup`. A
`⦿ incognito` prefix and a `⧗ …` order suffix decorate the line as needed.

No TUI? Every command still works: the hub falls back to a dialog menu (or plain text). `mint`
prints your new key once plus a funding hint; `topup` / `pay` print the address, amount, payment
URI, and a scannable text QR as plain lines.

## Pricing is exact

Per-request cost shown in Pi matches what nullsink actually deducts from your balance. nullsink meters
**pure upstream cost with no markup** — the small margin is applied only when you top up, not per
request ([billing model](https://github.com/nullsink/nullsink/blob/main/docs/billing-model.md)). The
cost table in `src/models.json` is taken verbatim from nullsink's own price snapshot, so Pi's spend
readout and your balance stay in agreement.

> Every request must set a max output tokens — Pi always does, so this is automatic.

## Self-hosting a fork

Running your own nullsink deployment? Point the extension at it:

```sh
export NULLSINK_BASE_URL=https://your-instance.example
```

The default is `https://nullsink.is`. The value may be the origin (`https://host`) or the OpenAI base
(`https://host/v1`) — both resolve correctly. You can also set it interactively via the hub's
**Connection → Base URL** row, which re-registers the providers immediately.

## Privacy note

Your key **is** your money and your only identity. It's minted **locally** — generated from your
operating system's CSPRNG, so it never has to be created anywhere but your own machine — and saved at
rest in `~/.pi/agent/nullsink.json` (mode `0600`, owner-only), the same directory and trust boundary
as Pi's own credentials. It's shown masked (`0sink_…w4Tz`) in all UI.

**Hash discipline.** The raw key leaves your machine only as the `x-api-key` /
`Authorization: Bearer` header to `/balance` and `/v1`, over TLS — the same way the official
Anthropic/OpenAI SDKs send an API key. When you fund it, the top-up calls (`/buy`, `/order-status`)
only ever see `sha256(key)` (lowercase hex), never the key itself.

That same `0600` file also stores **pending-order metadata** for an in-flight top-up — the pay-to
address, amounts, coin, and quote — so an order can resume across restarts. It holds no secret beyond
the key itself.

Review the [trust model](https://github.com/nullsink/nullsink/blob/main/docs/trust-model.md) for what
nullsink does and does not protect.

## Maintenance

`src/models.json` is generated — never hand-edit it. Regenerate from nullsink's price snapshot
(cost) joined with [models.dev](https://models.dev) (capabilities):

```sh
bun run sync:models   # rewrites src/models.json
git diff src/models.json
```

The script fails loudly if nullsink prices a model that models.dev doesn't yet describe, so a new
model never ships with guessed context/output limits.

```sh
bun run typecheck     # tsc --noEmit
bun test              # unit tests for the pure core
```

## License

MIT. nullsink itself is AGPL-3.0-or-later; this is an independent client extension.

# pi-nullsink

Use frontier **Anthropic**, **OpenAI**, and **Tinfoil** models in the [Pi coding agent](https://pi.dev)
through [**nullsink**](https://nullsink.is) — an anonymous, account-less, crypto-paid metered reverse
proxy. No account, no IP logs, no request logs. You mint a bearer key in your browser, fund it with
Monero or Bitcoin, and Pi calls the models through it.

## Install

```sh
pi install npm:pi-nullsink
```

On first launch it runs a short **guided setup** — mint & fund a key at
[nullsink.is](https://nullsink.is), or paste one you already have. Your key is saved to
`~/.pi/agent/nullsink.json` (mode `0600`) so you enter it **once** and never again — it persists
across sessions and shells. Re-run any time with `/nullsink setup`, or edit it later with
`/nullsink config`.

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

### `/nullsink` command

- `/nullsink` or `/nullsink balance` — fetch your remaining USD credit (`GET /balance`).
- `/nullsink models` — list every served model, grouped by provider.
- `/nullsink setup` — re-run the guided key setup (mint / paste / skip).
- `/nullsink config` — edit your key, base URL, or status display; or clear the saved config.
- `/nullsink help` — the command list.

### Config & status display

`/nullsink config` opens an interactive menu:

- **API key** — shown masked (`0sink_…w4Tz`); paste a new one to replace it. Takes effect on your
  next message.
- **Base URL** — for self-hosted forks; re-registers the providers on the spot.
- **Display** — how the balance readout appears: `statusline` (a footer line, default), `widget`
  (a two-line block above the editor), `both`, or `off`.
- **Clear saved config** — removes `~/.pi/agent/nullsink.json`.

The readout updates on session start, after `/nullsink balance` and config edits, and (throttled)
after each turn — never adding per-message latency. States: `● $42.50` (funded) · `⚠ $0.80 · top up`
(low) · `⚠ unfunded` (key set, no confirmed deposit) · `○ no key` (run setup).

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
(`https://host/v1`) — both resolve correctly. You can also set it interactively via `/nullsink config`
→ Base URL, which re-registers the providers immediately.

## Privacy note

Your key **is** your money and your only identity. It's saved at rest in `~/.pi/agent/nullsink.json`
(mode `0600`, owner-only) — the same directory and trust boundary as Pi's own credentials — and leaves
your machine only as the `x-api-key` / `Authorization: Bearer` header to the nullsink proxy over TLS,
the same way the official Anthropic/OpenAI SDKs send an API key. It's shown masked (`0sink_…w4Tz`) in
all UI. Review the
[trust model](https://github.com/nullsink/nullsink/blob/main/docs/trust-model.md) for what nullsink
does and does not protect.

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

// pi-nullsink — route pi through nullsink (https://nullsink.is), the anonymous, account-less,
// crypto-paid metered proxy for frontier Anthropic / OpenAI / Tinfoil models. One bearer key,
// no account, no IP or request logs.
//
// Install:  pi install npm:pi-nullsink
// Set key:  export NULLSINK_API_KEY=0sink_...   (mint one at https://nullsink.is)
// Use:      /model  → pick a "nullsink · …" model, then chat as usual.
//           /nullsink → check balance / list models / setup help.
import process from "node:process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  API_KEY_ENV,
  BASE_URL_ENV,
  buildProviders,
  interpretBalance,
  type ModelsFile,
  PROVIDER_IDS,
  resolveEndpoints,
  TOKEN_RE,
} from "./config.ts";
import modelsData from "./models.json";

const models = modelsData as ModelsFile;

// How long a /balance check may run before we give up (the command is otherwise unbounded).
const BALANCE_TIMEOUT_MS = 8000;

export default function nullsink(pi: ExtensionAPI): void {
  const endpoints = resolveEndpoints(process.env[BASE_URL_ENV]);
  for (const { name, config } of buildProviders(models, endpoints)) {
    pi.registerProvider(name, config);
  }

  pi.registerCommand("nullsink", {
    description: "nullsink: balance | models | setup",
    getArgumentCompletions(prefix) {
      const items = ["balance", "models", "setup"].map((value) => ({ value, label: value }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "models") return showModels(ctx);
      if (sub === "setup" || sub === "help") return showSetup(ctx, endpoints.site);
      return checkBalance(ctx, endpoints.balance);
    },
  });
}

// Route output through the TUI when present; fall back to stdout in print/JSON mode where notify
// is a no-op and writing to the terminal is safe.
function emit(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

async function checkBalance(ctx: ExtensionCommandContext, balanceUrl: string): Promise<void> {
  const key = process.env[API_KEY_ENV]?.trim();
  if (!key) {
    emit(ctx, `${API_KEY_ENV} is not set. Run /nullsink setup for instructions.`, "warning");
    return;
  }
  if (!TOKEN_RE.test(key)) {
    emit(ctx, `${API_KEY_ENV} doesn't look like a nullsink key (expected "0sink_…"). Checking anyway…`, "warning");
  }

  let status: number;
  let body: unknown;
  try {
    const res = await fetch(balanceUrl, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });
    status = res.status;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    emit(ctx, `Couldn't reach nullsink at ${balanceUrl}: ${reason}`, "error");
    return;
  }

  const result = interpretBalance(status, body);
  emit(ctx, result.message, result.kind === "ok" ? "info" : result.kind === "unknown" ? "warning" : "error");
}

function showModels(ctx: ExtensionCommandContext): void {
  const p = models.providers;
  const total = p.anthropic.length + p.openai.length + p.tinfoil.length;
  const lines = [
    `nullsink serves ${total} models across 3 providers:`,
    `  ${PROVIDER_IDS.anthropic} (Anthropic, ${p.anthropic.length}): ${p.anthropic.map((m) => m.id).join(", ")}`,
    `  ${PROVIDER_IDS.openai} (OpenAI, ${p.openai.length}): ${p.openai.map((m) => m.id).join(", ")}`,
    `  ${PROVIDER_IDS.tinfoil} (Tinfoil, ${p.tinfoil.length}): ${p.tinfoil.map((m) => m.id).join(", ")}`,
    `Pick one with /model, then chat as usual.`,
  ];
  emit(ctx, lines.join("\n"), "info");
}

function showSetup(ctx: ExtensionCommandContext, site: string): void {
  const configured = Boolean(process.env[API_KEY_ENV]?.trim());
  const lines = [
    "nullsink — anonymous, account-less, crypto-paid proxy for frontier models.",
    `  1. Mint a key in your browser at ${site} and fund it with Monero or Bitcoin.`,
    `  2. export ${API_KEY_ENV}=0sink_your_key   ${configured ? "(currently set ✓)" : "(currently NOT set)"}`,
    `  3. /model → choose a "nullsink · …" model.`,
    `  4. /nullsink balance → check remaining credit.`,
    `Self-hosting a fork? Set ${BASE_URL_ENV} to your origin (default ${site}).`,
  ];
  emit(ctx, lines.join("\n"), configured ? "info" : "warning");
}

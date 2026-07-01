// pi-nullsink — route pi through nullsink (https://nullsink.is), the anonymous, account-less,
// crypto-paid metered proxy for frontier Anthropic / OpenAI / Tinfoil models. One bearer key,
// no account, no IP or request logs.
//
// Install:  pi install npm:pi-nullsink
// First run walks you through minting/saving a key; after that it persists in ~/.pi/agent/nullsink.json.
// Use:      /model  → pick a "nullsink · …" model, then chat as usual.
//           /nullsink → balance · models · setup · config · help.
import process from "node:process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  API_KEY_ENV,
  BASE_URL_ENV,
  type BalanceResult,
  buildProviders,
  DISPLAY_MODES,
  type DisplayMode,
  type Endpoints,
  interpretBalance,
  isDisplayMode,
  maskKey,
  type ModelsFile,
  NULLSINK_DEFAULT_BASE_URL,
  PROVIDER_IDS,
  renderStatusLine,
  renderWidget,
  resolveBaseUrlValue,
  resolveEndpoints,
  type StatusState,
  TOKEN_RE,
} from "./config.ts";
import { clearConfig, loadConfig, saveConfig } from "./store.ts";
import modelsData from "./models.json";

const models = modelsData as ModelsFile;

// How long a /balance check may run before we give up.
const BALANCE_TIMEOUT_MS = 8000;
// Minimum gap between automatic (post-turn) balance refreshes, so the status never adds latency.
const REFRESH_THROTTLE_MS = 60_000;

// Single live instance per extension load. Captured so command handlers can re-register providers.
let piRef: ExtensionAPI | undefined;

// Mutable session state. `injectedEnv` = we set process.env from the saved file (so a later "clear"
// knows to unset it, without clobbering a key the user exported in their own shell).
const state: {
  injectedEnv: boolean;
  endpoints: Endpoints;
  display: DisplayMode;
  balance?: BalanceResult;
  loading: boolean;
  lastFetchAt: number;
} = {
  injectedEnv: false,
  endpoints: resolveEndpoints(undefined),
  display: "statusline",
  loading: false,
  lastFetchAt: 0,
};

export default function nullsink(pi: ExtensionAPI): void {
  piRef = pi;

  // Load saved config and, only when the env var is unset, inject the saved key so pi's per-request
  // resolver ($NULLSINK_API_KEY) — and --list-models — see it. Env always wins.
  const stored = loadConfig();
  if (!process.env[API_KEY_ENV]?.trim() && stored?.apiKey) {
    process.env[API_KEY_ENV] = stored.apiKey;
    state.injectedEnv = true;
  }
  state.display = stored?.display ?? "statusline";
  state.endpoints = resolveEndpoints(resolveBaseUrlValue(process.env[BASE_URL_ENV], stored?.baseUrl));
  registerAll(pi);

  pi.registerCommand("nullsink", {
    description: "nullsink: balance | models | setup | config | help",
    getArgumentCompletions(prefix) {
      const items = ["balance", "models", "setup", "config", "help"].map((value) => ({ value, label: value }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "models") return showModels(ctx);
      if (sub === "setup") return runSetup(ctx, false);
      if (sub === "config") return runConfigMenu(ctx);
      if (sub === "help") return showHelp(ctx);
      return checkBalance(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state.loading = false;
    state.lastFetchAt = 0;
    const key = process.env[API_KEY_ENV]?.trim();
    // First-run guided setup: interactive TUI only, no key yet, not previously completed/skipped.
    if (!key && ctx.mode === "tui" && ctx.hasUI && !loadConfig()?.setupDone) {
      await runSetup(ctx, true);
    }
    renderStatus(ctx);
    await refreshBalance(ctx, true);
  });

  // Post-turn refresh, throttled + fire-and-forget so it never delays the next prompt.
  pi.on("turn_end", (_event, ctx) => {
    void refreshBalance(ctx, false);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("nullsink", undefined);
      ctx.ui.setWidget("nullsink", undefined);
    }
  });
}

// (Re)register the three providers from the current endpoints. Called at load and after a base-URL
// change; post-load registerProvider takes effect immediately (no /reload).
function registerAll(pi: ExtensionAPI): void {
  for (const { name, config } of buildProviders(models, state.endpoints)) {
    pi.registerProvider(name, config);
  }
}

// Route output through the TUI when present; fall back to stdout in print/JSON mode where notify
// is a no-op and writing to the terminal is safe.
function emit(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

// Paint the footer line and/or widget per the current display mode. No-op without a UI.
function renderStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const key = process.env[API_KEY_ENV]?.trim();
  const s: StatusState = {
    configured: Boolean(key),
    loading: state.loading,
    balance: state.balance,
    keyMasked: key ? maskKey(key) : undefined,
  };
  const showLine = state.display === "statusline" || state.display === "both";
  const showWidget = state.display === "widget" || state.display === "both";
  ctx.ui.setStatus("nullsink", showLine ? renderStatusLine(s) : undefined);
  ctx.ui.setWidget("nullsink", showWidget ? renderWidget(s) : undefined);
}

// Fetch the balance and repaint. `force` bypasses the post-turn throttle (used by session start,
// /nullsink balance, and config edits). Self-contained timeout + error handling; never throws.
async function refreshBalance(ctx: ExtensionContext, force: boolean): Promise<void> {
  const key = process.env[API_KEY_ENV]?.trim();
  if (!key) {
    state.balance = undefined;
    return;
  }
  const now = Date.now();
  if (!force && now - state.lastFetchAt < REFRESH_THROTTLE_MS) return;
  state.lastFetchAt = now;
  state.loading = true;
  renderStatus(ctx);
  try {
    const res = await fetch(state.endpoints.balance, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    state.balance = interpretBalance(res.status, body);
  } catch {
    state.balance = { kind: "error", message: "Couldn't reach nullsink." };
  } finally {
    state.loading = false;
    renderStatus(ctx);
  }
}

async function checkBalance(ctx: ExtensionContext): Promise<void> {
  if (!process.env[API_KEY_ENV]?.trim()) {
    emit(ctx, "No nullsink key set. Run /nullsink setup.", "warning");
    return;
  }
  await refreshBalance(ctx, true);
  const b = state.balance;
  if (b) emit(ctx, b.message, b.kind === "ok" ? "info" : b.kind === "unknown" ? "warning" : "error");
}

// Guided first-run flow (and re-runnable via /nullsink setup). `auto` = triggered on session start,
// so we stay quiet on skip; a manual run gives feedback. Needs a UI; falls back to text otherwise.
async function runSetup(ctx: ExtensionContext, auto: boolean): Promise<void> {
  if (!ctx.hasUI) {
    showSetupText(ctx);
    return;
  }
  const choice = await ctx.ui.select("Set up nullsink — anonymous, no account, key = money (no refunds)", [
    "I have a key — paste it",
    "Mint & fund a key at nullsink.is",
    "Skip for now",
  ]);
  if (!choice || choice.startsWith("Skip")) {
    markSetupDone();
    if (!auto) emit(ctx, "Skipped. Run /nullsink setup anytime.", "info");
    return;
  }
  if (choice.startsWith("Mint")) {
    markSetupDone();
    await openUrl(NULLSINK_DEFAULT_BASE_URL);
    emit(
      ctx,
      `Opened ${NULLSINK_DEFAULT_BASE_URL}. Mint a key, fund it with Monero/Bitcoin, then run /nullsink setup to save it.`,
      "info",
    );
    return;
  }
  const key = await ctx.ui.input("Paste your nullsink key", "0sink_…");
  if (!key?.trim()) {
    emit(ctx, "No key entered.", "warning");
    return;
  }
  await saveKey(ctx, key.trim());
}

// Persist a key, enforce 0600, make it live for this session, refetch balance. Confirms on a
// shape mismatch (typo guard, not the checksum) rather than silently saving garbage.
async function saveKey(ctx: ExtensionContext, key: string): Promise<void> {
  if (!TOKEN_RE.test(key) && ctx.hasUI) {
    const ok = await ctx.ui.confirm("Unusual key", "That doesn't match the 0sink_ format. Save anyway?");
    if (!ok) return;
  }
  const stored = loadConfig() ?? {};
  stored.apiKey = key;
  stored.setupDone = true;
  saveConfig(stored);
  process.env[API_KEY_ENV] = key;
  state.injectedEnv = true;
  emit(ctx, "Key saved (0600). It's spendable with no refunds — keep it safe.", "info");
  await refreshBalance(ctx, true);
  renderStatus(ctx);
}

async function runConfigMenu(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    showConfigText(ctx);
    return;
  }
  const stored = loadConfig() ?? {};
  const key = process.env[API_KEY_ENV]?.trim();
  const urlLabel = resolveBaseUrlValue(process.env[BASE_URL_ENV], stored.baseUrl) ?? NULLSINK_DEFAULT_BASE_URL;
  const choice = await ctx.ui.select("nullsink config", [
    `API key: ${key ? maskKey(key) : "not set"}`,
    `Base URL: ${urlLabel}`,
    `Display: ${state.display}`,
    "Clear saved config",
  ]);
  if (!choice) return;
  if (choice.startsWith("API key")) return editKey(ctx);
  if (choice.startsWith("Base URL")) return editBaseUrl(ctx);
  if (choice.startsWith("Display")) return editDisplay(ctx);
  if (choice.startsWith("Clear")) return clearSaved(ctx);
}

async function editKey(ctx: ExtensionContext): Promise<void> {
  const key = await ctx.ui.input("New nullsink key", "0sink_…");
  if (!key?.trim()) {
    emit(ctx, "Unchanged.", "info");
    return;
  }
  // A key the user exported in their own shell overrides the saved one in future sessions — warn.
  const hadExternal = Boolean(process.env[API_KEY_ENV]?.trim()) && !state.injectedEnv;
  await saveKey(ctx, key.trim());
  if (hadExternal) {
    emit(ctx, `Heads up: ${API_KEY_ENV} is set in your shell and overrides the saved key in new sessions.`, "warning");
  }
}

async function editBaseUrl(ctx: ExtensionContext): Promise<void> {
  const url = await ctx.ui.input("nullsink base URL (blank = default)", NULLSINK_DEFAULT_BASE_URL);
  if (url === undefined) return;
  const trimmed = url.trim();
  if (trimmed) {
    let valid = false;
    try {
      const u = new URL(trimmed);
      valid = u.protocol === "http:" || u.protocol === "https:";
    } catch {
      valid = false;
    }
    if (!valid) {
      emit(ctx, "Not a valid http(s) URL.", "error");
      return;
    }
  }
  const stored = loadConfig() ?? {};
  if (trimmed) stored.baseUrl = trimmed;
  else delete stored.baseUrl;
  saveConfig(stored);
  state.endpoints = resolveEndpoints(resolveBaseUrlValue(process.env[BASE_URL_ENV], stored.baseUrl));
  if (piRef) registerAll(piRef);
  emit(ctx, `Base URL set to ${state.endpoints.site}. Providers reloaded.`, "info");
  if (process.env[BASE_URL_ENV]?.trim()) {
    emit(ctx, `Note: ${BASE_URL_ENV} is set in your shell and overrides this.`, "warning");
  }
  await refreshBalance(ctx, true);
  renderStatus(ctx);
}

async function editDisplay(ctx: ExtensionContext): Promise<void> {
  const choice = await ctx.ui.select("Status display", [...DISPLAY_MODES]);
  if (!choice || !isDisplayMode(choice)) return;
  state.display = choice;
  const stored = loadConfig() ?? {};
  stored.display = choice;
  saveConfig(stored);
  renderStatus(ctx);
  emit(ctx, `Display: ${choice}`, "info");
}

async function clearSaved(ctx: ExtensionContext): Promise<void> {
  const ok = await ctx.ui.confirm(
    "Clear nullsink config?",
    "Removes the saved key, URL, and display from ~/.pi/agent/nullsink.json.",
  );
  if (!ok) return;
  clearConfig();
  // Only unset the env key if WE injected it from the file; leave a user's shell export alone.
  if (state.injectedEnv) {
    delete process.env[API_KEY_ENV];
    state.injectedEnv = false;
  }
  state.display = "statusline";
  state.balance = undefined;
  state.endpoints = resolveEndpoints(resolveBaseUrlValue(process.env[BASE_URL_ENV], undefined));
  if (piRef) registerAll(piRef);
  renderStatus(ctx);
  emit(ctx, "Saved config cleared.", "info");
}

// Mark first-run as handled so the auto-prompt never fires again (even on skip). Cheap idempotent write.
function markSetupDone(): void {
  const stored = loadConfig() ?? {};
  if (stored.setupDone) return;
  stored.setupDone = true;
  saveConfig(stored);
}

// Best-effort open the funding page in the user's browser; silently ignore if the platform opener
// isn't available (the caller always also prints the URL).
async function openUrl(url: string): Promise<void> {
  if (!piRef) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    await piRef.exec(opener, [url], { timeout: 3000 });
  } catch {
    /* no opener — the URL is printed by the caller */
  }
}

function showModels(ctx: ExtensionContext): void {
  const p = models.providers;
  const total = p.anthropic.length + p.openai.length + p.tinfoil.length;
  const lines = [
    `nullsink serves ${total} models across 3 providers:`,
    `  ${PROVIDER_IDS.anthropic} (Anthropic, ${p.anthropic.length}): ${p.anthropic.map((m) => m.id).join(", ")}`,
    `  ${PROVIDER_IDS.openai} (OpenAI, ${p.openai.length}): ${p.openai.map((m) => m.id).join(", ")}`,
    `  ${PROVIDER_IDS.tinfoil} (Tinfoil, ${p.tinfoil.length}): ${p.tinfoil.map((m) => m.id).join(", ")}`,
    "Pick one with /model, then chat as usual.",
  ];
  emit(ctx, lines.join("\n"), "info");
}

function showHelp(ctx: ExtensionContext): void {
  const lines = [
    "nullsink — anonymous, account-less, crypto-paid proxy for frontier models.",
    "  /nullsink            check remaining credit",
    "  /nullsink models     list served models",
    "  /nullsink setup      guided key setup (mint / paste / skip)",
    "  /nullsink config     edit key, base URL, or status display",
    "  /nullsink help       this message",
    "Pick a model with /model → a \"nullsink · …\" entry. Top up at nullsink.is.",
  ];
  emit(ctx, lines.join("\n"), "info");
}

function showSetupText(ctx: ExtensionContext): void {
  const configured = Boolean(process.env[API_KEY_ENV]?.trim());
  const lines = [
    "nullsink setup (no UI available — set an env var instead):",
    `  1. Mint & fund a key at ${NULLSINK_DEFAULT_BASE_URL} (Monero/Bitcoin).`,
    `  2. export ${API_KEY_ENV}=0sink_your_key   ${configured ? "(currently set ✓)" : "(currently NOT set)"}`,
    "  3. /model → choose a \"nullsink · …\" model.",
  ];
  emit(ctx, lines.join("\n"), configured ? "info" : "warning");
}

function showConfigText(ctx: ExtensionContext): void {
  const stored = loadConfig() ?? {};
  const key = process.env[API_KEY_ENV]?.trim();
  const urlLabel = resolveBaseUrlValue(process.env[BASE_URL_ENV], stored.baseUrl) ?? NULLSINK_DEFAULT_BASE_URL;
  const lines = [
    "nullsink config (no UI available — edit env vars or ~/.pi/agent/nullsink.json):",
    `  API key: ${key ? maskKey(key) : "not set"}`,
    `  Base URL: ${urlLabel}`,
    `  Display: ${state.display}`,
  ];
  emit(ctx, lines.join("\n"), "info");
}

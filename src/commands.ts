// pi-nullsink /nullsink subcommands + non-TUI fallbacks: the command handlers (topup / pay / mint /
// balance / setup), the dialog-or-text config menu, pay-detail printing, and text output.
// Split out of index.ts; every config edit still routes through the same host `apply` side effects.
import process from "node:process";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  activeProfile,
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULTS,
  DISPLAY_MODES,
  formatUsd,
  maskKey,
  NULLSINK_DEFAULT_BASE_URL,
  type PendingOrder,
  PROVIDER_IDS,
  resolveBaseUrlValue,
} from "./config.ts";
import { hashToken, isValidToken } from "./token.ts";
import { saveConfigV2 } from "./store.ts";
import {
  BUY_MAX_USD,
  BUY_MIN_USD,
  BuyError,
  buyErrorMessage,
  type Quote,
  trocadorSwapUrl,
} from "./wallet.ts";
import type { HubHost } from "./ui/hub.ts";
import { validateField } from "./ui/hub-model.ts";
import { qrLines } from "./ui/qr.ts";
import { models } from "./models.ts";
import {
  activeProfileMut,
  currentEndpoints,
  emit,
  resolveRawKey,
  setEnvKey,
  state,
  walletApi,
} from "./index.ts";
import {
  doMint,
  keyForProviderId,
  makeHubHost,
  openHubOrMenu,
  type ProviderKey,
  refreshBalance,
  startWatch,
} from "./host.ts";

// --- commands ---------------------------------------------------------------

export async function checkBalance(ctx: ExtensionContext): Promise<void> {
  if (!resolveRawKey()) {
    emit(ctx, "No nullsink key set. Run /nullsink setup.", "warning");
    return;
  }
  await refreshBalance(ctx, true);
  const b = state.balance;
  if (b) emit(ctx, b.message, b.kind === "ok" ? "info" : b.kind === "unknown" ? "warning" : "error");
}

export async function cmdTopup(ctx: ExtensionCommandContext, argParts: string[]): Promise<void> {
  if (ctx.mode === "tui") return openHubOrMenu(ctx, { wizard: { step: "amount", cursor: 1, custom: "" } });

  // Non-TUI: run the buy directly and print the pay details.
  let usd = Number(argParts[0]);
  if (!argParts[0]) {
    if (ctx.hasUI) {
      const input = await ctx.ui.input(`Top-up amount in USD ($${BUY_MIN_USD}–$${BUY_MAX_USD})`, "10");
      if (!input?.trim()) {
        emit(ctx, "Cancelled.", "info");
        return;
      }
      usd = Number(input.trim());
    } else {
      emit(ctx, `Usage: /nullsink topup <usd $${BUY_MIN_USD}-$${BUY_MAX_USD}> [rail]`, "warning");
      return;
    }
  }
  if (!Number.isFinite(usd) || usd < BUY_MIN_USD || usd > BUY_MAX_USD) {
    emit(ctx, `Amount must be $${BUY_MIN_USD}–$${BUY_MAX_USD}.`, "error");
    return;
  }
  const key = resolveRawKey();
  if (!key) {
    emit(ctx, "No key. Run /nullsink mint or /nullsink setup first.", "warning");
    return;
  }
  const rails = state.rails ?? (await walletApi().rails());
  state.rails = rails;
  const rail = argParts[1] ?? rails.default;
  let quote: Quote;
  try {
    quote = await walletApi().buy(hashToken(key), usd, rail);
  } catch (e) {
    emit(ctx, `nullsink: ${e instanceof BuyError ? buyErrorMessage(e.code) : buyErrorMessage("network")}`, "error");
    return;
  }
  const order: PendingOrder = {
    hash: hashToken(key),
    baseUrl: currentEndpoints().site,
    creditUsd: usd,
    rail,
    unit: quote.unit,
    payTo: quote.payTo,
    amount: quote.amount,
    payUri: quote.payUri,
    expiresAt: quote.expiresAt,
    createdAt: Date.now(),
  };
  activeProfileMut().pendingOrder = order;
  saveConfigV2(state.cfg);
  startWatch(ctx);
  printPayDetails(ctx, order);
}

export async function cmdPay(ctx: ExtensionCommandContext): Promise<void> {
  const order = activeProfile(state.cfg).pendingOrder;
  if (!order) {
    emit(ctx, "No pending order. Start one with /nullsink topup.", "info");
    return;
  }
  if (ctx.mode === "tui") return openHubOrMenu(ctx, { wizard: { step: "pay" } });
  printPayDetails(ctx, order);
}

export async function cmdMint(ctx: ExtensionCommandContext): Promise<void> {
  const token = doMint(ctx);
  if (token === null) return; // env key owns the session — doMint already explained why
  if (ctx.mode === "tui") return openHubOrMenu(ctx, { reveal: token });
  emit(
    ctx,
    [
      "nullsink: new key minted — shown ONCE. It is spendable money; there are no refunds. Store it safely:",
      token,
      `Fund it now: /nullsink topup <usd $${BUY_MIN_USD}-$${BUY_MAX_USD}> [rail]`,
    ].join("\n"),
    "warning",
  );
}

// Print a pending order's pay details as plain lines (address, verbatim amount, URI, Trocador,
// text QR). Works in any mode; the text QR scans from terminal scrollback.
function printPayDetails(ctx: ExtensionContext, order: PendingOrder): void {
  const lines = [
    `nullsink top-up — $${order.creditUsd} via ${order.rail}`,
    `Send exactly: ${order.amount} ${order.unit}`,
    `To address:   ${order.payTo}`,
    `Payment URI:  ${order.payUri}`,
    `Any coin (Trocador): ${trocadorSwapUrl(order)}`,
    "",
    ...qrLines(order.payUri),
  ];
  emit(ctx, lines.join("\n"), "info");
}

// Non-TUI config editor: a dialog menu (RPC) or a text dump (print). Every edit routes through the
// SAME host `apply` side effects as the hub, so behavior is identical across surfaces.
export async function runConfigMenuNonTui(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    showConfigText(ctx);
    return;
  }
  const host = makeHubHost(ctx);
  const cfg = state.cfg;
  const providers = cfg.providers ?? DEFAULTS.providers;
  const key = resolveRawKey();
  const urlLabel = resolveBaseUrlValue(process.env[BASE_URL_ENV], cfg.baseUrl) ?? NULLSINK_DEFAULT_BASE_URL;
  const items = [
    `API key: ${key ? maskKey(key) : "not set"}`,
    `Base URL: ${urlLabel}`,
    `Display: ${cfg.display ?? DEFAULTS.display}`,
    `Low-balance warning: ${formatUsd(cfg.lowBalanceUsd ?? DEFAULTS.lowBalanceUsd)}`,
    `Session spend warning: ${cfg.spendWarnUsd !== undefined ? formatUsd(cfg.spendWarnUsd) : "off"}`,
    `Show session spend: ${cfg.showSpend ? "on" : "off"}`,
    `Refresh interval: ${cfg.refreshSeconds ?? DEFAULTS.refreshSeconds}s`,
    `Default model: ${cfg.defaultModel ?? "none"}`,
    `Default thinking: ${cfg.thinkingLevel ?? "off"}`,
    `Anthropic models: ${providers.anthropic ? "on" : "off"}`,
    `OpenAI models: ${providers.openai ? "on" : "off"}`,
    `Tinfoil models: ${providers.tinfoil ? "on" : "off"}`,
    "Clear saved config",
  ];
  const choice = await ctx.ui.select("nullsink config", items);
  if (!choice) return;

  const editNumber = async (label: string, rowId: string, placeholder: string): Promise<void> => {
    const input = await ctx.ui.input(label, placeholder);
    if (input === undefined) return;
    const res = validateField(rowId, input);
    if (!res.ok) {
      emit(ctx, res.error, "error");
      return;
    }
    await host.apply({ kind: "set", field: rowId, value: res.value });
  };
  const cycle = async (label: string, rowId: string, options: readonly string[]): Promise<void> => {
    const picked = await ctx.ui.select(label, [...options]);
    if (picked) await host.apply({ kind: "set", field: rowId, value: picked });
  };

  if (choice.startsWith("API key")) {
    if (state.externalEnv) {
      emit(ctx, `${API_KEY_ENV} is set in your shell and overrides the saved key — unset it to edit here.`, "warning");
      return;
    }
    const input = await ctx.ui.input("New nullsink key", "0sink_…");
    if (!input?.trim()) return;
    const v = input.trim();
    if (!isValidToken(v) && !(await ctx.ui.confirm("Unusual key", "That doesn't match the 0sink_ format. Save anyway?"))) {
      return;
    }
    await host.apply({ kind: "set", field: "apiKey", value: v });
    return;
  }
  if (choice.startsWith("Base URL")) {
    const input = await ctx.ui.input("nullsink base URL (blank = default)", NULLSINK_DEFAULT_BASE_URL);
    if (input === undefined) return;
    const trimmed = input.trim();
    if (trimmed) {
      const res = validateField("baseUrl", trimmed);
      if (!res.ok) {
        emit(ctx, res.error, "error");
        return;
      }
    }
    await host.apply({ kind: "set", field: "baseUrl", value: trimmed });
    return;
  }
  if (choice.startsWith("Display")) return cycle("Status display", "display", DISPLAY_MODES);
  if (choice.startsWith("Low-balance")) return editNumber("Low-balance warning (USD)", "lowBalanceUsd", "1");
  if (choice.startsWith("Session spend")) return editNumber("Session spend warning (USD, blank = off)", "spendWarnUsd", "");
  if (choice.startsWith("Show session spend")) return cycle("Show session spend", "showSpend", ["off", "on"]);
  if (choice.startsWith("Refresh interval")) return editNumber("Refresh interval (seconds, min 15)", "refreshSeconds", "60");
  if (choice.startsWith("Default thinking")) {
    return cycle("Default thinking", "thinkingLevel", ["off", "minimal", "low", "medium", "high", "xhigh"]);
  }
  if (choice.startsWith("Default model")) {
    const ids = [
      ...models.providers.anthropic,
      ...models.providers.openai,
      ...models.providers.tinfoil,
    ].map((m) => m.id);
    const picked = await ctx.ui.select("Default model (switches now + saves startup default)", ids);
    if (picked) await host.apply({ kind: "setDefaultModel", modelId: picked });
    return;
  }
  if (choice.startsWith("Anthropic models")) return toggleFromMenu(ctx, host, "anthropic");
  if (choice.startsWith("OpenAI models")) return toggleFromMenu(ctx, host, "openai");
  if (choice.startsWith("Tinfoil models")) return toggleFromMenu(ctx, host, "tinfoil");
  if (choice.startsWith("Clear saved config")) {
    const ok = await ctx.ui.confirm("Clear nullsink config?", "Removes saved keys, URL, and settings from ~/.pi/agent/nullsink.json.");
    if (!ok) return;
    await host.apply({ kind: "action", id: "clear-config" });
    emit(ctx, "Saved config cleared.", "info");
  }
}

async function toggleFromMenu(ctx: ExtensionCommandContext, host: HubHost, provider: ProviderKey): Promise<void> {
  const picked = await ctx.ui.select(`${provider} models`, ["on", "off"]);
  if (!picked) return;
  const on = picked === "on";
  // Mirror the hub guard: never disable the provider serving the current session model.
  if (!on && ctx.model && keyForProviderId(ctx.model.provider) === provider) {
    emit(ctx, "this provider serves the current session model — switch model first", "warning");
    return;
  }
  await host.apply({ kind: "toggleProvider", provider, on });
}

// --- guided setup + key save ------------------------------------------------

// Guided first-run flow (and re-runnable via /nullsink setup). `auto` = triggered on session start,
// so we stay quiet on skip; a manual run gives feedback. Needs a UI; falls back to text otherwise.
export async function runSetup(ctx: ExtensionContext, auto: boolean): Promise<void> {
  if (!ctx.hasUI) {
    showSetupText(ctx);
    return;
  }
  const choice = await ctx.ui.select("Set up nullsink — anonymous, no account, key = money (no refunds)", [
    "I have a key — paste it",
    "Mint a key now (generated locally)",
    "Skip for now",
  ]);
  if (!choice || choice.startsWith("Skip")) {
    markSetupDone();
    if (!auto) emit(ctx, "Skipped. Run /nullsink setup anytime.", "info");
    return;
  }
  if (choice.startsWith("Mint")) {
    const token = doMint(ctx);
    if (token === null) return; // env key owns the session — doMint already explained why
    markSetupDone();
    await ctx.ui.confirm(
      "Your new nullsink key — save it now",
      `${token}\n\nThis key IS your money — anyone holding it can spend it. It is saved to ~/.pi/agent/nullsink.json (mode 0600).`,
    );
    emit(ctx, `Fund it with /nullsink topup — $${BUY_MIN_USD}–$${BUY_MAX_USD} by QR.`, "info");
    return;
  }
  const key = await ctx.ui.input("Paste your nullsink key", "0sink_…");
  if (!key?.trim()) {
    emit(ctx, "No key entered.", "warning");
    return;
  }
  await saveKey(ctx, key.trim());
}

// Persist a key to the active profile, make it live (unless the shell owns env), refetch balance.
// Confirms on a shape-or-checksum mismatch rather than silently saving garbage.
async function saveKey(ctx: ExtensionContext, key: string): Promise<void> {
  if (!isValidToken(key) && ctx.hasUI) {
    const ok = await ctx.ui.confirm("Unusual key", "That doesn't match the 0sink_ format. Save anyway?");
    if (!ok) return;
  }
  activeProfileMut().apiKey = key;
  state.cfg.setupDone = true;
  saveConfigV2(state.cfg);
  setEnvKey(key);
  emit(ctx, "Key saved (0600). It's spendable with no refunds — keep it safe.", "info");
  if (state.externalEnv) {
    emit(ctx, `Heads up: ${API_KEY_ENV} is set in your shell and overrides the saved key.`, "warning");
  }
  await refreshBalance(ctx, true);
}

// Mark first-run as handled so the auto-prompt never fires again (even on skip).
function markSetupDone(): void {
  if (state.cfg.setupDone) return;
  state.cfg.setupDone = true;
  saveConfigV2(state.cfg);
}

// --- text output ------------------------------------------------------------

export function showModels(ctx: ExtensionContext): void {
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

export function showHelp(ctx: ExtensionContext): void {
  const lines = [
    "nullsink — anonymous, account-less, crypto-paid proxy for frontier models.",
    "  /nullsink            open the hub (settings · wallet · models)",
    "  /nullsink balance    check remaining credit",
    "  /nullsink topup      fund the active key (amount → coin → pay)",
    "  /nullsink mint       generate a fresh key locally (shown once)",
    "  /nullsink pay        reopen the pay screen for a pending order",
    "  /nullsink models     list served models",
    "  /nullsink config     edit settings",
    "  /nullsink setup      guided key setup (mint / paste / skip)",
    "  /nullsink help       this message",
    'Pick a model with /model → a "nullsink · …" entry. Top up at nullsink.is.',
  ];
  emit(ctx, lines.join("\n"), "info");
}

function showSetupText(ctx: ExtensionContext): void {
  const configured = Boolean(resolveRawKey());
  const lines = [
    "nullsink setup (no UI available — set an env var instead):",
    `  1. Mint a key locally with /nullsink mint (shown once), then fund it with /nullsink topup.`,
    `  2. export ${API_KEY_ENV}=0sink_your_key   ${configured ? "(currently set ✓)" : "(currently NOT set)"}`,
    '  3. /model → choose a "nullsink · …" model.',
  ];
  emit(ctx, lines.join("\n"), configured ? "info" : "warning");
}

function showConfigText(ctx: ExtensionContext): void {
  const cfg = state.cfg;
  const key = resolveRawKey();
  const providers = cfg.providers ?? DEFAULTS.providers;
  const urlLabel = resolveBaseUrlValue(process.env[BASE_URL_ENV], cfg.baseUrl) ?? NULLSINK_DEFAULT_BASE_URL;
  const lines = [
    "nullsink config (no UI available — edit env vars or ~/.pi/agent/nullsink.json):",
    `  API key: ${key ? maskKey(key) : "not set"}`,
    `  Base URL: ${urlLabel}`,
    `  Display: ${cfg.display ?? DEFAULTS.display}`,
    `  Low-balance warning: ${formatUsd(cfg.lowBalanceUsd ?? DEFAULTS.lowBalanceUsd)}`,
    `  Session spend warning: ${cfg.spendWarnUsd !== undefined ? formatUsd(cfg.spendWarnUsd) : "off"}`,
    `  Show session spend: ${cfg.showSpend ? "on" : "off"}`,
    `  Refresh interval: ${cfg.refreshSeconds ?? DEFAULTS.refreshSeconds}s`,
    `  Default model: ${cfg.defaultModel ?? "none"}`,
    `  Default thinking: ${cfg.thinkingLevel ?? "off"}`,
    `  Providers: anthropic=${providers.anthropic ? "on" : "off"} openai=${providers.openai ? "on" : "off"} tinfoil=${providers.tinfoil ? "on" : "off"}`,
  ];
  emit(ctx, lines.join("\n"), "info");
}

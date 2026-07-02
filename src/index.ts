// pi-nullsink — route pi through nullsink (https://nullsink.is), the anonymous, account-less,
// crypto-paid metered proxy for frontier Anthropic / OpenAI / Tinfoil models. One bearer key,
// no account, no IP or request logs.
//
// Install:  pi install npm:pi-nullsink
// First run walks you through minting/saving a key; after that it persists in ~/.pi/agent/nullsink.json.
// Use:      /model  → pick a "nullsink · …" model, then chat as usual.
//           /nullsink → hub (settings · wallet · models); balance · topup · mint · pay · incognito · help.
//
// This file is wiring ONLY: the pure modules (config/token/store/wallet/incognito/ui) do the thinking.
import process from "node:process";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  activeProfile,
  API_KEY_ENV,
  BASE_URL_ENV,
  type BalanceResult,
  buildProviders,
  clampRefreshSeconds,
  DEFAULTS,
  DISPLAY_MODES,
  emptyConfigV2,
  type Endpoints,
  formatUsd,
  INCOGNITO_MODES,
  isDisplayMode,
  isIncognitoMode,
  maskKey,
  type ModelsFile,
  NULLSINK_DEFAULT_BASE_URL,
  type PendingOrder,
  type Profile,
  PROVIDER_IDS,
  type ProviderToggles,
  renderStatusLine,
  renderWidget,
  resolveBaseUrlValue,
  resolveEndpoints,
  type StatusState,
  type StoredConfigV2,
} from "./config.ts";
import { generateToken, hashToken, isValidToken } from "./token.ts";
import { clearConfig, loadConfigV2, saveConfigV2 } from "./store.ts";
import {
  BUY_MAX_USD,
  BUY_MIN_USD,
  BuyError,
  buyErrorMessage,
  initialWatchState,
  type OrderStatusRes,
  orderDropReason,
  type Quote,
  type Rails,
  reduceStatus,
  resolveClosed,
  toOrderReadout,
  trocadorSwapUrl,
  WalletApi,
  type WatchState,
} from "./wallet.ts";
import { goIncognito, isIncognito, sessionIsFresh } from "./incognito.ts";
import { type HubHost, openHub } from "./ui/hub.ts";
import type { HubData, HubEffect, HubState } from "./ui/hub-model.ts";
import { validateField } from "./ui/hub-model.ts";
import { qrLines } from "./ui/qr.ts";
import modelsData from "./models.json";

const models = modelsData as ModelsFile;

// pi's ThinkingLevel union, kept local: pi-coding-agent does not re-export the type and its owner
// (@earendil-works/pi-agent-core) has no package `exports` map. This literal set is identical to
// that union, so a value of this type is directly assignable to `pi.setThinkingLevel(...)`.
type ThinkingLevelValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ProviderKey = "anthropic" | "openai" | "tinfoil";

// Single live instance per extension load. Captured so handlers can (un)register providers.
let piRef: ExtensionAPI | undefined;

// Mutable session state.
// - externalEnv: NULLSINK_API_KEY was set in the user's shell at load — env always wins; we never
//   touch it. Distinguishes a user override from a keyless profile so switches inject correctly.
// - injectedEnv: we currently hold a key we injected into process.env (so clear/switch can unset it).
const state: {
  cfg: StoredConfigV2; // loaded+migrated at startup (emptyConfigV2() when none)
  externalEnv: boolean;
  injectedEnv: boolean;
  balance?: BalanceResult;
  lastFetchMs: number;
  watch: WatchState | null; // pending-order watcher state
  watchTimer: Timer | null;
  spendWarned: boolean;
  spendUsd?: number; // this session's summed nullsink cost
  sessionStartEntryCount: number; // entries before this session's turns (spend baseline)
  rails?: Rails; // GET /rails cache, fetched once per session
} = {
  cfg: emptyConfigV2(),
  externalEnv: false,
  injectedEnv: false,
  lastFetchMs: 0,
  watch: null,
  watchTimer: null,
  spendWarned: false,
  sessionStartEntryCount: 0,
};

// Hub coordination. The host is stateless-per-open; these module vars bridge the open hub to async
// completions. `pendingOverride` is set from async work (quote resolved, mint) and returned-and-
// cleared by the host's takeStateOverride(); after setting it we call the repaint callback.
let pendingOverride: Partial<HubState> | null = null;
let repaintHub: (() => void) | null = null;
let closeHub: (() => void) | null = null;
let pendingAfterClose: ((ctx: ExtensionContext) => Promise<void>) | null = null;

// --- shared helpers ---------------------------------------------------------

// Effective endpoints under current env + config (env wins — same precedence everywhere).
function currentEndpoints(): Endpoints {
  return resolveEndpoints(resolveBaseUrlValue(process.env[BASE_URL_ENV], state.cfg.baseUrl));
}
// One WalletApi per call — it is stateless; origin follows live config edits.
function walletApi(): WalletApi {
  return new WalletApi(currentEndpoints().site);
}
// The raw key for /balance + /buy hashing: env wins, then the active profile.
function resolveRawKey(): string | undefined {
  return process.env[API_KEY_ENV]?.trim() || activeProfile(state.cfg).apiKey;
}

// Return the active profile as a stored reference (creating the slot if absent) so mutations
// persist. `activeProfile()` returns a throwaway `{}` when the slot is missing.
function activeProfileMut(): Profile {
  const cfg = state.cfg;
  const p = cfg.profiles[cfg.activeProfile] ?? {};
  cfg.profiles[cfg.activeProfile] = p;
  return p;
}

// Map a provider registration id (e.g. "nullsink-openai") back to its toggle key.
function keyForProviderId(id: string): ProviderKey | undefined {
  if (id === PROVIDER_IDS.anthropic) return "anthropic";
  if (id === PROVIDER_IDS.openai) return "openai";
  if (id === PROVIDER_IDS.tinfoil) return "tinfoil";
  return undefined;
}

// Which provider group a model id belongs to (drives default-model apply at session start).
function groupForModelId(id: string): ProviderKey | undefined {
  const p = models.providers;
  if (p.anthropic.some((m) => m.id === id)) return "anthropic";
  if (p.openai.some((m) => m.id === id)) return "openai";
  if (p.tinfoil.some((m) => m.id === id)) return "tinfoil";
  return undefined;
}

// Push the active profile's key into process.env — but only when we manage it (no shell override).
// A user's exported NULLSINK_API_KEY is authoritative and never touched.
function setEnvKey(key: string | undefined): void {
  if (state.externalEnv) return;
  if (key) {
    process.env[API_KEY_ENV] = key;
    state.injectedEnv = true;
  } else {
    delete process.env[API_KEY_ENV];
    state.injectedEnv = false;
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

// UI-only notice (no stdout fallback): used for ambient session events that would be noise in
// print/JSON mode.
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

// --- startup ----------------------------------------------------------------

export default function nullsink(pi: ExtensionAPI): void {
  piRef = pi;

  state.cfg = loadConfigV2() ?? emptyConfigV2();
  // Capture the shell override BEFORE we inject, so profile switches can tell "user owns env" from
  // "keyless profile" for the rest of the session.
  state.externalEnv = Boolean(process.env[API_KEY_ENV]?.trim());
  if (!state.externalEnv) setEnvKey(activeProfile(state.cfg).apiKey);

  registerAll(pi);

  pi.registerCommand("nullsink", {
    description: "nullsink: balance · topup · mint · pay · models · config · incognito · setup · help",
    getArgumentCompletions(prefix) {
      const items = ["balance", "topup", "mint", "pay", "models", "config", "incognito", "setup", "help"].map(
        (value) => ({ value, label: value }),
      );
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();
      switch (sub) {
        case "":
        case "config":
          return openHubOrMenu(ctx);
        case "balance":
          return checkBalance(ctx);
        case "models":
          return showModels(ctx);
        case "setup":
          return runSetup(ctx, false);
        case "help":
          return showHelp(ctx);
        case "incognito":
          return cmdIncognito(ctx);
        case "topup":
          return cmdTopup(ctx, parts.slice(1));
        case "pay":
          return cmdPay(ctx);
        case "mint":
          return cmdMint(ctx);
        default:
          return showHelp(ctx);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const cfg = state.cfg;
    state.lastFetchMs = 0;
    state.spendWarned = false;
    state.spendUsd = undefined;

    // 1) incognito "always": swap only fresh sessions; resumed ones keep saving.
    if (cfg.incognito === "always" && !isIncognito(ctx)) {
      if (sessionIsFresh(ctx.sessionManager.getEntries())) {
        const ok = await goIncognito(ctx);
        if (ok) notify(ctx, "incognito — this session will not be saved", "info");
        else notify(ctx, "couldn't go incognito automatically — run /nullsink incognito (or pi --no-session)", "warning");
      } else {
        notify(ctx, "resumed session is still being saved; start fresh for incognito", "info");
      }
    }

    // First-run guided setup (preserved behavior): interactive TUI, no key, not previously handled.
    if (!resolveRawKey() && ctx.mode === "tui" && ctx.hasUI && !cfg.setupDone) {
      await runSetup(ctx, true);
    }

    // 2) default model + thinking: applied once per session, only when the model's provider is on
    //    and a key resolves. Mid-session /model choices are never overridden.
    if (cfg.defaultModel) {
      const group = groupForModelId(cfg.defaultModel);
      const toggles = cfg.providers ?? DEFAULTS.providers;
      if (group && toggles[group] && resolveRawKey()) {
        const model = ctx.modelRegistry.find(PROVIDER_IDS[group], cfg.defaultModel);
        if (model) {
          const ok = await pi.setModel(model);
          if (!ok) notify(ctx, "nullsink: default model needs a key to apply", "warning");
        }
        if (cfg.thinkingLevel) pi.setThinkingLevel(cfg.thinkingLevel as ThinkingLevelValue);
      }
    }

    // 3) resume a persisted pending order (drop first if stale / instance-mismatch).
    const order = activeProfile(cfg).pendingOrder;
    if (order) {
      const drop = orderDropReason(order, Date.now(), currentEndpoints().site);
      if (drop) {
        delete activeProfileMut().pendingOrder;
        saveConfigV2(cfg);
        notify(ctx, `nullsink: pending order dropped (${drop})`, "warning");
      } else {
        startWatch(ctx);
      }
    }

    // 4) spend baseline + non-blocking balance + rails prefetch.
    state.sessionStartEntryCount = ctx.sessionManager.getEntries().length;
    renderStatus(ctx);
    void refreshBalance(ctx, true);
    void walletApi()
      .rails()
      .then((r) => {
        state.rails = r;
      });
  });

  // Post-turn refresh, throttled + fire-and-forget so it never delays the next prompt; then spend.
  pi.on("turn_end", (_event, ctx) => {
    void refreshBalance(ctx, false);
    updateSpend(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopWatch();
    if (ctx.hasUI) {
      ctx.ui.setStatus("nullsink", undefined);
      ctx.ui.setWidget("nullsink", undefined);
    }
  });
}

// (Re)register the enabled providers from the current endpoints. Called at load, after a base-URL
// change, and after clearing config. Disabled providers are filtered out (never registered).
function registerAll(pi: ExtensionAPI): void {
  const toggles = state.cfg.providers ?? DEFAULTS.providers;
  for (const { name, config } of buildProviders(models, currentEndpoints())) {
    const key = keyForProviderId(name);
    if (key && !toggles[key]) continue;
    pi.registerProvider(name, config);
  }
}

// --- status + balance -------------------------------------------------------

// Paint the footer line and/or widget per the current display mode. No-op without a UI.
function renderStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const cfg = state.cfg;
  const s: StatusState = {
    configured: Boolean(resolveRawKey()),
    balance: state.balance,
    lowBalanceUsd: cfg.lowBalanceUsd ?? DEFAULTS.lowBalanceUsd,
    incognito: isIncognito(ctx),
    order: state.watch ? toOrderReadout(state.watch) : undefined,
    spendUsd: cfg.showSpend ? state.spendUsd : undefined,
  };
  const display = cfg.display ?? DEFAULTS.display;
  const showLine = display === "statusline" || display === "both";
  const showWidget = display === "widget" || display === "both";
  ctx.ui.setStatus("nullsink", showLine ? renderStatusLine(s) : undefined);
  ctx.ui.setWidget("nullsink", showWidget ? renderWidget(s) : undefined);
}

// Fetch the balance and repaint. `force` bypasses the config-driven post-turn throttle (used by
// session start, wallet actions, and config edits). Self-contained; never throws.
async function refreshBalance(ctx: ExtensionContext, force: boolean): Promise<void> {
  const key = resolveRawKey();
  if (!key) {
    state.balance = undefined;
    renderStatus(ctx);
    return;
  }
  const now = Date.now();
  const throttleMs = clampRefreshSeconds(state.cfg.refreshSeconds ?? DEFAULTS.refreshSeconds) * 1000;
  if (!force && now - state.lastFetchMs < throttleMs) return;
  state.lastFetchMs = now;
  try {
    state.balance = await walletApi().balance(key);
  } catch {
    state.balance = { kind: "error", message: "Couldn't reach nullsink." };
  }
  renderStatus(ctx);
}

async function checkBalance(ctx: ExtensionContext): Promise<void> {
  if (!resolveRawKey()) {
    emit(ctx, "No nullsink key set. Run /nullsink setup.", "warning");
    return;
  }
  await refreshBalance(ctx, true);
  const b = state.balance;
  if (b) emit(ctx, b.message, b.kind === "ok" ? "info" : b.kind === "unknown" ? "warning" : "error");
}

// Sum this session's assistant-message costs (entries after the baseline whose provider is ours).
// AssistantMessage.usage.cost.total is the per-message spend (pi-ai types).
function updateSpend(ctx: ExtensionContext): void {
  const entries = ctx.sessionManager.getEntries();
  let sum = 0;
  for (let i = state.sessionStartEntryCount; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== "message") continue;
    const msg = e.message;
    if (msg.role !== "assistant" || !keyForProviderId(msg.provider)) continue;
    const total = msg.usage.cost.total;
    if (Number.isFinite(total)) sum += total;
  }
  state.spendUsd = sum;
  const warn = state.cfg.spendWarnUsd;
  if (warn !== undefined && !state.spendWarned && sum >= warn) {
    state.spendWarned = true;
    notify(ctx, `nullsink: session spend passed ${formatUsd(warn)} (now ${formatUsd(sum)})`, "warning");
  }
  renderStatus(ctx);
}

// --- order watcher ----------------------------------------------------------

function startWatch(ctx: ExtensionContext): void {
  stopWatch();
  state.watch = initialWatchState();
  state.watchTimer = setInterval(() => void tickWatch(ctx), 20_000);
  void tickWatch(ctx); // immediate first tick
  renderStatus(ctx);
}

function stopWatch(): void {
  clearInterval(state.watchTimer ?? undefined);
  state.watchTimer = null;
}

async function tickWatch(ctx: ExtensionContext): Promise<void> {
  const order = activeProfile(state.cfg).pendingOrder;
  if (!order || !state.watch) return stopWatch();
  const drop = orderDropReason(order, Date.now(), currentEndpoints().site);
  if (drop) return settleWatch(ctx, "dropped", drop);
  let status: OrderStatusRes;
  try {
    status = await walletApi().orderStatus(order.hash);
  } catch {
    return; // transient — next tick retries
  }
  if (status.state !== "closed") {
    state.watch = reduceStatus(state.watch, status);
    renderStatus(ctx);
    return;
  }
  // closed = ambiguous → resolve against a fresh balance
  const key = resolveRawKey();
  const before = state.balance?.kind === "ok" ? state.balance.balanceUsd : undefined;
  if (!key) return settleWatch(ctx, "unknown"); // keyless can't resolve — surface "check balance"
  const fresh = await walletApi().balance(key);
  if (fresh.kind === "error") return; // transient blip at the settle moment — retry next tick
  if (fresh.kind === "ok") state.balance = fresh;
  settleWatch(ctx, resolveClosed(before, fresh) === "credited" ? "credited" : "unknown");
}

function settleWatch(ctx: ExtensionContext, phase: "credited" | "unknown" | "dropped", reason?: string): void {
  stopWatch();
  state.watch = null;
  delete activeProfileMut().pendingOrder;
  saveConfigV2(state.cfg);
  const msg =
    phase === "credited"
      ? "top-up landed — balance updated"
      : phase === "unknown"
        ? "order closed — check /nullsink balance to confirm"
        : `pending order dropped (${reason})`;
  emit(ctx, `nullsink: ${msg}`, phase === "credited" ? "info" : "warning");
  renderStatus(ctx);
}

// --- guided setup + key save ------------------------------------------------

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

// Best-effort open a URL in the user's browser; silently ignore if no opener (caller prints the URL).
async function openUrl(url: string): Promise<void> {
  if (!piRef) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    await piRef.exec(opener, [url], { timeout: 3000 });
  } catch {
    /* no opener — the URL is printed by the caller */
  }
}

// --- hub host ---------------------------------------------------------------

function makeHubHost(ctx: ExtensionCommandContext): HubHost {
  repaintHub = null;
  closeHub = null;
  pendingOverride = null;
  pendingAfterClose = null;
  return {
    data: (): HubData => {
      const model = ctx.model;
      return {
        cfg: state.cfg,
        // Surface a key as "(env)" only when the shell owns it; our injected profile key stays editable.
        envKey: state.externalEnv ? process.env[API_KEY_ENV]?.trim() || undefined : undefined,
        envUrl: process.env[BASE_URL_ENV]?.trim() || undefined,
        balance: state.balance,
        watch: state.watch ?? undefined,
        rails: state.rails,
        models,
        currentModelId: model?.id,
        currentProviderKey: model ? keyForProviderId(model.provider) : undefined,
        incognitoActive: isIncognito(ctx),
        spendUsd: state.spendUsd,
      };
    },
    apply: (effect) => applyEffect(ctx, effect),
    onRepaint: (cb) => {
      repaintHub = cb;
    },
    onClose: (cb) => {
      closeHub = cb;
    },
    takeStateOverride: () => {
      const o = pendingOverride;
      pendingOverride = null;
      return o;
    },
  };
}

// Set an override from async work and ask the open hub to repaint (a no-op when no hub is open).
function pushOverride(o: Partial<HubState>): void {
  pendingOverride = o;
  repaintHub?.();
}

async function applyEffect(ctx: ExtensionCommandContext, effect: HubEffect): Promise<void> {
  switch (effect.kind) {
    case "set":
      return applySet(ctx, effect.field, effect.value);
    case "toggleProvider":
      return applyToggle(ctx, effect.provider, effect.on);
    case "setDefaultModel":
      return applyDefaultModel(ctx, effect.modelId);
    case "quote":
      return applyQuote(ctx, effect.creditUsd, effect.rail);
    case "openTrocador":
      return applyTrocador();
    case "action":
      return applyAction(ctx, effect.id);
    case "close":
      return; // handled inside openHub's dispatch; defensive no-op here
  }
}

// `set` writes the field (row id) into cfg, persists, then runs the field's side effect. apiKey is
// the ONE exception: it lives per-profile (StoredConfigV2 has no top-level apiKey — a top-level
// write is silently lost on reload when the active profile already holds a key).
async function applySet(
  ctx: ExtensionContext,
  field: string,
  value: string | number | boolean | undefined,
): Promise<void> {
  const cfg = state.cfg;
  switch (field) {
    case "apiKey": {
      const v = typeof value === "string" ? value : "";
      activeProfileMut().apiKey = v;
      saveConfigV2(cfg);
      setEnvKey(v);
      await refreshBalance(ctx, true); // spec cadence: after config edits and wallet actions
      renderStatus(ctx);
      return;
    }
    case "baseUrl": {
      if (typeof value === "string" && value.trim()) cfg.baseUrl = value.trim();
      else delete cfg.baseUrl;
      saveConfigV2(cfg);
      if (piRef) registerAll(piRef);
      await refreshBalance(ctx, true);
      renderStatus(ctx);
      return;
    }
    case "lowBalanceUsd":
      cfg.lowBalanceUsd = typeof value === "number" ? value : DEFAULTS.lowBalanceUsd;
      break;
    case "spendWarnUsd":
      cfg.spendWarnUsd = typeof value === "number" ? value : undefined;
      break;
    case "refreshSeconds":
      cfg.refreshSeconds = clampRefreshSeconds(typeof value === "number" ? value : DEFAULTS.refreshSeconds);
      break;
    case "display":
      if (isDisplayMode(value)) cfg.display = value;
      break;
    case "showSpend":
      cfg.showSpend = value === true || value === "on";
      break;
    case "thinkingLevel":
      if (typeof value === "string") cfg.thinkingLevel = value;
      break;
    case "incognito":
      if (isIncognitoMode(value)) cfg.incognito = value;
      break;
    default:
      return; // unknown field — ignore
  }
  saveConfigV2(cfg);
  renderStatus(ctx);
}

function applyToggle(ctx: ExtensionContext, provider: ProviderKey, on: boolean): void {
  const cfg = state.cfg;
  const providers: ProviderToggles = { ...(cfg.providers ?? DEFAULTS.providers) };
  providers[provider] = on;
  cfg.providers = providers;
  saveConfigV2(cfg);
  if (piRef) {
    if (on) {
      const np = buildProviders(models, currentEndpoints()).find((p) => p.name === PROVIDER_IDS[provider]);
      if (np) piRef.registerProvider(np.name, np.config);
    } else {
      piRef.unregisterProvider(PROVIDER_IDS[provider]);
    }
  }
  renderStatus(ctx);
}

function applyDefaultModel(ctx: ExtensionContext, modelId: string): void {
  state.cfg.defaultModel = modelId;
  saveConfigV2(state.cfg);
  notify(ctx, "nullsink: default model set — applies at next session start", "info");
  renderStatus(ctx);
}

async function applyQuote(ctx: ExtensionContext, creditUsd: number, rail: string): Promise<void> {
  const key = resolveRawKey();
  if (!key) {
    pushOverride({ wizard: { step: "error", message: "mint or paste a key first" } });
    return;
  }
  let quote: Quote;
  try {
    quote = await walletApi().buy(hashToken(key), creditUsd, rail);
  } catch (e) {
    const message = e instanceof BuyError ? buyErrorMessage(e.code) : buyErrorMessage("network");
    pushOverride({ wizard: { step: "error", message } });
    return;
  }
  const order: PendingOrder = {
    hash: hashToken(key),
    baseUrl: currentEndpoints().site,
    creditUsd,
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
  pushOverride({ wizard: { step: "pay" } });
}

async function applyTrocador(): Promise<void> {
  const order = activeProfile(state.cfg).pendingOrder;
  if (order) await openUrl(trocadorSwapUrl(order));
}

async function applyAction(ctx: ExtensionCommandContext, id: string): Promise<void> {
  if (id === "balance") return void (await refreshBalance(ctx, true));
  if (id === "setup") {
    // Close the hub, then run the guided setup on top of the restored editor.
    pendingAfterClose = (c) => runSetup(c, false);
    closeHub?.();
    return;
  }
  if (id === "clear-config") return actionClearConfig(ctx);
  if (id === "mint") {
    const token = doMint(ctx);
    pushOverride({ reveal: token });
    return;
  }
  if (id === "mint-saved") {
    pushOverride({ wizard: { step: "amount", cursor: 1, custom: "" } });
    return;
  }
  if (id.startsWith("profile-switch:")) return switchProfile(ctx, id.slice("profile-switch:".length));
  if (id.startsWith("profile-new:")) return newProfile(ctx, id.slice("profile-new:".length));
  if (id.startsWith("profile-rename:")) return renameProfile(ctx, id.slice("profile-rename:".length));
  if (id === "profile-delete") return deleteProfile(ctx);
}

// Generate a key, save it, and make it the active/current key. Keyless active profile → fund it in
// place; otherwise mint into a fresh key-N profile and SWITCH to it, so the follow-up wizard funds
// the key just revealed — never the old profile's. Returns the token for the one-time reveal.
function doMint(ctx: ExtensionContext): string {
  const token = generateToken();
  const cfg = state.cfg;
  if (!activeProfile(cfg).apiKey) {
    activeProfileMut().apiKey = token;
  } else {
    let n = 2;
    while (cfg.profiles[`key-${n}`] !== undefined) n++;
    const name = `key-${n}`;
    cfg.profiles[name] = { apiKey: token };
    cfg.activeProfile = name;
    stopWatch();
    state.watch = null;
    state.balance = undefined;
  }
  saveConfigV2(cfg);
  setEnvKey(token);
  renderStatus(ctx);
  return token;
}

// Reset balance/watch and re-inject the active profile's key, then refresh and resume its order.
// Shared by every profile change (switch / new / delete).
function afterProfileChange(ctx: ExtensionContext): void {
  setEnvKey(activeProfile(state.cfg).apiKey);
  stopWatch();
  state.watch = null;
  state.balance = undefined;
  void refreshBalance(ctx, true);
  const order = activeProfile(state.cfg).pendingOrder;
  if (order) {
    if (orderDropReason(order, Date.now(), currentEndpoints().site)) {
      delete activeProfileMut().pendingOrder;
      saveConfigV2(state.cfg);
    } else {
      startWatch(ctx);
    }
  }
  renderStatus(ctx);
}

function switchProfile(ctx: ExtensionContext, name: string): void {
  const cfg = state.cfg;
  if (name === cfg.activeProfile || cfg.profiles[name] === undefined) return;
  cfg.activeProfile = name;
  saveConfigV2(cfg);
  afterProfileChange(ctx);
}

function newProfile(ctx: ExtensionContext, name: string): void {
  const cfg = state.cfg;
  if (cfg.profiles[name] !== undefined) {
    notify(ctx, `nullsink: profile "${name}" already exists`, "warning");
    return;
  }
  cfg.profiles[name] = {};
  cfg.activeProfile = name;
  saveConfigV2(cfg);
  afterProfileChange(ctx);
}

function renameProfile(ctx: ExtensionContext, name: string): void {
  const cfg = state.cfg;
  const cur = cfg.activeProfile;
  if (name === cur) return;
  if (cfg.profiles[name] !== undefined) {
    notify(ctx, `nullsink: profile "${name}" already exists`, "warning");
    return;
  }
  cfg.profiles[name] = cfg.profiles[cur] ?? {};
  delete cfg.profiles[cur];
  cfg.activeProfile = name;
  saveConfigV2(cfg);
  renderStatus(ctx);
}

function deleteProfile(ctx: ExtensionContext): void {
  const cfg = state.cfg;
  delete cfg.profiles[cfg.activeProfile];
  const remaining = Object.keys(cfg.profiles);
  cfg.activeProfile = remaining[0] ?? "default";
  saveConfigV2(cfg);
  afterProfileChange(ctx);
}

function actionClearConfig(ctx: ExtensionContext): void {
  clearConfig();
  state.cfg = emptyConfigV2();
  if (state.injectedEnv && !state.externalEnv) {
    delete process.env[API_KEY_ENV];
    state.injectedEnv = false;
  }
  state.balance = undefined;
  stopWatch();
  state.watch = null;
  if (piRef) registerAll(piRef);
  renderStatus(ctx);
}

// --- commands ---------------------------------------------------------------

// Open the hub (TUI) or the dialog/text menu (non-TUI). `initial` pre-opens a hub screen.
async function openHubOrMenu(ctx: ExtensionCommandContext, initial?: Partial<HubState>): Promise<void> {
  if (ctx.mode !== "tui") return runConfigMenuNonTui(ctx);
  const host = makeHubHost(ctx);
  await openHub(ctx, host, initial);
  if (pendingAfterClose) {
    const fn = pendingAfterClose;
    pendingAfterClose = null;
    await fn(ctx);
  }
}

async function cmdTopup(ctx: ExtensionCommandContext, argParts: string[]): Promise<void> {
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

async function cmdPay(ctx: ExtensionCommandContext): Promise<void> {
  const order = activeProfile(state.cfg).pendingOrder;
  if (!order) {
    emit(ctx, "No pending order. Start one with /nullsink topup.", "info");
    return;
  }
  if (ctx.mode === "tui") return openHubOrMenu(ctx, { wizard: { step: "pay" } });
  printPayDetails(ctx, order);
}

async function cmdMint(ctx: ExtensionCommandContext): Promise<void> {
  const token = doMint(ctx);
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

async function cmdIncognito(ctx: ExtensionCommandContext): Promise<void> {
  if (isIncognito(ctx)) {
    emit(ctx, "Already incognito — this session isn't being saved.", "info");
    return;
  }
  const ok = await goIncognito(ctx);
  if (ok) {
    emit(ctx, "incognito — this session will not be saved.", "info");
    renderStatus(ctx);
  } else {
    emit(ctx, "Couldn't go incognito — run pi --no-session instead.", "warning");
  }
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
async function runConfigMenuNonTui(ctx: ExtensionCommandContext): Promise<void> {
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
    `Incognito: ${cfg.incognito ?? DEFAULTS.incognito}`,
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
    const picked = await ctx.ui.select("Default model (applies next session)", ids);
    if (picked) await host.apply({ kind: "setDefaultModel", modelId: picked });
    return;
  }
  if (choice.startsWith("Anthropic models")) return toggleFromMenu(ctx, host, "anthropic");
  if (choice.startsWith("OpenAI models")) return toggleFromMenu(ctx, host, "openai");
  if (choice.startsWith("Tinfoil models")) return toggleFromMenu(ctx, host, "tinfoil");
  if (choice.startsWith("Incognito")) return cycle("Incognito", "incognito", INCOGNITO_MODES);
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

// --- text output ------------------------------------------------------------

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
    "  /nullsink            open the hub (settings · wallet · models)",
    "  /nullsink balance    check remaining credit",
    "  /nullsink topup      fund the active key (amount → coin → pay)",
    "  /nullsink mint       generate a fresh key locally (shown once)",
    "  /nullsink pay        reopen the pay screen for a pending order",
    "  /nullsink models     list served models",
    "  /nullsink config     edit settings",
    "  /nullsink incognito  stop saving this session's transcript",
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
    `  1. Mint & fund a key at ${NULLSINK_DEFAULT_BASE_URL} (Monero/Bitcoin).`,
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
    `  Incognito: ${cfg.incognito ?? DEFAULTS.incognito}`,
  ];
  emit(ctx, lines.join("\n"), "info");
}

// pi-nullsink hub host: the ctx.ui.custom component's backing side effects. Owns the session state
// object + shared helpers, the makeHubHost bridge, apply(effects), the order-watch / balance-refresh
// timers, and mint + profile management. Split out of index.ts, which stays the wiring shell.
import process from "node:process";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  activeProfile,
  API_KEY_ENV,
  BASE_URL_ENV,
  buildProviders,
  clampRefreshSeconds,
  DEFAULTS,
  emptyConfigV2,
  isDisplayMode,
  type PendingOrder,
  PROVIDER_IDS,
  type ProviderToggles,
  renderStatusLine,
  renderWidget,
  type StatusState,
} from "./config.ts";
import { generateToken, hashToken } from "./token.ts";
import { clearConfig, saveConfigV2 } from "./store.ts";
import {
  BuyError,
  buyErrorMessage,
  initialWatchState,
  type OrderStatusRes,
  orderDropReason,
  type Quote,
  reduceStatus,
  resolveClosed,
  toOrderReadout,
  trocadorSwapUrl,
} from "./wallet.ts";
import { type HubHost, openHub } from "./ui/hub.ts";
import type { HubData, HubEffect, HubState } from "./ui/hub-model.ts";
import { models } from "./models.ts";
import {
  activeProfileMut,
  currentEndpoints,
  emit,
  notify,
  piRef,
  registerAll,
  resolveRawKey,
  setEnvKey,
  state,
  walletApi,
} from "./index.ts";
import { runConfigMenuNonTui, runSetup } from "./commands.ts";

// The three provider toggle keys, in registration order: the single source for the
// provider-id↔toggle-key and model→group mappings.
export type ProviderKey = "anthropic" | "openai" | "tinfoil";

export const PROVIDER_KEYS: readonly ProviderKey[] = ["anthropic", "openai", "tinfoil"];


// Map a provider registration id (e.g. "nullsink-openai") back to its toggle key.
export function keyForProviderId(id: string): ProviderKey | undefined {
  return PROVIDER_KEYS.find((k) => PROVIDER_IDS[k] === id);
}

// Hub coordination. The host is stateless-per-open; these module vars bridge the open hub to async
// completions. `pendingOverride` is set from async work (quote resolved, mint) and returned-and-
// cleared by the host's takeStateOverride(); after setting it we call the repaint callback.
let pendingOverride: Partial<HubState> | null = null;
let repaintHub: (() => void) | null = null;
let closeHub: (() => void) | null = null;
let pendingAfterClose: ((ctx: ExtensionContext) => Promise<void>) | null = null;

// --- status + balance -------------------------------------------------------

// Paint the footer line and/or widget per the current display mode. No-op without a UI.
export function renderStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const cfg = state.cfg;
  const s: StatusState = {
    configured: Boolean(resolveRawKey()),
    balance: state.balance,
    lowBalanceUsd: cfg.lowBalanceUsd ?? DEFAULTS.lowBalanceUsd,
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
export async function refreshBalance(ctx: ExtensionContext, force: boolean): Promise<void> {
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

// --- order watcher ----------------------------------------------------------

export function startWatch(ctx: ExtensionContext): void {
  stopWatch();
  state.watch = initialWatchState();
  state.watchTimer = setInterval(() => void tickWatch(ctx), 20_000);
  void tickWatch(ctx); // immediate first tick
  renderStatus(ctx);
}

export function stopWatch(): void {
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
    repaintHub?.(); // live-refresh an open pay screen on every poll
    return;
  }
  // closed = ambiguous → resolve against a fresh balance.
  const key = resolveRawKey();
  if (!key) return settleWatch(ctx, "unknown"); // keyless can't resolve — surface "check balance"
  // No baseline OR errored baseline (state.balance === undefined or kind "error") → nothing to
  // honestly compare against, so we can't claim the credit landed: settle NEUTRAL. DISTINCT from
  // state.balance.kind === "unknown" (a confirmed 401-unfunded key), which IS a legitimate
  // first-fund baseline → before=undefined → resolveClosed(undefined, ok) = "credited".
  if (state.balance === undefined || state.balance.kind === "error") return settleWatch(ctx, "unknown");
  const before = state.balance.kind === "ok" ? state.balance.balanceUsd : undefined;
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
  repaintHub?.(); // reflect the settled state in an open hub
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

export function makeHubHost(ctx: ExtensionCommandContext): HubHost {
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

async function applyDefaultModel(ctx: ExtensionContext, modelId: string): Promise<void> {
  state.cfg.defaultModel = modelId;
  saveConfigV2(state.cfg);

  const group = PROVIDER_KEYS.find((k) => models.providers[k].some((m) => m.id === modelId));
  const toggles = state.cfg.providers ?? DEFAULTS.providers;
  let switched = false;
  if (piRef && group && toggles[group] && resolveRawKey()) {
    const model = ctx.modelRegistry.find(PROVIDER_IDS[group], modelId);
    switched = model ? await piRef.setModel(model) : false;
  }

  notify(
    ctx,
    switched
      ? `nullsink: switched to ${modelId} and saved it as the startup default`
      : "nullsink: default model saved — switch needs an enabled provider and key",
    switched ? "info" : "warning",
  );
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
    if (token !== null) pushOverride({ reveal: token });
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
export function doMint(ctx: ExtensionContext): string | null {
  // Env key wins wherever the apiKey editor is locked (config precedence): a key minted here could
  // never be used by this session. Abort with the same guidance the disabled row shows.
  if (state.externalEnv) {
    emit(ctx, `${API_KEY_ENV} is set — the env key always wins; unset it to mint or manage keys here`, "warning");
    return null;
  }
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

// Open the hub (TUI) or the dialog/text menu (non-TUI). `initial` pre-opens a hub screen.
export async function openHubOrMenu(ctx: ExtensionCommandContext, initial?: Partial<HubState>): Promise<void> {
  if (ctx.mode !== "tui") return runConfigMenuNonTui(ctx);
  const host = makeHubHost(ctx);
  await openHub(ctx, host, initial);
  if (pendingAfterClose) {
    const fn = pendingAfterClose;
    pendingAfterClose = null;
    await fn(ctx);
  }
}

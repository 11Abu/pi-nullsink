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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  activeProfile,
  API_KEY_ENV,
  BASE_URL_ENV,
  type BalanceResult,
  buildProviders,
  DEFAULTS,
  emptyConfigV2,
  type Endpoints,
  formatUsd,
  type Profile,
  PROVIDER_IDS,
  resolveBaseUrlValue,
  resolveEndpoints,
  type StoredConfigV2,
} from "./config.ts";
import { orderDropReason, type Rails, WalletApi, type WatchState } from "./wallet.ts";
import { loadConfigV2, saveConfigV2 } from "./store.ts";
import { goIncognito, isIncognito, sessionIsFresh } from "./incognito.ts";
import { models } from "./models.ts";
import {
  keyForProviderId,
  openHubOrMenu,
  PROVIDER_KEYS,
  refreshBalance,
  renderStatus,
  startWatch,
  stopWatch,
} from "./host.ts";
import { checkBalance, cmdIncognito, cmdMint, cmdPay, cmdTopup, runSetup, showHelp, showModels } from "./commands.ts";

// pi's ThinkingLevel union, kept local: pi-coding-agent does not re-export the type and its owner
// (@earendil-works/pi-agent-core) has no package `exports` map. This literal set is identical to
// that union, so a value of this type is directly assignable to `pi.setThinkingLevel(...)`.
type ThinkingLevelValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// Single live instance per extension load. Captured so handlers can (un)register providers.
export let piRef: ExtensionAPI | undefined;

// Mutable session state.
// - externalEnv: NULLSINK_API_KEY was set in the user's shell at load — env always wins; we never
//   touch it. Distinguishes a user override from a keyless profile so switches inject correctly.
// - injectedEnv: we currently hold a key we injected into process.env (so clear/switch can unset it).
export const state: {
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

// --- shared helpers ---------------------------------------------------------

// Effective endpoints under current env + config (env wins — same precedence everywhere).
export function currentEndpoints(): Endpoints {
  return resolveEndpoints(resolveBaseUrlValue(process.env[BASE_URL_ENV], state.cfg.baseUrl));
}
// One WalletApi per call — it is stateless; origin follows live config edits.
export function walletApi(): WalletApi {
  return new WalletApi(currentEndpoints().site);
}
// The raw key for /balance + /buy hashing: env wins, then the active profile.
export function resolveRawKey(): string | undefined {
  return process.env[API_KEY_ENV]?.trim() || activeProfile(state.cfg).apiKey;
}

// Return the active profile as a stored reference (creating the slot if absent) so mutations
// persist. `activeProfile()` returns a throwaway `{}` when the slot is missing.
export function activeProfileMut(): Profile {
  const cfg = state.cfg;
  const p = cfg.profiles[cfg.activeProfile] ?? {};
  cfg.profiles[cfg.activeProfile] = p;
  return p;
}


// Push the active profile's key into process.env — but only when we manage it (no shell override).
// A user's exported NULLSINK_API_KEY is authoritative and never touched.
export function setEnvKey(key: string | undefined): void {
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
export function emit(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

// UI-only notice (no stdout fallback): used for ambient session events that would be noise in
// print/JSON mode.
export function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
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
        const ok = await goIncognito(ctx, (freshCtx) => {
          notify(freshCtx as ExtensionContext, "incognito — this session will not be saved", "info");
        });
        // A successful swap replaces the session: pi invalidates THIS ctx and fires a fresh
        // session_start for the replacement, which re-runs setup / default model / order resume on
        // the new ctx. Stop here so we never touch the stale ctx.
        if (ok) return;
        notify(ctx, "couldn't go incognito automatically — run /nullsink incognito (or pi --no-session)", "warning");
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
      const group = PROVIDER_KEYS.find((k) => models.providers[k].some((m) => m.id === cfg.defaultModel));
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
        // Baseline the balance BEFORE watching: a reaped order that settles "closed" must not read
        // as "credited" for lack of a pre-close balance (I2).
        await refreshBalance(ctx, true);
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
export function registerAll(pi: ExtensionAPI): void {
  const toggles = state.cfg.providers ?? DEFAULTS.providers;
  for (const { name, config } of buildProviders(models, currentEndpoints())) {
    const key = keyForProviderId(name);
    if (key && !toggles[key]) continue;
    pi.registerProvider(name, config);
  }
}

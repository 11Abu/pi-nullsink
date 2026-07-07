// Pure hub model: rows, state, key reducer, wizard machine. NO pi-tui imports, NO I/O —
// everything here runs under bun test with plain objects.
import {
  activeProfile, DEFAULTS, DISPLAY_MODES, INCOGNITO_MODES, maskKey, renderOrderSegment,
  type ModelsFile, type StoredConfigV2,
} from "../config.ts";
import { isValidToken } from "../token.ts";
import {
  AMOUNT_PRESETS, BUY_MAX_USD, BUY_MIN_USD, RAILS_FALLBACK, toOrderReadout,
  type Rails, type WatchState,
} from "../wallet.ts";
import type { BalanceResult } from "../config.ts";

export type Tab = "settings" | "wallet" | "models";
export const TABS: readonly Tab[] = ["settings", "wallet", "models"];

export type KeyName =
  | "up" | "down" | "left" | "right" | "tab" | "shift-tab" | "enter" | "esc" | "backspace"
  | { char: string };

export interface RowSpec {
  id: string;
  section: string;
  label: string;
  value: string;
  kind: "cycle" | "edit" | "action";
  options?: readonly string[];
  description: string;
  disabled?: boolean;
}

export interface HubData {
  cfg: StoredConfigV2;
  envKey?: string;
  envUrl?: string;
  balance?: BalanceResult;
  watch?: WatchState;
  rails?: Rails;
  models: ModelsFile;
  currentModelId?: string;
  currentProviderKey?: "anthropic" | "openai" | "tinfoil";
  incognitoActive: boolean;
  spendUsd?: number;
}

export type WizardState =
  | { step: "amount"; cursor: number; custom: string; error?: string }
  | { step: "rail"; creditUsd: number; cursor: number }
  | { step: "quoting"; creditUsd: number; rail: string }
  | { step: "pay" }
  | { step: "error"; message: string };

export interface HubState {
  tab: Tab;
  cursor: Record<Tab, number>;
  top: Record<Tab, number>;
  editing: { rowId: string; buffer: string; error?: string; confirmMismatch?: boolean } | null;
  confirm: string | null;
  reveal: string | null;
  wizard: WizardState | null;
  filter: string;
  pickDefault: boolean;
}

export function initialHubState(): HubState {
  return {
    tab: "settings",
    cursor: { settings: 0, wallet: 0, models: 0 },
    top: { settings: 0, wallet: 0, models: 0 },
    editing: null, confirm: null, reveal: null, wizard: null, filter: "", pickDefault: false,
  };
}

// pi's full ThinkingLevel union — see @earendil-works/pi-agent-core/dist/types.d.ts (verify on read).
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function settingsRows(d: HubData): RowSpec[] {
  const cfg = d.cfg;
  const prof = activeProfile(cfg);
  const providers = cfg.providers ?? DEFAULTS.providers;
  const rows: RowSpec[] = [];

  const keyFromEnv = Boolean(d.envKey);
  rows.push({
    id: "apiKey", section: "Account", label: "API key", kind: "edit",
    value: keyFromEnv ? `${maskKey(d.envKey!)} (env)` : prof.apiKey ? maskKey(prof.apiKey) : "not set",
    disabled: keyFromEnv,
    description: keyFromEnv
      ? "Set via NULLSINK_API_KEY — unset the env var to edit here"
      : "Key used to authenticate against the nullsink proxy. Paste to replace.",
  });
  rows.push({
    id: "lowBalanceUsd", section: "Account", label: "Low-balance warning", kind: "edit",
    value: `$${(cfg.lowBalanceUsd ?? DEFAULTS.lowBalanceUsd).toFixed(2)}`,
    description: "Warn in the status line when remaining credit drops below this amount",
  });
  rows.push({
    id: "spendWarnUsd", section: "Account", label: "Session spend warning", kind: "edit",
    value: cfg.spendWarnUsd !== undefined ? `$${cfg.spendWarnUsd.toFixed(2)}` : "off",
    description: "Warn once when this session's cost crosses this amount. Empty = off.",
  });

  const urlFromEnv = Boolean(d.envUrl);
  rows.push({
    id: "baseUrl", section: "Connection", label: "Base URL", kind: "edit",
    value: urlFromEnv ? `${d.envUrl} (env)` : (cfg.baseUrl ?? "https://nullsink.is"),
    disabled: urlFromEnv,
    description: urlFromEnv
      ? "Set via NULLSINK_BASE_URL — unset the env var to edit here"
      : "nullsink instance. Changing re-registers the providers immediately.",
  });
  for (const p of ["anthropic", "openai", "tinfoil"] as const) {
    const on = providers[p];
    const inUse = d.currentProviderKey === p && on;
    rows.push({
      id: `provider-${p}`, section: "Connection",
      label: `${p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : "Tinfoil"} models`,
      kind: "cycle", options: ["on", "off"], value: on ? "on" : "off", disabled: inUse,
      description: inUse
        ? "This provider serves the current session model — switch model first"
        : "Show or hide this provider's models in /model",
    });
  }

  rows.push({
    id: "defaultModel", section: "Model", label: "Default model", kind: "action",
    value: cfg.defaultModel ?? "none",
    description: "Enter picks from the Models tab, switches now, and saves the startup default.",
  });
  rows.push({
    id: "thinkingLevel", section: "Model", label: "Default thinking", kind: "cycle",
    options: THINKING_LEVELS, value: cfg.thinkingLevel ?? "off",
    description: "Thinking level applied at session start (clamped to the model's capabilities)",
  });

  rows.push({
    id: "display", section: "Display", label: "Status display", kind: "cycle",
    options: DISPLAY_MODES, value: cfg.display ?? DEFAULTS.display,
    description: "Where the balance readout appears: footer line, widget above the editor, both, or off",
  });
  rows.push({
    id: "showSpend", section: "Display", label: "Show session spend", kind: "cycle",
    options: ["off", "on"], value: cfg.showSpend ? "on" : "off",
    description: "Append this session's nullsink cost to the readout",
  });
  rows.push({
    id: "refreshSeconds", section: "Display", label: "Refresh interval", kind: "edit",
    value: `${cfg.refreshSeconds ?? DEFAULTS.refreshSeconds}s`,
    description: "Post-turn balance re-check throttle, seconds (min 15)",
  });

  rows.push({
    id: "incognito", section: "Privacy", label: "Incognito", kind: "cycle",
    options: INCOGNITO_MODES, value: cfg.incognito ?? DEFAULTS.incognito,
    description: "always: fresh sessions are never written to disk. Terminal scrollback and files the agent edits are outside this.",
  });
  return rows;
}

// `now` drives the pending-order countdown; callers that only need row IDENTITY (the reducer)
// can use the default.
export function walletRows(d: HubData, now: number = Date.now()): RowSpec[] {
  const cfg = d.cfg;
  const rows: RowSpec[] = [];
  const names = Object.keys(cfg.profiles);
  rows.push({
    id: "profile", section: "Wallet", label: "Profile", kind: "cycle",
    options: names.length > 0 ? names : ["default"], value: cfg.activeProfile,
    description: "Active key profile — a profile is a named wallet",
  });
  rows.push({ id: "topup", section: "Wallet", label: "Top up", kind: "action", value: "", description: "Fund the active key: amount → coin → pay by QR/address" });
  if (activeProfile(cfg).pendingOrder) {
    rows.push({ id: "pay", section: "Wallet", label: "Pending order", kind: "action", value: orderRowValue(d, now), description: "Reopen the pay screen for the in-flight order" });
  }
  const mintDisabled = Boolean(d.envKey);
  rows.push({
    id: "mint", section: "Wallet", label: "Mint new key", kind: "action", value: "",
    disabled: mintDisabled,
    description: mintDisabled
      ? "NULLSINK_API_KEY is set — the env key always wins; unset it to mint or manage keys here"
      : "Generate a fresh key locally (shown once), then fund it",
  });
  rows.push({ id: "profile-new", section: "Wallet", label: "New profile", kind: "action", value: "", description: "Add a named profile for another key" });
  rows.push({ id: "profile-rename", section: "Wallet", label: "Rename profile", kind: "action", value: cfg.activeProfile, description: "Rename the active profile" });
  rows.push({ id: "profile-delete", section: "Wallet", label: "Delete profile", kind: "action", value: cfg.activeProfile, description: "Remove the active profile and its saved key (enter twice)" });
  rows.push({ id: "balance", section: "Wallet", label: "Check balance now", kind: "action", value: "", description: "Fetch the live balance" });
  rows.push({ id: "setup", section: "Wallet", label: "Re-run setup", kind: "action", value: "", description: "The guided first-run flow" });
  rows.push({ id: "clear-config", section: "Wallet", label: "Clear saved config", kind: "action", value: "", description: "Delete ~/.pi/agent/nullsink.json (enter twice)" });
  return rows;
}

// Row value for the pending order: state · credit · time to the pay-by deadline (spec:
// "⧗ confirming 4/10 · $25 · expires 19:42"). Single source for the ⧗ prefix: renderOrderSegment.
function orderRowValue(d: HubData, now: number): string {
  const order = activeProfile(d.cfg).pendingOrder;
  const seg = d.watch && toOrderReadout(d.watch) ? renderOrderSegment(toOrderReadout(d.watch)!) : "⧗ …";
  if (!order) return seg;
  const remaining = Math.max(0, order.expiresAt - now);
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000).toString().padStart(2, "0");
  return `${seg} · $${order.creditUsd} · expires ${mm}:${ss}`;
}

export interface ModelRow {
  id: string;
  provider: "anthropic" | "openai" | "tinfoil";
  name: string;
  contextWindow: number;
  input: number;
  output: number;
}

export function modelRows(
  models: ModelsFile,
  filter: string,
  toggles: { anthropic: boolean; openai: boolean; tinfoil: boolean },
): ModelRow[] {
  const out: ModelRow[] = [];
  const f = filter.trim().toLowerCase();
  for (const provider of ["anthropic", "openai", "tinfoil"] as const) {
    if (!toggles[provider]) continue;
    for (const m of models.providers[provider]) {
      if (f && !`${m.id} ${m.name}`.toLowerCase().includes(f)) continue;
      out.push({ id: m.id, provider, name: m.name, contextWindow: m.contextWindow, input: m.cost.input, output: m.cost.output });
    }
  }
  return out;
}

export type HubEffect =
  | { kind: "set"; field: string; value: string | number | boolean | undefined }
  | { kind: "action"; id: string }
  | { kind: "quote"; creditUsd: number; rail: string }
  | { kind: "setDefaultModel"; modelId: string }
  | { kind: "toggleProvider"; provider: "anthropic" | "openai" | "tinfoil"; on: boolean }
  | { kind: "openTrocador" }
  | { kind: "close" };

export function validateField(
  rowId: string,
  buffer: string,
): { ok: true; value: string | number | undefined } | { ok: false; error: string } {
  const v = buffer.trim();
  switch (rowId) {
    case "apiKey": {
      if (!isValidToken(v)) return { ok: false, error: "not a valid nullsink key (checksum failed)" };
      return { ok: true, value: v };
    }
    case "baseUrl": {
      try {
        const u = new URL(v);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
        return { ok: true, value: v };
      } catch {
        return { ok: false, error: "enter a full http(s) URL" };
      }
    }
    case "lowBalanceUsd": {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: "enter a dollar amount ≥ 0" };
      return { ok: true, value: n };
    }
    case "spendWarnUsd": {
      if (v === "") return { ok: true, value: undefined }; // off
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "enter a dollar amount, or empty for off" };
      return { ok: true, value: n };
    }
    case "refreshSeconds": {
      const n = Number(v.replace(/s$/, ""));
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "enter seconds (min 15)" };
      return { ok: true, value: Math.max(15, Math.round(n)) };
    }
    case "profile-rename":
    case "profile-new": {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(v)) return { ok: false, error: "letters/digits/dash/underscore, max 32" };
      return { ok: true, value: v };
    }
    default:
      return { ok: true, value: v };
  }
}

// One reducer for the whole hub. Layers, innermost first: reveal → editing → wizard → confirm → rows/tabs.
export function reduceHub(state: HubState, key: KeyName, d: HubData): { state: HubState; effects: HubEffect[] } {
  // 1) reveal (mint display) swallows everything except enter
  if (state.reveal !== null) {
    if (key === "enter") return { state: { ...state, reveal: null }, effects: [{ kind: "action", id: "mint-saved" }] };
    return { state, effects: [] };
  }
  // 2) inline editor
  if (state.editing) return reduceEditing(state, key);
  // 3) wizard
  if (state.wizard) return reduceWizard(state, key, d);
  // 4) confirm arm/cancel handled inside row activation below
  return reduceRows(state, key, d);
}

function reduceEditing(state: HubState, key: KeyName): { state: HubState; effects: HubEffect[] } {
  const e = state.editing!;
  if (key === "esc") return { state: { ...state, editing: null }, effects: [] };
  if (key === "backspace") return { state: { ...state, editing: { ...e, buffer: e.buffer.slice(0, -1), error: undefined, confirmMismatch: false } }, effects: [] };
  if (typeof key === "object") return { state: { ...state, editing: { ...e, buffer: e.buffer + key.char, error: undefined, confirmMismatch: false } }, effects: [] };
  if (key === "enter") {
    const res = validateField(e.rowId, e.buffer);
    if (!res.ok) {
      // Spec: API-key checksum mismatch is confirmable — a second consecutive enter saves anyway
      // (mirrors the guided setup's "save anyway?"). All other fields hard-reject.
      if (e.rowId === "apiKey" && e.buffer.trim().length > 0) {
        if (e.confirmMismatch) {
          return { state: { ...state, editing: null }, effects: [{ kind: "set", field: "apiKey", value: e.buffer.trim() }] };
        }
        return { state: { ...state, editing: { ...e, error: "checksum failed — enter again to save anyway", confirmMismatch: true } }, effects: [] };
      }
      return { state: { ...state, editing: { ...e, error: res.error } }, effects: [] };
    }
    const effect: HubEffect = e.rowId === "profile-new" || e.rowId === "profile-rename"
      ? { kind: "action", id: `${e.rowId}:${res.value}` }
      : { kind: "set", field: e.rowId, value: res.value };
    return { state: { ...state, editing: null }, effects: [effect] };
  }
  return { state, effects: [] };
}

function reduceWizard(state: HubState, key: KeyName, d: HubData): { state: HubState; effects: HubEffect[] } {
  const w = state.wizard!;
  const set = (wizard: WizardState | null): HubState => ({ ...state, wizard });
  switch (w.step) {
    case "amount": {
      const cells = AMOUNT_PRESETS.length + 1; // + custom
      if (key === "esc") return { state: set(null), effects: [] };
      if (key === "left") return { state: set({ ...w, cursor: (w.cursor + cells - 1) % cells, error: undefined }), effects: [] };
      if (key === "right" || key === "tab") return { state: set({ ...w, cursor: (w.cursor + 1) % cells, error: undefined }), effects: [] };
      if (key === "backspace") return { state: set({ ...w, custom: w.custom.slice(0, -1) }), effects: [] };
      if (typeof key === "object" && /[0-9.]/.test(key.char)) {
        return { state: set({ ...w, cursor: AMOUNT_PRESETS.length, custom: w.custom + key.char, error: undefined }), effects: [] };
      }
      if (key === "enter") {
        const usd = w.cursor < AMOUNT_PRESETS.length ? AMOUNT_PRESETS[w.cursor]! : Number(w.custom);
        if (!Number.isFinite(usd) || usd < BUY_MIN_USD || usd > BUY_MAX_USD) {
          return { state: set({ ...w, error: `amount must be $${BUY_MIN_USD}–$${BUY_MAX_USD}` }), effects: [] };
        }
        const rails = d.rails ?? RAILS_FALLBACK;
        const defIdx = Math.max(0, rails.rails.findIndex((r) => r.name === rails.default));
        return { state: set({ step: "rail", creditUsd: usd, cursor: defIdx }), effects: [] };
      }
      return { state, effects: [] };
    }
    case "rail": {
      const rails = (d.rails ?? RAILS_FALLBACK).rails;
      if (key === "esc") return { state: set({ step: "amount", cursor: 1, custom: "" }), effects: [] };
      if (key === "up" || key === "left") return { state: set({ ...w, cursor: (w.cursor + rails.length - 1) % rails.length }), effects: [] };
      if (key === "down" || key === "right") return { state: set({ ...w, cursor: (w.cursor + 1) % rails.length }), effects: [] };
      if (key === "enter") {
        const rail = rails[w.cursor]!;
        return { state: set({ step: "quoting", creditUsd: w.creditUsd, rail: rail.name }), effects: [{ kind: "quote", creditUsd: w.creditUsd, rail: rail.name }] };
      }
      return { state, effects: [] };
    }
    case "quoting":
      return { state, effects: [] }; // host resolves to pay or error
    case "pay": {
      if (typeof key === "object" && key.char.toLowerCase() === "t") return { state, effects: [{ kind: "openTrocador" }] };
      if (key === "esc") return { state: set(null), effects: [] }; // background; watching continues
      return { state, effects: [] };
    }
    case "error": {
      if (key === "enter" || key === "esc") return { state: set({ step: "amount", cursor: 1, custom: "" }), effects: [] };
      return { state, effects: [] };
    }
  }
}

function cycleTab(state: HubState, back: boolean): HubState {
  const dir = back ? TABS.length - 1 : 1;
  const tab = TABS[(TABS.indexOf(state.tab) + dir) % TABS.length]!;
  return { ...state, tab, confirm: null };
}

function reduceRows(state: HubState, key: KeyName, d: HubData): { state: HubState; effects: HubEffect[] } {
  // tab switching
  if (key === "tab" || key === "shift-tab") {
    return { state: cycleTab(state, key === "shift-tab"), effects: [] };
  }
  if (key === "esc") {
    if (state.confirm) return { state: { ...state, confirm: null }, effects: [] };
    return { state, effects: [{ kind: "close" }] };
  }

  // models tab: filter + list
  if (state.tab === "models") {
    const rows = modelRows(d.models, state.filter, d.cfg.providers ?? DEFAULTS.providers);
    if (key === "left" || key === "right") return { state: cycleTab(state, key === "left"), effects: [] };
    if (typeof key === "object") return { state: { ...state, filter: state.filter + key.char }, effects: [] };
    if (key === "backspace") return { state: { ...state, filter: state.filter.slice(0, -1) }, effects: [] };
    if (key === "down") return { state: moveCursor(state, "models", 1, rows.length), effects: [] };
    if (key === "up") return { state: moveCursor(state, "models", -1, rows.length), effects: [] };
    if (key === "enter" && rows.length > 0) {
      const m = rows[Math.min(state.cursor.models, rows.length - 1)]!;
      const next = state.pickDefault ? { ...state, pickDefault: false, tab: "settings" as Tab } : state;
      return { state: next, effects: [{ kind: "setDefaultModel", modelId: m.id }] };
    }
    return { state, effects: [] };
  }

  // settings / wallet rows
  const rows = state.tab === "settings" ? settingsRows(d) : walletRows(d);
  const cursor = Math.min(state.cursor[state.tab], Math.max(0, rows.length - 1));
  const row = rows[cursor];
  if (key === "down") return { state: moveCursor(state, state.tab, 1, rows.length), effects: [] };
  if (key === "up") return { state: moveCursor(state, state.tab, -1, rows.length), effects: [] };
  if (!row || row.disabled) return { state: { ...state, confirm: null }, effects: [] };

  // ←→ on a NON-cycle row = tab switching (spec: "←→ when no row edit is active").
  if ((key === "left" || key === "right") && row.kind !== "cycle") {
    return { state: cycleTab(state, key === "left"), effects: [] };
  }

  if (row.kind === "cycle" && (key === "enter" || key === "left" || key === "right")) {
    const opts = row.options!;
    const dir = key === "left" ? opts.length - 1 : 1;
    // Clamp: an unknown stored value anchors at index 0, so cycling stays deterministic.
    const cur = Math.max(0, opts.indexOf(row.value.replace(" (env)", "")));
    const next = opts[(cur + dir) % opts.length]!;
    if (row.id.startsWith("provider-")) {
      return { state, effects: [{ kind: "toggleProvider", provider: row.id.slice("provider-".length) as "anthropic" | "openai" | "tinfoil", on: next === "on" }] };
    }
    if (row.id === "profile") return { state, effects: [{ kind: "action", id: `profile-switch:${next}` }] };
    if (row.id === "showSpend") return { state, effects: [{ kind: "set", field: "showSpend", value: next === "on" }] };
    return { state, effects: [{ kind: "set", field: row.id, value: next }] };
  }

  if (key === "enter") {
    if (row.kind === "edit") {
      const seed = rawEditValue(row.id, d);
      return { state: { ...state, editing: { rowId: row.id, buffer: seed } }, effects: [] };
    }
    if (row.kind === "action") {
      const destructive = row.id === "clear-config" || row.id === "profile-delete";
      if (destructive && state.confirm !== row.id) return { state: { ...state, confirm: row.id }, effects: [] };
      if (row.id === "topup") return { state: { ...state, confirm: null, wizard: { step: "amount", cursor: 1, custom: "" } }, effects: [] };
      if (row.id === "pay") return { state: { ...state, confirm: null, wizard: { step: "pay" } }, effects: [] };
      if (row.id === "profile-new" || row.id === "profile-rename") return { state: { ...state, confirm: null, editing: { rowId: row.id, buffer: "" } }, effects: [] };
      if (row.id === "defaultModel") return { state: { ...state, tab: "models", pickDefault: true }, effects: [] };
      return { state: { ...state, confirm: null }, effects: [{ kind: "action", id: row.id }] };
    }
  }
  return { state: { ...state, confirm: null }, effects: [] };
}

function moveCursor(state: HubState, tab: Tab, delta: number, count: number): HubState {
  const c = Math.max(0, Math.min(count - 1, state.cursor[tab] + delta));
  return { ...state, confirm: null, cursor: { ...state.cursor, [tab]: c } };
}

// Seed for the inline editor: ONLY explicitly-set values echo back; unset fields (and secrets)
// start empty so defaults are never accidentally prefixed into the typed value.
function rawEditValue(rowId: string, d: HubData): string {
  const cfg = d.cfg;
  switch (rowId) {
    case "baseUrl": return cfg.baseUrl ?? "";
    case "lowBalanceUsd": return cfg.lowBalanceUsd !== undefined ? String(cfg.lowBalanceUsd) : "";
    case "spendWarnUsd": return cfg.spendWarnUsd !== undefined ? String(cfg.spendWarnUsd) : "";
    case "refreshSeconds": return cfg.refreshSeconds !== undefined ? String(cfg.refreshSeconds) : "";
    default: return ""; // apiKey and profile names always start blank
  }
}

// Hub rendering: pure (state, data, width, now) → lines. All styling through ThemeLike so tests
// run with an identity stub. Style AFTER padding (padCell truncation assumes unstyled cells).
import {
  activeProfile, formatUsd, type PendingOrder, type StoredConfigV2,
} from "../config.ts";
import { AMOUNT_PRESETS, RAILS_FALLBACK, type WatchState } from "../wallet.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clampScroll, padCell, twoCol } from "./layout.ts";
import {
  modelRows, settingsRows, walletRows,
  type HubData, type HubState, type RowSpec, type Tab,
} from "./hub-model.ts";
import { qrLines } from "./qr.ts";

export interface ThemeLike { fg(color: string, s: string): string }

const LABEL_W = 24;
const RAIL_W = 12;
const HINTS = "tab switch panel · ↑↓ navigate · enter edit · esc close";

export function renderHub(state: HubState, d: HubData, width: number, height: number, theme: ThemeLike): string[] {
  if (state.reveal !== null) {
    const body = [
      "", theme.fg("accent", "  Your new nullsink key — save it now, it is shown ONCE:"), "",
      `  ${state.reveal}`, "",
      theme.fg("warning", "  This key IS your money. Anyone holding it can spend it. No refunds."),
      theme.fg("muted", "  It is saved to ~/.pi/agent/nullsink.json (mode 0600)."), "",
      theme.fg("accent", "  press enter once you've stored it safely"),
    ];
    return [renderTabBar(state.tab, theme), theme.fg("dim", "─".repeat(width)), ...body];
  }
  const body: string[] =
    state.tab === "settings" ? renderSettingsTab(state, d, width, height - 5, theme)
    : state.tab === "wallet" ? renderWalletTab(state, d, width, height - 5, theme, Date.now())
    : renderModelsTab(state, d, width, height - 5, theme);
  const lines = [renderTabBar(state.tab, theme), theme.fg("dim", "─".repeat(Math.max(0, width))), ...body];
  lines.push(theme.fg("dim", "─".repeat(Math.max(0, width))));
  lines.push(theme.fg("muted", padCell(footerDescription(state, d), width)));
  lines.push(theme.fg("dim", padCell(HINTS, width)));
  return lines.map((l) => clampLine(l, width));
}

function renderTabBar(active: Tab, theme: ThemeLike): string {
  const tabs: Array<[Tab, string]> = [["settings", "⚙ Settings"], ["wallet", "◈ Wallet"], ["models", "▤ Models"]];
  return ` ${tabs.map(([t, label]) => (t === active ? theme.fg("accent", label) : theme.fg("muted", label))).join("   ")}`;
}

export function renderSettingsTab(state: HubState, d: HubData, width: number, height: number, theme: ThemeLike): string[] {
  const rows = settingsRows(d);
  const cursor = Math.min(state.cursor.settings, rows.length - 1);
  const sections = [...new Set(rows.map((r) => r.section))];
  const focusedSection = rows[cursor]?.section;

  const rail = sections.map((s) => (s === focusedSection ? theme.fg("accent", padCell(s, RAIL_W)) : theme.fg("muted", padCell(s, RAIL_W))));

  const right: string[] = [];
  let lastSection = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.section !== lastSection) {
      right.push(theme.fg("accent", r.section));
      lastSection = r.section;
    }
    right.push(renderRow(r, i === cursor, theme));
    if (i === cursor && state.editing) {
      right.push(`    ▸ ${state.editing.buffer}█`);
      if (state.editing.error) right.push(theme.fg("warning", `    ✗ ${state.editing.error}`));
    }
  }
  const top = clampScroll(rowLineIndex(rows, cursor), right.length, height, state.top.settings);
  return twoCol(rail, right.slice(top, top + height), RAIL_W, theme.fg("dim", " │ ")).map((l) => clampLine(l, width));
}

function rowLineIndex(rows: RowSpec[], cursor: number): number {
  // line index of the cursor row inside the right-pane lines (rows + one header line per section)
  let lines = 0;
  let lastSection = "";
  for (let i = 0; i <= cursor && i < rows.length; i++) {
    if (rows[i]!.section !== lastSection) {
      lines++;
      lastSection = rows[i]!.section;
    }
    if (i < cursor) lines++;
  }
  return lines;
}

function renderRow(r: RowSpec, focused: boolean, theme: ThemeLike): string {
  const marker = focused ? "❯ " : "  ";
  const cell = `${marker}${padCell(r.label, LABEL_W)}${r.value}`;
  if (r.disabled) return theme.fg("dim", cell);
  return focused ? theme.fg("accent", cell) : cell;
}

export function renderWalletTab(state: HubState, d: HubData, width: number, height: number, theme: ThemeLike, now: number): string[] {
  if (state.wizard?.step === "pay") {
    const order = activeProfile(d.cfg).pendingOrder;
    if (order) return renderPayScreen(order, d.watch ?? { phase: "waiting" }, now, width, theme);
  }
  const head = `Balance ${d.balance?.kind === "ok" && d.balance.balanceUsd !== undefined ? `● ${formatUsd(d.balance.balanceUsd)}` : d.balance?.kind === "unknown" ? "⚠ unfunded" : "…"} · Profile: ${d.cfg.activeProfile}`;
  const lines: string[] = [theme.fg("accent", clampLine(head, width)), ""];

  if (state.wizard) {
    lines.push(...renderWizard(state, d, theme));
    return lines.map((l) => clampLine(l, width));
  }
  const rows = walletRows(d, now);
  const cursor = Math.min(state.cursor.wallet, rows.length - 1);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const suffix = state.confirm === r.id ? theme.fg("warning", "  press enter again to confirm") : "";
    lines.push(renderRow(r, i === cursor, theme) + suffix);
    if (i === cursor && state.editing?.rowId === "profile-new") {
      lines.push(`    ▸ ${state.editing.buffer}█`);
      if (state.editing.error) lines.push(theme.fg("warning", `    ✗ ${state.editing.error}`));
    }
  }
  return lines.slice(0, height).map((l) => clampLine(l, width));
}

function renderWizard(state: HubState, d: HubData, theme: ThemeLike): string[] {
  const w = state.wizard!;
  if (w.step === "amount") {
    const cells = AMOUNT_PRESETS.map((p, i) => (i === w.cursor ? theme.fg("accent", `❯ $${p}`) : `  $${p}`));
    const custom = w.cursor === AMOUNT_PRESETS.length ? theme.fg("accent", `❯ custom… ${w.custom}█`) : "  custom…";
    const lines = ["Top up — how much?", "", `${cells.join("   ")}   ${custom}`];
    if (w.error) lines.push(theme.fg("warning", `✗ ${w.error}`));
    return lines;
  }
  if (w.step === "rail") {
    const rails = (d.rails ?? RAILS_FALLBACK).rails;
    return [
      `Top up $${w.creditUsd} — pay with:`, "",
      ...rails.map((r, i) => (i === w.cursor ? theme.fg("accent", `❯ ${r.unit} (${r.name}, ${r.confirmations} conf)`) : `  ${r.unit} (${r.name}, ${r.confirmations} conf)`)),
    ];
  }
  if (w.step === "quoting") return [`Top up $${w.creditUsd} — requesting quote…`];
  if (w.step === "error") return [theme.fg("warning", `✗ ${w.message}`), "", "enter to try again · esc to cancel"];
  return [];
}

export function renderPayScreen(order: PendingOrder, watch: WatchState, now: number, width: number, theme: ThemeLike): string[] {
  const qr = qrLines(order.payUri);
  const remaining = Math.max(0, order.expiresAt - now);
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000).toString().padStart(2, "0");
  const status = watch.phase === "waiting" ? "waiting for payment…"
    : watch.phase === "confirming" ? `confirming ${watch.confirmations ?? "…"}/${watch.required ?? "…"}`
    : watch.phase === "finalizing" ? "finalizing…"
    : watch.phase;
  const details = [
    "", theme.fg("accent", `Send exactly  ${order.amount} ${order.unit}`),
    `to  ${order.payTo}`, "",
    theme.fg("muted", `rate locked · expires in ${mm}:${ss}`),
    status, "",
    theme.fg("muted", "[t] pay with another coin (Trocador)"),
    theme.fg("muted", "[esc] background — I'll keep watching"),
  ];
  return twoCol(qr, details, Math.max(...qr.map((l) => l.length), 0), "   ").map((l) => clampLine(l, width));
}

export function renderModelsTab(state: HubState, d: HubData, width: number, height: number, theme: ThemeLike): string[] {
  const rows = modelRows(d.models, state.filter, d.cfg.providers ?? { anthropic: true, openai: true, tinfoil: true });
  const cursor = Math.min(state.cursor.models, Math.max(0, rows.length - 1));
  const lines: string[] = [`filter: ${state.filter}█`, ""];
  let lastProvider = "";
  const body: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]!;
    if (m.provider !== lastProvider) {
      body.push(theme.fg("accent", m.provider));
      lastProvider = m.provider;
    }
    const isDefault = d.cfg.defaultModel === m.id;
    const cell = `${i === cursor ? "❯ " : "  "}${padCell(m.id, 34)}${padCell(`${Math.round(m.contextWindow / 1000)}k`, 8)}$${m.input}/$${m.output} MTok${isDefault ? "  ← default" : ""}`;
    body.push(i === cursor ? theme.fg("accent", cell) : cell);
  }
  const top = clampScroll(cursor, body.length, height - 2, state.top.models);
  lines.push(...body.slice(top, top + height - 2));
  return lines.map((l) => clampLine(l, width));
}

function footerDescription(state: HubState, d: HubData): string {
  if (state.editing?.error) return `✗ ${state.editing.error}`;
  if (state.wizard) {
    if (state.wizard.step === "amount") return `$${2}–$${100} per top-up · type digits for a custom amount`;
    if (state.wizard.step === "rail") return "confirmations = network finality before credit lands";
    if (state.wizard.step === "pay") return "send from any wallet — credit lands after network confirmations";
    return "";
  }
  if (state.reveal) return "this key IS the money — it is saved to ~/.pi/agent/nullsink.json (0600)";
  const rows = state.tab === "settings" ? settingsRows(d) : state.tab === "wallet" ? walletRows(d) : [];
  return rows[Math.min(state.cursor[state.tab], Math.max(0, rows.length - 1))]?.description ?? "";
}

// Clamp a finished line to the terminal width. Fast path: already fits. Overflow with ANSI
// styling falls back to stripping the styling before the cut — a plain truncated line beats
// a corrupted escape sequence or a wrapped row.
const ANSI_RE = /\u001b\[[0-9;]*m/g;
function clampLine(l: string, width: number): string {
  if (visibleWidth(l) <= width) return l;
  const plain = l.replace(ANSI_RE, "");
  return plain.length <= width ? plain : `${plain.slice(0, Math.max(0, width - 1))}…`;
}

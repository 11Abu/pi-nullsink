import { describe, expect, test } from "bun:test";
import type { ModelsFile, PendingOrder, StoredConfigV2 } from "../src/config.ts";
import { emptyConfigV2 } from "../src/config.ts";
import modelsData from "../src/models.json";
import { initialHubState, modelRows, walletRows, type HubData, type HubState } from "../src/ui/hub-model.ts";
import { renderHub, renderModelsTab, renderPayScreen } from "../src/ui/hub-render.ts";

const theme = { fg: (_c: string, s: string) => s };
const models = modelsData as ModelsFile;

function data(over: Partial<HubData> = {}): HubData {
  const cfg: StoredConfigV2 = emptyConfigV2();
  cfg.profiles.default = { apiKey: "0sink_" + "a".repeat(47) };
  return { cfg, models, incognitoActive: false, ...over };
}

describe("renderHub", () => {
  test("frame: tab bar, sections, focused row marker, footer description", () => {
    const lines = renderHub(initialHubState(), data(), 80, 30, theme);
    const text = lines.join("\n");
    expect(text).toContain("Settings");
    expect(text).toContain("Wallet");
    expect(text).toContain("Account");
    expect(text).toContain("❯");
    expect(text).toContain("API key");
    expect(text).toContain("0sink_…"); // masked, never raw
    expect(text).not.toContain("a".repeat(20));
    expect(text).toContain("tab switch panel");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
  });
  test("editing shows buffer line and error", () => {
    const s: HubState = { ...initialHubState(), editing: { rowId: "lowBalanceUsd", buffer: "2.", error: "enter a dollar amount ≥ 0" } };
    const text = renderHub(s, data(), 80, 30, theme).join("\n");
    expect(text).toContain("▸ 2.");
    expect(text).toContain("✗ enter a dollar amount");
  });
  test("wallet tab shows balance header and rows", () => {
    const s: HubState = { ...initialHubState(), tab: "wallet" };
    const text = renderHub(s, data({ balance: { kind: "ok", balanceUsd: 42.5, message: "" } }), 80, 30, theme).join("\n");
    expect(text).toContain("$42.50");
    expect(text).toContain("Profile: default");
    expect(text).toContain("Top up");
  });
  test("amount step renders presets with cursor", () => {
    const s: HubState = { ...initialHubState(), tab: "wallet", wizard: { step: "amount", cursor: 1, custom: "" } };
    const text = renderHub(s, data(), 80, 30, theme).join("\n");
    expect(text).toContain("$10");
    expect(text).toContain("❯ $25");
    expect(text).toContain("custom…");
  });
  test("rename-profile editor line renders under the focused row", () => {
    const d = data();
    const idx = walletRows(d, 0).findIndex((r) => r.id === "profile-rename");
    expect(idx).toBeGreaterThan(-1);
    const base = initialHubState();
    const s: HubState = { ...base, tab: "wallet", cursor: { ...base.cursor, wallet: idx }, editing: { rowId: "profile-rename", buffer: "work" } };
    const text = renderHub(s, d, 80, 30, theme).join("\n");
    expect(text).toContain("▸ work█");
  });
  test("models tab scroll keeps the last row visible despite provider header lines", () => {
    const d = data();
    const rows = modelRows(d.models, "", d.cfg.providers ?? { anthropic: true, openai: true, tinfoil: true });
    const last = rows[rows.length - 1]!;
    const base = initialHubState();
    const s: HubState = { ...base, tab: "models", cursor: { ...base.cursor, models: rows.length - 1 } };
    const text = renderModelsTab(s, d, 100, 12, theme).join("\n");
    expect(text).toContain(last.id);
  });
});

describe("renderPayScreen", () => {
  const order: PendingOrder = {
    hash: "a".repeat(64), baseUrl: "https://nullsink.is", creditUsd: 25, rail: "monero", unit: "XMR",
    payTo: "8AbCdEf", amount: "0.14720100", payUri: "monero:8AbCdEf?tx_amount=0.14720100",
    expiresAt: 1_000_000 + 19 * 60_000 + 42_000, createdAt: 1_000_000,
  };
  test("QR + verbatim amount + countdown + hints", () => {
    const lines = renderPayScreen(order, { phase: "waiting" }, 1_000_000, 100, theme);
    const text = lines.join("\n");
    expect(text).toContain("0.14720100 XMR"); // verbatim — trailing zeros intact
    expect(text).toContain("8AbCdEf");
    expect(text).toContain("19:42");
    expect(text).toContain("[t]");
    expect(text).toMatch(/[▀▄█]/); // QR blocks present
  });
  test("expired countdown floors at 0:00, still watching", () => {
    const text = renderPayScreen(order, { phase: "confirming", confirmations: 4, required: 10 }, 5_000_000, 100, theme).join("\n");
    expect(text).toContain("0:00");
    expect(text).toContain("confirming 4/10");
  });
});

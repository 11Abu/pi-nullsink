// test/hub-model.test.ts
import { describe, expect, test } from "bun:test";
import type { StoredConfigV2 } from "../src/config.ts";
import { emptyConfigV2 } from "../src/config.ts";
import { generateToken } from "../src/token.ts";
import {
  initialHubState, modelRows, reduceHub, settingsRows, validateField, walletRows,
  type HubData, type HubState,
} from "../src/ui/hub-model.ts";
import { models } from "../src/models.ts";

function cfg(over: Partial<StoredConfigV2> = {}): StoredConfigV2 {
  const c = emptyConfigV2();
  c.profiles.default = { apiKey: "0sink_" + "a".repeat(47) };
  return { ...c, ...over };
}
function data(over: Partial<HubData> = {}): HubData {
  return { cfg: cfg(), models, incognitoActive: false, ...over };
}

describe("settingsRows", () => {
  test("groups into the five sections in order", () => {
    const sections = [...new Set(settingsRows(data()).map((r) => r.section))];
    expect(sections).toEqual(["Account", "Connection", "Model", "Display", "Privacy"]);
  });
  test("masks the key and tags env overrides", () => {
    const rows = settingsRows(data({ envKey: "0sink_" + "b".repeat(47) }));
    const key = rows.find((r) => r.id === "apiKey")!;
    expect(key.value).toContain("(env)");
    expect(key.disabled).toBe(true);
    expect(key.value).not.toContain("b".repeat(20)); // never the raw key
  });
  test("in-use provider toggle is locked on", () => {
    const rows = settingsRows(data({ currentProviderKey: "anthropic" }));
    const row = rows.find((r) => r.id === "provider-anthropic")!;
    expect(row.disabled).toBe(true);
    expect(row.description).toContain("switch model");
  });
});

describe("reduceHub navigation", () => {
  test("tab cycles tabs; shift-tab reverses", () => {
    let s = initialHubState();
    s = reduceHub(s, "tab", data()).state;
    expect(s.tab).toBe("wallet");
    s = reduceHub(s, "shift-tab", data()).state;
    expect(s.tab).toBe("settings");
  });
  test("up/down move the cursor within rows and clamp", () => {
    let s = initialHubState();
    const d = data();
    s = reduceHub(s, "down", d).state;
    expect(s.cursor.settings).toBe(1);
    s = reduceHub(s, "up", d).state;
    s = reduceHub(s, "up", d).state;
    expect(s.cursor.settings).toBe(0);
  });
  test("esc at top level emits close", () => {
    const { effects } = reduceHub(initialHubState(), "esc", data());
    expect(effects).toEqual([{ kind: "close" }]);
  });
});

describe("cycle + edit rows", () => {
  function cursorTo(s: HubState, d: HubData, rowId: string): HubState {
    const rows = settingsRows(d);
    const idx = rows.findIndex((r) => r.id === rowId);
    return { ...s, cursor: { ...s.cursor, settings: idx } };
  }
  test("display cycles and emits set", () => {
    const d = data();
    const s = cursorTo(initialHubState(), d, "display");
    const { effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([{ kind: "set", field: "display", value: "widget" }]);
  });
  test("provider toggle emits toggleProvider", () => {
    const d = data();
    const s = cursorTo(initialHubState(), d, "provider-openai");
    const { effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([{ kind: "toggleProvider", provider: "openai", on: false }]);
  });
  test("edit row opens editor, types, validates, commits", () => {
    const d = data();
    let s = cursorTo(initialHubState(), d, "lowBalanceUsd");
    s = reduceHub(s, "enter", d).state;
    expect(s.editing?.rowId).toBe("lowBalanceUsd");
    for (const ch of "2.5") s = reduceHub(s, { char: ch }, d).state;
    const { state: s2, effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([{ kind: "set", field: "lowBalanceUsd", value: 2.5 }]);
    expect(s2.editing).toBeNull();
  });
  test("invalid edit keeps the editor open with an error", () => {
    const d = data();
    let s = cursorTo(initialHubState(), d, "lowBalanceUsd");
    s = reduceHub(s, "enter", d).state;
    for (const ch of "abc") s = reduceHub(s, { char: ch }, d).state;
    const { state: s2, effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([]);
    expect(s2.editing?.error).toBeTruthy();
  });
  test("apiKey edit rejects a checksum-failing token", () => {
    const bad = "0sink_" + "c".repeat(47);
    expect(validateField("apiKey", bad).ok).toBe(false);
  });
});

describe("wallet wizard", () => {
  function openWizard(d: HubData): HubState {
    let s: HubState = { ...initialHubState(), tab: "wallet" };
    const rows = walletRows(d);
    const idx = rows.findIndex((r) => r.id === "topup");
    s = { ...s, cursor: { ...s.cursor, wallet: idx } };
    return reduceHub(s, "enter", d).state;
  }
  test("amount step: preset navigation and selection", () => {
    const d = data();
    let s = openWizard(d);
    expect(s.wizard).toEqual({ step: "amount", cursor: 1, custom: "" });
    s = reduceHub(s, "right", d).state; // -> $50
    s = reduceHub(s, "enter", d).state;
    expect(s.wizard?.step).toBe("rail");
    if (s.wizard?.step === "rail") expect(s.wizard.creditUsd).toBe(50);
  });
  test("custom amount: digits jump to custom; out-of-band rejected", () => {
    const d = data();
    let s = openWizard(d);
    for (const ch of "150") s = reduceHub(s, { char: ch }, d).state;
    const { state: s2 } = reduceHub(s, "enter", d);
    expect(s2.wizard?.step).toBe("amount");
    if (s2.wizard?.step === "amount") expect(s2.wizard.error).toContain("100");
  });
  test("rail step: enter emits quote effect", () => {
    const d = data({ rails: { default: "monero", rails: [{ name: "monero", unit: "XMR", confirmations: 10 }, { name: "bitcoin", unit: "BTC", confirmations: 3 }] } });
    let s = openWizard(d);
    s = reduceHub(s, "enter", d).state; // $25 -> rail step
    const { state: s2, effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([{ kind: "quote", creditUsd: 25, rail: "monero" }]);
    expect(s2.wizard).toEqual({ step: "quoting", creditUsd: 25, rail: "monero" });
  });
  test("pay step: t opens Trocador, esc backgrounds", () => {
    const d = data();
    let s: HubState = { ...initialHubState(), tab: "wallet", wizard: { step: "pay" } };
    expect(reduceHub(s, { char: "t" }, d).effects).toEqual([{ kind: "openTrocador" }]);
    s = reduceHub(s, "esc", d).state;
    expect(s.wizard).toBeNull();
  });
});

describe("modelRows", () => {
  test("filter narrows, provider toggles hide groups", () => {
    const all = modelRows(models, "", { anthropic: true, openai: true, tinfoil: true });
    const noAnthropic = modelRows(models, "", { anthropic: false, openai: true, tinfoil: true });
    expect(noAnthropic.length).toBeLessThan(all.length);
    expect(noAnthropic.some((m) => m.provider === "anthropic")).toBe(false);
    const filtered = modelRows(models, "opus", { anthropic: true, openai: true, tinfoil: true });
    expect(filtered.length).toBeGreaterThan(0);
    for (const m of filtered) expect(`${m.id} ${m.name}`.toLowerCase()).toContain("opus");
  });
});

describe("confirm + reveal", () => {
  test("clear-config needs a second enter", () => {
    const d = data();
    let s: HubState = { ...initialHubState(), tab: "wallet" };
    const rows = walletRows(d);
    s = { ...s, cursor: { ...s.cursor, wallet: rows.findIndex((r) => r.id === "clear-config") } };
    const first = reduceHub(s, "enter", d);
    expect(first.effects).toEqual([]);
    expect(first.state.confirm).toBe("clear-config");
    const second = reduceHub(first.state, "enter", d);
    expect(second.effects).toEqual([{ kind: "action", id: "clear-config" }]);
    expect(second.state.confirm).toBeNull();
  });
  test("reveal swallows keys until enter", () => {
    const d = data();
    const s: HubState = { ...initialHubState(), reveal: "0sink_" + "d".repeat(47) };
    expect(reduceHub(s, { char: "x" }, d).state.reveal).not.toBeNull();
    const { state: s2, effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([{ kind: "action", id: "mint-saved" }]);
    expect(s2.reveal).toBeNull();
  });
});

describe("review-pinned behaviors", () => {
  function cursorToSettings(s: HubState, d: HubData, rowId: string): HubState {
    const idx = settingsRows(d).findIndex((r) => r.id === rowId);
    return { ...s, cursor: { ...s.cursor, settings: idx } };
  }
  test("←→ on a non-cycle row switches tabs", () => {
    const d = data();
    let s = cursorToSettings(initialHubState(), d, "apiKey"); // edit row
    s = reduceHub(s, "right", d).state;
    expect(s.tab).toBe("wallet");
    s = reduceHub({ ...s, tab: "settings" }, "left", d).state;
    expect(s.tab).toBe("models");
  });
  test("pick-default round trip: Settings → Models → enter → back to Settings", () => {
    const d = data();
    let s = cursorToSettings(initialHubState(), d, "defaultModel");
    s = reduceHub(s, "enter", d).state;
    expect(s).toMatchObject({ tab: "models", pickDefault: true });
    const { state: s2, effects } = reduceHub(s, "enter", d);
    expect(effects[0]?.kind).toBe("setDefaultModel");
    expect(s2).toMatchObject({ tab: "settings", pickDefault: false });
  });
  test("plain Models visit: enter sets default but stays on the tab", () => {
    const d = data();
    const s: HubState = { ...initialHubState(), tab: "models" };
    const { state: s2, effects } = reduceHub(s, "enter", d);
    expect(effects[0]?.kind).toBe("setDefaultModel");
    expect(s2.tab).toBe("models");
  });
  test("apiKey checksum mismatch: first enter arms, second enter saves anyway", () => {
    const d = data();
    let s = cursorToSettings(initialHubState(), d, "apiKey");
    s = reduceHub(s, "enter", d).state; // open editor (blank seed)
    const bad = `0sink_${"c".repeat(47)}`;
    for (const ch of bad) s = reduceHub(s, { char: ch }, d).state;
    const first = reduceHub(s, "enter", d);
    expect(first.effects).toEqual([]);
    expect(first.state.editing?.error).toContain("enter again");
    const second = reduceHub(first.state, "enter", d);
    expect(second.effects).toEqual([{ kind: "set", field: "apiKey", value: bad }]);
    expect(second.state.editing).toBeNull();
  });
  test("rename profile: action opens editor, commit emits profile-rename:<name>", () => {
    const d = data();
    let s: HubState = { ...initialHubState(), tab: "wallet" };
    const rows = walletRows(d);
    s = { ...s, cursor: { ...s.cursor, wallet: rows.findIndex((r) => r.id === "profile-rename") } };
    s = reduceHub(s, "enter", d).state;
    expect(s.editing?.rowId).toBe("profile-rename");
    for (const ch of "work") s = reduceHub(s, { char: ch }, d).state;
    const { effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([{ kind: "action", id: "profile-rename:work" }]);
  });
  test("editor seeds empty for unset numeric fields", () => {
    const d = data(); // cfg has no lowBalanceUsd set
    let s = cursorToSettings(initialHubState(), d, "lowBalanceUsd");
    s = reduceHub(s, "enter", d).state;
    expect(s.editing?.buffer).toBe("");
  });
});

describe("contract completions", () => {
  function cursorToSettings(s: HubState, d: HubData, rowId: string): HubState {
    const idx = settingsRows(d).findIndex((r) => r.id === rowId);
    return { ...s, cursor: { ...s.cursor, settings: idx } };
  }
  function openWizard(d: HubData): HubState {
    let s: HubState = { ...initialHubState(), tab: "wallet" };
    const idx = walletRows(d).findIndex((r) => r.id === "topup");
    s = { ...s, cursor: { ...s.cursor, wallet: idx } };
    return reduceHub(s, "enter", d).state;
  }

  test("esc in the editor closes it without a close effect", () => {
    const d = data();
    let s = cursorToSettings(initialHubState(), d, "lowBalanceUsd");
    s = reduceHub(s, "enter", d).state;
    expect(s.editing?.rowId).toBe("lowBalanceUsd");
    const { state: s2, effects } = reduceHub(s, "esc", d);
    expect(s2.editing).toBeNull();
    expect(effects).toEqual([]);
  });
  test("esc on the rail step returns to the amount step", () => {
    const d = data();
    let s = openWizard(d);
    s = reduceHub(s, "enter", d).state; // $25 -> rail
    expect(s.wizard?.step).toBe("rail");
    s = reduceHub(s, "esc", d).state;
    expect(s.wizard).toEqual({ step: "amount", cursor: 1, custom: "" });
  });
  test("enter on the error step returns to the amount step", () => {
    const d = data();
    const s: HubState = { ...initialHubState(), tab: "wallet", wizard: { step: "error", message: "quote failed" } };
    const { state: s2 } = reduceHub(s, "enter", d);
    expect(s2.wizard).toEqual({ step: "amount", cursor: 1, custom: "" });
  });
  test("armed clear-config confirm disarms on cursor movement, no action fires", () => {
    const d = data();
    let s: HubState = { ...initialHubState(), tab: "wallet" };
    const rows = walletRows(d);
    s = { ...s, cursor: { ...s.cursor, wallet: rows.findIndex((r) => r.id === "clear-config") } };
    s = reduceHub(s, "enter", d).state;
    expect(s.confirm).toBe("clear-config");
    const { state: s2, effects } = reduceHub(s, "up", d);
    expect(s2.confirm).toBeNull();
    expect(effects).toEqual([]);
  });

  test("armed mismatch confirm disarms on backspace: next enter re-arms, no commit", () => {
    const d = data();
    let s = cursorToSettings(initialHubState(), d, "apiKey");
    s = reduceHub(s, "enter", d).state;
    for (const ch of `0sink_${"c".repeat(47)}`) s = reduceHub(s, { char: ch }, d).state;
    s = reduceHub(s, "enter", d).state; // arm
    expect(s.editing?.confirmMismatch).toBe(true);
    s = reduceHub(s, "backspace", d).state; // disarm
    const { state: s2, effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([]); // re-armed, NOT committed
    expect(s2.editing?.error).toContain("enter again");
    expect(s2.editing?.confirmMismatch).toBe(true);
  });
  test("valid apiKey commits on the first enter, no arming", () => {
    const d = data();
    const good = generateToken();
    let s = cursorToSettings(initialHubState(), d, "apiKey");
    s = reduceHub(s, "enter", d).state;
    for (const ch of good) s = reduceHub(s, { char: ch }, d).state;
    const { state: s2, effects } = reduceHub(s, "enter", d);
    expect(effects).toEqual([{ kind: "set", field: "apiKey", value: good }]);
    expect(s2.editing).toBeNull();
  });

  test("←→ on a cycle row cycles the value instead of switching tabs", () => {
    const d = data(); // display defaults to "statusline"
    const s = cursorToSettings(initialHubState(), d, "display");
    const right = reduceHub(s, "right", d);
    expect(right.effects).toEqual([{ kind: "set", field: "display", value: "widget" }]);
    expect(right.state.tab).toBe("settings");
    const left = reduceHub(s, "left", d);
    expect(left.effects).toEqual([{ kind: "set", field: "display", value: "off" }]); // wraps backwards
    expect(left.state.tab).toBe("settings");
  });

  test("editor seeds the explicitly-set value", () => {
    const d = data({ cfg: cfg({ lowBalanceUsd: 2.5 }) });
    let s = cursorToSettings(initialHubState(), d, "lowBalanceUsd");
    s = reduceHub(s, "enter", d).state;
    expect(s.editing?.buffer).toBe("2.5");
  });

  test("baseUrl env override disables the row and tags (env)", () => {
    const rows = settingsRows(data({ envUrl: "https://env.example" }));
    const row = rows.find((r) => r.id === "baseUrl")!;
    expect(row.disabled).toBe(true);
    expect(row.value).toContain("(env)");
  });

  test("models tab: typed chars build the filter, backspace trims it", () => {
    const d = data();
    let s: HubState = { ...initialHubState(), tab: "models" };
    for (const ch of "op") s = reduceHub(s, { char: ch }, d).state;
    expect(s.filter).toBe("op");
    s = reduceHub(s, "backspace", d).state;
    expect(s.filter).toBe("o");
  });

  test("custom amount below the minimum stays on amount with the $2 floor in the error", () => {
    const d = data();
    let s = openWizard(d);
    s = reduceHub(s, { char: "1" }, d).state;
    const { state: s2 } = reduceHub(s, "enter", d);
    expect(s2.wizard?.step).toBe("amount");
    if (s2.wizard?.step === "amount") expect(s2.wizard.error).toContain("$2");
  });

  test("tab is swallowed while editing", () => {
    const d = data();
    let s = cursorToSettings(initialHubState(), d, "lowBalanceUsd");
    s = reduceHub(s, "enter", d).state;
    const { state: s2, effects } = reduceHub(s, "tab", d);
    expect(s2.editing?.rowId).toBe("lowBalanceUsd");
    expect(s2.tab).toBe("settings");
    expect(effects).toEqual([]);
  });

  test("unknown cycle value anchors at index 0: left emits the last option", () => {
    const d = data({ cfg: cfg({ thinkingLevel: "weird" }) });
    const s = cursorToSettings(initialHubState(), d, "thinkingLevel");
    const { effects } = reduceHub(s, "left", d);
    expect(effects).toEqual([{ kind: "set", field: "thinkingLevel", value: "xhigh" }]);
  });
});

describe("wallet mint env guard", () => {
  test("env key disables the mint row with the env explanation", () => {
    const rows = walletRows(data({ envKey: `0sink_${"e".repeat(47)}` }));
    const mint = rows.find((r) => r.id === "mint")!;
    expect(mint.disabled).toBe(true);
    expect(mint.description).toContain("NULLSINK_API_KEY");
  });
  test("mint row stays enabled without an env key", () => {
    const mint = walletRows(data()).find((r) => r.id === "mint")!;
    expect(mint.disabled).toBeFalsy();
  });
});

describe("deferred minors (T8)", () => {
  function openWizard(d: HubData): HubState {
    let s: HubState = { ...initialHubState(), tab: "wallet" };
    const idx = walletRows(d).findIndex((r) => r.id === "topup");
    s = { ...s, cursor: { ...s.cursor, wallet: idx } };
    return reduceHub(s, "enter", d).state;
  }
  test("rail step opens the cursor on the default rail even when it is not index 0", () => {
    const rails = {
      default: "bitcoin",
      rails: [
        { name: "monero", unit: "XMR", confirmations: 10 },
        { name: "bitcoin", unit: "BTC", confirmations: 3 },
        { name: "litecoin", unit: "LTC", confirmations: 6 },
      ],
    };
    const d = data({ rails });
    let s = openWizard(d); // amount step, cursor 1 => $25
    s = reduceHub(s, "enter", d).state; // -> rail step
    expect(s.wizard).toEqual({ step: "rail", creditUsd: 25, cursor: 1 }); // bitcoin (index 1), not 0
  });
  test("orderRowValue renders '⧗ confirming n/m · $credit · expires mm:ss' at a frozen now", () => {
    const now = 1_000_000;
    const c = emptyConfigV2();
    c.profiles.default = {
      apiKey: "0sink_" + "a".repeat(47),
      pendingOrder: {
        hash: "a".repeat(64), baseUrl: "https://nullsink.is", creditUsd: 25,
        rail: "monero", unit: "XMR", payTo: "8AbC", amount: "0.147",
        payUri: "monero:8AbC", expiresAt: now + 19 * 60_000 + 42_000, createdAt: now,
      },
    };
    const d = data({ cfg: c, watch: { phase: "confirming", confirmations: 4, required: 10 } });
    const row = walletRows(d, now).find((r) => r.id === "pay")!;
    expect(row.value).toBe("⧗ confirming 4/10 · $25 · expires 19:42");
  });
});

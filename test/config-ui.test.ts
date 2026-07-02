import { describe, expect, test } from "bun:test";
import {
  isDisplayMode,
  maskKey,
  renderOrderSegment,
  renderStatusLine,
  renderWidget,
  resolveBaseUrlValue,
  type BalanceKind,
  type BalanceResult,
  type StatusState,
} from "../src/config.ts";

// --- fixtures -------------------------------------------------------------

// BalanceResult carries a required `message` the renderers never read; the helper keeps fixtures
// type-correct (so `bun run typecheck` stays green) while exposing only the fields under test.
const bal = (kind: BalanceKind, balanceUsd?: number): BalanceResult => ({ kind, balanceUsd, message: "" });

// A configured, settled snapshot by default; each test overrides only the axis it exercises.
// lowBalanceUsd is required by the v2 StatusState — every case passes the default threshold of 1.
const st = (over: Partial<StatusState> = {}): StatusState => ({ configured: true, loading: false, lowBalanceUsd: 1, ...over });

describe("isDisplayMode", () => {
  test("accepts the four canonical display modes", () => {
    expect(isDisplayMode("statusline")).toBe(true);
    expect(isDisplayMode("widget")).toBe(true);
    expect(isDisplayMode("both")).toBe(true);
    expect(isDisplayMode("off")).toBe(true);
  });

  test("rejects blanks, wrong case, unknown strings, and non-strings", () => {
    expect(isDisplayMode("")).toBe(false);
    expect(isDisplayMode("STATUSLINE")).toBe(false);
    expect(isDisplayMode("line")).toBe(false);
    expect(isDisplayMode(null)).toBe(false);
    expect(isDisplayMode(undefined)).toBe(false);
    expect(isDisplayMode(3)).toBe(false);
    expect(isDisplayMode({})).toBe(false);
  });
});

describe("maskKey", () => {
  test("collapses length <= 4 to just the ellipsis", () => {
    expect(maskKey("")).toBe("…");
    expect(maskKey("ab")).toBe("…");
    expect(maskKey("abcd")).toBe("…");
  });

  test("shows ellipsis + last 4 for length 5..10", () => {
    expect(maskKey("0sink_ab")).toBe("…k_ab");
  });

  test("keeps prefix + ellipsis + last 4 for length > 10, hiding the middle", () => {
    const secretMid = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"; // 43 chars
    const key = `0sink_${secretMid}wxyz`; // 6 + 43 + 4 = 53, matches "0sink_" + 47
    const masked = maskKey(key);
    expect(masked.startsWith("0sink_")).toBe(true);
    expect(masked).toContain("…");
    expect(masked.endsWith(key.slice(-4))).toBe(true);
    expect(masked).not.toContain(secretMid);
    expect(masked).toBe("0sink_…wxyz");
  });

  test("trims before masking", () => {
    expect(maskKey("  0sink_ab  ")).toBe("…k_ab");
    expect(maskKey("  abcd  ")).toBe("…");
  });
});

describe("resolveBaseUrlValue", () => {
  test("env override wins and is trimmed", () => {
    expect(resolveBaseUrlValue("  https://e ", "https://f")).toBe("https://e");
  });

  test("falls back to the trimmed file value when env is blank/undefined/null", () => {
    expect(resolveBaseUrlValue("", "https://f")).toBe("https://f");
    expect(resolveBaseUrlValue("   ", "https://f")).toBe("https://f");
    expect(resolveBaseUrlValue(undefined, "https://f")).toBe("https://f");
    expect(resolveBaseUrlValue(null, "  https://f  ")).toBe("https://f");
  });

  test("returns undefined when both are blank/undefined", () => {
    expect(resolveBaseUrlValue(undefined, undefined)).toBeUndefined();
    expect(resolveBaseUrlValue("", "")).toBeUndefined();
    expect(resolveBaseUrlValue("  ", null)).toBeUndefined();
  });
});

describe("renderStatusLine", () => {
  test("unconfigured → setup nudge", () => {
    expect(renderStatusLine(st({ configured: false }))).toBe("nullsink ○ no key · /nullsink setup");
  });

  test("healthy balance → amount + ● and no top-up", () => {
    const line = renderStatusLine(st({ balance: bal("ok", 42.5) }));
    expect(line).toContain("$42.50");
    expect(line).toContain("●");
    expect(line).not.toContain("top up");
  });

  test("low balance → amount + ⚠ + top up", () => {
    const line = renderStatusLine(st({ balance: bal("ok", 0.8) }));
    expect(line).toContain("$0.80");
    expect(line).toContain("⚠");
    expect(line).toContain("top up");
  });

  test("unknown balance → unfunded", () => {
    expect(renderStatusLine(st({ balance: bal("unknown") }))).toBe("nullsink ⚠ unfunded · /nullsink topup");
  });

  test("error balance → unavailable", () => {
    expect(renderStatusLine(st({ balance: bal("error") }))).toContain("unavailable");
  });

  test("no balance while loading → checking", () => {
    expect(renderStatusLine(st({ loading: true }))).toContain("checking");
  });

  test("no balance, not loading → balance not checked", () => {
    expect(renderStatusLine(st({ loading: false }))).toBe("nullsink ● balance not checked");
  });
});

describe("renderWidget", () => {
  test("returns a two-line array whose head equals renderStatusLine", () => {
    const s = st({ balance: bal("ok", 42.5) });
    const w = renderWidget(s);
    expect(Array.isArray(w)).toBe(true);
    expect(w).toHaveLength(2);
    expect(w[0]).toBe(renderStatusLine(s));
  });

  test("second line is the fixed /nullsink hint, configured or not", () => {
    expect(renderWidget(st())[1]).toBe("  /nullsink — settings · wallet · models");
    expect(renderWidget(st({ configured: false }))[1]).toBe("  /nullsink — settings · wallet · models");
  });
});

describe("renderStatusLine v2 decorations", () => {
  const base = { configured: true, lowBalanceUsd: 1, balance: { kind: "ok", balanceUsd: 42.5, message: "" } } as const;
  test("incognito prefix", () => {
    expect(renderStatusLine({ ...base, incognito: true })).toBe("⦿ incognito · nullsink ● $42.50");
  });
  test("spend segment", () => {
    expect(renderStatusLine({ ...base, spendUsd: 0.834 })).toBe("nullsink ● $42.50 · spent $0.83");
  });
  test("order segment states", () => {
    expect(renderOrderSegment({ phase: "waiting" })).toBe("⧗ waiting");
    expect(renderOrderSegment({ phase: "confirming", confirmations: 4, required: 10 })).toBe("⧗ confirming 4/10");
    expect(renderOrderSegment({ phase: "finalizing" })).toBe("⧗ finalizing");
    expect(renderStatusLine({ ...base, order: { phase: "confirming", confirmations: 4, required: 10 } }))
      .toBe("nullsink ● $42.50 · ⧗ confirming 4/10");
  });
  test("configurable low threshold", () => {
    const low = { kind: "ok", balanceUsd: 2.4, message: "" } as const;
    expect(renderStatusLine({ configured: true, lowBalanceUsd: 5, balance: low })).toContain("⚠");
    expect(renderStatusLine({ configured: true, lowBalanceUsd: 1, balance: low })).toContain("●");
  });
  test("all decorations compose in order", () => {
    expect(renderStatusLine({ ...base, incognito: true, spendUsd: 1.2, order: { phase: "waiting" } }))
      .toBe("⦿ incognito · nullsink ● $42.50 · spent $1.20 · ⧗ waiting");
  });
});

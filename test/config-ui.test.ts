import { describe, expect, test } from "bun:test";
import {
  isDisplayMode,
  LOW_BALANCE_USD,
  maskKey,
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
const st = (over: Partial<StatusState> = {}): StatusState => ({ configured: true, loading: false, ...over });

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

  test("LOW_BALANCE_USD is the boundary: at threshold not low, below is low", () => {
    expect(LOW_BALANCE_USD).toBe(1);

    // At the threshold (1) → NOT low.
    const atThreshold = renderStatusLine(st({ balance: bal("ok", LOW_BALANCE_USD) }));
    expect(atThreshold).toContain("$1.00");
    expect(atThreshold).toContain("●");
    expect(atThreshold).not.toContain("top up");

    // Just below the threshold → low.
    const below = renderStatusLine(st({ balance: bal("ok", LOW_BALANCE_USD - 0.2) }));
    expect(below).toContain("⚠");
    expect(below).toContain("top up");
  });

  test("unknown balance → unfunded", () => {
    expect(renderStatusLine(st({ balance: bal("unknown") }))).toContain("unfunded");
  });

  test("error balance → unavailable", () => {
    expect(renderStatusLine(st({ balance: bal("error") }))).toContain("unavailable");
  });

  test("no balance while loading → checking", () => {
    expect(renderStatusLine(st({ loading: true }))).toContain("checking");
  });

  test("no balance, not loading → key set", () => {
    expect(renderStatusLine(st({ loading: false }))).toBe("nullsink ● key set");
  });
});

describe("renderWidget", () => {
  test("returns a two-line array whose head equals renderStatusLine", () => {
    const s = st({ keyMasked: "0sink_…wxyz" });
    const w = renderWidget(s);
    expect(Array.isArray(w)).toBe(true);
    expect(w).toHaveLength(2);
    expect(w[0]).toBe(renderStatusLine(s));
  });

  test("configured second line shows the masked key + config action", () => {
    const w = renderWidget(st({ keyMasked: "0sink_…wxyz" }));
    expect(w[1]).toContain("0sink_…wxyz");
    expect(w[1]).toContain("/nullsink config");
  });

  test("unconfigured second line points at nullsink.is", () => {
    const s = st({ configured: false });
    const w = renderWidget(s);
    expect(w[0]).toBe(renderStatusLine(s));
    expect(w[1]).toContain("nullsink.is");
  });
});

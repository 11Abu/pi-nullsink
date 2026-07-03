// test/config-v2.test.ts
import { describe, expect, test } from "bun:test";
import {
  activeProfile, clampRefreshSeconds, DEFAULTS, emptyConfigV2, parseConfigV2, serializeConfigV2,
} from "../src/config.ts";

describe("parseConfigV2", () => {
  test("migrates a v1 file into profiles.default", () => {
    const v1 = { apiKey: "0sink_x", baseUrl: "https://self.host", display: "widget", setupDone: true };
    const cfg = parseConfigV2(v1)!;
    expect(cfg.version).toBe(2);
    expect(cfg.activeProfile).toBe("default");
    expect(cfg.profiles.default!.apiKey).toBe("0sink_x");
    expect(cfg.baseUrl).toBe("https://self.host");
    expect(cfg.display).toBe("widget");
    expect(cfg.setupDone).toBe(true);
  });
  test("parses a v2 file and keeps unknown fields in extra", () => {
    const raw = {
      version: 2, activeProfile: "work",
      profiles: { work: { apiKey: "0sink_y" } },
      lowBalanceUsd: 3, futureField: { keep: "me" },
    };
    const cfg = parseConfigV2(raw)!;
    expect(cfg.activeProfile).toBe("work");
    expect(cfg.lowBalanceUsd).toBe(3);
    expect(cfg.extra).toEqual({ futureField: { keep: "me" } });
    const out = serializeConfigV2(cfg);
    expect((out as Record<string, unknown>).futureField).toEqual({ keep: "me" });
    expect("extra" in out).toBe(false);
  });
  test("wrong-typed fields degrade to absent, never throw", () => {
    const cfg = parseConfigV2({ version: 2, activeProfile: 7, profiles: "nope", lowBalanceUsd: "x", incognito: "loud" })!;
    expect(cfg.activeProfile).toBe("default");
    expect(cfg.profiles).toEqual({});
    expect(cfg.lowBalanceUsd).toBeUndefined();
    expect(cfg.incognito).toBeUndefined();
  });
  test("drops a malformed pendingOrder but keeps the profile", () => {
    const cfg = parseConfigV2({
      version: 2, activeProfile: "default",
      profiles: { default: { apiKey: "0sink_z", pendingOrder: { hash: 42 } } },
    })!;
    expect(cfg.profiles.default!.apiKey).toBe("0sink_z");
    expect(cfg.profiles.default!.pendingOrder).toBeUndefined();
  });
  test("non-object input → null; empty object → empty v2", () => {
    expect(parseConfigV2("junk")).toBeNull();
    expect(parseConfigV2(null)).toBeNull();
    const cfg = parseConfigV2({})!;
    expect(cfg.profiles).toEqual({});
    expect(activeProfile(cfg)).toEqual({});
  });
});

describe("defaults + clamps", () => {
  test("clampRefreshSeconds", () => {
    expect(clampRefreshSeconds(60)).toBe(60);
    expect(clampRefreshSeconds(3)).toBe(15);
    expect(clampRefreshSeconds(Number.NaN)).toBe(60);
  });
  test("emptyConfigV2 shape", () => {
    const cfg = emptyConfigV2();
    expect(cfg.version).toBe(2);
    expect(cfg.activeProfile).toBe("default");
    expect(DEFAULTS.lowBalanceUsd).toBe(1);
  });
});

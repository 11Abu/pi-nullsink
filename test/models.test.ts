// The catalog must load via a runtime read (src/models.ts), not a static JSON module import:
// host loaders that transpile every statically imported file under the extension dir (e.g.
// Oh My Pi's legacy-pi compat) choke on JSON modules, which silently kills the whole extension.
import { describe, expect, test } from "bun:test";
import { models } from "../src/models.ts";

describe("models catalog runtime loader", () => {
  test("all three provider groups are present and non-empty", () => {
    const groups = ["anthropic", "openai", "tinfoil"] as const;
    for (const g of groups) {
      expect(models.providers[g].length).toBeGreaterThan(0);
    }
  });

  test("every model satisfies the RawModel contract buildProviders depends on", () => {
    for (const m of Object.values(models.providers).flat()) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.name.length).toBeGreaterThan(0);
      expect(typeof m.reasoning).toBe("boolean");
      expect(m.input.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
      for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        expect(m.cost[k]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildProviders,
  interpretBalance,
  PROVIDER_IDS,
  resolveEndpoints,
  type Endpoints,
  type ModelsFile,
  type RawModel,
} from "../src/config.ts";

// --- fixtures -------------------------------------------------------------

// Distinct numeric fields per model so cost/contextWindow/maxTokens passthrough is falsifiable.
function raw(id: string, input: string[], n: number): RawModel {
  return {
    id,
    name: `${id} name`,
    reasoning: n % 2 === 0,
    input,
    cost: { input: n, output: n + 1, cacheRead: n + 2, cacheWrite: n + 3 },
    contextWindow: 1000 * n,
    maxTokens: 100 * n,
  };
}

// The passthrough projection: every field toModelConfig copies verbatim (i.e. everything but `input`).
const passthrough = (m: RawModel | { id: string; name: string; reasoning: boolean; cost: RawModel["cost"]; contextWindow: number; maxTokens: number }) => ({
  id: m.id,
  name: m.name,
  reasoning: m.reasoning,
  cost: m.cost,
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
});

describe("resolveEndpoints", () => {
  test("blank/absent overrides fall back to the public origin", () => {
    const expected: Endpoints = {
      site: "https://nullsink.is",
      openai: "https://nullsink.is/v1",
      balance: "https://nullsink.is/balance",
    };
    for (const override of [undefined, null, "", "   "] as (string | null | undefined)[]) {
      expect(resolveEndpoints(override)).toEqual(expected);
    }
  });

  test("strips trailing slashes down to the site root", () => {
    expect(resolveEndpoints("https://x.io/").site).toBe("https://x.io");
    expect(resolveEndpoints("https://x.io///").site).toBe("https://x.io");
  });

  test("tolerates an override that already carries a trailing /v1", () => {
    const e = resolveEndpoints("https://x.io/v1");
    expect(e.site).toBe("https://x.io");
    expect(e.openai).toBe("https://x.io/v1");
  });

  test("derives openai + balance from a custom origin", () => {
    const e = resolveEndpoints("https://ns.example.com");
    expect(e.site).toBe("https://ns.example.com");
    expect(e.openai).toBe("https://ns.example.com/v1");
    expect(e.balance).toBe("https://ns.example.com/balance");
  });
});

describe("buildProviders", () => {
  // Distinct hosts for site vs openai so baseUrl routing is unambiguous.
  const endpoints: Endpoints = {
    site: "https://site.example",
    openai: "https://openai.example/v1",
    balance: "https://balance.example",
  };

  const aTextPdf = raw("a-textpdf", ["text", "pdf"], 1); // filtering: pdf dropped -> ["text"]
  const aTextImg = raw("a-textimg", ["text", "image"], 2); // both kept, order preserved
  const oPdf = raw("o-pdf", ["pdf"], 3); // fallback: filtered empty -> ["text"]
  const oImgText = raw("o-imgtext", ["image", "text"], 4); // kept in source order (not sorted)
  const tText = raw("t-text", ["text"], 5);

  const models: ModelsFile = {
    providers: {
      anthropic: [aTextPdf, aTextImg],
      openai: [oPdf, oImgText],
      tinfoil: [tText],
    },
  };

  const providers = buildProviders(models, endpoints);

  // ProviderConfig.models is optional upstream; buildProviders always sets it. Narrow with a
  // throwing guard so a regression that drops models fails loudly instead of type-erroring.
  const modelsOf = (p: (typeof providers)[number]) => {
    const ms = p.config.models;
    if (!ms) throw new Error(`provider ${p.name} has no models`);
    return ms;
  };

  test("emits exactly three providers, ordered + named per PROVIDER_IDS", () => {
    expect(providers.length).toBe(3);
    expect(providers.map((p) => p.name)).toEqual([
      PROVIDER_IDS.anthropic,
      PROVIDER_IDS.openai,
      PROVIDER_IDS.tinfoil,
    ]);
  });

  test("wire format: Anthropic and OpenAI use their native APIs while Tinfoil stays chat completions", () => {
    expect(providers.map((p) => p.config.api)).toEqual([
      "anthropic-messages",
      "openai-responses",
      "openai-completions",
    ]);
  });

  test("baseUrl routes anthropic at site root, openai + tinfoil at the /v1 base", () => {
    expect(providers.map((p) => p.config.baseUrl)).toEqual([
      endpoints.site,
      endpoints.openai,
      endpoints.openai,
    ]);
  });

  test("apiKey is always the env reference, never a raw key", () => {
    expect(providers.map((p) => p.config.apiKey)).toEqual([
      "$NULLSINK_API_KEY",
      "$NULLSINK_API_KEY",
      "$NULLSINK_API_KEY",
    ]);
  });

  test("model counts match the fixture per provider", () => {
    expect(providers.map((p) => modelsOf(p).length)).toEqual([2, 2, 1]);
  });

  test("input is narrowed to text/image: pdf dropped, empty falls back to [text], order kept", () => {
    expect(providers.map((p) => modelsOf(p).map((m) => m.input))).toEqual([
      [["text"], ["text", "image"]],
      [["text"], ["image", "text"]],
      [["text"]],
    ]);
  });

  test("id/name/reasoning/cost/contextWindow/maxTokens pass through unchanged", () => {
    expect(providers.map((p) => modelsOf(p).map(passthrough))).toEqual([
      [passthrough(aTextPdf), passthrough(aTextImg)],
      [passthrough(oPdf), passthrough(oImgText)],
      [passthrough(tText)],
    ]);
  });
});

describe("interpretBalance", () => {
  test("401 is deliberately ambiguous -> unknown", () => {
    expect(interpretBalance(401, { balance_usd: 5 }).kind).toBe("unknown");
  });

  test("non-2xx statuses -> error", () => {
    expect(interpretBalance(500, {}).kind).toBe("error");
    expect(interpretBalance(503, {}).kind).toBe("error");
  });

  test("200 with a finite balance_usd -> ok, with a $-formatted message", () => {
    const res = interpretBalance(200, { balance_usd: 12.5 });
    expect(res.kind).toBe("ok");
    expect(res.balanceUsd).toBe(12.5);
    expect(res.message).toContain("$");
  });

  const malformed: Array<[string, unknown]> = [
    ["missing balance_usd", {}],
    ["string body", "str"],
    ["null body", null],
    ["string balance_usd", { balance_usd: "5" }],
    ["NaN balance_usd", { balance_usd: NaN }],
    ["Infinity balance_usd", { balance_usd: Infinity }],
  ];
  test.each(malformed)("200 with %s -> error", (_label, body) => {
    expect(interpretBalance(200, body).kind).toBe("error");
  });
});

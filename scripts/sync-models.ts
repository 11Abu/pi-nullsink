// Regenerate src/models.json — the vendored model catalog the extension registers. Run manually,
// review the diff, and commit:
//
//   bun run sync:models && git diff src/models.json
//
// Two upstreams, joined by model id:
//   • CAPABILITIES  ← models.dev (api.json): reasoning, input modalities, context window, max output.
//   • COST          ← nullsink core/src/cost/prices.json: input/output/cache rates per 1M tokens.
//
// Cost MUST come from nullsink's prices.json, not models.dev: that file is exactly what the metered
// proxy bills the balance at (see docs/billing-model.md — pure upstream cost, the 1.1 markup lives at
// top-up, not per request). So pi's per-request cost readout matches the actual balance deduction.
//
// The served set = every id in prices.json, with dated aliases collapsed to their canonical id
// (claude-haiku-4-5 keeps, claude-haiku-4-5-20251001 drops) — mirroring nullsink's own
// client/sync-models.ts. Ordering also mirrors it: family rank → newest version → variant tier, so
// the /model picker reads flagship-first like the nullsink /models page.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MODELS_DEV = "https://models.dev/api.json";
const PRICES =
  "https://raw.githubusercontent.com/nullsink/nullsink/main/core/src/cost/prices.json";
const OUT = join(import.meta.dir, "../src/models.json");

// The three trust tiers nullsink serves, in display order.
const PROVIDERS = ["anthropic", "openai", "tinfoil"] as const;
type Provider = (typeof PROVIDERS)[number];

// Family rank (flagship → small) per provider — the primary sort key, curated because tier isn't
// derivable from the id or price. New versions inside a family self-sort; only a brand-new family
// needs a line here. Mirrors nullsink client/sync-models.ts.
const FAMILY: Record<Provider, string[]> = {
  anthropic: ["claude-opus", "claude-sonnet", "claude-haiku"],
  openai: ["gpt-5", "o4", "o3", "o1", "gpt-4.1", "gpt-4o", "gpt-4", "gpt-3"],
  tinfoil: ["glm", "kimi", "gpt-oss-120b", "llama", "gemma", "gpt-oss"],
};

interface PriceRow {
  provider: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}
interface DevModel {
  name?: string;
  reasoning?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
}
interface OutModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

// A dated suffix: -YYYYMMDD (Anthropic) or -YYYY-MM-DD (OpenAI). Drop the alias only when the
// undated base is itself priced, so a model that exists ONLY in dated form is never lost.
const DATED = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

function familyRank(id: string, fams: string[]): number {
  let rank = fams.length;
  let len = -1;
  fams.forEach((p, i) => {
    if (id.startsWith(p) && p.length > len) {
      rank = i;
      len = p.length;
    }
  });
  return rank;
}

// Variant tier inside one version: pro → base → codex(max) → codex → codex-mini → chat → mini → nano.
function variantRank(id: string): number {
  if (id.includes("pro")) return 0;
  if (id.includes("codex")) return id.includes("max") ? 2 : id.includes("mini") ? 4 : 3;
  if (id.includes("chat")) return 5;
  if (id.includes("mini")) return 6;
  if (id.includes("nano")) return 7;
  return 1;
}

// Compare two model ids for display order: family rank → newest version → variant tier.
function compareModels(a: string, b: string, fams: string[]): number {
  const byFamily = familyRank(a, fams) - familyRank(b, fams);
  if (byFamily !== 0) return byFamily;
  const na = a.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] ?? -1;
    const y = nb[i] ?? -1;
    if (x !== y) return y - x; // newer version first
  }
  return variantRank(a) - variantRank(b);
}

const [dev, prices] = await Promise.all([
  fetchJson<Record<string, { models?: Record<string, DevModel> }>>(MODELS_DEV),
  fetchJson<Record<string, PriceRow>>(PRICES),
]);

const priced = new Set(Object.keys(prices));
const isDatedAlias = (id: string): boolean => {
  const m = DATED.exec(id);
  return m != null && priced.has(id.slice(0, m.index));
};

const out: Record<Provider, OutModel[]> = { anthropic: [], openai: [], tinfoil: [] };
const missing: string[] = [];

for (const provider of PROVIDERS) {
  const devModels = dev[provider]?.models ?? {};
  const servedIds = Object.keys(prices).filter(
    (id) => prices[id]!.provider === provider && !isDatedAlias(id),
  );
  const built: OutModel[] = [];
  for (const id of servedIds) {
    const meta = devModels[id];
    if (!meta) {
      missing.push(`${provider}/${id}`);
      continue;
    }
    const price = prices[id]!;
    const input = (meta.modalities?.input ?? ["text"]).filter(
      (x): x is "text" | "image" => x === "text" || x === "image",
    );
    if (!input.includes("text")) input.unshift("text");
    built.push({
      id,
      name: meta.name ?? id,
      reasoning: Boolean(meta.reasoning),
      input,
      cost: {
        input: price.input,
        output: price.output,
        cacheRead: price.cache_read,
        cacheWrite: price.cache_write,
      },
      contextWindow: meta.limit?.context ?? 128000,
      maxTokens: meta.limit?.output ?? 8192,
    });
  }
  built.sort((a, b) => compareModels(a.id, b.id, FAMILY[provider]));
  out[provider] = built;
}

if (missing.length > 0) {
  // A served id absent from models.dev would ship with fallback caps — fail loud so the maintainer
  // adds a manual entry or waits for models.dev to catch up, rather than silently mis-sizing it.
  throw new Error(`Not found on models.dev (add a manual capability entry):\n  ${missing.join("\n  ")}`);
}

const total = PROVIDERS.reduce((n, p) => n + out[p].length, 0);
const payload = {
  $generated: new Date().toISOString().slice(0, 10),
  providers: out,
};
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  `sync:models — wrote ${total} models (` +
    PROVIDERS.map((p) => `${p} ${out[p].length}`).join(", ") +
    `) to ${OUT}`,
);

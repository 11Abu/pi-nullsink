# pi-nullsink v0.2 Terminal Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn pi-nullsink into a full terminal client for nullsink: native key mint, top-up with QR + live order ticker, a tabbed `/nullsink` hub (Settings / Wallet / Models), key profiles, and incognito mode.

**Architecture:** Pure cores (token, wallet reducers, config v2, hub state model) carry all decisions and are unit-tested; thin shells (store I/O, HTTP client, TUI component, index.ts wiring) execute effects. The hub is one `ctx.ui.custom` component driven by a pure key-reducer; money flows mirror nullsink.is's own 3-step buy flow over its 4 public endpoints.

**Tech Stack:** Bun + TypeScript, `@earendil-works/pi-coding-agent` (peer), `@earendil-works/pi-tui` (Editor/Key/visibleWidth), `uqr` (QR matrices, MIT, zero-dep — the only new runtime dep).

**Spec:** `docs/2026-07-02-terminal-client-design.md` — normative. On any conflict, the spec wins.

## Global Constraints

- Raw token on the wire ONLY to `GET /balance` (`x-api-key`) and `/v1`; `/buy` + `/order-status` see only `sha256(token)` lowercase hex.
- Coin amounts (`amount`, `received`, `expected`) are verbatim strings — never parse/round/reformat for display.
- Buy limits: min $2, max $100, presets `[10, 25, 50, 100]`. Mirror client-side; server authoritative. Never auto-retry a 429.
- Token format: `"0sink_" + 43 base64url chars + 4-char FNV-1a checksum`; CSPRNG only, never `Math.random`.
- Config file `~/.pi/agent/nullsink.json` mode `0600`; unknown JSON fields survive load→save round trips.
- Env precedence unchanged: `NULLSINK_API_KEY` > active profile key; `NULLSINK_BASE_URL` > stored `baseUrl`.
- No code copied from the nullsink repo (AGPL); reimplement from format facts. Correctness pinned by generated vectors.
- All new decision logic lands in pure functions with `bun test` coverage; TUI/render shells stay dumb.
- Clean cutover: no back-compat aliases; `TOKEN_RE` moves to `token.ts`, v1 config migrates on load.
- Commit after every green test cycle. Do not run formatters or project-wide checks mid-task; `bun run typecheck` + `bun test` run per task and at the end.
- Skip formatters, linters, and unrelated test suites; the final task runs the full gate once.

## File Map (end state)

| File | Responsibility |
| --- | --- |
| `src/token.ts` | NEW pure leaf: alphabet, regex, checksum, generate, validate, sha256 hex |
| `src/wallet.ts` | NEW: money-API client (rails/buy/order-status/balance), buy-error copy, Trocador URL, order-watch reducer |
| `src/config.ts` | Pure core: + v2 schema/migration/defaults, readout states (order/incognito/spend), validators |
| `src/store.ts` | I/O: v2 load/save (atomic, 0600), profile CRUD helpers |
| `src/ui/layout.ts` | NEW pure: two-column composition, cell padding, scroll clamping |
| `src/ui/qr.ts` | NEW: `uqr` wrapper → half-block lines |
| `src/ui/hub-model.ts` | NEW pure: tab/row specs, hub state, key reducer, top-up wizard machine |
| `src/ui/hub.ts` | NEW: the `ctx.ui.custom` component shell (render + input dispatch only) |
| `src/incognito.ts` | NEW: badge detection, fresh-session guard, go-incognito effect |
| `src/index.ts` | Wiring: commands, events, timers, provider (un)registration, spend, default model |
| `test/*.test.ts` | Unit + mock-server integration tests |
| `scripts/gen-token-vectors.ts` | Dev-only: generate cross-implementation token vectors |

Execution context: work directly on `main` (solo pre-publish repo; no worktree needed). TDD per task.

---

### Task 1: Token core

**Files:**
- Create: `src/token.ts`
- Create: `scripts/gen-token-vectors.ts`
- Create: `test/fixtures/token-vectors.json`
- Create: `test/token.test.ts`
- Modify: `src/config.ts` (remove `TOKEN_RE`), `src/index.ts` (import from `./token.ts`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ALPHABET: string`, `TOKEN_RE: RegExp`, `tokenChecksum(random: string): string`, `isValidToken(token: string): boolean`, `generateToken(): string`, `hashToken(token: string): string` (sync, 64-char lowercase hex).

- [ ] **Step 1: Generate cross-implementation vectors**

```ts
// scripts/gen-token-vectors.ts — dev-only. Fetches nullsink's AGPL token-format.ts (pinned commit),
// runs it locally (never committed/distributed), and records input→output pairs. The committed
// vectors are facts; our MIT reimplementation must reproduce them.
import { mkdirSync, writeFileSync } from "node:fs";

const PIN = "main"; // replace with the commit sha printed by: git ls-remote https://github.com/nullsink/nullsink main
const URL = `https://raw.githubusercontent.com/nullsink/nullsink/${PIN}/core/src/token-format.ts`;

const src = await (await fetch(URL)).text();
const tmp = `${process.env.TMPDIR ?? "/tmp"}/nullsink-token-format-${Date.now()}.ts`;
writeFileSync(tmp, src);
const mod = await import(tmp);

const randoms = [
  "A".repeat(43),
  "_".repeat(43),
  "abcDEF123-_ghiJKL456MNopq789rstUVWxyz0-AbCd",
  "0000000000000000000000000000000000000000000",
  "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
];
const vectors = randoms.map((random) => ({
  random,
  checksum: mod.tokenChecksum(random),
  token: `0sink_${random}${mod.tokenChecksum(random)}`,
}));
mkdirSync("test/fixtures", { recursive: true });
writeFileSync("test/fixtures/token-vectors.json", `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors (pin: ${PIN})`);
```

Run: `git ls-remote https://github.com/nullsink/nullsink main` → paste the sha into `PIN`, then `bun run scripts/gen-token-vectors.ts`.
Expected: `wrote 5 vectors (pin: <sha>)`, file `test/fixtures/token-vectors.json` exists. Commit the fixture.

- [ ] **Step 2: Write the failing test**

```ts
// test/token.test.ts
import { describe, expect, test } from "bun:test";
import vectors from "./fixtures/token-vectors.json";
import { ALPHABET, generateToken, hashToken, isValidToken, TOKEN_RE, tokenChecksum } from "../src/token.ts";

describe("tokenChecksum", () => {
  test("matches nullsink's own algorithm on recorded vectors", () => {
    for (const v of vectors) expect(tokenChecksum(v.random)).toBe(v.checksum);
  });
});

describe("isValidToken", () => {
  test("accepts every recorded full token", () => {
    for (const v of vectors) expect(isValidToken(v.token)).toBe(true);
  });
  test("rejects a single-char typo in the random part", () => {
    const t = vectors[2]!.token;
    const typo = `${t.slice(0, 10)}${t[10] === "a" ? "b" : "a"}${t.slice(11)}`;
    expect(TOKEN_RE.test(typo)).toBe(true); // shape still fine…
    expect(isValidToken(typo)).toBe(false); // …checksum catches it
  });
  test("rejects wrong shape", () => {
    expect(isValidToken("")).toBe(false);
    expect(isValidToken("0sink_short")).toBe(false);
    expect(isValidToken(`1sink_${"a".repeat(47)}`)).toBe(false);
  });
});

describe("generateToken", () => {
  test("mints valid, unique, well-shaped tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const t = generateToken();
      expect(isValidToken(t)).toBe(true);
      expect(t).toHaveLength(53); // "0sink_" (6) + 43 + 4
      seen.add(t);
    }
    expect(seen.size).toBe(64);
  });
  test("random part uses only base64url chars", () => {
    const random = generateToken().slice(6, 49);
    for (const ch of random) expect(ALPHABET.includes(ch)).toBe(true);
  });
});

describe("hashToken", () => {
  test("sha256 lowercase hex, 64 chars", () => {
    // Independently verifiable: printf '%s' 'abc' | shasum -a 256
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashToken(vectors[0]!.token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `bun test test/token.test.ts` → FAIL (`Cannot find module '../src/token.ts'`).

- [ ] **Step 4: Implement `src/token.ts`**

```ts
// nullsink token format — CLEAN-ROOM reimplementation from the public format facts
// (docs/2026-07-02-terminal-client-design.md §Token format). Pure leaf: node:crypto only.
//
// "0sink_" + base64url(32 CSPRNG bytes, no padding — 43 chars) + 4-char checksum.
// Checksum = FNV-1a/32 over the 43 chars, low 24 bits, base64url-alphabet encoded.
// It is a typo guard, not security; the 43 random chars are the entire 256-bit secret.
import { createHash, getRandomValues } from "node:crypto";

export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"; // base64url order

export const TOKEN_RE = /^0sink_[A-Za-z0-9_-]{47}$/; // 43 random + 4 checksum

export function tokenChecksum(random: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < random.length; i++) h = Math.imul(h ^ random.charCodeAt(i), 0x01000193);
  const v = (h >>> 0) & 0xffffff;
  return ALPHABET[(v >> 18) & 63]! + ALPHABET[(v >> 12) & 63]! + ALPHABET[(v >> 6) & 63]! + ALPHABET[v & 63]!;
}

// Shape AND checksum. Use for every paste; a typo'd token funds an unspendable hash.
export function isValidToken(token: string): boolean {
  if (!TOKEN_RE.test(token)) return false;
  return tokenChecksum(token.slice(6, 49)) === token.slice(49);
}

export function generateToken(): string {
  const bytes = getRandomValues(new Uint8Array(32)); // CSPRNG — never Math.random
  const random = Buffer.from(bytes).toString("base64url"); // 43 chars, no padding
  return `0sink_${random}${tokenChecksum(random)}`;
}

// Identity for /buy + /order-status: SHA-256 of the WHOLE token, lowercase hex.
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
```

- [ ] **Step 5: Run to verify pass** — `bun test test/token.test.ts` → all PASS. The vector test failing here means the FNV constants or encoding drifted from nullsink's — fix ours, never the fixture.

- [ ] **Step 6: Move `TOKEN_RE` ownership**

In `src/config.ts`: delete the `TOKEN_RE` export (lines near the top, comment included). In `src/index.ts`: replace `TOKEN_RE` in the import from `./config.ts` with `import { isValidToken } from "./token.ts";` and change the two validation sites (`saveKey`, key paste in setup) from `TOKEN_RE.test(key)` to `isValidToken(key)`. In `test/config.test.ts` remove any `TOKEN_RE` assertions (they move to token.test.ts).

Run: `bun run typecheck` → clean. `bun test` → all pass.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: clean-room nullsink token core with cross-implementation vectors"`

---

### Task 2: Config schema v2 + store

**Files:**
- Modify: `src/config.ts` (v2 types, parse+migrate, defaults/clamps)
- Modify: `src/store.ts` (atomic write, profile helpers)
- Create: `test/config-v2.test.ts`

**Interfaces:**
- Consumes: `DisplayMode`, `isDisplayMode`, existing `StoredConfig` (v1 shape) from `src/config.ts`.
- Produces (config.ts):
  - `type IncognitoMode = "off" | "always"`; `const INCOGNITO_MODES: readonly ["off","always"]`
  - `interface PendingOrder { hash: string; baseUrl: string; creditUsd: number; rail: string; unit: string; payTo: string; amount: string; payUri: string; expiresAt: number; createdAt: number }`
  - `interface Profile { apiKey?: string; pendingOrder?: PendingOrder }`
  - `interface ProviderToggles { anthropic: boolean; openai: boolean; tinfoil: boolean }`
  - `interface StoredConfigV2 { version: 2; activeProfile: string; profiles: Record<string, Profile>; baseUrl?: string; display?: DisplayMode; defaultModel?: string; thinkingLevel?: string; providers?: ProviderToggles; lowBalanceUsd?: number; spendWarnUsd?: number; showSpend?: boolean; refreshSeconds?: number; incognito?: IncognitoMode; setupDone?: boolean; extra?: Record<string, unknown> }`
  - `parseConfigV2(raw: unknown): StoredConfigV2 | null` (null only for non-object/unparseable; v1 shapes migrate)
  - `serializeConfigV2(cfg: StoredConfigV2): Record<string, unknown>` (spreads `extra` back at top level)
  - `emptyConfigV2(): StoredConfigV2`
  - `activeProfile(cfg: StoredConfigV2): Profile`
  - `const DEFAULTS = { lowBalanceUsd: 1, refreshSeconds: 60, display: "statusline", incognito: "off", providers: { anthropic: true, openai: true, tinfoil: true } } as const`
  - `clampRefreshSeconds(n: number): number` (min 15, non-finite → 60)
- Produces (store.ts): `loadConfigV2(): StoredConfigV2 | null`, `saveConfigV2(cfg: StoredConfigV2): void` (atomic: tmp + rename, 0600), `clearConfig(): void` (kept), `configPath(): string` (kept). v1 `loadConfig`/`saveConfig`/`StoredConfig` are DELETED (clean cutover; index.ts switches in this task).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run to verify failure** — `bun test test/config-v2.test.ts` → FAIL (missing exports).

- [ ] **Step 3: Implement in `src/config.ts`**

Replace the v1 `StoredConfig` + `parseStoredConfig` block with:

```ts
// --- persistent config, schema v2 (profiles) --------------------------------
export const INCOGNITO_MODES = ["off", "always"] as const;
export type IncognitoMode = (typeof INCOGNITO_MODES)[number];
export function isIncognitoMode(x: unknown): x is IncognitoMode {
  return typeof x === "string" && (INCOGNITO_MODES as readonly string[]).includes(x);
}

export interface PendingOrder {
  hash: string;      // sha256 of the profile's token
  baseUrl: string;   // instance the quote came from — mismatch drops the order
  creditUsd: number;
  rail: string;      // server rail id, e.g. "monero"
  unit: string;      // display ticker, e.g. "XMR"
  payTo: string;
  amount: string;    // VERBATIM coin string — display as-is
  payUri: string;
  expiresAt: number; // epoch ms (pay-by deadline)
  createdAt: number; // epoch ms (drives the 24h backstop)
}

export interface Profile { apiKey?: string; pendingOrder?: PendingOrder }
export interface ProviderToggles { anthropic: boolean; openai: boolean; tinfoil: boolean }

export interface StoredConfigV2 {
  version: 2;
  activeProfile: string;
  profiles: Record<string, Profile>;
  baseUrl?: string;
  display?: DisplayMode;
  defaultModel?: string;
  thinkingLevel?: string;
  providers?: ProviderToggles;
  lowBalanceUsd?: number;
  spendWarnUsd?: number;
  showSpend?: boolean;
  refreshSeconds?: number;
  incognito?: IncognitoMode;
  setupDone?: boolean;
  /** Unknown top-level fields, preserved across load→save (forward compatibility). */
  extra?: Record<string, unknown>;
}

export const DEFAULTS = {
  lowBalanceUsd: 1,
  refreshSeconds: 60,
  display: "statusline",
  incognito: "off",
  providers: { anthropic: true, openai: true, tinfoil: true },
} as const;

const KNOWN_KEYS = new Set([
  "version", "activeProfile", "profiles", "baseUrl", "display", "defaultModel", "thinkingLevel",
  "providers", "lowBalanceUsd", "spendWarnUsd", "showSpend", "refreshSeconds", "incognito", "setupDone",
  // v1 keys, consumed by migration:
  "apiKey",
]);

const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const bool = (x: unknown): boolean | undefined => (typeof x === "boolean" ? x : undefined);

function parsePendingOrder(x: unknown): PendingOrder | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as Record<string, unknown>;
  const hash = str(o.hash), baseUrl = str(o.baseUrl), rail = str(o.rail), unit = str(o.unit);
  const payTo = str(o.payTo), amount = str(o.amount), payUri = str(o.payUri);
  const creditUsd = num(o.creditUsd), expiresAt = num(o.expiresAt), createdAt = num(o.createdAt);
  if (!hash || !baseUrl || !rail || !unit || !payTo || !amount || !payUri) return undefined;
  if (creditUsd === undefined || expiresAt === undefined || createdAt === undefined) return undefined;
  return { hash, baseUrl, creditUsd, rail, unit, payTo, amount, payUri, expiresAt, createdAt };
}

function parseProfile(x: unknown): Profile {
  if (typeof x !== "object" || x === null) return {};
  const o = x as Record<string, unknown>;
  const p: Profile = {};
  const apiKey = str(o.apiKey);
  if (apiKey) p.apiKey = apiKey;
  const order = parsePendingOrder(o.pendingOrder);
  if (order) p.pendingOrder = order;
  return p;
}

function parseProviders(x: unknown): ProviderToggles | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as Record<string, unknown>;
  return {
    anthropic: bool(o.anthropic) ?? true,
    openai: bool(o.openai) ?? true,
    tinfoil: bool(o.tinfoil) ?? true,
  };
}

export function emptyConfigV2(): StoredConfigV2 {
  return { version: 2, activeProfile: "default", profiles: {} };
}

// Parse any historical shape. v1 ({ apiKey, baseUrl, display, setupDone }) migrates into
// profiles.default. Wrong-typed fields degrade to absent — a hand-edited file never bricks load.
export function parseConfigV2(raw: unknown): StoredConfigV2 | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const cfg = emptyConfigV2();

  if (typeof o.profiles === "object" && o.profiles !== null) {
    for (const [name, p] of Object.entries(o.profiles as Record<string, unknown>)) {
      const clean = str(name);
      if (clean) cfg.profiles[clean] = parseProfile(p);
    }
  }
  // v1 migration: a top-level apiKey becomes profiles.default (v2 files never carry one).
  const v1Key = str(o.apiKey);
  if (v1Key && !cfg.profiles.default?.apiKey) {
    cfg.profiles.default = { ...cfg.profiles.default, apiKey: v1Key };
  }

  const active = str(o.activeProfile);
  cfg.activeProfile = active && active in cfg.profiles ? active : "default";

  cfg.baseUrl = str(o.baseUrl);
  cfg.display = isDisplayMode(o.display) ? o.display : undefined;
  cfg.defaultModel = str(o.defaultModel);
  cfg.thinkingLevel = str(o.thinkingLevel);
  cfg.providers = parseProviders(o.providers);
  cfg.lowBalanceUsd = num(o.lowBalanceUsd);
  cfg.spendWarnUsd = num(o.spendWarnUsd);
  cfg.showSpend = bool(o.showSpend);
  cfg.refreshSeconds = num(o.refreshSeconds);
  cfg.incognito = isIncognitoMode(o.incognito) ? o.incognito : undefined;
  cfg.setupDone = bool(o.setupDone);

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  if (Object.keys(extra).length > 0) cfg.extra = extra;

  return cfg;
}

// Disk shape: defined fields + preserved unknowns at top level; `extra` itself never serialized.
export function serializeConfigV2(cfg: StoredConfigV2): Record<string, unknown> {
  const { extra, ...rest } = cfg;
  const out: Record<string, unknown> = { ...extra, ...rest };
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
}

export function activeProfile(cfg: StoredConfigV2): Profile {
  return cfg.profiles[cfg.activeProfile] ?? {};
}

export function clampRefreshSeconds(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.refreshSeconds;
  return Math.max(15, Math.round(n));
}
```

Keep `maskKey`, `resolveBaseUrlValue`, `DISPLAY_MODES`. Delete `StoredConfig` + `parseStoredConfig` (v1) and the `LOW_BALANCE_USD` const (threshold becomes config; Task 3 rewires `StatusState`). Update `test/config.test.ts`: delete v1 `parseStoredConfig` describe-blocks (replaced by this suite) and any `LOW_BALANCE_USD` references.

- [ ] **Step 4: Rewrite `src/store.ts`**

```ts
// Persistent config I/O for ~/.pi/agent/nullsink.json — the ONE place that touches the filesystem
// and the one place that must enforce 0600 on a file holding spendable keys.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseConfigV2, serializeConfigV2, type StoredConfigV2 } from "./config.ts";

const FILE_MODE = 0o600;

export function configPath(): string {
  return join(getAgentDir(), "nullsink.json");
}

// Load + migrate, or null when absent/corrupt. Never throws: a bad file degrades to "unconfigured".
export function loadConfigV2(): StoredConfigV2 | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return parseConfigV2(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

// Atomic replace: write tmp in the same dir, chmod, rename over. A crash mid-write can't leave a
// truncated file holding half a key, and readers never observe a partial state.
export function saveConfigV2(cfg: StoredConfigV2): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(serializeConfigV2(cfg), null, 2)}\n`, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, path);
}

export function clearConfig(): void {
  rmSync(configPath(), { force: true });
}
```

Update `src/index.ts` call sites: `loadConfig()` → `loadConfigV2()`, `saveConfig(...)` → `saveConfigV2(...)`; where the old code read `stored.apiKey` it now reads `activeProfile(cfg).apiKey`; where it wrote `{ apiKey }` it now writes into `cfg.profiles[cfg.activeProfile]`. (Full index.ts rework lands in Task 12; here only enough to compile: mechanical substitutions, same behavior.)

- [ ] **Step 5: Run** — `bun test` + `bun run typecheck` → green.

- [ ] **Step 6: Commit** — `git commit -am "feat: config schema v2 — profiles, pending orders, atomic 0600 store, v1 migration"`

---

### Task 3: Readout renderers v2

**Files:**
- Modify: `src/config.ts` (StatusState + renderers)
- Modify: `test/config-ui.test.ts`

**Interfaces:**
- Consumes: `BalanceResult`, `maskKey` (existing).
- Produces:
  - `interface OrderReadout { phase: "waiting" | "confirming" | "finalizing"; confirmations?: number; required?: number }`
  - `interface StatusState { configured: boolean; balance?: BalanceResult; loading?: boolean; lowBalanceUsd: number; incognito?: boolean; order?: OrderReadout; spendUsd?: number }`
  - `renderStatusLine(s: StatusState): string`, `renderWidget(s: StatusState): string[]` (same names, new state shape)
  - `renderOrderSegment(o: OrderReadout): string` → `"⧗ waiting" | "⧗ confirming 4/10" | "⧗ finalizing"`

- [ ] **Step 1: Update the test file (failing first)**

In `test/config-ui.test.ts`, update every existing `renderStatusLine`/`renderWidget` case to pass `lowBalanceUsd: 1` explicitly, then add:

```ts
describe("renderStatusLine v2 decorations", () => {
  const base = { configured: true, lowBalanceUsd: 1, balance: { kind: "ok", balanceUsd: 42.5, display: "$42.50" } } as const;
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
    const low = { kind: "ok", balanceUsd: 2.4, display: "$2.40" } as const;
    expect(renderStatusLine({ configured: true, lowBalanceUsd: 5, balance: low })).toContain("⚠");
    expect(renderStatusLine({ configured: true, lowBalanceUsd: 1, balance: low })).toContain("●");
  });
  test("all decorations compose in order", () => {
    expect(renderStatusLine({ ...base, incognito: true, spendUsd: 1.2, order: { phase: "waiting" } }))
      .toBe("⦿ incognito · nullsink ● $42.50 · spent $1.20 · ⧗ waiting");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test test/config-ui.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `src/config.ts`, replace the `StatusState` block and renderers:

```ts
export interface OrderReadout {
  phase: "waiting" | "confirming" | "finalizing";
  confirmations?: number;
  required?: number;
}

export function renderOrderSegment(o: OrderReadout): string {
  if (o.phase === "confirming" && o.confirmations !== undefined && o.required !== undefined) {
    return `⧗ confirming ${o.confirmations}/${o.required}`;
  }
  return `⧗ ${o.phase}`;
}

export interface StatusState {
  configured: boolean;
  balance?: BalanceResult;
  loading?: boolean;
  lowBalanceUsd: number;
  incognito?: boolean;
  order?: OrderReadout;
  spendUsd?: number;
}

// Core readout: no key → balance (low vs ok) → 401 unfunded → error → mid-fetch → not-yet-fetched.
function renderCore(s: StatusState): string {
  if (!s.configured) return "○ no key · /nullsink setup";
  const b = s.balance;
  if (b?.kind === "ok") {
    return b.balanceUsd < s.lowBalanceUsd ? `⚠ ${b.display} · top up` : `● ${b.display}`;
  }
  if (b?.kind === "unknown") return "⚠ unfunded · /nullsink topup";
  if (b?.kind === "error") return "⚠ balance unavailable";
  return s.loading ? "… checking balance" : "● balance not checked";
}

export function renderStatusLine(s: StatusState): string {
  const parts = [`nullsink ${renderCore(s)}`];
  if (s.spendUsd !== undefined) parts.push(`spent ${USD_FMT.format(s.spendUsd)}`);
  if (s.order) parts.push(renderOrderSegment(s.order));
  const line = parts.join(" · ");
  return s.incognito ? `⦿ incognito · ${line}` : line;
}

export function renderWidget(s: StatusState): string[] {
  return [renderStatusLine(s), "  /nullsink — settings · wallet · models"];
}
```

Adjust the existing exact-string assertions in `test/config-ui.test.ts` to the new copy (`⚠ unfunded · /nullsink topup`, widget line 2) — the states themselves are unchanged. Keep whatever copy the old tests pin for `no key` (`○ no key · /nullsink setup`).

- [ ] **Step 4: Run** — `bun test` → green. **Step 5: Commit** — `git commit -am "feat: status readout v2 — incognito prefix, spend + order segments, configurable threshold"`

---

### Task 4: Wallet API client

**Files:**
- Create: `src/wallet.ts`
- Create: `test/wallet-api.test.ts`

**Interfaces:**
- Consumes: `interpretBalance`, `BalanceResult` from `./config.ts`; `PendingOrder` type from `./config.ts`.
- Produces:
  - `const BUY_MIN_USD = 2`, `BUY_MAX_USD = 100`, `AMOUNT_PRESETS = [10, 25, 50, 100] as const`
  - `interface Rail { name: string; unit: string; confirmations: number }`, `interface Rails { default: string; rails: Rail[] }`, `const RAILS_FALLBACK: Rails`
  - `interface Quote { payTo: string; amount: string; unit: string; payUri: string; rateUsd: number; confirmationsRequired: number; expiresAt: number }`
  - `type OrderState = "waiting" | "confirming" | "finalizing" | "closed"`
  - `interface OrderStatusRes { state: OrderState; confirmations?: number; required?: number; received?: string; expected?: string; unit?: string; expiresAt?: number }`
  - `class BuyError extends Error { constructor(readonly code: string, readonly status: number) }`
  - `buyErrorMessage(code: string): string`
  - `trocadorSwapUrl(q: { unit: string; payTo: string; amount: string }): string`
  - `class WalletApi { constructor(origin: string); rails(): Promise<Rails>; buy(hash: string, creditUsd: number, rail?: string): Promise<Quote>; orderStatus(hash: string): Promise<OrderStatusRes>; balance(rawKey: string): Promise<BalanceResult> }` — every method takes an optional trailing `AbortSignal`; network timeout 8s via `AbortSignal.any` with `AbortSignal.timeout(8000)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/wallet-api.test.ts — WalletApi against a stub Bun.serve; no real network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { BuyError, buyErrorMessage, RAILS_FALLBACK, trocadorSwapUrl, WalletApi } from "../src/wallet.ts";

let server: Server;
let api: WalletApi;
let mode: "ok" | "buy429" | "railsDown" = "ok";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/rails") {
        if (mode === "railsDown") return new Response("nope", { status: 500 });
        return Response.json({
          default: "monero",
          rails: [
            { name: "monero", unit: "XMR", confirmations: 10 },
            { name: "bitcoin", unit: "BTC", confirmations: 3 },
          ],
        });
      }
      if (url.pathname === "/buy") {
        if (mode === "buy429") return Response.json({ error: "rate_limited" }, { status: 429 });
        const body = (await req.json()) as { hash: string; credit_usd: number; rail?: string };
        expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
        return Response.json({
          pay_to: "8AbCaddr", amount: "0.14720100", unit: body.rail === "bitcoin" ? "BTC" : "XMR",
          pay_uri: "monero:8AbCaddr?tx_amount=0.14720100", rate_usd: 169.87,
          confirmations_required: 10, expires_at: 1900000000000,
        });
      }
      if (url.pathname === "/order-status") {
        return Response.json({ state: "confirming", confirmations: 4, required: 10, received: "0.14720100", expected: "0.14720100", unit: "XMR" });
      }
      if (url.pathname === "/balance") {
        return req.headers.get("x-api-key") === "0sink_good"
          ? Response.json({ balance_usd: 42.5 })
          : new Response("", { status: 401 });
      }
      return new Response("", { status: 404 });
    },
  });
  api = new WalletApi(`http://localhost:${server.port}`);
});
afterAll(() => server.stop(true));

describe("WalletApi", () => {
  test("rails: parses the live set", async () => {
    mode = "ok";
    const rails = await api.rails();
    expect(rails.default).toBe("monero");
    expect(rails.rails).toHaveLength(2);
  });
  test("rails: falls back on 5xx instead of throwing", async () => {
    mode = "railsDown";
    expect(await api.rails()).toEqual(RAILS_FALLBACK);
    mode = "ok";
  });
  test("buy: snake_case → camelCase, amount verbatim", async () => {
    const q = await api.buy("a".repeat(64), 25);
    expect(q.payTo).toBe("8AbCaddr");
    expect(q.amount).toBe("0.14720100"); // exact string, trailing zeros intact
    expect(q.confirmationsRequired).toBe(10);
    expect(q.expiresAt).toBe(1900000000000);
  });
  test("buy: non-200 throws BuyError with the server code", async () => {
    mode = "buy429";
    try {
      await api.buy("a".repeat(64), 25);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BuyError);
      expect((e as BuyError).code).toBe("rate_limited");
      expect((e as BuyError).status).toBe(429);
    }
    mode = "ok";
  });
  test("orderStatus: passes fields through", async () => {
    const s = await api.orderStatus("b".repeat(64));
    expect(s.state).toBe("confirming");
    expect(s.confirmations).toBe(4);
    expect(s.received).toBe("0.14720100");
  });
  test("balance: 200 → ok, 401 → unknown (via interpretBalance)", async () => {
    expect((await api.balance("0sink_good")).kind).toBe("ok");
    expect((await api.balance("0sink_bad")).kind).toBe("unknown");
  });
});

describe("buyErrorMessage", () => {
  test("known codes get calm copy; unknown gets generic retry", () => {
    expect(buyErrorMessage("rate_limited")).toBe("Busy right now. Try again in a moment.");
    expect(buyErrorMessage("rate_unavailable")).toBe("Couldn't get a price right now. Try again shortly.");
    expect(buyErrorMessage("wallet_unavailable")).toBe("Temporarily unavailable. Try again shortly.");
    expect(buyErrorMessage("unknown_rail")).toBe("That coin isn't available right now — pick another.");
    expect(buyErrorMessage("network")).toBe("Couldn't reach the server. Check your connection and try again.");
    expect(buyErrorMessage("whatever_else")).toBe("Something went wrong. Try again.");
  });
});

describe("trocadorSwapUrl", () => {
  test("carries ONLY ticker/network/address/amount/name/description — no token, no hash", () => {
    const u = new URL(trocadorSwapUrl({ unit: "XMR", payTo: "8AbCaddr", amount: "0.14720100" }));
    expect(u.origin + u.pathname).toBe("https://trocador.app/anonpay/");
    expect(u.searchParams.get("ticker_to")).toBe("xmr");
    expect(u.searchParams.get("network_to")).toBe("Mainnet");
    expect(u.searchParams.get("address")).toBe("8AbCaddr");
    expect(u.searchParams.get("amount")).toBe("0.14720100");
    expect(u.searchParams.get("name")).toBe("nullsink");
    expect([...u.searchParams.keys()].sort()).toEqual(["address", "amount", "description", "name", "network_to", "ticker_to"]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test test/wallet-api.test.ts` → FAIL (missing module).

- [ ] **Step 3: Implement `src/wallet.ts` (client half)**

```ts
// nullsink money API — the four public endpoints the purchase UI uses, plus the pure order-watch
// reducer (below). Contract: docs/2026-07-02-terminal-client-design.md §nullsink API contract.
// Amounts stay verbatim strings end to end; /buy and /order-status only ever see the token HASH.
import { type BalanceResult, interpretBalance, type PendingOrder } from "./config.ts";

export const BUY_MIN_USD = 2;
export const BUY_MAX_USD = 100;
export const AMOUNT_PRESETS = [10, 25, 50, 100] as const;

export interface Rail { name: string; unit: string; confirmations: number }
export interface Rails { default: string; rails: Rail[] }

// Same conservative fallback the web client ships: /rails being down never blocks a top-up.
export const RAILS_FALLBACK: Rails = { default: "monero", rails: [{ name: "monero", unit: "XMR", confirmations: 10 }] };

export interface Quote {
  payTo: string;
  amount: string; // verbatim coin string — display AS-IS
  unit: string;
  payUri: string;
  rateUsd: number;
  confirmationsRequired: number;
  expiresAt: number;
}

export type OrderState = "waiting" | "confirming" | "finalizing" | "closed";
export interface OrderStatusRes {
  state: OrderState;
  confirmations?: number;
  required?: number;
  received?: string;
  expected?: string;
  unit?: string;
  expiresAt?: number;
}

export class BuyError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(`buy failed: ${code} (${status})`);
  }
}

// Calm, user-facing copy per /buy error code (mirrors the web client's mapping).
export function buyErrorMessage(code: string): string {
  switch (code) {
    case "rate_unavailable": return "Couldn't get a price right now. Try again shortly.";
    case "busy_try_later": return "The system is busy. Try again soon.";
    case "rate_limited": return "Busy right now. Try again in a moment.";
    case "wallet_unavailable": return "Temporarily unavailable. Try again shortly.";
    case "unknown_rail": return "That coin isn't available right now — pick another.";
    case "network": return "Couldn't reach the server. Check your connection and try again.";
    default: return "Something went wrong. Try again.";
  }
}

// Pre-filled Trocador AnonPay hand-off: destination locked to THIS order. Carries only
// address/amount/coin + static copy — never a token or hash.
export function trocadorSwapUrl(q: { unit: string; payTo: string; amount: string }): string {
  const params = new URLSearchParams({
    ticker_to: q.unit.toLowerCase(),
    network_to: "Mainnet",
    address: q.payTo,
    amount: q.amount,
    name: "nullsink",
    description: "api credit",
  });
  return `https://trocador.app/anonpay/?${params.toString()}`;
}

const TIMEOUT_MS = 8000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export class WalletApi {
  constructor(readonly origin: string) {}

  async rails(signal?: AbortSignal): Promise<Rails> {
    try {
      const res = await fetch(`${this.origin}/rails`, { signal: withTimeout(signal) });
      if (!res.ok) return RAILS_FALLBACK;
      const body = (await res.json()) as Rails;
      return body?.rails?.length ? body : RAILS_FALLBACK;
    } catch {
      return RAILS_FALLBACK;
    }
  }

  async buy(hash: string, creditUsd: number, rail?: string, signal?: AbortSignal): Promise<Quote> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rail ? { hash, credit_usd: creditUsd, rail } : { hash, credit_usd: creditUsd }),
        signal: withTimeout(signal),
      });
    } catch {
      throw new BuyError("network", 0);
    }
    if (!res.ok) {
      let code = "unknown";
      try {
        code = ((await res.json()) as { error?: string })?.error ?? "unknown";
      } catch { /* non-JSON body */ }
      throw new BuyError(code, res.status);
    }
    const b = (await res.json()) as {
      pay_to: string; amount: string; unit: string; pay_uri: string;
      rate_usd: number; confirmations_required: number; expires_at: number;
    };
    return {
      payTo: b.pay_to, amount: b.amount, unit: b.unit, payUri: b.pay_uri,
      rateUsd: b.rate_usd, confirmationsRequired: b.confirmations_required, expiresAt: b.expires_at,
    };
  }

  async orderStatus(hash: string, signal?: AbortSignal): Promise<OrderStatusRes> {
    const res = await fetch(`${this.origin}/order-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash }),
      signal: withTimeout(signal),
    });
    if (!res.ok) throw new Error(`order_status_${res.status}`);
    const b = (await res.json()) as OrderStatusRes & { expires_at?: number };
    return { ...b, expiresAt: b.expires_at ?? b.expiresAt };
  }

  async balance(rawKey: string, signal?: AbortSignal): Promise<BalanceResult> {
    const res = await fetch(`${this.origin}/balance`, {
      headers: { "x-api-key": rawKey },
      signal: withTimeout(signal),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return interpretBalance(res.status, body);
  }
}
```

Note: `interpretBalance(status, body)` already maps 200→ok / 401→unknown / other→error (existing, tested). If its signature differs on read, adapt the call — do not change `interpretBalance`.

- [ ] **Step 4: Run** — `bun test test/wallet-api.test.ts` → PASS. **Step 5: Commit** — `git commit -am "feat: wallet API client — rails/buy/order-status/balance, buy-error copy, Trocador URL"`

---

### Task 5: Order-watch reducer

**Files:**
- Modify: `src/wallet.ts` (append reducer section)
- Create: `test/order-watch.test.ts`

**Interfaces:**
- Consumes: `OrderStatusRes`, `PendingOrder`, `BalanceResult`.
- Produces:
  - `const ORDER_BACKSTOP_MS = 24 * 3600 * 1000`
  - `type WatchPhase = "waiting" | "confirming" | "finalizing" | "credited" | "unknown" | "dropped"`
  - `interface WatchState { phase: WatchPhase; confirmations?: number; required?: number; dropReason?: "stale" | "instance-mismatch" }`
  - `initialWatchState(): WatchState` → `{ phase: "waiting" }`
  - `orderDropReason(order: PendingOrder, nowMs: number, currentBaseUrl: string): "stale" | "instance-mismatch" | null`
  - `reduceStatus(prev: WatchState, s: OrderStatusRes): WatchState` — `closed` keeps `prev` phase fields but the CALLER must resolve via balance; reducer marks nothing final on `closed` itself, callers call `resolveClosed`
  - `resolveClosed(lastKnownUsd: number | undefined, fresh: BalanceResult): "credited" | "unknown"`
  - `toOrderReadout(w: WatchState): OrderReadout | undefined` (undefined for terminal phases)

- [ ] **Step 1: Write the failing test**

```ts
// test/order-watch.test.ts
import { describe, expect, test } from "bun:test";
import type { PendingOrder } from "../src/config.ts";
import {
  initialWatchState, ORDER_BACKSTOP_MS, orderDropReason, reduceStatus, resolveClosed, toOrderReadout,
} from "../src/wallet.ts";

const order: PendingOrder = {
  hash: "a".repeat(64), baseUrl: "https://nullsink.is", creditUsd: 25, rail: "monero", unit: "XMR",
  payTo: "8AbC", amount: "0.147", payUri: "monero:8AbC", expiresAt: 2000, createdAt: 1000,
};

describe("orderDropReason", () => {
  test("null while young and same instance (even past expiresAt — server watches to backstop)", () => {
    expect(orderDropReason(order, 3000, "https://nullsink.is")).toBeNull();
  });
  test("stale past the 24h backstop", () => {
    expect(orderDropReason(order, 1000 + ORDER_BACKSTOP_MS + 1, "https://nullsink.is")).toBe("stale");
  });
  test("instance mismatch", () => {
    expect(orderDropReason(order, 3000, "https://fork.example")).toBe("instance-mismatch");
  });
});

describe("reduceStatus", () => {
  test("progresses waiting → confirming with counts", () => {
    const w = reduceStatus(initialWatchState(), { state: "confirming", confirmations: 4, required: 10 });
    expect(w).toEqual({ phase: "confirming", confirmations: 4, required: 10 });
  });
  test("finalizing drops the counts", () => {
    const w = reduceStatus({ phase: "confirming", confirmations: 9, required: 10 }, { state: "finalizing" });
    expect(w.phase).toBe("finalizing");
  });
  test("closed leaves phase for the caller to resolve", () => {
    const prev = { phase: "confirming" as const, confirmations: 10, required: 10 };
    expect(reduceStatus(prev, { state: "closed" })).toEqual(prev);
  });
});

describe("resolveClosed", () => {
  test("credited when balance rose", () => {
    expect(resolveClosed(10, { kind: "ok", balanceUsd: 35, display: "$35.00" })).toBe("credited");
  });
  test("credited when previously unfunded and now any balance", () => {
    expect(resolveClosed(undefined, { kind: "ok", balanceUsd: 24.9, display: "$24.90" })).toBe("credited");
  });
  test("unknown when balance unchanged / fetch failed / still 401", () => {
    expect(resolveClosed(10, { kind: "ok", balanceUsd: 10, display: "$10.00" })).toBe("unknown");
    expect(resolveClosed(10, { kind: "error", display: "" })).toBe("unknown");
    expect(resolveClosed(undefined, { kind: "unknown", display: "" })).toBe("unknown");
  });
});

describe("toOrderReadout", () => {
  test("active phases map through, terminal phases yield undefined", () => {
    expect(toOrderReadout({ phase: "confirming", confirmations: 4, required: 10 }))
      .toEqual({ phase: "confirming", confirmations: 4, required: 10 });
    expect(toOrderReadout({ phase: "credited" })).toBeUndefined();
    expect(toOrderReadout({ phase: "dropped" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement** (append to `src/wallet.ts`):

```ts
// --- order watching (pure) ---------------------------------------------------
// The extension keeps watching a paid-for order across sessions. Server truth:
// `closed` is ambiguous (credited / reaped / never existed), so the caller resolves
// it against a fresh /balance. The 24h figure mirrors the server's stuck-order backstop.
import type { OrderReadout } from "./config.ts";

export const ORDER_BACKSTOP_MS = 24 * 3600 * 1000;

export type WatchPhase = "waiting" | "confirming" | "finalizing" | "credited" | "unknown" | "dropped";
export interface WatchState {
  phase: WatchPhase;
  confirmations?: number;
  required?: number;
  dropReason?: "stale" | "instance-mismatch";
}

export function initialWatchState(): WatchState {
  return { phase: "waiting" };
}

export function orderDropReason(
  order: PendingOrder,
  nowMs: number,
  currentBaseUrl: string,
): "stale" | "instance-mismatch" | null {
  if (order.baseUrl !== currentBaseUrl) return "instance-mismatch";
  if (nowMs - order.createdAt > ORDER_BACKSTOP_MS) return "stale";
  return null;
}

export function reduceStatus(prev: WatchState, s: OrderStatusRes): WatchState {
  switch (s.state) {
    case "waiting":
      return { phase: "waiting" };
    case "confirming":
      return { phase: "confirming", confirmations: s.confirmations, required: s.required };
    case "finalizing":
      return { phase: "finalizing" };
    case "closed":
      return prev; // ambiguous — caller resolves via resolveClosed(balance)
  }
}

export function resolveClosed(lastKnownUsd: number | undefined, fresh: BalanceResult): "credited" | "unknown" {
  if (fresh.kind !== "ok") return "unknown";
  if (lastKnownUsd === undefined) return "credited"; // was unfunded/unknown; any balance = the credit landed
  return fresh.balanceUsd > lastKnownUsd ? "credited" : "unknown";
}

export function toOrderReadout(w: WatchState): OrderReadout | undefined {
  if (w.phase === "waiting" || w.phase === "confirming" || w.phase === "finalizing") {
    return { phase: w.phase, confirmations: w.confirmations, required: w.required };
  }
  return undefined;
}
```

Note: `BalanceResult` for `kind: "ok"` carries `balanceUsd: number` (existing shape — verify field name in `src/config.ts` on read; if it is `usd` or similar, use the existing name EVERYWHERE in Tasks 4–5 and the tests).

- [ ] **Step 4: Run** — `bun test` → green. **Step 5: Commit** — `git commit -am "feat: pure order-watch reducer — drop reasons, status progression, closed-resolution"`

---

### Task 6: QR renderer

**Files:**
- Modify: `package.json` (add dependency `uqr`)
- Create: `src/ui/qr.ts`
- Create: `test/qr.test.ts`

**Interfaces:**
- Consumes: `uqr`'s `renderUnicodeCompact(text: string, opts?): string`.
- Produces: `qrLines(data: string): string[]` — half-block QR, one string per terminal row, no trailing newline entries.

- [ ] **Step 1: Add the dependency** — `bun add uqr` (runtime dep; MIT, zero transitive deps — verify with `bun pm ls uqr`). Then check the export name: `bun -e 'import("uqr").then(m => console.log(Object.keys(m)))'` — expect `renderUnicodeCompact` among them (uqr ≥0.1 exports it; if the name differs, use the listed unicode-compact renderer and adjust the import below).

- [ ] **Step 2: Write the failing test**

```ts
// test/qr.test.ts
import { describe, expect, test } from "bun:test";
import { qrLines } from "../src/ui/qr.ts";

describe("qrLines", () => {
  test("returns a square-ish block of half-block characters", () => {
    const lines = qrLines("monero:8AbCaddr?tx_amount=0.14720100");
    expect(lines.length).toBeGreaterThan(10);
    // Every line same visible width, only QR glyphs + spaces.
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
    for (const l of lines) expect(/^[▀▄█ ]*$/.test(l)).toBe(true);
  });
  test("deterministic for the same input", () => {
    expect(qrLines("x")).toEqual(qrLines("x"));
  });
});
```

- [ ] **Step 3: Run to verify failure**, then **Step 4: Implement `src/ui/qr.ts`**

```ts
// Terminal QR: uqr renders half-block unicode (2 modules per char cell vertically).
// Scannability beats compactness — keep the default border (quiet zone).
import { renderUnicodeCompact } from "uqr";

export function qrLines(data: string): string[] {
  return renderUnicodeCompact(data).split("\n").filter((l) => l.length > 0);
}
```

- [ ] **Step 5: Run** — `bun test test/qr.test.ts` → PASS (if the glyph set differs — some versions emit `▖▗`-style quadrants — relax the regex to the glyphs actually emitted and pin those). **Step 6: Commit** — `git commit -am "feat: terminal QR rendering via uqr"`

---

### Task 7: Layout helpers

**Files:**
- Create: `src/ui/layout.ts`
- Create: `test/layout.test.ts`

**Interfaces:**
- Consumes: `visibleWidth` from `@earendil-works/pi-tui` (ANSI-aware width; same helper the questionnaire example uses).
- Produces:
  - `padCell(s: string, width: number): string` — pad/truncate to exact visible width (truncate plain, append `…` when cut)
  - `twoCol(left: string[], right: string[], leftWidth: number, gap: string): string[]` — zip columns; shorter column padded with blanks
  - `clampScroll(cursor: number, count: number, viewport: number, top: number): number` — returns new top so cursor stays visible

- [ ] **Step 1: Write the failing test**

```ts
// test/layout.test.ts
import { describe, expect, test } from "bun:test";
import { clampScroll, padCell, twoCol } from "../src/ui/layout.ts";

describe("padCell", () => {
  test("pads short content to exact width", () => {
    expect(padCell("ab", 5)).toBe("ab   ");
  });
  test("truncates long content with ellipsis", () => {
    expect(padCell("abcdefgh", 5)).toBe("abcd…");
  });
  test("keeps ANSI-styled content aligned (styled text is wider in bytes, same visible width)", () => {
    const styled = "\u001b[31mab\u001b[0m";
    expect(padCell(styled, 5).endsWith("   ")).toBe(true);
  });
});

describe("twoCol", () => {
  test("zips and pads the shorter column", () => {
    expect(twoCol(["A", "B"], ["x"], 3, " │ ")).toEqual(["A   │ x", "B   │ "]);
  });
});

describe("clampScroll", () => {
  test("scrolls down when cursor passes the viewport", () => {
    expect(clampScroll(10, 20, 5, 0)).toBe(6);
  });
  test("scrolls up when cursor above top", () => {
    expect(clampScroll(2, 20, 5, 6)).toBe(2);
  });
  test("stays put when visible", () => {
    expect(clampScroll(7, 20, 5, 6)).toBe(6);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement `src/ui/layout.ts`**

```ts
// ANSI-aware layout primitives for the hub. Pure string math — no TUI objects.
import { visibleWidth } from "@earendil-works/pi-tui";

// Pad to exact visible width; truncate with a trailing ellipsis when over.
// Truncation assumes UNSTYLED input (all hub cells style AFTER padding).
export function padCell(s: string, width: number): string {
  const w = visibleWidth(s);
  if (w <= width) return s + " ".repeat(width - w);
  return `${s.slice(0, Math.max(0, width - 1))}…`;
}

export function twoCol(left: string[], right: string[], leftWidth: number, gap: string): string[] {
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(`${padCell(left[i] ?? "", leftWidth)}${gap}${right[i] ?? ""}`);
  }
  return out;
}

// Keep `cursor` within [top, top+viewport). Returns the adjusted top.
export function clampScroll(cursor: number, count: number, viewport: number, top: number): number {
  if (viewport <= 0 || count <= viewport) return 0;
  let t = top;
  if (cursor < t) t = cursor;
  if (cursor >= t + viewport) t = cursor - viewport + 1;
  return Math.max(0, Math.min(t, count - viewport));
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `git commit -am "feat: ANSI-aware layout helpers for the hub"`

---

### Task 8: Hub model — rows, state, key reducer

**Files:**
- Create: `src/ui/hub-model.ts`
- Create: `test/hub-model.test.ts`

**Interfaces:**
- Consumes: `StoredConfigV2`, `activeProfile`, `DEFAULTS`, `maskKey`, `DISPLAY_MODES`, `INCOGNITO_MODES`, `clampRefreshSeconds`, `PendingOrder` from `../config.ts`; `ModelsFile`, `RawModel` from `../config.ts`; `Rails`, `WatchState`, `AMOUNT_PRESETS`, `BUY_MIN_USD`, `BUY_MAX_USD`, `BalanceResult` from `../wallet.ts` / `../config.ts`; `isValidToken` from `../token.ts`.
- Produces (all pure):
  - `type Tab = "settings" | "wallet" | "models"`; `const TABS: readonly Tab[]`
  - `type KeyName = "up" | "down" | "left" | "right" | "tab" | "shift-tab" | "enter" | "esc" | "backspace" | { char: string }`
  - `interface RowSpec { id: string; section: string; label: string; value: string; kind: "cycle" | "edit" | "action"; options?: readonly string[]; description: string; disabled?: boolean }`
  - `interface HubData { cfg: StoredConfigV2; envKey?: string; envUrl?: string; balance?: BalanceResult; watch?: WatchState; rails?: Rails; models: ModelsFile; currentModelId?: string; currentProviderKey?: "anthropic" | "openai" | "tinfoil"; incognitoActive: boolean; spendUsd?: number }`
  - `type WizardState = { step: "amount"; cursor: number; custom: string; error?: string } | { step: "rail"; creditUsd: number; cursor: number } | { step: "quoting"; creditUsd: number; rail: string } | { step: "pay" } | { step: "error"; message: string }`
  - `interface HubState { tab: Tab; cursor: Record<Tab, number>; top: Record<Tab, number>; editing: { rowId: string; buffer: string; error?: string } | null; confirm: string | null; reveal: string | null; wizard: WizardState | null; filter: string }`
  - `initialHubState(): HubState`
  - `settingsRows(d: HubData): RowSpec[]`, `walletRows(d: HubData): RowSpec[]`
  - `interface ModelRow { id: string; provider: "anthropic" | "openai" | "tinfoil"; name: string; contextWindow: number; input: number; output: number }`
  - `modelRows(models: ModelsFile, filter: string, toggles: { anthropic: boolean; openai: boolean; tinfoil: boolean }): ModelRow[]`
  - `type HubEffect = { kind: "set"; field: string; value: string | number | boolean | undefined } | { kind: "action"; id: string } | { kind: "quote"; creditUsd: number; rail: string } | { kind: "setDefaultModel"; modelId: string } | { kind: "toggleProvider"; provider: "anthropic" | "openai" | "tinfoil"; on: boolean } | { kind: "openTrocador" } | { kind: "close" }`
  - `reduceHub(state: HubState, key: KeyName, d: HubData): { state: HubState; effects: HubEffect[] }`
  - `validateField(rowId: string, buffer: string): { ok: true; value: string | number | undefined } | { ok: false; error: string }`

Behavior contract (encode in tests):
- `tab`/`shift-tab` cycle tabs (never while `editing`/`wizard`/`reveal` active); `esc` closes the innermost layer (editor → wizard step back → confirm → hub `close` effect).
- Cycle rows: `enter`/`right` next option, `left` previous; emit `set` (or `toggleProvider`) immediately.
- Edit rows: `enter` opens editor seeded with the RAW current value ("" for unset); chars/backspace edit; `enter` validates → `set` effect + close editor, or error kept in editor; `esc` cancels.
- Action rows: `enter` emits `action`; destructive ids (`clear-config`, `profile-delete`) require a second `enter` while `confirm === rowId` (any other key cancels confirm).
- Provider toggle rows: disabled (with explanatory description) when `d.currentProviderKey` matches and the toggle is currently on — the in-use provider can't be switched off.
- Env-overridden rows (`apiKey` when `envKey`, `baseUrl` when `envUrl`): `disabled: true`, value suffixed `" (env)"`.
- Wallet wizard: on `topup` action → `{ step: "amount", cursor: 1, custom: "" }` (cursor 1 = $25 default); presets + `custom…` navigable with `left`/`right`; digits type into custom (auto-jump cursor to custom); `enter` validates ($2–$100) → `{ step: "rail", cursor: index-of-default-rail }`; rails listed from `d.rails ?? RAILS_FALLBACK`; `enter` → `quote` effect + `{ step: "quoting" }`; in `pay`: `{ char: "t" }` → `openTrocador`, `esc` → wizard `null` (watching continues); in `error`: `enter`/`esc` → back to `amount`.
- `reveal` (mint): any key except `enter` ignored; `enter` emits `action: "mint-saved"`.
- Models tab: printable chars append to `filter`, `backspace` deletes, rows from `modelRows`, `enter` emits `setDefaultModel`.

- [ ] **Step 1: Write the failing test** — cover the whole contract above. Key cases (write ALL of these):

```ts
// test/hub-model.test.ts
import { describe, expect, test } from "bun:test";
import type { StoredConfigV2 } from "../src/config.ts";
import { emptyConfigV2 } from "../src/config.ts";
import {
  initialHubState, modelRows, reduceHub, settingsRows, validateField, walletRows,
  type HubData, type HubState,
} from "../src/ui/hub-model.ts";
import modelsData from "../src/models.json";
import type { ModelsFile } from "../src/config.ts";

const models = modelsData as ModelsFile;

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
    expect((s.wizard as { creditUsd: number }).creditUsd).toBe(50);
  });
  test("custom amount: digits jump to custom; out-of-band rejected", () => {
    const d = data();
    let s = openWizard(d);
    for (const ch of "150") s = reduceHub(s, { char: ch }, d).state;
    const { state: s2 } = reduceHub(s, "enter", d);
    expect(s2.wizard?.step).toBe("amount");
    expect((s2.wizard as { error?: string }).error).toContain("100");
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
```

- [ ] **Step 2: Run to verify failure** — `bun test test/hub-model.test.ts` → FAIL (missing module).

- [ ] **Step 3: Implement `src/ui/hub-model.ts`** — the reducer is mechanical from the contract; structure it exactly like this (complete the obvious symmetric branches — `shift-tab` mirrors `tab`, `up` mirrors `down`, `left` mirrors `right` — with the code patterns shown):

```ts
// Pure hub model: rows, state, key reducer, wizard machine. NO pi-tui imports, NO I/O —
// everything here runs under bun test with plain objects.
import {
  activeProfile, DEFAULTS, DISPLAY_MODES, maskKey,
  type ModelsFile, type StoredConfigV2,
} from "../config.ts";
import { isValidToken } from "../token.ts";
import {
  AMOUNT_PRESETS, BUY_MAX_USD, BUY_MIN_USD, RAILS_FALLBACK,
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
  editing: { rowId: string; buffer: string; error?: string } | null;
  confirm: string | null;
  reveal: string | null;
  wizard: WizardState | null;
  filter: string;
}

export function initialHubState(): HubState {
  return {
    tab: "settings",
    cursor: { settings: 0, wallet: 0, models: 0 },
    top: { settings: 0, wallet: 0, models: 0 },
    editing: null, confirm: null, reveal: null, wizard: null, filter: "",
  };
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const; // pi's ThinkingLevel set

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
    description: "Model applied at session start. Enter picks from the Models tab.",
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
    options: ["off", "always"], value: cfg.incognito ?? DEFAULTS.incognito,
    description: "always: fresh sessions are never written to disk. Terminal scrollback and files the agent edits are outside this.",
  });
  return rows;
}

export function walletRows(d: HubData): RowSpec[] {
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
    rows.push({ id: "pay", section: "Wallet", label: "Pending order", kind: "action", value: orderRowValue(d), description: "Reopen the pay screen for the in-flight order" });
  }
  rows.push({ id: "mint", section: "Wallet", label: "Mint new key", kind: "action", value: "", description: "Generate a fresh key locally (shown once), then fund it" });
  rows.push({ id: "profile-new", section: "Wallet", label: "New profile", kind: "action", value: "", description: "Add a named profile for another key" });
  rows.push({ id: "profile-delete", section: "Wallet", label: "Delete profile", kind: "action", value: cfg.activeProfile, description: "Remove the active profile and its saved key (enter twice)" });
  rows.push({ id: "balance", section: "Wallet", label: "Check balance now", kind: "action", value: "", description: "Fetch the live balance" });
  rows.push({ id: "setup", section: "Wallet", label: "Re-run setup", kind: "action", value: "", description: "The guided first-run flow" });
  rows.push({ id: "clear-config", section: "Wallet", label: "Clear saved config", kind: "action", value: "", description: "Delete ~/.pi/agent/nullsink.json (enter twice)" });
  return rows;
}

function orderRowValue(d: HubData): string {
  const w = d.watch;
  if (!w) return "⧗ …";
  if (w.phase === "confirming" && w.confirmations !== undefined) return `⧗ confirming ${w.confirmations}/${w.required}`;
  return `⧗ ${w.phase}`;
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
  if (key === "backspace") return { state: { ...state, editing: { ...e, buffer: e.buffer.slice(0, -1), error: undefined } }, effects: [] };
  if (typeof key === "object") return { state: { ...state, editing: { ...e, buffer: e.buffer + key.char, error: undefined } }, effects: [] };
  if (key === "enter") {
    const res = validateField(e.rowId, e.buffer);
    if (!res.ok) return { state: { ...state, editing: { ...e, error: res.error } }, effects: [] };
    const field = e.rowId === "profile-new" ? "profile-new" : e.rowId;
    const effect: HubEffect = field === "profile-new"
      ? { kind: "action", id: `profile-new:${res.value}` }
      : { kind: "set", field, value: res.value };
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

function rowsFor(state: HubState, d: HubData): RowSpec[] {
  return state.tab === "settings" ? settingsRows(d) : state.tab === "wallet" ? walletRows(d) : [];
}

function reduceRows(state: HubState, key: KeyName, d: HubData): { state: HubState; effects: HubEffect[] } {
  // tab switching
  if (key === "tab" || key === "shift-tab") {
    const dir = key === "tab" ? 1 : TABS.length - 1;
    const tab = TABS[(TABS.indexOf(state.tab) + dir) % TABS.length]!;
    return { state: { ...state, tab, confirm: null }, effects: [] };
  }
  if (key === "esc") {
    if (state.confirm) return { state: { ...state, confirm: null }, effects: [] };
    return { state, effects: [{ kind: "close" }] };
  }

  // models tab: filter + list
  if (state.tab === "models") {
    const rows = modelRows(d.models, state.filter, d.cfg.providers ?? DEFAULTS.providers);
    if (typeof key === "object") return { state: { ...state, filter: state.filter + key.char }, effects: [] };
    if (key === "backspace") return { state: { ...state, filter: state.filter.slice(0, -1) }, effects: [] };
    if (key === "down") return { state: moveCursor(state, "models", 1, rows.length), effects: [] };
    if (key === "up") return { state: moveCursor(state, "models", -1, rows.length), effects: [] };
    if (key === "enter" && rows.length > 0) {
      const m = rows[Math.min(state.cursor.models, rows.length - 1)]!;
      return { state, effects: [{ kind: "setDefaultModel", modelId: m.id }] };
    }
    return { state, effects: [] };
  }

  // settings / wallet rows
  const rows = rowsFor(state, d);
  const cursor = Math.min(state.cursor[state.tab], Math.max(0, rows.length - 1));
  const row = rows[cursor];
  if (key === "down") return { state: moveCursor(state, state.tab, 1, rows.length), effects: [] };
  if (key === "up") return { state: moveCursor(state, state.tab, -1, rows.length), effects: [] };
  if (!row || row.disabled) return { state: { ...state, confirm: null }, effects: [] };

  if (row.kind === "cycle" && (key === "enter" || key === "left" || key === "right")) {
    const opts = row.options!;
    const dir = key === "left" ? opts.length - 1 : 1;
    const next = opts[(opts.indexOf(row.value.replace(" (env)", "")) + dir) % opts.length]!;
    if (row.id.startsWith("provider-")) {
      return { state, effects: [{ kind: "toggleProvider", provider: row.id.slice("provider-".length) as "anthropic" | "openai" | "tinfoil", on: next === "on" }] };
    }
    if (row.id === "profile") return { state, effects: [{ kind: "action", id: `profile-switch:${next}` }] };
    if (row.id === "showSpend") return { state, effects: [{ kind: "set", field: "showSpend", value: next === "on" }] };
    return { state, effects: [{ kind: "set", field: row.id, value: next }] };
  }

  if (key === "enter") {
    if (row.kind === "edit") {
      const seed = row.id === "apiKey" || row.id === "profile-new" ? "" : rawEditValue(row.id, d);
      return { state: { ...state, editing: { rowId: row.id, buffer: seed } }, effects: [] };
    }
    if (row.kind === "action") {
      const destructive = row.id === "clear-config" || row.id === "profile-delete";
      if (destructive && state.confirm !== row.id) return { state: { ...state, confirm: row.id }, effects: [] };
      if (row.id === "topup") return { state: { ...state, confirm: null, wizard: { step: "amount", cursor: 1, custom: "" } }, effects: [] };
      if (row.id === "pay") return { state: { ...state, confirm: null, wizard: { step: "pay" } }, effects: [] };
      if (row.id === "profile-new") return { state: { ...state, confirm: null, editing: { rowId: "profile-new", buffer: "" } }, effects: [] };
      if (row.id === "defaultModel") return { state: { ...state, tab: "models" }, effects: [] };
      return { state: { ...state, confirm: null }, effects: [{ kind: "action", id: row.id }] };
    }
  }
  return { state: { ...state, confirm: null }, effects: [] };
}

function moveCursor(state: HubState, tab: Tab, delta: number, count: number): HubState {
  const c = Math.max(0, Math.min(count - 1, state.cursor[tab] + delta));
  return { ...state, confirm: null, cursor: { ...state.cursor, [tab]: c } };
}

function rawEditValue(rowId: string, d: HubData): string {
  const cfg = d.cfg;
  switch (rowId) {
    case "baseUrl": return cfg.baseUrl ?? "";
    case "lowBalanceUsd": return String(cfg.lowBalanceUsd ?? DEFAULTS.lowBalanceUsd);
    case "spendWarnUsd": return cfg.spendWarnUsd !== undefined ? String(cfg.spendWarnUsd) : "";
    case "refreshSeconds": return String(cfg.refreshSeconds ?? DEFAULTS.refreshSeconds);
    default: return "";
  }
}
```

- [ ] **Step 4: Run** — `bun test test/hub-model.test.ts` → PASS (iterate until green; the contract tests are the spec).
- [ ] **Step 5: Commit** — `git commit -am "feat: pure hub model — rows, tabs, key reducer, top-up wizard machine"`

---

### Task 9: Hub renderers

**Files:**
- Create: `src/ui/hub-render.ts`
- Create: `test/hub-render.test.ts`

**Interfaces:**
- Consumes: Task 8 types (`HubState`, `HubData`, `RowSpec`, `WizardState`), `settingsRows`, `walletRows`, `modelRows`, layout helpers (Task 7), `qrLines` (Task 6), `trocadorSwapUrl`, `AMOUNT_PRESETS` (Task 4), `renderOrderSegment` (Task 3), `activeProfile`.
- Produces:
  - `interface ThemeLike { fg(color: string, s: string): string }` (structural subset of pi-tui `Theme` — pass the real theme at runtime, an identity stub in tests)
  - `renderHub(state: HubState, d: HubData, width: number, height: number, theme: ThemeLike): string[]` — full frame: tab bar, active tab body, footer (description + key hints)
  - internal per-tab renderers exported for tests: `renderSettingsTab`, `renderWalletTab`, `renderModelsTab`, `renderPayScreen`

Rendering contract (encode in tests, identity theme):
- Tab bar: `" ⚙ Settings   ◈ Wallet   ▤ Models"`, active tab wrapped by `theme.fg("accent", …)`.
- Settings: left rail lists sections, `❯` marks the focused row's section; right pane rows as `label  value` cells (label 24, value rest), focused row prefixed `❯ `, disabled rows dimmed via `theme.fg("dim", …)`; section header lines render the section name once, above their rows.
- Editing: the focused row's line is followed by `  ▸ <buffer>█` and, on error, `  ✗ <error>`.
- Wallet: header line `Balance ● $42.50 · Profile: default` (or the balance state string), then rows.
- Wizard amount step: one line of presets `❯ $10   $25   $50   $100   custom…` with cursor marker; error line when set.
- Pay screen: QR block from `qrLines(order.payUri)` left, details right (`Send exactly <amount> <unit>`, `to <payTo>`, `rate locked · expires in MM:SS` from `expiresAt - now` — pass `now` as a parameter for determinism, countdown floor 0), status line from watch, `[t] pay with another coin · [esc] background`.
- Footer: focused row's `description` (or wizard hint), then hint line `tab switch panel · ↑↓ navigate · enter edit · esc close`.
- Every emitted line is `padCell`-clamped to `width`.

- [ ] **Step 1: Write the failing test** — assert structure, not full golden frames:

```ts
// test/hub-render.test.ts
import { describe, expect, test } from "bun:test";
import type { ModelsFile, PendingOrder, StoredConfigV2 } from "../src/config.ts";
import { emptyConfigV2 } from "../src/config.ts";
import modelsData from "../src/models.json";
import { initialHubState, type HubData, type HubState } from "../src/ui/hub-model.ts";
import { renderHub, renderPayScreen } from "../src/ui/hub-render.ts";

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
    const text = renderHub(s, data({ balance: { kind: "ok", balanceUsd: 42.5, display: "$42.50" } }), 80, 30, theme).join("\n");
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
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement `src/ui/hub-render.ts`** — pure string building:

```ts
// Hub rendering: pure (state, data, width, now) → lines. All styling through ThemeLike so tests
// run with an identity stub. Style AFTER padding (padCell truncation assumes unstyled cells).
import {
  activeProfile, type PendingOrder, type StoredConfigV2,
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
  const head = `Balance ${d.balance?.kind === "ok" ? `● ${d.balance.display}` : d.balance?.kind === "unknown" ? "⚠ unfunded" : "…"} · Profile: ${d.cfg.activeProfile}`;
  const lines: string[] = [theme.fg("accent", clampLine(head, width)), ""];

  if (state.wizard) {
    lines.push(...renderWizard(state, d, theme));
    return lines.map((l) => clampLine(l, width));
  }
  const rows = walletRows(d);
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
```

Reveal screen: when `state.reveal !== null`, `renderHub` short-circuits the body to:

```ts
// inside renderHub, before per-tab dispatch:
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
```

- [ ] **Step 4: Run** — `bun test test/hub-render.test.ts` → PASS. **Step 5: Commit** — `git commit -am "feat: hub renderers — settings rail+rows, wallet wizard, pay screen with QR, models list"`

---

### Task 10: Hub component shell

**Files:**
- Create: `src/ui/hub.ts`

**Interfaces:**
- Consumes: `reduceHub`, `initialHubState`, `renderHub`, `HubData`, `HubEffect`, `KeyName`.
- Produces: `interface HubHost { data(): HubData; apply(effect: HubEffect): Promise<void>; onRepaint(repaint: () => void): void; takeStateOverride(): Partial<HubState> | null }` — host executes effects, pushes async updates via the repaint callback, and hands the component state overrides (mint reveal, quote resolution); `openHub(ctx: ExtensionContext, host: HubHost): Promise<void>` — resolves when the hub closes. Also `hubKeyFromData(data: string): KeyName | null` (raw stdin → KeyName; exported for reuse).
- No new tests (pure logic already covered; this file is dumb glue — verified by the Task 14 live smoke).

- [ ] **Step 1: Implement `src/ui/hub.ts`** (mirror the component shape of `examples/extensions/questionnaire.ts`):

```ts
// The ctx.ui.custom shell: raw input → KeyName → reduceHub → effects to the host → re-render.
// ALL decisions live in hub-model.ts; this file only adapts pi-tui's component contract.
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initialHubState, type HubData, type HubEffect, type HubState, type KeyName } from "./hub-model.ts";
import { reduceHub } from "./hub-model.ts";
import { renderHub } from "./hub-render.ts";

export interface HubHost {
  /** Current world state; re-read after every effect. */
  data(): HubData;
  /** Execute one effect (persist config, fire a quote, toggle a provider, …). */
  apply(effect: HubEffect): Promise<void>;
  /** Host pushes async updates (order tick, quote resolved) by calling the repaint it gets back. */
  onRepaint(repaint: () => void): void;
  /** Mint flow: host sets the freshly generated token to reveal, wizard to open next. */
  takeStateOverride(): Partial<HubState> | null;
}

export function hubKeyFromData(data: string): KeyName | null {
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, Key.left)) return "left";
  if (matchesKey(data, Key.right)) return "right";
  if (matchesKey(data, Key.tab)) return "tab";
  if (matchesKey(data, Key.shift("tab"))) return "shift-tab";
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.escape)) return "esc";
  if (matchesKey(data, Key.backspace)) return "backspace";
  if (data.length === 1 && data >= " " && data !== "\u007f") return { char: data };
  return null;
}

export function openHub(ctx: ExtensionContext, host: HubHost): Promise<void> {
  return ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let state: HubState = initialHubState();
    let closed = false;

    const repaint = () => {
      const override = host.takeStateOverride();
      if (override) state = { ...state, ...override };
      tui.requestRender();
    };
    host.onRepaint(repaint);

    async function dispatch(effects: HubEffect[]) {
      for (const e of effects) {
        if (e.kind === "close") {
          if (!closed) {
            closed = true;
            done(undefined);
          }
          return;
        }
        await host.apply(e);
      }
      repaint();
    }

    return {
      render(width: number): string[] {
        return renderHub(state, host.data(), width, Math.max(16, (tui as { rows?: number }).rows ?? 30), theme);
      },
      handleInput(data: string): void {
        const key = hubKeyFromData(data);
        if (!key) return;
        const r = reduceHub(state, key, host.data());
        state = r.state;
        void dispatch(r.effects);
        tui.requestRender();
      },
    };
  });
}
```

Note: if `Component`'s interface differs on read (e.g. render signature or a required `dispose`), match `examples/extensions/questionnaire.ts` exactly — it is the canonical consumer of `ctx.ui.custom` for this pi version. The `tui.rows` probe is best-effort; when unavailable use 30.

- [ ] **Step 2: Typecheck** — `bun run typecheck` → clean. **Step 3: Commit** — `git commit -am "feat: hub component shell wiring model+render into ctx.ui.custom"`

---

### Task 11: Incognito

**Files:**
- Create: `src/incognito.ts`
- Create: `test/incognito.test.ts`

**Interfaces:**
- Consumes: `ExtensionContext` (`ctx.sessionManager`), `SessionManager` (full, inside `newSession` setup callback).
- Produces:
  - `isIncognito(ctx: { sessionManager: { getSessionFile(): string | undefined } }): boolean`
  - `sessionIsFresh(entries: ReadonlyArray<{ type?: string }>): boolean` — true when no entry is a user/assistant message (headers/custom entries don't count)
  - `goIncognito(ctx: ExtensionContext): Promise<boolean>` — replaces the session with a never-persisted one; false (and no session change) on any failure

- [ ] **Step 1: Write the failing test** (pure parts only — the effect is smoke-tested live):

```ts
// test/incognito.test.ts
import { describe, expect, test } from "bun:test";
import { isIncognito, sessionIsFresh } from "../src/incognito.ts";

describe("isIncognito", () => {
  test("true when the session has no file (pi --no-session or our swap)", () => {
    expect(isIncognito({ sessionManager: { getSessionFile: () => undefined } })).toBe(true);
    expect(isIncognito({ sessionManager: { getSessionFile: () => "/tmp/s.jsonl" } })).toBe(false);
  });
});

describe("sessionIsFresh", () => {
  test("fresh: only header/custom entries", () => {
    expect(sessionIsFresh([])).toBe(true);
    expect(sessionIsFresh([{ type: "session" }, { type: "custom" }])).toBe(true);
  });
  test("not fresh once a message exists", () => {
    expect(sessionIsFresh([{ type: "session" }, { type: "message" }])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement `src/incognito.ts`**

```ts
// Incognito: stop pi from persisting the transcript. Rides pi's own primitives —
// getSessionFile() === undefined IS the native --no-session state; our swap reproduces it
// for a session started without the flag. Public-but-internal API (setSessionFile), so the
// whole effect is try/catch'd and release-gated by a live smoke test.
//
// Boundary (also in README): this stops the TRANSCRIPT. Terminal scrollback, shell history,
// and files the agent edits are out of scope. Config writes (key, orders) continue by design.
import { rmSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isIncognito(ctx: { sessionManager: { getSessionFile(): string | undefined } }): boolean {
  return ctx.sessionManager.getSessionFile() === undefined;
}

// A session is fresh while it holds no real messages — replacing it can't lose work.
export function sessionIsFresh(entries: ReadonlyArray<{ type?: string }>): boolean {
  return !entries.some((e) => e.type === "message");
}

// Swap to a session that will never touch disk again: point the session file at /dev/null
// and remove the stub pi created at newSession time. Returns success; failure leaves the
// original session intact (caller notifies "run pi --no-session instead").
export async function goIncognito(ctx: ExtensionContext): Promise<boolean> {
  try {
    let swapped = false;
    await ctx.newSession({
      setup: async (sm) => {
        const stub = sm.getSessionFile();
        sm.setSessionFile("/dev/null");
        if (stub && stub !== "/dev/null") rmSync(stub, { force: true });
        swapped = true;
      },
    });
    return swapped;
  } catch {
    return false;
  }
}
```

Verify the entry `type` discriminant before finishing this task: run
`grep -n "type SessionEntry" -A 12 node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`
— if messages are discriminated differently (e.g. `role` or a union of `"user" | "assistant"` types), adjust `sessionIsFresh` AND its test to the real discriminant. The test pins whatever the real shape is.

Also verify where `newSession` lives: run
`grep -n "newSession" node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
— it sits on the command/event extension context (~line 252). If the `session_start` event ctx does
NOT expose it, restrict `always`-mode to a notify ("run /nullsink incognito") and keep `goIncognito`
on the command path only; the live smoke (Task 14, step 4) is the arbiter.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `git commit -am "feat: incognito — badge detection, fresh-session guard, no-persist session swap"`

---

### Task 12: index.ts rewiring

**Files:**
- Modify: `src/index.ts` (structural rework of the wiring; pure modules from Tasks 1–11 do the thinking)

**Interfaces:**
- Consumes: everything produced above. No new exports (extension entry).

This task is directive-style by necessity (it edits a 400-line file that Tasks 2–6 already touched mechanically), but every behavior below is REQUIRED and each has a named anchor:

- [ ] **Step 1: Session state object** — extend the module-level `state` with:

First define the three tiny helpers the handlers below share (near the existing endpoint/provider code):

```ts
// Effective endpoints under current env + config (env wins — same precedence everywhere).
function currentEndpoints(): Endpoints {
  return resolveEndpoints(resolveBaseUrlValue(process.env[BASE_URL_ENV], state.cfg.baseUrl));
}
// One WalletApi per call — it is stateless; origin follows live config edits.
function walletApi(): WalletApi {
  return new WalletApi(currentEndpoints().origin);
}
// The raw key for /balance + /buy hashing: env wins, then the active profile.
function resolveRawKey(): string | undefined {
  return process.env[API_KEY_ENV]?.trim() || activeProfile(state.cfg).apiKey;
}
```

(`Endpoints` already exposes the site root — check the existing `resolveEndpoints` return shape for
the exact field name; if it is `origin`/`site`/`root`, use that name consistently in Tasks 4, 12, 13.)

```ts
const state: {
  cfg: StoredConfigV2;                    // loaded+migrated at startup (emptyConfigV2() when none)
  injectedEnv: boolean;
  balance?: BalanceResult;
  lastFetchMs: number;
  watch: WatchState | null;               // pending-order watcher state
  watchTimer: ReturnType<typeof setInterval> | null;
  spendWarned: boolean;
  sessionStartEntryCount: number;         // for spend: entries before this session's turns
} = { cfg: emptyConfigV2(), injectedEnv: false, lastFetchMs: 0, watch: null, watchTimer: null, spendWarned: false, sessionStartEntryCount: 0 };
```

- [ ] **Step 2: Startup (extension function body)** — order: `state.cfg = loadConfigV2() ?? emptyConfigV2()`; inject `process.env[API_KEY_ENV] = activeProfile(cfg).apiKey` when env unset and profile key present (`state.injectedEnv = true`); register providers per `cfg.providers ?? DEFAULTS.providers` (skip disabled ones — filter `buildProviders(...)` output by toggle before `registerProvider`); register the `/nullsink` command; subscribe events.

- [ ] **Step 3: `session_start` handler** —
  1. incognito `always`: if `cfg.incognito === "always"` and NOT already `isIncognito(ctx)`: if `sessionIsFresh(ctx.sessionManager.getEntries())` → `await goIncognito(ctx)`; success → `ctx.ui.notify("incognito — this session will not be saved", "info")`; failure → notify warning `couldn't go incognito — run pi --no-session`. Not fresh → notify info `resumed session is still being saved; start fresh for incognito`.
  2. default model: if `cfg.defaultModel` set and its provider toggle on: find the model via `pi.models` registry lookup used at registration (match by `provider === PROVIDER_IDS.* && id === cfg.defaultModel`); `await pi.setModel(model)`; if it returns false, notify once. Then `pi.setThinkingLevel(cfg.thinkingLevel as ThinkingLevel)` when set. (Find the exact model-lookup call by reading how the existing code passes models to `registerProvider` — the registered `ProviderConfig.models` entries carry ids; `pi.setModel` accepts a `Model` object; obtain one via the existing `buildProviders` output: provider entry + model id → construct the same object shape the provider registration used. Anchor: `registerAll()`.)
  3. resume order watch: `const order = activeProfile(cfg).pendingOrder`; if present → `startWatch(ctx)` (below), applying `orderDropReason(order, Date.now(), endpoints.origin)` first: a drop reason clears `pendingOrder` (save) + notify.
  4. `state.sessionStartEntryCount = ctx.sessionManager.getEntries().length`; kick a non-blocking `refreshBalance(ctx, true)`.

- [ ] **Step 4: order watcher** —

```ts
function startWatch(ctx: ExtensionContext): void {
  stopWatch();
  state.watch = initialWatchState();
  state.watchTimer = setInterval(() => void tickWatch(ctx), 20_000);
  void tickWatch(ctx); // immediate first tick
  renderStatus(ctx);
}
function stopWatch(): void {
  if (state.watchTimer) clearInterval(state.watchTimer);
  state.watchTimer = null;
}
async function tickWatch(ctx: ExtensionContext): Promise<void> {
  const order = activeProfile(state.cfg).pendingOrder;
  if (!order || !state.watch) return stopWatch();
  const drop = orderDropReason(order, Date.now(), currentEndpoints().origin);
  if (drop) return settleWatch(ctx, "dropped", drop);
  let status: OrderStatusRes;
  try {
    status = await walletApi().orderStatus(order.hash);
  } catch {
    return; // transient — next tick retries
  }
  if (status.state !== "closed") {
    state.watch = reduceStatus(state.watch, status);
    renderStatus(ctx);
    return;
  }
  // closed = ambiguous → resolve against a fresh balance
  const key = resolveRawKey();                       // env or active profile
  const before = state.balance?.kind === "ok" ? state.balance.balanceUsd : undefined;
  const fresh = key ? await walletApi().balance(key) : ({ kind: "error", display: "" } as BalanceResult);
  if (fresh.kind === "ok") state.balance = fresh;
  settleWatch(ctx, resolveClosed(before, fresh) === "credited" ? "credited" : "unknown");
}
function settleWatch(ctx: ExtensionContext, phase: "credited" | "unknown" | "dropped", reason?: string): void {
  stopWatch();
  state.watch = null;
  const prof = activeProfile(state.cfg);
  delete prof.pendingOrder;
  saveConfigV2(state.cfg);
  const msg = phase === "credited" ? "top-up landed — balance updated"
    : phase === "unknown" ? "order closed — check /nullsink balance to confirm"
    : `pending order dropped (${reason})`;
  emit(ctx, `nullsink: ${msg}`, phase === "credited" ? "info" : "warning");
  renderStatus(ctx);
}
```

- [ ] **Step 5: `turn_end` handler** — existing throttled refresh switches to `clampRefreshSeconds(cfg.refreshSeconds ?? 60) * 1000`; then spend: sum this session's assistant-message costs (entries after `state.sessionStartEntryCount` whose model id belongs to our three providers). Verify the usage field first: `grep -n "usage" node_modules/@earendil-works/pi-coding-agent/dist/core/messages.d.ts | head` — expect a per-message `usage` with a cost total or component costs; sum `usage.cost.total` when present, else compute from components. Store into `state.spendUsd`; when `cfg.spendWarnUsd` set, not yet `state.spendWarned`, and spend crosses it → notify + `state.spendWarned = true`.

- [ ] **Step 6: `session_shutdown`** — `stopWatch()` in addition to the existing timer cleanup.

- [ ] **Step 7: renderStatus** — build `StatusState` from the new state: `lowBalanceUsd: cfg.lowBalanceUsd ?? DEFAULTS.lowBalanceUsd`, `incognito: isIncognito(ctx)`, `order: state.watch ? toOrderReadout(state.watch) : undefined`, `spendUsd: cfg.showSpend ? state.spendUsd : undefined`. Display modes unchanged (`statusline`/`widget`/`both`/`off`).

- [ ] **Step 8: `/nullsink` command** — subcommands: no-arg → **open the hub** (TUI) or dialog menu (non-TUI); `balance`, `models`, `setup`, `help` kept; NEW: `config` → hub (Settings tab), `topup` → hub with wizard pre-opened, `pay` → hub with pay screen (when an order exists, else notify), `mint` → hub with mint flow triggered, `incognito` → immediate `goIncognito` + notify.

- [ ] **Step 9: HubHost implementation** (inside index.ts) — `data()` assembles `HubData` from `state` + env + `pi` model info (`currentProviderKey` from the session model's provider vs `PROVIDER_IDS`); `apply(effect)`:
  - `set` → write field into `state.cfg` (respecting field name = row id; `refreshSeconds` through `clampRefreshSeconds`), `saveConfigV2`, then side effects: `baseUrl` → re-register providers; `display` → re-render; any → `renderStatus`.
  - `toggleProvider` → update `cfg.providers`, save, register/unregister that provider (`pi.unregisterProvider(PROVIDER_IDS[p])` / register from `buildProviders` output).
  - `setDefaultModel` → `cfg.defaultModel = id`, save, notify "applies at next session start".
  - `quote` → `walletApi().buy(hashToken(key), creditUsd, rail)`; on success: build `PendingOrder` (incl. `baseUrl: currentEndpoints().origin`, `createdAt: Date.now()`), store in active profile, save, `startWatch`, push state override `{ wizard: { step: "pay" } }`; on `BuyError` → override `{ wizard: { step: "error", message: buyErrorMessage(code) } }`. No key → error step with "mint or paste a key first".
  - `openTrocador` → `openUrl(trocadorSwapUrl(order))` (existing `openUrl` helper).
  - `action` ids: `balance` → force refresh; `setup` → close hub then `runSetup`; `clear-config` → `clearConfig()` + reset `state.cfg` + unset injected env; `mint` → `generateToken()` → save into a free profile slot (active if keyless, else `key-2`, `key-3`, …) → override `{ reveal: token }`; `mint-saved` → override `{ wizard: { step: "amount", cursor: 1, custom: "" } }`; `profile-switch:<name>` → set active, save, re-inject env key (when we injected), refresh balance, restart watch for that profile's order; `profile-new:<name>` → create empty profile + switch; `profile-delete` → delete active profile (fall back to first remaining or `default`), save.

- [ ] **Step 10: Gate** — `bun run typecheck` clean; `bun test` green (all suites). Commit: `git commit -am "feat: wire hub, wallet, incognito, spend, provider toggles into the extension"`

---

### Task 13: Mock-nullsink integration test

**Files:**
- Create: `test/mock-nullsink.ts`
- Create: `test/wallet-flow.test.ts`

**Interfaces:**
- Consumes: `WalletApi`, watch reducer functions, `hashToken`, `PendingOrder`.
- Produces: `startMockNullsink(script: MockScript): { origin: string; stop(): void; seen: { buys: number; statusPolls: number } }` where `MockScript = { statusSequence: OrderStatusRes[]; balanceAfterClose?: number; balanceBefore?: number; buyResponse?: "ok" | { error: string; status: number } }`.

- [ ] **Step 1: Implement the mock**

```ts
// test/mock-nullsink.ts — scripted in-process nullsink for integration tests.
import type { Server } from "bun";
import type { OrderStatusRes } from "../src/wallet.ts";

export interface MockScript {
  statusSequence: OrderStatusRes[];       // consumed one per /order-status poll; last repeats
  balanceBefore?: number;                 // before the order closes (undefined → 401)
  balanceAfterClose?: number;             // once the sequence is exhausted
  buyResponse?: "ok" | { error: string; status: number };
}

export function startMockNullsink(script: MockScript) {
  const seen = { buys: 0, statusPolls: 0 };
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/rails") {
        return Response.json({ default: "monero", rails: [{ name: "monero", unit: "XMR", confirmations: 10 }] });
      }
      if (path === "/buy") {
        seen.buys++;
        const r = script.buyResponse ?? "ok";
        if (r !== "ok") return Response.json({ error: r.error }, { status: r.status });
        return Response.json({
          pay_to: "8MockAddr", amount: "0.10000000", unit: "XMR", pay_uri: "monero:8MockAddr?tx_amount=0.1",
          rate_usd: 170, confirmations_required: 10, expires_at: Date.now() + 20 * 60_000,
        });
      }
      if (path === "/order-status") {
        const i = Math.min(seen.statusPolls, script.statusSequence.length - 1);
        seen.statusPolls++;
        return Response.json(script.statusSequence[i]);
      }
      if (path === "/balance") {
        const closed = seen.statusPolls >= script.statusSequence.length
          || script.statusSequence[Math.min(seen.statusPolls, script.statusSequence.length) - 1]?.state === "closed";
        const usd = closed ? script.balanceAfterClose : script.balanceBefore;
        if (usd === undefined) return new Response("", { status: 401 });
        return Response.json({ balance_usd: usd });
      }
      return new Response("", { status: 404 });
    },
  });
  return { origin: `http://localhost:${server.port}`, stop: () => server.stop(true), seen };
}
```

- [ ] **Step 2: Write the flow test**

```ts
// test/wallet-flow.test.ts — the full money path against the scripted mock: quote → persist →
// poll progression → closed → balance resolution. Drives the SAME pure functions index.ts wires.
import { afterEach, describe, expect, test } from "bun:test";
import type { PendingOrder } from "../src/config.ts";
import { hashToken } from "../src/token.ts";
import {
  initialWatchState, orderDropReason, reduceStatus, resolveClosed, WalletApi, type WatchState,
} from "../src/wallet.ts";
import { startMockNullsink } from "./mock-nullsink.ts";

let mock: ReturnType<typeof startMockNullsink> | null = null;
afterEach(() => mock?.stop());

const KEY = "0sink_mockmockmockmockmockmockmockmockmockmockmock"; // shape irrelevant to the mock

async function runWatchToCompletion(api: WalletApi, order: PendingOrder, before?: number) {
  let watch: WatchState = initialWatchState();
  for (let i = 0; i < 20; i++) {
    expect(orderDropReason(order, Date.now(), order.baseUrl)).toBeNull();
    const status = await api.orderStatus(order.hash);
    if (status.state !== "closed") {
      watch = reduceStatus(watch, status);
      continue;
    }
    const fresh = await api.balance(KEY);
    return { watch, outcome: resolveClosed(before, fresh) };
  }
  throw new Error("mock never closed");
}

describe("full top-up flow", () => {
  test("waiting → confirming → closed → credited", async () => {
    mock = startMockNullsink({
      statusSequence: [
        { state: "waiting" },
        { state: "confirming", confirmations: 4, required: 10 },
        { state: "confirming", confirmations: 10, required: 10 },
        { state: "finalizing" },
        { state: "closed" },
      ],
      balanceBefore: 10,
      balanceAfterClose: 35,
    });
    const api = new WalletApi(mock.origin);
    const q = await api.buy(hashToken(KEY), 25, "monero");
    expect(q.amount).toBe("0.10000000");
    const order: PendingOrder = {
      hash: hashToken(KEY), baseUrl: mock.origin, creditUsd: 25, rail: "monero", unit: q.unit,
      payTo: q.payTo, amount: q.amount, payUri: q.payUri, expiresAt: q.expiresAt, createdAt: Date.now(),
    };
    const { outcome } = await runWatchToCompletion(api, order, 10);
    expect(outcome).toBe("credited");
    expect(mock.seen.buys).toBe(1);
  });

  test("first-fund flow: 401 before, credited after close", async () => {
    mock = startMockNullsink({
      statusSequence: [{ state: "waiting" }, { state: "closed" }],
      balanceAfterClose: 24.9, // proportional credit — still credited
    });
    const api = new WalletApi(mock.origin);
    const q = await api.buy(hashToken(KEY), 25);
    const order: PendingOrder = {
      hash: hashToken(KEY), baseUrl: mock.origin, creditUsd: 25, rail: "monero", unit: q.unit,
      payTo: q.payTo, amount: q.amount, payUri: q.payUri, expiresAt: q.expiresAt, createdAt: Date.now(),
    };
    const { outcome } = await runWatchToCompletion(api, order, undefined);
    expect(outcome).toBe("credited");
  });

  test("reaped order: closed with no balance change → unknown", async () => {
    mock = startMockNullsink({
      statusSequence: [{ state: "closed" }],
      balanceBefore: 10,
      balanceAfterClose: 10,
    });
    const api = new WalletApi(mock.origin);
    const order: PendingOrder = {
      hash: hashToken(KEY), baseUrl: mock.origin, creditUsd: 25, rail: "monero", unit: "XMR",
      payTo: "x", amount: "0.1", payUri: "monero:x", expiresAt: Date.now() + 1000, createdAt: Date.now(),
    };
    const { outcome } = await runWatchToCompletion(api, order, 10);
    expect(outcome).toBe("unknown");
  });

  test("429 on buy surfaces the code, no retry", async () => {
    mock = startMockNullsink({ statusSequence: [{ state: "waiting" }], buyResponse: { error: "rate_limited", status: 429 } });
    const api = new WalletApi(mock.origin);
    await expect(api.buy(hashToken(KEY), 25)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(mock.seen.buys).toBe(1);
  });
});
```

- [ ] **Step 3: Run** — `bun test test/wallet-flow.test.ts` → PASS. **Step 4: Commit** — `git commit -am "test: mock-nullsink integration — full top-up, first-fund, reaped, rate-limited paths"`

---

### Task 14: Docs, version, release gate

**Files:**
- Modify: `README.md`, `package.json` (version `0.2.0`)
- Modify: `src/models.json` (regenerate)

- [ ] **Step 1: README** — rewrite these sections to match shipped behavior (keep the tone and the Pricing/License sections):
  - **Install**: setup now mints IN the terminal (no browser required); mention `/nullsink` opens the hub.
  - **What you get**: add the hub (⚙ Settings · ◈ Wallet · ▤ Models) with a short block diagram; the `/nullsink` command list: `balance · models · setup · config · topup · pay · mint · incognito · help`.
  - **NEW “Top up from the terminal”**: the 3-step flow, QR, live `⧗ confirming n/m` ticker, resume-after-restart, Trocador hand-off, $2–$100 band.
  - **NEW “Incognito”**: what it does, the `always` mode, the honest boundary paragraph (transcript only; scrollback/shell history/agent edits excluded; resumed sessions never silently swapped).
  - **Config & status display**: profiles, all settings rows with defaults, env precedence note.
  - **Privacy note**: add the hash discipline (mint is local; `/buy` sees only `sha256(key)`), and that the key file now also holds pending-order metadata (address + amounts — no secrets beyond the key itself).
- [ ] **Step 2: Version + models** — set `"version": "0.2.0"`; run `bun run sync:models`, commit the (date-stamp) diff.
- [ ] **Step 3: Full gate** — `bun run typecheck` && `bun test` → all green, then `npm pack --dry-run` → confirm file list = README/LICENSE/package.json/src (now incl. `src/ui/*`, `src/token.ts`, `src/wallet.ts`, `src/incognito.ts`).
- [ ] **Step 4: Live smoke checklist** (manual, in a real terminal; REQUIRED before any npm publish — record results in the PR/commit message):
  1. `cd ~/dev/Method6/Piexus/Clients/Nullsink && pi` (the `.pi/settings.json` dev link loads the extension).
  2. `/nullsink` → hub renders; tab through Settings/Wallet/Models; edit low-balance to `2`; confirm `~/.pi/agent/nullsink.json` updated with `"lowBalanceUsd": 2` and file mode `0600`.
  3. Wallet → Mint new key → reveal screen → enter → amount step appears; `esc` out; key present in config file; `/model` still lists nullsink models.
  4. Settings → Incognito → `always`; quit; `pi` fresh → notification appears and `pi` session list gains NO new session; flip back to `off`.
  5. `/nullsink incognito` in a fresh session → same check.
  6. Provider toggle: switch OpenAI off → `/model` hides GPT models; current-model provider row shows locked.
  7. (With a funded or fundable key, $2) `/nullsink topup` → real QR renders; pay; watch `⧗ confirming n/m` tick; kill the terminal mid-confirmation; reopen → ticker resumes; credit lands → balance rises.
- [ ] **Step 5: Commit + push** — `git commit -am "docs: v0.2 README — hub, terminal top-up, incognito; bump to 0.2.0" && git push`. npm publish stays a SEPARATE, explicitly-approved step (account/owner decision pending).

---

## Plan Self-Review Notes

- Spec coverage: mint (T1/T12), top-up wizard + QR + ticker + resume (T4–T6, T8–T9, T12–T13), Trocador (T4/T9), hub tabs (T8–T10), profiles (T2/T8/T12), incognito (T11/T12), default model + thinking (T8/T12), provider toggles (T8/T12), spend (T3/T12), thresholds/refresh (T2/T3/T8), non-TUI fallback (T12 step 8 — dialog menu retained), README boundary + hash discipline (T14).
- Deliberate deviations from the spec: none. Deviations from v0.1 behavior: API-key paste in the hub REJECTS checksum-failing keys outright (the guided-setup dialog keeps its save-anyway confirm); justified by the checksum now existing (T1) — a failing checksum is a typo by construction.
- Verify-on-read anchors (external types that may drift): `BalanceResult.balanceUsd` field name (T4/T5), `SessionEntry` message discriminant (T11), per-message `usage` cost shape (T12 step 5), `uqr` export name (T6), `Component`/`tui.rows` shape (T10). Each has an explicit check step; none block other tasks.

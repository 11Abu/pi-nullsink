// test/wallet-flow.test.ts — the full money path against the scripted mock: quote → persist →
// poll progression → closed → balance resolution. Drives the SAME pure functions index.ts wires.
import { afterEach, describe, expect, test } from "bun:test";
import type { PendingOrder } from "../src/config.ts";
import { emptyConfigV2, parseConfigV2, serializeConfigV2 } from "../src/config.ts";
import { hashToken } from "../src/token.ts";
import {
  initialWatchState, ORDER_BACKSTOP_MS, orderDropReason, reduceStatus, resolveClosed, WalletApi, type WatchState,
} from "../src/wallet.ts";
import { startMockNullsink, type MockNullsink } from "./mock-nullsink.ts";

let mock: MockNullsink | null = null;
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

  test("malformed /order-status response throws (caller treats as transient, next tick retries)", async () => {
    mock = startMockNullsink({ statusSequence: [{ state: "waiting" }], malformed: true });
    const api = new WalletApi(mock.origin);
    await expect(api.orderStatus("a".repeat(64))).rejects.toBeDefined();
  });

  test("resume-from-config: PendingOrder survives a serialize/parse round trip and drop rules still apply", async () => {
    mock = startMockNullsink({ statusSequence: [{ state: "confirming", confirmations: 7, required: 10 }] });
    const api = new WalletApi(mock.origin);
    const q = await api.buy(hashToken(KEY), 10, "monero");
    const order: PendingOrder = {
      hash: hashToken(KEY), baseUrl: mock.origin, creditUsd: 10, rail: "monero", unit: q.unit,
      payTo: q.payTo, amount: q.amount, payUri: q.payUri, expiresAt: q.expiresAt, createdAt: Date.now(),
    };
    // Persist exactly as the extension does, reload, and resume the watch on the parsed copy.
    const cfg = emptyConfigV2();
    cfg.profiles.default = { apiKey: KEY, pendingOrder: order };
    const reloaded = parseConfigV2(JSON.parse(JSON.stringify(serializeConfigV2(cfg))))!;
    const restored = reloaded.profiles.default!.pendingOrder!;
    expect(restored).toEqual(order); // verbatim amount string included
    expect(orderDropReason(restored, Date.now(), mock.origin)).toBeNull();
    expect(orderDropReason(restored, Date.now() + ORDER_BACKSTOP_MS + 1, mock.origin)).toBe("stale");
    expect(orderDropReason(restored, Date.now(), "https://other.example")).toBe("instance-mismatch");
    const status = await api.orderStatus(restored.hash);
    expect(reduceStatus(initialWatchState(), status)).toEqual({ phase: "confirming", confirmations: 7, required: 10 });
  });
});

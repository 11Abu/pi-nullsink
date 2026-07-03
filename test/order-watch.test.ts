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
  test("instance-mismatch wins when both stale and instance-mismatch hold (baseUrl checked first)", () => {
    const pastBackstop = order.createdAt + ORDER_BACKSTOP_MS + 1;
    expect(orderDropReason(order, pastBackstop, "https://fork.example")).toBe("instance-mismatch");
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
    expect(resolveClosed(10, { kind: "ok", balanceUsd: 35, message: "" })).toBe("credited");
  });
  test("credited when previously unfunded and now any balance", () => {
    expect(resolveClosed(undefined, { kind: "ok", balanceUsd: 24.9, message: "" })).toBe("credited");
  });
  test("unknown when balance unchanged / fetch failed / still 401", () => {
    expect(resolveClosed(10, { kind: "ok", balanceUsd: 10, message: "" })).toBe("unknown");
    expect(resolveClosed(10, { kind: "error", message: "" })).toBe("unknown");
    expect(resolveClosed(undefined, { kind: "unknown", message: "" })).toBe("unknown");
  });
  test("ok balance without a balanceUsd field → unknown (credit can't be confirmed)", () => {
    expect(resolveClosed(10, { kind: "ok", message: "" })).toBe("unknown");
    expect(resolveClosed(undefined, { kind: "ok", message: "" })).toBe("unknown");
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

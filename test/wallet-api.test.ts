// test/wallet-api.test.ts — WalletApi against a stub Bun.serve; no real network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { BuyError, buyErrorMessage, RAILS_FALLBACK, trocadorSwapUrl, WalletApi } from "../src/wallet.ts";

let server: Server<unknown>; // Bun's Server is generic over websocket data (typecheck-proven fix)
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
      if (!(e instanceof BuyError)) throw e; // narrows for the checked reads below
      expect(e.code).toBe("rate_limited");
      expect(e.status).toBe(429);
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

// test/mock-nullsink.ts — scripted in-process nullsink for integration tests.
import type { Server } from "bun";
import type { OrderStatusRes } from "../src/wallet.ts";

export interface MockScript {
  statusSequence: OrderStatusRes[];       // consumed one per /order-status poll; last repeats
  balanceBefore?: number;                 // before the order closes (undefined → 401)
  balanceAfterClose?: number;             // once the sequence is exhausted
  buyResponse?: "ok" | { error: string; status: number };
  malformed?: boolean;                    // /order-status returns non-JSON garbage
}

export interface MockNullsink {
  origin: string;
  stop(): void;
  seen: { buys: number; statusPolls: number };
}

export function startMockNullsink(script: MockScript): MockNullsink {
  const seen = { buys: 0, statusPolls: 0 };
  const server: Server<unknown> = Bun.serve({
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
        if (script.malformed) return new Response("not json {", { headers: { "content-type": "application/json" } });
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

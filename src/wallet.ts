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
      // Trusted nullsink API contract shape; malformed bodies fall back below.
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
        const errBody: unknown = await res.json();
        if (errBody !== null && typeof errBody === "object" && "error" in errBody && typeof errBody.error === "string") {
          code = errBody.error;
        }
      } catch { /* non-JSON body */ }
      throw new BuyError(code, res.status);
    }
    // Trusted nullsink API contract shape (docs §nullsink API contract).
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
    // Trusted nullsink API contract shape (docs §nullsink API contract).
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

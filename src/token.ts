// nullsink token format — CLEAN-ROOM reimplementation from the public format facts
// (docs/2026-07-02-terminal-client-design.md §Token format). Pure leaf: node:crypto only.
//
// Layout: "0sink_" + 43 base64url chars (32 CSPRNG bytes, unpadded) + a 4-char tail.
// The tail folds an FNV-1a/32 hash of those 43 chars down to 24 bits, written as four
// base64url symbols — a paste-typo guard only; the 43 random chars carry the 256-bit secret.
import { createHash, getRandomValues } from "node:crypto";

export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"; // base64url order

export const TOKEN_RE = /^0sink_[A-Za-z0-9_-]{47}$/; // 43 random + 4 checksum

export function tokenChecksum(random: string): string {
  // FNV-1a/32: seed with the offset basis, then XOR-and-multiply each char by the prime.
  let fnv = 0x811c9dc5;
  for (let pos = 0; pos < random.length; pos++) fnv = Math.imul(fnv ^ random.charCodeAt(pos), 0x01000193);
  const low24 = (fnv >>> 0) & 0xffffff; // keep the low 24 bits — exactly four 6-bit groups
  return ALPHABET[(low24 >> 18) & 63]! + ALPHABET[(low24 >> 12) & 63]! + ALPHABET[(low24 >> 6) & 63]! + ALPHABET[low24 & 63]!;
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

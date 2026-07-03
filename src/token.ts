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

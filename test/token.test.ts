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

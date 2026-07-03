// test/qr.test.ts
import { readFileSync } from "node:fs";
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
  test("golden lines for a pinned input (spec: known-matrix golden)", () => {
    // Committed on first green run: `bun -e 'import("./src/ui/qr.ts").then(m => console.log(JSON.stringify(m.qrLines("nullsink-golden"), null, 2)))' > test/fixtures/qr-golden.json`
    // Review the output visually once (scan it with a phone), then the fixture pins the renderer.
    const golden = JSON.parse(readFileSync("test/fixtures/qr-golden.json", "utf8")) as string[];
    expect(qrLines("nullsink-golden")).toEqual(golden);
  });
});

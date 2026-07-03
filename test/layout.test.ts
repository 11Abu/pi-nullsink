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

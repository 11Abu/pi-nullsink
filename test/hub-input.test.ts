import { describe, expect, test } from "bun:test";
import { hubKeysFromData } from "../src/ui/hub.ts";

describe("hub input decoding", () => {
  test("plain multi-character paste becomes individual typed chars", () => {
    expect(hubKeysFromData("0sink_abc")).toEqual([
      { char: "0" },
      { char: "s" },
      { char: "i" },
      { char: "n" },
      { char: "k" },
      { char: "_" },
      { char: "a" },
      { char: "b" },
      { char: "c" },
    ]);
  });

  test("bracketed paste wrappers are stripped", () => {
    expect(hubKeysFromData("\x1b[200~abc\x1b[201~")).toEqual([
      { char: "a" },
      { char: "b" },
      { char: "c" },
    ]);
  });

  test("pasted trailing newline submits the editor", () => {
    expect(hubKeysFromData("abc\n")).toEqual([
      { char: "a" },
      { char: "b" },
      { char: "c" },
      "enter",
    ]);
  });
});

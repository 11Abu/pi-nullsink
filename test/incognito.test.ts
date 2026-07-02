// test/incognito.test.ts
import { describe, expect, test } from "bun:test";
import { isIncognito, sessionIsFresh } from "../src/incognito.ts";

describe("isIncognito", () => {
  test("true when the session has no file (pi --no-session or our swap)", () => {
    expect(isIncognito({ sessionManager: { getSessionFile: () => undefined } })).toBe(true);
    expect(isIncognito({ sessionManager: { getSessionFile: () => "/tmp/s.jsonl" } })).toBe(false);
  });
});

describe("sessionIsFresh", () => {
  test("fresh: only header/custom entries", () => {
    expect(sessionIsFresh([])).toBe(true);
    expect(sessionIsFresh([{ type: "session" }, { type: "custom" }])).toBe(true);
  });
  test("not fresh once a message exists", () => {
    expect(sessionIsFresh([{ type: "session" }, { type: "message" }])).toBe(false);
  });
});

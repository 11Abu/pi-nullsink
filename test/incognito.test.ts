// test/incognito.test.ts
import { describe, expect, test } from "bun:test";
import { goIncognito, isIncognito, sessionIsFresh } from "../src/incognito.ts";

type NSOptions = {
  setup?: (sm: { getSessionFile(): string | undefined; setSessionFile(f: string): void }) => Promise<void>;
  withSession?: (freshCtx: unknown) => Promise<void> | void;
};

describe("isIncognito", () => {
  test("true when the session has no file (pi --no-session or our swap)", () => {
    expect(isIncognito({ sessionManager: { getSessionFile: () => undefined } })).toBe(true);
    expect(isIncognito({ sessionManager: { getSessionFile: () => "/tmp/s.jsonl" } })).toBe(false);
  });
  test("true for the /dev/null swap goIncognito leaves behind", () => {
    expect(isIncognito({ sessionManager: { getSessionFile: () => "/dev/null" } })).toBe(true);
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

describe("goIncognito", () => {
  test("null/undefined ctx returns false without throwing", async () => {
    expect(await goIncognito(null)).toBe(false);
    expect(await goIncognito(undefined)).toBe(false);
  });

  test("onSwapped is wired through as newSession's withSession, invoked with the fresh ctx", async () => {
    let opts: NSOptions | undefined;
    const freshCtx = { fresh: true };
    const fakeCtx = {
      newSession: async (o: NSOptions) => {
        opts = o;
        // pi runs setup (against the new SessionManager) then withSession (fresh replacement ctx).
        await o.setup?.({ getSessionFile: () => undefined, setSessionFile: () => {} });
        await o.withSession?.(freshCtx);
        return {};
      },
    };
    let received: unknown;
    const ok = await goIncognito(fakeCtx, (c) => { received = c; });
    expect(ok).toBe(true);
    expect(typeof opts?.withSession).toBe("function");
    expect(received).toBe(freshCtx);
  });

  test("no withSession is passed when onSwapped is omitted", async () => {
    let opts: NSOptions | undefined;
    const fakeCtx = {
      newSession: async (o: NSOptions) => {
        opts = o;
        await o.setup?.({ getSessionFile: () => undefined, setSessionFile: () => {} });
        return {};
      },
    };
    const ok = await goIncognito(fakeCtx);
    expect(ok).toBe(true);
    expect(opts?.withSession).toBeUndefined();
  });
});

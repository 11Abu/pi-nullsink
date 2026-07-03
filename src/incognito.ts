// Incognito: stop pi from persisting the transcript. Rides pi's own primitives —
// getSessionFile() === undefined is the native --no-session state; "/dev/null" is our
// swap (goIncognito points the session file there). isIncognito treats both as incognito.
// Public-but-internal API (setSessionFile), so the whole effect is try/catch'd and
// release-gated by a live smoke test.
//
// Boundary (also in README): this stops the TRANSCRIPT. Terminal scrollback, shell history,
// and files the agent edits are out of scope. Config writes (key, orders) continue by design.
import { rmSync } from "node:fs";

export function isIncognito(ctx: { sessionManager: { getSessionFile(): string | undefined } }): boolean {
  const f = ctx.sessionManager.getSessionFile();
  return f === undefined || f === "/dev/null";
}

// A session is fresh while it holds no real messages — replacing it can't lose work.
export function sessionIsFresh(entries: ReadonlyArray<{ type?: string }>): boolean {
  return !entries.some((e) => e.type === "message");
}

// Swap to a session that will never touch disk again: point the session file at /dev/null
// and remove the stub pi created at newSession time. Returns success; failure leaves the
// original session intact (caller notifies "run pi --no-session instead").
//
// newSession lives on ExtensionCommandContext (types.d.ts ~L249), NOT on the plain
// ExtensionContext event handlers receive — but the runner's action table registers it for
// event contexts too. So: accept a structural ctx and probe at runtime; a ctx without
// newSession simply returns false and the caller falls back to messaging.
type NewSessionCapable = {
  newSession(options?: {
    setup?: (sm: { getSessionFile(): string | undefined; setSessionFile(f: string): void }) => Promise<void>;
    withSession?: (freshCtx: unknown) => Promise<void> | void;
  }): Promise<unknown>;
};

export async function goIncognito(
  ctx: unknown,
  onSwapped?: (freshCtx: unknown) => void | Promise<void>,
): Promise<boolean> {
  const c = ctx as Partial<NewSessionCapable> | null | undefined;
  if (typeof c?.newSession !== "function") return false;
  try {
    let swapped = false;
    await c.newSession({
      setup: async (sm) => {
        const stub = sm.getSessionFile();
        sm.setSessionFile("/dev/null");
        if (stub && stub !== "/dev/null") {
          try {
            rmSync(stub, { force: true });
          } catch {
            // best-effort: an orphaned stub is cosmetic; aborting pi's
            // session-replacement tail is not.
          }
        }
        swapped = true;
      },
      // pi invalidates the pre-swap ctx after newSession — post-swap work (the caller's notice +
      // status repaint) MUST run against the fresh replacement ctx (pi docs: "Session replacement
      // lifecycle and footguns"). Only wire withSession when the caller has post-swap work.
      ...(onSwapped ? { withSession: async (freshCtx: unknown) => { await onSwapped(freshCtx); } } : {}),
    });
    return swapped;
  } catch {
    return false;
  }
}

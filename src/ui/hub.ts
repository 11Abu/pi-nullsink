// The ctx.ui.custom shell: raw input → KeyName → reduceHub → effects to the host → re-render.
// ALL decisions live in hub-model.ts; this file only adapts pi-tui's component contract.
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initialHubState, type HubData, type HubEffect, type HubState, type KeyName } from "./hub-model.ts";
import { reduceHub } from "./hub-model.ts";
import { renderHub } from "./hub-render.ts";

export interface HubHost {
  /** Current world state; re-read after every effect. */
  data(): HubData;
  /** Execute one effect (persist config, fire a quote, toggle a provider, …). */
  apply(effect: HubEffect): Promise<void>;
  /** Host pushes async updates (order tick, quote resolved) by calling the repaint it gets back. */
  onRepaint(repaint: () => void): void;
  /** Mint flow: host sets the freshly generated token to reveal, wizard to open next. */
  takeStateOverride(): Partial<HubState> | null;
  /** Host receives a closer it can call to dismiss the hub programmatically (e.g. "Re-run setup"). */
  onClose?(close: () => void): void;
}

export function hubKeyFromData(data: string): KeyName | null {
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, Key.left)) return "left";
  if (matchesKey(data, Key.right)) return "right";
  if (matchesKey(data, Key.tab)) return "tab";
  if (matchesKey(data, Key.shift("tab"))) return "shift-tab";
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.escape)) return "esc";
  if (matchesKey(data, Key.backspace)) return "backspace";
  if (data.length === 1 && data >= " " && data !== "\u007f") return { char: data };
  return null;
}

export function openHub(ctx: ExtensionContext, host: HubHost, initial?: Partial<HubState>): Promise<void> {
  return ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let state: HubState = { ...initialHubState(), ...(initial ?? {}) };
    let closed = false;
    let cached: { width: number; lines: string[] } | undefined;

    const close = () => {
      if (!closed) {
        closed = true;
        done(undefined);
      }
    };
    const repaint = () => {
      const override = host.takeStateOverride();
      if (override) state = { ...state, ...override };
      cached = undefined;
      tui.requestRender();
    };
    host.onRepaint(repaint);
    host.onClose?.(close);

    async function dispatch(effects: HubEffect[]) {
      for (const e of effects) {
        if (e.kind === "close") {
          close();
          return;
        }
        await host.apply(e);
      }
      repaint();
    }

    return {
      render(width: number): string[] {
        if (!cached || cached.width !== width) {
          cached = { width, lines: renderHub(state, host.data(), width, Math.max(16, tui.terminal.rows ?? 30), theme) };
        }
        return cached.lines;
      },
      invalidate(): void {
        cached = undefined; // Component contract REQUIRES invalidate (pi-tui dist/tui.d.ts)
      },
      handleInput(data: string): void {
        const key = hubKeyFromData(data);
        if (!key) return;
        const r = reduceHub(state, key, host.data());
        state = r.state;
        cached = undefined;
        void dispatch(r.effects);
        tui.requestRender();
      },
    };
  });
}

// ANSI-aware layout primitives for the hub. Pure string math — no TUI objects.
import { visibleWidth } from "@earendil-works/pi-tui";

// Pad to exact visible width; truncate with a trailing ellipsis when over.
// Truncation assumes UNSTYLED input (all hub cells style AFTER padding).
export function padCell(s: string, width: number): string {
  const w = visibleWidth(s);
  if (w <= width) return s + " ".repeat(width - w);
  return `${s.slice(0, Math.max(0, width - 1))}…`;
}

export function twoCol(left: string[], right: string[], leftWidth: number, gap: string): string[] {
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(`${padCell(left[i] ?? "", leftWidth)}${gap}${right[i] ?? ""}`);
  }
  return out;
}

// Keep `cursor` within [top, top+viewport). Returns the adjusted top.
export function clampScroll(cursor: number, count: number, viewport: number, top: number): number {
  if (viewport <= 0 || count <= viewport) return 0;
  let t = top;
  if (cursor < t) t = cursor;
  if (cursor >= t + viewport) t = cursor - viewport + 1;
  return Math.max(0, Math.min(t, count - viewport));
}

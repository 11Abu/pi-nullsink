// Terminal QR: uqr renders half-block unicode (2 modules per char cell vertically).
// Scannability beats compactness — keep the default border (quiet zone).
import { renderUnicodeCompact } from "uqr";

export function qrLines(data: string): string[] {
  return renderUnicodeCompact(data).split("\n").filter((l) => l.length > 0);
}

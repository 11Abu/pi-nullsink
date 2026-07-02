// Persistent config I/O for ~/.pi/agent/nullsink.json — the ONE place that touches the filesystem
// and the one place that must enforce 0600 on a file holding spendable keys.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseConfigV2, serializeConfigV2, type StoredConfigV2 } from "./config.ts";

const FILE_MODE = 0o600;

export function configPath(): string {
  return join(getAgentDir(), "nullsink.json");
}

// Load + migrate, or null when absent/corrupt. Never throws: a bad file degrades to "unconfigured".
export function loadConfigV2(): StoredConfigV2 | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return parseConfigV2(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

// Atomic replace: write tmp in the same dir, chmod, rename over. A crash mid-write can't leave a
// truncated file holding half a key, and readers never observe a partial state.
export function saveConfigV2(cfg: StoredConfigV2): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(serializeConfigV2(cfg), null, 2)}\n`, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, path);
}

export function clearConfig(): void {
  rmSync(configPath(), { force: true });
}

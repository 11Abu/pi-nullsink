// Persistent config I/O for ~/.pi/agent/nullsink.json. Isolated from the pure core (config.ts) and
// the wiring (index.ts) so the one place that touches the filesystem — and the one place that must
// enforce 0600 on a file holding a spendable key — is small and obvious.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseStoredConfig, type StoredConfig } from "./config.ts";

// Owner read/write only — the file can hold the raw key, so it lives at the same trust level as pi's
// own auth.json. Enforced on every write via chmod (writeFileSync's mode only applies on create).
const FILE_MODE = 0o600;

export function configPath(): string {
  return join(getAgentDir(), "nullsink.json");
}

// Load the saved config, or null if none exists / it's unreadable / it's not valid JSON. Never throws:
// a corrupt file must not brick extension load — it degrades to "unconfigured".
export function loadConfig(): StoredConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return parseStoredConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

// Persist the config at 0600, creating the agent dir if needed. Rewrites the whole file (the config is
// tiny and always fully known), then chmods to guarantee perms even if the file pre-existed at 0644.
export function saveConfig(config: StoredConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}

// Delete the saved config. Idempotent — clearing when nothing is saved is a no-op.
export function clearConfig(): void {
  rmSync(configPath(), { force: true });
}

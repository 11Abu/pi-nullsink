// scripts/gen-token-vectors.ts — dev-only. Fetches nullsink's AGPL token-format.ts (pinned commit),
// runs it locally (never committed/distributed), and records input→output pairs. The committed
// vectors are facts; our MIT reimplementation must reproduce them.
import { mkdirSync, writeFileSync } from "node:fs";

const PIN = "1f13e2a8838457dbf211583386e683fd9ae14456"; // git ls-remote https://github.com/nullsink/nullsink main
const URL = `https://raw.githubusercontent.com/nullsink/nullsink/${PIN}/core/src/token-format.ts`;

const src = await (await fetch(URL)).text();
const tmp = `${process.env.TMPDIR ?? "/tmp"}/nullsink-token-format-${Date.now()}.ts`;
writeFileSync(tmp, src);
// Dynamic import is required here: the module is fetched at runtime and written to a
// timestamped temp path — it does not exist at author/build time.
const mod = await import(tmp);

const randoms = [
  "A".repeat(43),
  "_".repeat(43),
  "abcDEF123-_ghiJKL456MNopq789rstUVWxyz0-AbCd",
  "0000000000000000000000000000000000000000000",
  "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
];
const vectors = randoms.map((random) => ({
  random,
  checksum: mod.tokenChecksum(random),
  token: `0sink_${random}${mod.tokenChecksum(random)}`,
}));
mkdirSync("test/fixtures", { recursive: true });
writeFileSync("test/fixtures/token-vectors.json", `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors (pin: ${PIN})`);

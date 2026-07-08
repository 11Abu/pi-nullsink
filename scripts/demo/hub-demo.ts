// Self-driving demo of the /nullsink hub, for recording the README GIF (see scripts/demo/demo.tape).
//
// It does NOT boot pi or touch the network or any real money. It scripts a tour through the REAL,
// pure hub functions — reduceHub for navigation, renderHub for every frame — against hand-built
// fixture data. What you see is byte-for-byte what the shipped hub renders; only the keystrokes and
// the top-up progression are scripted instead of live.
//
//   bun run scripts/demo/hub-demo.ts            # play the animation (used by vhs)
//   DEMO_STILL=1 bun run scripts/demo/hub-demo.ts   # print a few static frames and exit (for review)
import type { BalanceResult, PendingOrder, StoredConfigV2 } from "../../src/config.ts";
import { models } from "../../src/models.ts";
import {
  initialHubState, reduceHub,
  type HubData, type HubEffect, type HubState, type KeyName,
} from "../../src/ui/hub-model.ts";
import { renderHub, type ThemeLike } from "../../src/ui/hub-render.ts";
import type { Rails, WatchState } from "../../src/wallet.ts";

// ── palette ──────────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const COLORS: Record<string, string> = {
  accent: "\x1b[1;38;5;44m",  // bold teal — selection, headers, the brand accent
  muted: "\x1b[38;5;246m",    // gray — secondary text
  dim: "\x1b[38;5;240m",      // dark gray — rules, hints
  warning: "\x1b[38;5;214m",  // amber — warnings, confirms
};
const theme: ThemeLike = { fg: (c, s) => `${COLORS[c] ?? ""}${s}${RESET}` };

// ── fixture world ────────────────────────────────────────────────────────────
// A masked display only ever shows "0sink_…<last4>", so a fixed fake key is enough and leaks nothing.
const DEMO_KEY = `0sink_${"dEm0onLyNotARealKeyXXXXXXXXXXXXXXXXXXXXXXX"}w4Tz`;
const DEMO_TOKEN = `0sink_${"F3nrQ8pLk2wZ7bV0cJ9yHtA6sD1gN4mR5xU8eK3oI2"}q7Rz`; // shown once on mint

function demoConfig(): StoredConfigV2 {
  return {
    version: 2,
    activeProfile: "default",
    profiles: { default: { apiKey: DEMO_KEY } },
    display: "statusline",
    providers: { anthropic: true, openai: true, tinfoil: true },
    lowBalanceUsd: 1,
    refreshSeconds: 60,
    setupDone: true,
  };
}

const DEMO_RAILS: Rails = {
  default: "monero",
  rails: [
    { name: "monero", unit: "XMR", confirmations: 10 },
    { name: "bitcoin", unit: "BTC", confirmations: 2 },
    { name: "litecoin", unit: "LTC", confirmations: 6 },
  ],
};

const data: HubData = {
  cfg: demoConfig(),
  balance: { kind: "ok", balanceUsd: 42.5, message: "" } satisfies BalanceResult,
  rails: DEMO_RAILS,
  models,
  currentProviderKey: "anthropic",
  currentModelId: models.providers.anthropic[0]?.id,
};

function demoOrder(creditUsd: number): PendingOrder {
  return {
    hash: "9f2c…demo…a1",
    baseUrl: "https://nullsink.is",
    creditUsd,
    rail: "monero",
    unit: "XMR",
    payTo: "88Nsdemo7XMRaddrQ2kTq9",
    amount: "0.29411764",
    payUri: "monero:88Nsdemo7XMRaddrQ2kTq9?tx_amount=0.29411764",
    expiresAt: Date.now() + 20 * 60_000,
    createdAt: Date.now(),
  };
}

// The host effects the demo needs to mimic. reduceHub sets most state itself; the async, host-driven
// transitions (a quote resolving to the pay screen; a mint revealing its key) are simulated here,
// exactly as host.ts would.
let state: HubState = initialHubState();
function applyEffects(effects: HubEffect[]): void {
  for (const e of effects) {
    if (e.kind === "quote") {
      data.cfg.profiles.default!.pendingOrder = demoOrder(e.creditUsd);
      data.watch = { phase: "waiting" };
      state = { ...state, wizard: { step: "pay" } };
    } else if (e.kind === "action" && e.id === "mint") {
      state = { ...state, reveal: DEMO_TOKEN };
    }
    // every other effect (set/toggle/setDefaultModel/openTrocador/close) is a no-op for the demo
  }
}

// ── frame output ─────────────────────────────────────────────────────────────
const cols = () => process.stdout.columns ?? 90;
const rows = () => process.stdout.rows ?? 28;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frame(): void {
  const lines = renderHub(state, data, cols(), rows(), theme);
  let out = "\x1b[H"; // home
  for (const l of lines) out += `${l}\x1b[K\r\n`; // write line, clear to EOL
  out += "\x1b[J"; // clear everything below
  process.stdout.write(out);
}

async function key(k: KeyName, hold = 650): Promise<void> {
  const r = reduceHub(state, k, data);
  state = r.state;
  applyEffects(r.effects);
  frame();
  await sleep(hold);
}
async function host(mutate: () => void, hold = 900): Promise<void> {
  mutate();
  frame();
  await sleep(hold);
}
const type = async (s: string, hold = 130) => {
  for (const ch of s) await key({ char: ch }, hold);
};

// ── the tour ─────────────────────────────────────────────────────────────────
async function play(): Promise<void> {
  process.stdout.write("\x1b[?25l\x1b[2J"); // hide cursor, clear
  try {
    frame();
    await sleep(1500);

    // Settings — glance down the rail
    await key("down"); await key("down"); await key("down", 900);

    // Wallet — mint a fresh key
    await key("tab", 1100);
    await key("down"); await key("down", 700);   // Profile → Top up → Mint new key
    await key("enter", 450);                       // reveal the key
    await sleep(2800);
    await key("enter", 700);                        // stored → back to wallet

    // Top up — amount → coin → pay
    await key("up", 650);                           // → Top up
    await key("enter", 900);                         // open the wizard (amount)
    await key("right", 750);                          // $25 → $50
    await key("enter", 1000);                          // → coin
    await key("down", 650); await key("up", 550);       // browse rails, land on Monero
    await key("enter", 1600);                             // quote → pay screen (QR)

    // the live order ticker
    await host(() => (data.watch = { phase: "confirming", confirmations: 1, required: 10 }));
    await host(() => (data.watch = { phase: "confirming", confirmations: 3, required: 10 }));
    await host(() => (data.watch = { phase: "confirming", confirmations: 6, required: 10 }));
    await host(() => (data.watch = { phase: "confirming", confirmations: 9, required: 10 }));
    await host(() => (data.watch = { phase: "finalizing" }), 1400);
    await key("esc", 1100);                               // background the order

    // Models — filter as you type
    await key("tab", 1100);                               // → Models
    await type("opus");
    await sleep(1600);
    await key("down"); await key("down", 1200);
    await sleep(2600);                                     // hold the closing frame
  } finally {
    process.stdout.write(`${RESET}\x1b[?25h\r\n`); // show cursor
  }
}

// ── still mode: dump a few frames for review (no animation) ────────────────────
function still(): void {
  const scenes: Array<[string, () => void]> = [
    ["Settings", () => { state = initialHubState(); }],
    ["Wallet", () => { state = { ...initialHubState(), tab: "wallet" }; }],
    ["Mint reveal", () => { state = { ...initialHubState(), tab: "wallet", reveal: DEMO_TOKEN }; }],
    ["Pay screen", () => {
      data.cfg.profiles.default!.pendingOrder = demoOrder(50);
      data.watch = { phase: "confirming", confirmations: 6, required: 10 };
      state = { ...initialHubState(), tab: "wallet", wizard: { step: "pay" } };
    }],
    ["Models", () => { state = { ...initialHubState(), tab: "models", filter: "opus" }; }],
  ];
  for (const [name, setup] of scenes) {
    setup();
    process.stdout.write(`\n\x1b[1m── ${name} ${"─".repeat(Math.max(0, cols() - name.length - 5))}\x1b[0m\n`);
    process.stdout.write(renderHub(state, data, cols(), rows(), theme).join("\n") + "\n");
  }
}

if (process.env.DEMO_STILL) {
  still();
} else {
  await play();
}

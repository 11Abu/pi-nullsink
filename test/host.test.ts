import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { emptyConfigV2, PROVIDER_IDS } from "../src/config.ts";
import { makeHubHost } from "../src/host.ts";
import nullsink, { state } from "../src/index.ts";
import { models } from "../src/models.ts";

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_API_KEY = process.env.NULLSINK_API_KEY;
const ORIGINAL_BASE_URL = process.env.NULLSINK_BASE_URL;
let agentDir: string | undefined;

afterEach(() => {
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  if (ORIGINAL_API_KEY === undefined) delete process.env.NULLSINK_API_KEY;
  else process.env.NULLSINK_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_BASE_URL === undefined) delete process.env.NULLSINK_BASE_URL;
  else process.env.NULLSINK_BASE_URL = ORIGINAL_BASE_URL;
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = undefined;
  state.cfg = emptyConfigV2();
  state.externalEnv = false;
  state.injectedEnv = false;
});

describe("makeHubHost", () => {
  test("setDefaultModel applies the selected registry model in the current session", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-nullsink-host-test-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.NULLSINK_API_KEY;
    delete process.env.NULLSINK_BASE_URL;

    const selectedModels: unknown[] = [];
    const fakePi = {
      registerProvider() {},
      registerCommand() {},
      on() {},
      setModel: async (model: unknown) => {
        selectedModels.push(model);
        return true;
      },
      setThinkingLevel() {},
    };
    nullsink(fakePi as unknown as ExtensionAPI);

    state.cfg = emptyConfigV2();
    state.cfg.providers = { anthropic: true, openai: true, tinfoil: true };
    state.cfg.profiles.default = { apiKey: "0sink_" + "a".repeat(47) };

    const modelId = models.providers.openai[0]!.id;
    const registryModel = { id: modelId, provider: PROVIDER_IDS.openai, name: "registry OpenAI model" };
    const ctx = {
      hasUI: false,
      mode: "tui",
      modelRegistry: {
        find: (provider: string, id: string) => (provider === PROVIDER_IDS.openai && id === modelId ? registryModel : undefined),
      },
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionCommandContext;

    await makeHubHost(ctx).apply({ kind: "setDefaultModel", modelId });

    expect(selectedModels).toEqual([registryModel]);
    expect(state.cfg.defaultModel).toBe(modelId);
  });
});

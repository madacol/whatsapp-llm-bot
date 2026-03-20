import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCodexAvailableModels } from "../harnesses/codex-models.js";

describe("getCodexAvailableModels", () => {
  it("returns fresh cached models without probing", async () => {
    /** @type {string[]} */
    const probed = [];
    const models = await getCodexAvailableModels({
      stat: async () => ({ mtimeMs: 1_000 }),
      now: () => 1_500,
      readFile: async () => JSON.stringify({
        checkedAt: "2026-03-20T00:00:00.000Z",
        models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
      }),
      probeModel: async (modelId) => {
        probed.push(modelId);
        return true;
      },
    });

    assert.deepEqual(models, [{ id: "gpt-5.4", label: "GPT-5.4" }]);
    assert.deepEqual(probed, []);
  });

  it("probes candidates and writes cache when stale", async () => {
    /** @type {string[]} */
    const probed = [];
    /** @type {string[]} */
    const writes = [];

    const models = await getCodexAvailableModels({
      stat: async () => ({ mtimeMs: 0 }),
      now: () => 24 * 60 * 60 * 1000 + 1,
      readFile: async () => {
        throw new Error("no cache");
      },
      mkdir: async () => undefined,
      writeFile: async (_path, content) => {
        writes.push(content);
      },
      probeModel: async (modelId) => {
        probed.push(modelId);
        return modelId === "gpt-5.4" || modelId === "gpt-5-codex";
      },
    });

    assert.deepEqual(models, [
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5-codex", label: "GPT-5 Codex" },
    ]);
    assert.ok(probed.includes("gpt-5.4"));
    assert.ok(probed.includes("gpt-5-codex"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0]?.includes("\"gpt-5.4\""));
  });
});

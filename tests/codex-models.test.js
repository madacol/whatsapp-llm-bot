import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCodexAvailableModels } from "../harnesses/codex-models.js";

describe("getCodexAvailableModels", () => {
  it("returns fresh cached models without refreshing the catalog", async () => {
    let readCatalogCalls = 0;
    const models = await getCodexAvailableModels({
      stat: async () => ({ mtimeMs: 1_000 }),
      now: () => 1_500,
      readFile: async () => JSON.stringify({
        checkedAt: "2026-03-20T00:00:00.000Z",
        models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
      }),
      readModelCatalog: async () => {
        readCatalogCalls += 1;
        return JSON.stringify({ models: [] });
      },
    });

    assert.deepEqual(models, [{ id: "gpt-5.4", label: "GPT-5.4" }]);
    assert.equal(readCatalogCalls, 0);
  });

  it("loads the current visible Codex models from the live catalog when stale", async () => {
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
      readModelCatalog: async () => JSON.stringify({
        models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_in_api: true },
          { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", supported_in_api: true },
          { slug: "gpt-5.3-codex-spark", display_name: "GPT-5.3-Codex-Spark", visibility: "list", supported_in_api: false },
        ],
      }),
    });

    assert.deepEqual(models, [
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
    ]);
    assert.equal(writes.length, 1);
    assert.ok(writes[0]?.includes("\"gpt-5.5\""));
    assert.ok(!writes[0]?.includes("codex-auto-review"));
  });

  it("falls back to stale cached models when the live catalog fails", async () => {
    const models = await getCodexAvailableModels({
      stat: async () => ({ mtimeMs: 0 }),
      now: () => 24 * 60 * 60 * 1000 + 1,
      readFile: async () => JSON.stringify({
        checkedAt: "2026-03-20T00:00:00.000Z",
        models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
      }),
      readModelCatalog: async () => {
        throw new Error("catalog unavailable");
      },
    });

    assert.deepEqual(models, [{ id: "gpt-5.4", label: "GPT-5.4" }]);
  });
});

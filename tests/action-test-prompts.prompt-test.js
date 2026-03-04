/**
 * Prompt test runner — discovers and runs `test_prompts` from action files.
 *
 * Uses a REAL LLM (not mocked), so these tests:
 *   - Are slow (network + inference latency)
 *   - Cost money (real API calls)
 *   - Are non-deterministic
 *
 * Run via: pnpm test:prompts
 * Filter: ACTION=track_purchases pnpm test:prompts
 * Never included in: pnpm test
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { createLlmClient, createCallLlm } from "../llm.js";

dotenv.config();

const actionFilter = process.env.ACTION;

/** @type {Array<{fileName: string, action: Action}>} */
let actions = [];

/** @type {CallLlm} */
let callLlm;

const fixturesDir = path.resolve(process.cwd(), "tests", "fixtures");

/**
 * Read a fixture file from tests/fixtures/ by name.
 * @param {string} name - Filename relative to tests/fixtures/
 * @returns {Promise<Buffer>}
 */
async function readFixture(name) {
  return readFile(path.join(fixturesDir, name));
}

before(async () => {
  assert.ok(process.env.LLM_API_KEY, "LLM_API_KEY env var is required to run prompt tests");

  const llmClient = createLlmClient();
  callLlm = createCallLlm(llmClient);

  // Discover actions with _test-prompts.js files
  const actionsDir = path.resolve(process.cwd(), "actions");
  const files = (await fs.readdir(actionsDir, { recursive: true }))
    .filter((f) => f === "_test-prompts.js" || f.endsWith("/_test-prompts.js"));
  for (const file of files) {
    const promptsPath = path.join(actionsDir, file);
    const indexPath = path.join(path.dirname(promptsPath), "index.js");
    const [promptsMod, actionMod] = await Promise.all([
      import(`file://${promptsPath}`),
      import(`file://${indexPath}`),
    ]);
    if (actionFilter && !actionMod.default.name.includes(actionFilter)) continue;
    actions.push({
      fileName: file,
      action: { ...actionMod.default, test_prompts: promptsMod.default },
    });
  }
});

describe("action test_prompts", () => {
  it("runs all test_prompts for actions that define them", { timeout: 120_000 }, async (t) => {
    if (actions.length === 0) {
      t.skip("no actions with test_prompts found");
      return;
    }

    for (const { action } of actions) {
      await t.test(action.name, { timeout: 60_000 }, async (t2) => {
        for (const fn of action.test_prompts || []) {
          await t2.test(fn.name || "anonymous prompt test", { timeout: 60_000 }, async () => {
            await fn(callLlm, readFixture, action.prompt ?? (() => ""));
          });
        }
      });
    }
  });
});

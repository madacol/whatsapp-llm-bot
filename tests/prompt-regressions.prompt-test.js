/**
 * Prompt regression test runner — discovers and runs JSON test cases
 * from tests/prompt-regressions/.
 *
 * Uses a REAL LLM (not mocked), so these tests:
 *   - Are slow (network + inference latency)
 *   - Cost money (real API calls)
 *   - Are non-deterministic
 *
 * Run via: pnpm test:prompts
 * Filter: REGRESSION=test-name pnpm test:prompts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createLlmClient, createCallLlm } from "../llm.js";
import { getActions } from "../actions.js";
import { actionsToToolDefinitions } from "../message-formatting.js";
import { checkAssertion } from "./prompt-regressions/assertions.js";

dotenv.config();

const regressionFilter = process.env.REGRESSION;

/** @typedef {import("./prompt-regressions/assertions.js").TestAssertion} TestAssertion */

/**
 * @typedef {{
 *   name: string;
 *   description: string;
 *   created_at: string;
 *   model?: string;
 *   system_prompt: string;
 *   messages: ChatMessage[];
 *   tools: string[];
 *   assertions: TestAssertion[];
 * }} RegressionTestCase
 */

const regressionsDir = path.resolve(process.cwd(), "tests", "prompt-regressions");
const fixturesDir = path.join(regressionsDir, "fixtures");

/** @type {RegressionTestCase[]} */
let testCases = [];

/** @type {CallLlm} */
let callLlm;

/** @type {Map<string, ToolDefinition>} */
let toolDefsByName = new Map();

/**
 * Resolve fixture references in message content blocks.
 * Replaces `{type:"image", fixture:"...", mime_type:"..."}` with actual base64 data.
 * @param {ChatMessage[]} messages
 * @returns {Promise<ChatMessage[]>}
 */
async function resolveFixtures(messages) {
  /** @type {ChatMessage[]} */
  const resolved = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      resolved.push(msg);
      continue;
    }
    const resolvedContent = await Promise.all(
      msg.content.map(async (block) => {
        if (
          block.type === "image" &&
          "fixture" in block &&
          typeof block.fixture === "string"
        ) {
          const fixturePath = path.join(fixturesDir, block.fixture);
          const data = await fs.readFile(fixturePath);
          return {
            type: /** @type {const} */ ("image"),
            encoding: /** @type {const} */ ("base64"),
            mime_type: block.mime_type || "image/jpeg",
            data: data.toString("base64"),
          };
        }
        return block;
      }),
    );
    resolved.push({ ...msg, content: resolvedContent });
  }
  return resolved;
}

before(async () => {
  assert.ok(
    process.env.LLM_API_KEY,
    "LLM_API_KEY env var is required to run prompt tests",
  );

  const llmClient = createLlmClient();
  callLlm = createCallLlm(llmClient);

  // Load all actions and build tool definitions
  const actions = await getActions();
  const allToolDefs = actionsToToolDefinitions(actions);
  for (const td of allToolDefs) {
    toolDefsByName.set(td.function.name, td);
  }

  // Discover test case JSON files
  let files;
  try {
    files = await fs.readdir(regressionsDir);
  } catch {
    return; // directory doesn't exist yet
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  for (const file of jsonFiles) {
    const name = path.basename(file, ".json");
    if (regressionFilter && !name.includes(regressionFilter)) continue;
    const content = await fs.readFile(path.join(regressionsDir, file), "utf-8");
    testCases.push(JSON.parse(content));
  }
});

describe("prompt regressions", () => {
  it("runs all regression test cases", { timeout: 120_000 }, async (t) => {
    if (testCases.length === 0) {
      t.skip("no regression test cases found");
      return;
    }

    for (const testCase of testCases) {
      await t.test(
        testCase.name,
        { timeout: 60_000 },
        async () => {
          // Resolve fixture references to actual base64 data
          const messages = await resolveFixtures(testCase.messages);

          // Prepend system prompt
          messages.unshift({ role: "system", content: testCase.system_prompt });

          // Filter tool definitions to only those specified in the test case
          const tools = testCase.tools
            .map((name) => toolDefsByName.get(name))
            .filter((td) => td !== undefined);

          // Call LLM
          const response = await callLlm({
            model: testCase.model,
            messages,
            tools,
            tool_choice: "auto",
          });

          // Check all assertions
          const results = await Promise.all(
            testCase.assertions.map((a) => checkAssertion(a, response, callLlm)),
          );

          const failures = results.filter((r) => !r.passed);
          if (failures.length > 0) {
            assert.fail(
              `Assertion(s) failed:\n${failures.map((f) => `  - ${f.message}`).join("\n")}`,
            );
          }
        },
      );
    }
  });
});

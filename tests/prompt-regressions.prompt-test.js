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
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { createLlmClient, createCallLlm } from "../llm.js";
import { getActions } from "../actions.js";
import { actionsToToolDefinitions } from "../message-formatting.js";
import { resolveModel } from "../model-roles.js";

dotenv.config();

const regressionFilter = process.env.REGRESSION;

/**
 * @typedef {{
 *   name: string;
 *   description: string;
 *   created_at: string;
 *   model?: string;
 *   system_prompt: string;
 *   messages: CallLlmMessage[];
 *   tools: string[];
 *   assertions: TestAssertion[];
 * }} RegressionTestCase
 *
 * @typedef {
 *   | { type: "tool_call"; tool_name: string }
 *   | { type: "no_tool_call"; tool_name: string }
 *   | { type: "contains"; value: string }
 *   | { type: "not_contains"; value: string }
 *   | { type: "llm_judge"; criteria: string }
 * } TestAssertion
 */

const regressionsDir = path.resolve(process.cwd(), "tests", "prompt-regressions");
const fixturesDir = path.join(regressionsDir, "fixtures");

/** @type {RegressionTestCase[]} */
let testCases = [];

/** @type {CallLlm} */
let callLlm;

/** @type {ToolDefinition[]} */
let allToolDefs = [];

/** @type {Map<string, ToolDefinition>} */
let toolDefsByName = new Map();

/**
 * Resolve fixture references in message content blocks.
 * Replaces `{type:"image", fixture:"...", mime_type:"..."}` with actual base64 data.
 * @param {CallLlmMessage[]} messages
 * @returns {Promise<CallLlmMessage[]>}
 */
async function resolveFixtures(messages) {
  /** @type {CallLlmMessage[]} */
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

/**
 * Check a single assertion against an LLM response.
 * @param {TestAssertion} assertion
 * @param {LlmChatResponse} response
 * @returns {Promise<{ passed: boolean; message: string }>}
 */
async function checkAssertion(assertion, response) {
  switch (assertion.type) {
    case "tool_call": {
      const found = response.toolCalls?.some(
        (tc) => tc.name === assertion.tool_name,
      );
      return {
        passed: !!found,
        message: found
          ? `Called ${assertion.tool_name}`
          : `Expected tool call to ${assertion.tool_name}, got: ${
              response.toolCalls?.map((tc) => tc.name).join(", ") || "none"
            }`,
      };
    }
    case "no_tool_call": {
      const found = response.toolCalls?.some(
        (tc) => tc.name === assertion.tool_name,
      );
      return {
        passed: !found,
        message: found
          ? `Expected NO call to ${assertion.tool_name}, but it was called`
          : `Correctly did not call ${assertion.tool_name}`,
      };
    }
    case "contains": {
      const content = response.content || "";
      const passed = content.includes(assertion.value);
      return {
        passed,
        message: passed
          ? `Response contains "${assertion.value}"`
          : `Response does not contain "${assertion.value}"`,
      };
    }
    case "not_contains": {
      const content = response.content || "";
      const passed = !content.includes(assertion.value);
      return {
        passed,
        message: passed
          ? `Response correctly omits "${assertion.value}"`
          : `Response unexpectedly contains "${assertion.value}"`,
      };
    }
    case "llm_judge": {
      const judgeResponse = await callLlm(
        `Given this LLM response:\n\n${JSON.stringify({ content: response.content, toolCalls: response.toolCalls })}\n\nDoes it satisfy this criteria: ${assertion.criteria}\n\nAnswer only YES or NO.`,
        { model: resolveModel("fast") },
      );
      const answer = typeof judgeResponse === "string" ? judgeResponse : "";
      const passed = answer.trim().toUpperCase().startsWith("YES");
      return {
        passed,
        message: passed
          ? `LLM judge: criteria satisfied`
          : `LLM judge: criteria NOT satisfied — "${answer}"`,
      };
    }
    default:
      return { passed: false, message: `Unknown assertion type: ${/** @type {{type: string}} */ (assertion).type}` };
  }
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
  allToolDefs = actionsToToolDefinitions(actions);
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
            testCase.assertions.map((a) => checkAssertion(a, response)),
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

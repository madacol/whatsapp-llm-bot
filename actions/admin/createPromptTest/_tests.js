import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../../../config.js";
import { writeMedia } from "../../../media-store.js";
import { seedChat } from "../../../tests/helpers.js";

const regressionsDir = path.resolve(process.cwd(), "tests", "prompt-regressions");
const fixturesDir = path.join(regressionsDir, "fixtures");

/**
 * Remove a test JSON file written during a test.
 * @param {string} testName
 */
async function cleanupTestFile(testName) {
  await fs.rm(path.join(regressionsDir, `${testName}.json`), { force: true });
}

/**
 * Remove a fixture file written during a test.
 * @param {string} fixtureName
 */
async function cleanupFixtureFile(fixtureName) {
  await fs.rm(path.join(fixturesDir, fixtureName), { force: true });
}

/**
 * Build a mock CallLlm that returns the given LlmChatResponse.
 * @param {LlmChatResponse} response
 * @returns {CallLlm}
 */
function mockCallLlm(response) {
  return /** @type {CallLlm} */ (/** @type {unknown} */ (async () => response));
}

/** @type {(ActionTestFn | ActionDbTestFn)[]} */
export default [
  /** @type {ActionTestFn} */
  async function rejects_invalid_assertion_json(action_fn) {
    const result = await action_fn(
      {
        chatId: "test-chat",
        rootDb: /** @type {PGlite} */ (/** @type {unknown} */ ({})),
        callLlm: /** @type {CallLlm} */ (/** @type {unknown} */ (() => {})),
        confirm: async () => true,
        log: async () => "",
        getActions: async () => [],
      },
      {
        test_name: "test-bad-assertion",
        description: "test",
        messages: '[{"role":"user","content":"hello"}]',
        assertion: "not-json",
      },
    );
    assert.ok(
      typeof result === "string" && result.includes("Invalid assertion JSON"),
      `Expected error about invalid JSON, got: ${result}`,
    );
  },

  /** @type {ActionTestFn} */
  async function rejects_invalid_messages_json(action_fn) {
    const result = await action_fn(
      {
        chatId: "test-chat",
        rootDb: /** @type {PGlite} */ (/** @type {unknown} */ ({})),
        callLlm: /** @type {CallLlm} */ (/** @type {unknown} */ (() => {})),
        confirm: async () => true,
        log: async () => "",
        getActions: async () => [],
      },
      {
        test_name: "test-bad-messages",
        description: "test",
        messages: "not-json",
        assertion: '{"type":"contains","value":"hello"}',
      },
    );
    assert.ok(
      typeof result === "string" && result.includes("Invalid messages JSON"),
      `Expected error about invalid JSON, got: ${result}`,
    );
  },

  /** @type {ActionTestFn} */
  async function rejects_assertion_with_missing_fields(action_fn) {
    const result = await action_fn(
      {
        chatId: "test-chat",
        rootDb: /** @type {PGlite} */ (/** @type {unknown} */ ({})),
        callLlm: /** @type {CallLlm} */ (/** @type {unknown} */ (() => {})),
        confirm: async () => true,
        log: async () => "",
        getActions: async () => [],
      },
      {
        test_name: "test-missing-field",
        description: "test",
        messages: '[{"role":"user","content":"hello"}]',
        assertion: '{"type":"tool_call"}',
      },
    );
    assert.ok(
      typeof result === "string" && result.includes("tool_name"),
      `Expected error about missing tool_name, got: ${result}`,
    );
  },

  // --- Integration tests (use DB) ---

  /** @type {ActionDbTestFn} */
  async function writes_test_case_json_when_assertion_fails(action_fn, db) {
    const testName = "test-writes-on-fail";
    try {
      const result = await action_fn(
        {
          chatId: "test-chat-write",
          rootDb: db,
          callLlm: mockCallLlm({ content: "some other response", toolCalls: [] }),
          confirm: async () => true,
          log: async () => "",
          getActions: async () => [],
        },
        {
          test_name: testName,
          description: "bot should say hello",
          messages: '[{"role":"user","content":"say hello"}]',
          assertion: '{"type":"contains","value":"hello"}',
        },
      );

      assert.ok(typeof result === "string" && result.includes("Test created"), `Expected success, got: ${result}`);
      assert.ok(result.includes("verified FAILING"), `Expected FAILING status, got: ${result}`);

      const raw = await fs.readFile(path.join(regressionsDir, `${testName}.json`), "utf-8");
      const testCase = JSON.parse(raw);

      assert.equal(testCase.name, testName);
      assert.equal(testCase.description, "bot should say hello");
      assert.ok(typeof testCase.system_prompt === "string" && testCase.system_prompt.length > 0);
      assert.ok(Array.isArray(testCase.messages));
      assert.ok(testCase.messages.every((/** @type {Record<string, unknown>} */ m) => m.role !== "system"),
        "messages in JSON must not contain system role");
      assert.ok(Array.isArray(testCase.tools));
      assert.deepEqual(testCase.assertions, [{ type: "contains", value: "hello" }]);
    } finally {
      await cleanupTestFile(testName);
    }
  },

  /** @type {ActionDbTestFn} */
  async function cancels_when_assertion_passes_and_user_declines(action_fn, db) {
    const testName = "test-cancel-on-pass";
    try {
      const result = await action_fn(
        {
          chatId: "test-chat-cancel",
          rootDb: db,
          callLlm: mockCallLlm({ content: "hello world", toolCalls: [] }),
          confirm: async () => false,
          log: async () => "",
          getActions: async () => [],
        },
        {
          test_name: testName,
          description: "bot should say hello",
          messages: '[{"role":"user","content":"say hello"}]',
          assertion: '{"type":"contains","value":"hello"}',
        },
      );

      assert.ok(typeof result === "string" && result.includes("cancelled"), `Expected cancellation, got: ${result}`);

      const exists = await fs.access(path.join(regressionsDir, `${testName}.json`)).then(() => true, () => false);
      assert.ok(!exists, "File should not have been written when user declines");
    } finally {
      await cleanupTestFile(testName);
    }
  },

  /** @type {ActionDbTestFn} */
  async function saves_with_warning_when_assertion_passes_and_user_confirms(action_fn, db) {
    const testName = "test-save-with-warning";
    try {
      const result = await action_fn(
        {
          chatId: "test-chat-warn",
          rootDb: db,
          callLlm: mockCallLlm({ content: "hello world", toolCalls: [] }),
          confirm: async () => true,
          log: async () => "",
          getActions: async () => [],
        },
        {
          test_name: testName,
          description: "bot should say hello",
          messages: '[{"role":"user","content":"say hello"}]',
          assertion: '{"type":"contains","value":"hello"}',
        },
      );

      assert.ok(typeof result === "string" && result.includes("Test created"), `Expected success, got: ${result}`);
      assert.ok(result.includes("WARNING"), `Expected WARNING in result, got: ${result}`);

      const exists = await fs.access(path.join(regressionsDir, `${testName}.json`)).then(() => true, () => false);
      assert.ok(exists, "File should have been written when user confirms");
    } finally {
      await cleanupTestFile(testName);
    }
  },

  /** @type {ActionDbTestFn} */
  async function uses_chat_system_prompt_from_db(action_fn, db) {
    const testName = "test-db-system-prompt";
    const chatId = "test-chat-custom-prompt";
    const customPrompt = "You are a custom test bot.";
    await seedChat(db, chatId, { systemPrompt: customPrompt });

    try {
      await action_fn(
        {
          chatId,
          rootDb: db,
          callLlm: mockCallLlm({ content: "irrelevant", toolCalls: [] }),
          confirm: async () => true,
          log: async () => "",
          getActions: async () => [],
        },
        {
          test_name: testName,
          description: "test db prompt",
          messages: '[{"role":"user","content":"hi"}]',
          assertion: '{"type":"contains","value":"xyz-never-matches"}',
        },
      );

      const raw = await fs.readFile(path.join(regressionsDir, `${testName}.json`), "utf-8");
      const testCase = JSON.parse(raw);
      assert.equal(testCase.system_prompt, customPrompt,
        `Expected DB system prompt "${customPrompt}", got: "${testCase.system_prompt}"`);
    } finally {
      await cleanupTestFile(testName);
    }
  },

  /** @type {ActionDbTestFn} */
  async function falls_back_to_config_system_prompt(action_fn, db) {
    const testName = "test-config-system-prompt";
    const chatId = "test-chat-no-prompt-row";

    try {
      await action_fn(
        {
          chatId,
          rootDb: db,
          callLlm: mockCallLlm({ content: "irrelevant", toolCalls: [] }),
          confirm: async () => true,
          log: async () => "",
          getActions: async () => [],
        },
        {
          test_name: testName,
          description: "test config fallback",
          messages: '[{"role":"user","content":"hi"}]',
          assertion: '{"type":"contains","value":"xyz-never-matches"}',
        },
      );

      const raw = await fs.readFile(path.join(regressionsDir, `${testName}.json`), "utf-8");
      const testCase = JSON.parse(raw);
      assert.equal(testCase.system_prompt, config.system_prompt,
        `Expected config system prompt, got: "${testCase.system_prompt}"`);
    } finally {
      await cleanupTestFile(testName);
    }
  },

  /** @type {ActionDbTestFn} */
  async function resolves_media_paths_into_regression_fixtures(action_fn, db) {
    const testName = "test-media-path-fixtures";
    const imageBuffer = Buffer.from("create-prompt-test-image");
    const mediaPath = await writeMedia(imageBuffer, "image/png", "image");

    try {
      const result = await action_fn(
        {
          chatId: "test-chat-media-path",
          rootDb: db,
          callLlm: mockCallLlm({ content: "wrong", toolCalls: [] }),
          confirm: async () => true,
          log: async () => "",
          getActions: async () => [],
        },
        {
          test_name: testName,
          description: "stores media fixtures by canonical path",
          messages: JSON.stringify([
            {
              role: "user",
              content: [
                { type: "image", path: mediaPath },
                { type: "text", text: "describe this" },
              ],
            },
          ]),
          assertion: '{"type":"contains","value":"hello"}',
        },
      );

      assert.ok(typeof result === "string" && result.includes("Fixtures:"), `Expected fixture summary, got: ${result}`);

      const raw = await fs.readFile(path.join(regressionsDir, `${testName}.json`), "utf-8");
      const testCase = JSON.parse(raw);
      assert.deepEqual(testCase.messages[0].content[0], {
        type: "image",
        fixture: mediaPath,
        mime_type: "image/png",
      });

      const fixtureData = await fs.readFile(path.join(fixturesDir, mediaPath));
      assert.deepEqual(fixtureData, imageBuffer);
    } finally {
      await cleanupTestFile(testName);
      await cleanupFixtureFile(mediaPath);
    }
  },
];

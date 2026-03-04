import assert from "node:assert/strict";

/** @type {ActionTestFn[]} */
export default [
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
];

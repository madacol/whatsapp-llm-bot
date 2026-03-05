import assert from "node:assert/strict";

/** @type {ActionTestFn[]} */
export default [
  async function rejects_unknown_agent(action_fn) {
    const result = await action_fn(
      {
        chatId: "test-chat",
        senderIds: ["test-user"],
        agentDepth: 0,
        llmClient: /** @type {LlmClient} */ ({}),
      },
      { agent_name: "nonexistent_agent_xyz", task: "do something" },
    );
    assert.ok(typeof result === "string");
    assert.ok(result.includes("not found"));
  },
];

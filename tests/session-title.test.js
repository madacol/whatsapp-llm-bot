import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSessionTitle } from "../conversation/session-title.js";
import {
  registerHarnessDriver,
  resetHarnessRegistryForTests,
} from "../harnesses/index.js";

/**
 * @param {Partial<import("../store.js").ChatRow> & { chat_id: string }} overrides
 * @returns {import("../store.js").ChatRow}
 */
function createChatRow(overrides) {
  return {
    is_enabled: true,
    system_prompt: null,
    model: null,
    respond_on_any: false,
    respond_on_mention: true,
    respond_on_reply: true,
    respond_on: "mention",
    debug: false,
    media_to_text_models: {},
    model_roles: {},
    memory: false,
    memory_threshold: null,
    active_persona: null,
    harness: null,
    harness_cwd: null,
    output_visibility: {},
    harness_config: {},
    harness_session_id: null,
    harness_session_kind: null,
    harness_session_history: [],
    harness_fork_stack: [],
    timestamp: "2026-03-23T20:00:00.000Z",
    ...overrides,
  };
}

describe("generateSessionTitle", () => {
  it("uses the active harness instance text generator when available", async () => {
    resetHarnessRegistryForTests();
    registerHarnessDriver({
      name: "title-test",
      supportsInstances: true,
      createInstance() {
        return {
          harness: {
            getName: () => "title-test",
            getCapabilities: () => ({
              supportsResume: false,
              supportsCancel: false,
              supportsLiveInput: false,
              supportsApprovals: false,
              supportsWorkdir: false,
              supportsSandboxConfig: false,
              supportsModelSelection: false,
              supportsReasoningEffort: false,
              supportsSessionFork: false,
            }),
            async run() {
              return {
                response: [],
                messages: [],
                usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
              };
            },
            handleCommand: async () => false,
            listSlashCommands: () => [],
          },
          textGeneration: {
            generateSessionTitle: async ({ transcript }) => {
              assert.match(transcript, /User: Debug checkout flow/);
              return "Harness Checkout Debug";
            },
          },
        };
      },
    });

    const title = await generateSessionTitle({
      llmClient: /** @type {LlmClient} */ (/** @type {unknown} */ ({
        chat: {
          completions: {
            create: async () => {
              assert.fail("LLM fallback should not be called");
            },
          },
        },
      })),
      chatInfo: createChatRow({
        chat_id: "chat-1",
        harness: "title-test",
        harness_config: {
          activeHarnessInstances: { "title-test": "work" },
        },
      }),
      messageRows: [
        {
          message_data: {
            role: "user",
            content: [{ type: "text", text: "Debug checkout flow" }],
          },
        },
      ],
    });

    assert.equal(title, "Harness Checkout Debug");
  });
});

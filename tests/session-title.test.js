import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSessionTitle } from "../conversation/session-title.js";
import {
  registerHarnessDriver,
  resetHarnessRegistryForTests,
} from "../harnesses/index.js";

describe("generateSessionTitle", () => {
  it("uses the active harness instance text generator when available", async () => {
    resetHarnessRegistryForTests();
    registerHarnessDriver("title-test", () => {
      assert.fail("Instance-aware test driver should use createInstance.");
    }, {
      supportsInstances: true,
      createInstance() {
        return {
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
      llmClient: /** @type {LlmClient} */ ({
        chat: {
          completions: {
            create: async () => {
              assert.fail("LLM fallback should not be called");
            },
          },
        },
      }),
      chatInfo: /** @type {import("../store.js").ChatRow} */ ({
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

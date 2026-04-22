import { describe, it } from "node:test";
import assert from "node:assert/strict";
import config from "../config.js";
import {
  buildExternalSystemPrompt,
  buildHarnessRunRequest,
} from "../conversation/build-harness-run-request.js";

describe("buildExternalSystemPrompt", () => {
  it("keeps the app default prompt for the native harness", () => {
    assert.equal(
      buildExternalSystemPrompt(null, undefined, "native"),
      config.system_prompt,
    );
  });

  it("does not add the app default prompt to non-native harnesses by default", () => {
    for (const harnessName of ["codex", "pi", "claude-agent-sdk"]) {
      assert.equal(
        buildExternalSystemPrompt(null, undefined, harnessName),
        "",
        `expected ${harnessName} to exclude the app default prompt`,
      );
    }
  });

  it("still applies explicit chat or persona prompts for SDK harnesses", () => {
    assert.equal(
      buildExternalSystemPrompt(
        /** @type {AgentDefinition} */ ({
          name: "persona",
          description: "desc",
          systemPrompt: "Use the custom persona prompt.",
        }),
        undefined,
        "codex",
      ),
      "Use the custom persona prompt.",
    );
  });
});

describe("buildHarnessRunRequest", () => {
  it("keeps Codex external instructions limited to the explicit persona prompt", async () => {
    const action = {
      name: "send_path",
      description: "Send a local path back to WhatsApp.",
      parameters: { type: "object", properties: {} },
      permissions: {},
      action_fn: async () => "ok",
    };
    const request = await buildHarnessRunRequest({
      chatId: "codex-chat",
      senderIds: ["user-1"],
      chatInfo: undefined,
      chatName: "Codex Chat",
      context: {
        chatId: "codex-chat",
        senderIds: ["user-1"],
        content: [{ type: "text", text: "hello" }],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      },
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      persona: {
        name: "persona",
        description: "desc",
        systemPrompt: "Use the custom persona prompt.",
      },
      actions: [action],
      actionResolver: async () => null,
      llmClient: /** @type {LlmClient} */ ({}),
      getMessages: async () => [],
      executeActionFn: async () => ({ result: "ok", permissions: {} }),
      addMessage: async () => undefined,
      updateToolMessage: async () => undefined,
      saveHarnessSession: async () => undefined,
      hooks: {},
      harnessName: "codex",
    });

    assert.equal(request.llmConfig.externalInstructions, "Use the custom persona prompt.");
    assert.deepEqual(
      request.llmConfig.toolRuntime.listTools().map((tool) => tool.name),
      ["send_path"],
    );
  });
});

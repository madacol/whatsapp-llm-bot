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
      buildExternalSystemPrompt(null, undefined, "\n\nYou are in a group chat", "native"),
      `${config.system_prompt}\n\nYou are in a group chat`,
    );
  });

  it("does not add the app default prompt to Codex by default", () => {
    assert.equal(
      buildExternalSystemPrompt(null, undefined, "\n\nYou are in a group chat", "codex"),
      "",
    );
  });

  it("does not add the app default prompt to Claude SDK by default", () => {
    assert.equal(
      buildExternalSystemPrompt(null, undefined, "\n\nYou are in a group chat", "claude-agent-sdk"),
      "",
    );
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
        "\n\nYou are in a group chat",
        "codex",
      ),
      "Use the custom persona prompt.\n\nYou are in a group chat",
    );
  });
});

describe("buildHarnessRunRequest", () => {
  it("does not append shared skill instructions to Codex external instructions", async () => {
    const action = {
      name: "send_path",
      description: "Send a local path back to WhatsApp.",
      sharedSkill: {
        name: "send-path",
        description: "Return a generated file to the chat.",
        instructions: "Use workspace-relative paths when possible.",
      },
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
      systemPromptSuffix: "",
      harnessName: "codex",
    });

    assert.equal(request.llmConfig.externalInstructions, "Use the custom persona prompt.");
    assert.deepEqual(
      request.llmConfig.toolRuntime.listTools().map((tool) => tool.name),
      ["send_path"],
    );
  });
});

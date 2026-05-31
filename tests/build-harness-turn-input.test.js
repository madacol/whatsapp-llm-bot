import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExternalSystemPrompt,
  buildHarnessTurnInput,
} from "../conversation/build-harness-turn-input.js";

describe("buildExternalSystemPrompt", () => {
  it("does not add the app default prompt to provider harnesses by default", () => {
    for (const harnessName of ["codex", "pi", "claude"]) {
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

describe("buildHarnessTurnInput", () => {
  it("builds semantic provider turn input without app runner plumbing", async () => {
    const turn = await buildHarnessTurnInput({
      chatId: "provider-chat",
      chatInfo: undefined,
      context: {
        chatId: "provider-chat",
        senderIds: ["user-1"],
        content: [{ type: "text", text: "hello provider" }],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      },
      message: {
        role: "user",
        content: [{ type: "text", text: "hello provider" }],
      },
      persona: {
        name: "persona",
        description: "desc",
        systemPrompt: "Use the provider prompt.",
      },
      llmClient: /** @type {LlmClient} */ ({}),
      getMessages: async () => [{
        message_id: 1,
        chat_id: "provider-chat",
        sender_id: "user-1",
        message_data: {
          role: "user",
          content: [{ type: "text", text: "hello provider" }],
        },
        timestamp: new Date("2026-05-19T00:00:00.000Z"),
        display_key: null,
      }],
      harnessName: "codex",
      runConfig: { workdir: "/repo", model: "gpt-5.4" },
    });

    assert.deepEqual(Object.keys(turn).sort(), [
      "chatId",
      "externalInstructions",
      "input",
      "messages",
      "runConfig",
    ]);
    assert.equal(turn.chatId, "provider-chat");
    assert.equal(turn.input, "hello provider");
    assert.equal(turn.externalInstructions, "Use the provider prompt.");
    assert.deepEqual(turn.messages.at(-1), {
      role: "user",
      content: [{ type: "text", text: "hello provider" }],
    });
    assert.deepEqual(turn.runConfig, { workdir: "/repo", model: "gpt-5.4" });
    assert.equal("session" in turn, false);
    assert.equal("llmConfig" in turn, false);
    assert.equal("hooks" in turn, false);
    assert.equal("mediaRegistry" in turn, false);
  });

});

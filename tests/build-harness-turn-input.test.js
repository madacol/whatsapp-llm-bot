import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExternalSystemPrompt,
  buildHarnessTurnInput,
} from "../conversation/build-harness-turn-input.js";
import { setSqliteDb } from "../db.js";
import { getChatSqlitePath } from "../chat-paths.js";
import { createTestDb } from "./helpers.js";

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
    const messages = turn.messages;
    assert.ok(messages);
    assert.deepEqual(messages.at(-1), {
      role: "user",
      content: [{ type: "text", text: "hello provider" }],
    });
    assert.deepEqual(turn.runConfig, { workdir: "/repo", model: "gpt-5.4" });
    assert.equal("session" in turn, false);
    assert.equal("llmConfig" in turn, false);
    assert.equal("hooks" in turn, false);
    assert.equal("mediaRegistry" in turn, false);
  });

  it("passes the last 20 previous user and assistant messages to audio transcription", async () => {
    const chatId = "provider-audio-context-chat";
    const db = await createTestDb();
    setSqliteDb(getChatSqlitePath(chatId), db);
    /** @type {unknown[]} */
    const requests = [];
    const llmClient = /** @type {LlmClient} */ (/** @type {unknown} */ ({
      chat: {
        completions: {
          /** @param {unknown} request */
          create: async (request) => {
            requests.push(request);
            return {
              choices: [{ message: { content: "Deploy finished after the smoke test." } }],
            };
          },
        },
      },
    }));
    /** @type {import("../store.js").MessageRow[]} */
    const historyRows = Array.from({ length: 22 }, (_, index) => {
      const messageNumber = index + 1;
      const role = messageNumber % 2 === 0
        ? /** @type {const} */ ("assistant")
        : /** @type {const} */ ("user");
      return {
        message_id: messageNumber,
        chat_id: chatId,
        sender_id: role,
        message_data: {
          role,
          content: [{ type: "text", text: `history ${messageNumber}` }],
        },
        timestamp: new Date(`2026-05-19T00:${String(messageNumber).padStart(2, "0")}:00.000Z`),
        display_key: null,
      };
    });
    /** @type {UserMessage} */
    const currentMessage = {
      role: /** @type {const} */ ("user"),
      content: [
        { type: "text", text: "Please transcribe this deployment note" },
        {
          type: /** @type {const} */ ("audio"),
          encoding: /** @type {const} */ ("base64"),
          mime_type: "audio/mp3",
          data: Buffer.from("deployment audio bytes").toString("base64"),
        },
      ],
    };
    /** @type {import("../store.js").MessageRow} */
    const currentRow = {
      message_id: 23,
      chat_id: chatId,
      sender_id: "user",
      message_data: currentMessage,
      timestamp: new Date("2026-05-19T00:23:00.000Z"),
      display_key: null,
    };

    const turn = await buildHarnessTurnInput({
      chatId,
      chatInfo: /** @type {import("../store.js").ChatRow} */ ({
        media_to_text_models: { audio: "audio/model" },
      }),
      context: {
        chatId,
        senderIds: ["user-1"],
        content: currentMessage.content,
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      },
      message: currentMessage,
      persona: null,
      llmClient,
      getMessages: async () => [
        currentRow,
        ...[...historyRows].reverse(),
      ],
      harnessName: "codex",
      runConfig: { workdir: "/repo", model: "gpt-5.4" },
    });

    assert.equal(turn.input, "Please transcribe this deployment note\nAudio transcript:\nDeploy finished after the smoke test.");
    assert.equal(requests.length, 1);
    const request = requests[0];
    if (!request || typeof request !== "object" || !("messages" in request) || !Array.isArray(request.messages)) {
      assert.fail(`Expected captured request with messages, got ${JSON.stringify(request)}`);
    }
    const requestMessages = /** @type {Array<{ role: string, content: unknown }>} */ (request.messages);
    const contextTexts = requestMessages.slice(0, 20).map((message) => {
      if (!Array.isArray(message.content)) {
        return "";
      }
      return message.content
        .map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "")
        .join("\n");
    });
    assert.deepEqual(
      contextTexts,
      Array.from({ length: 20 }, (_, index) => `history ${index + 3}`),
    );
    assert.equal(requestMessages[0]?.role, "user");
    assert.equal(requestMessages[1]?.role, "assistant");
    assert.equal(requestMessages[19]?.role, "assistant");
    assert.ok(
      JSON.stringify(requestMessages.at(-1)).includes("User's message: Please transcribe this deployment note"),
      JSON.stringify(requestMessages.at(-1)),
    );
  });

  it("omits media reference text for ACP-backed harnesses", async () => {
    const mediaPath = `${"a".repeat(64)}.png`;
    const turn = await buildHarnessTurnInput({
      chatId: "provider-media-chat",
      chatInfo: undefined,
      context: {
        chatId: "provider-media-chat",
        senderIds: ["user-1"],
        content: [
          { type: "text", text: "see these" },
          { type: "image", path: mediaPath, mime_type: "image/png" },
          { type: "file", path: `${"b".repeat(64)}.pdf`, mime_type: "application/pdf", file_name: "brief.pdf" },
        ],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      },
      message: {
        role: "user",
        content: [
          { type: "text", text: "see these" },
          { type: "image", path: mediaPath, mime_type: "image/png" },
          { type: "file", path: `${"b".repeat(64)}.pdf`, mime_type: "application/pdf", file_name: "brief.pdf" },
        ],
      },
      persona: null,
      llmClient: /** @type {LlmClient} */ ({}),
      getMessages: async () => [{
        message_id: 1,
        chat_id: "provider-media-chat",
        sender_id: "user-1",
        message_data: {
          role: "user",
          content: [
            { type: "text", text: "see these" },
            { type: "image", path: mediaPath, mime_type: "image/png" },
            { type: "file", path: `${"b".repeat(64)}.pdf`, mime_type: "application/pdf", file_name: "brief.pdf" },
          ],
        },
        timestamp: new Date("2026-05-19T00:00:00.000Z"),
        display_key: null,
      }],
      harnessName: "codex",
      runConfig: { workdir: "/repo", model: "gpt-5.4" },
    });

    assert.equal(turn.input, "see these");
    assert.ok(!turn.input.includes("Media file available"));
    assert.ok(!turn.input.includes(".media"));
    assert.ok(!turn.input.includes("brief.pdf"));
  });

});

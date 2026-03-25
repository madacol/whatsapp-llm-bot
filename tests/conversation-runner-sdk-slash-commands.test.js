import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";

import { createChatTurn, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {import("@electric-sql/pglite").PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;
/** @type {typeof import("../harnesses/index.js").registerHarness} */
let registerHarness;
/** @type {typeof import("../harnesses/claude-agent-sdk.js").createClaudeAgentSdkHarness} */
let createClaudeAgentSdkHarness;
/** @type {typeof import("../harnesses/codex.js").createCodexHarness} */
let createCodexHarness;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);

  const { initStore } = await import("../store.js");
  store = await initStore(db);

  const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
  ({ registerHarness } = await import("../harnesses/index.js"));
  ({ createClaudeAgentSdkHarness } = await import("../harnesses/claude-agent-sdk.js"));
  ({ createCodexHarness } = await import("../harnesses/codex.js"));

  const runner = createConversationRunner({
    store,
    llmClient: /** @type {LlmClient} */ ({}),
    getActionsFn: async () => [],
    executeActionFn: async () => {
      throw new Error("executeAction should not be called");
    },
  });
  handleMessage = runner.handleMessage;
});

afterEach(() => {
  registerHarness("claude-agent-sdk", createClaudeAgentSdkHarness);
  registerHarness("codex", createCodexHarness);
});

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(db, chatId, options);

describe("createConversationRunner with SDK slash commands", () => {
  it("sends slash-prefixed messages directly to the SDK without local command handling or chat formatting", async () => {
    await seedChat("conv-sdk-slash-1", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'claude-agent-sdk',
          harness_config = '{}'::jsonb
      WHERE chat_id = 'conv-sdk-slash-1'
    `;

    let handledCommandCalls = 0;
    /** @type {string | null} */
    let seenPrompt = null;

    registerHarness("claude-agent-sdk", () => ({
      getName: () => "claude-agent-sdk",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: true,
        supportsLiveInput: true,
        supportsApprovals: true,
        supportsWorkdir: true,
        supportsSandboxConfig: false,
        supportsModelSelection: true,
        supportsReasoningEffort: true,
        supportsSessionFork: false,
      }),
      handleCommand: async () => {
        handledCommandCalls += 1;
        return false;
      },
      run: async (params) => {
        const lastMessage = params.messages.at(-1);
        assert.ok(lastMessage, "Expected a final message");
        assert.equal(lastMessage.role, "user");
        const textBlock = lastMessage.content.find((block) => block.type === "text");
        assert.ok(textBlock, "Expected the final user message to include text");
        seenPrompt = textBlock.text;

        await params.hooks.onLlmResponse("SDK slash command received");
        return {
          response: [{ type: "text", text: "SDK slash command received" }],
          messages: params.messages,
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        };
      },
    }));

    const { context, responses } = createChatTurn({
      chatId: "conv-sdk-slash-1",
      senderName: "Marco",
      facts: { isGroup: true },
      content: [{ type: "text", text: "/help" }],
    });
    await handleMessage(context);

    assert.equal(handledCommandCalls, 0);
    assert.equal(seenPrompt, "/help");
    assert.ok(
      responses.some((response) => response.text.includes("SDK slash command received")),
      `Expected the SDK harness to receive the slash command, got: ${responses.map((response) => response.text).join(" | ")}`,
    );
  });

  it("keeps Codex slash-prefixed messages on the harness command surface", async () => {
    await seedChat("conv-sdk-slash-codex", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb
      WHERE chat_id = 'conv-sdk-slash-codex'
    `;

    /** @type {string[]} */
    const seenCommands = [];
    let runCalls = 0;

    registerHarness("codex", () => ({
      getName: () => "codex",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: true,
        supportsLiveInput: true,
        supportsApprovals: true,
        supportsWorkdir: true,
        supportsSandboxConfig: true,
        supportsModelSelection: true,
        supportsReasoningEffort: false,
        supportsSessionFork: false,
      }),
      handleCommand: async (input) => {
        seenCommands.push(input.command);
        await input.context.reply({
          kind: "content",
          source: "tool-result",
          content: "Codex slash command handled",
        });
        return true;
      },
      run: async (params) => {
        runCalls += 1;
        await params.hooks.onLlmResponse("run should not be called");
        return {
          response: [{ type: "text", text: "run should not be called" }],
          messages: params.messages,
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        };
      },
    }));

    const { context, responses } = createChatTurn({
      chatId: "conv-sdk-slash-codex",
      content: [{ type: "text", text: "/model GPT-5.4" }],
    });
    await handleMessage(context);

    assert.deepEqual(seenCommands, ["model gpt-5.4"]);
    assert.equal(runCalls, 0);
    assert.ok(
      responses.some((response) => response.text.includes("Codex slash command handled")),
      `Expected Codex to handle the slash command locally, got: ${responses.map((response) => response.text).join(" | ")}`,
    );
  });
});

import { afterEach, before, describe, it } from "node:test";
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
/** @type {typeof import("../harnesses/codex.js").createCodexHarness} */
let createCodexHarness;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);

  const { initStore } = await import("../store.js");
  store = await initStore(db);

  const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
  ({ registerHarness } = await import("../harnesses/index.js"));
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
  registerHarness("codex", createCodexHarness);
});

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(db, chatId, options);

describe("createConversationRunner prompt formatting", () => {
  it("stores raw group text, carries sender metadata, and omits the group-chat cue", async () => {
    await seedChat("conv-prompt-group", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb
      WHERE chat_id = 'conv-prompt-group'
    `;

    /** @type {Message[] | null} */
    let seenMessages = null;
    /** @type {string | null} */
    let seenExternalInstructions = null;

    registerHarness("codex", () => createCodexHarness({
      startRun: async (input) => {
        seenMessages = input.messages;
        seenExternalInstructions = input.externalInstructions ?? null;
        return {
          abortController: new AbortController(),
          done: Promise.resolve({
            sessionId: null,
            result: {
              response: [{ type: "text", text: "ok" }],
              messages: input.messages,
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
            },
          }),
        };
      },
    }));

    const turn = createChatTurn({
      chatId: "conv-prompt-group",
      senderName: "Alice",
      content: [{ type: "text", text: "hello" }],
      facts: { isGroup: true, addressedToBot: true, repliedToBot: false },
    });
    await handleMessage(turn.context);

    assert.ok(seenMessages, "Expected the harness to receive messages");
    const lastMessage = seenMessages.at(-1);
    assert.ok(lastMessage, "Expected a final user message");
    assert.equal(lastMessage.role, "user");
    if (lastMessage.role !== "user") {
      throw new Error("Expected the final message to be a user message");
    }
    assert.equal(lastMessage.senderName, "Alice");
    assert.deepEqual(lastMessage.content, [{ type: "text", text: "hello" }]);
    assert.equal(seenExternalInstructions, "");
  });
});

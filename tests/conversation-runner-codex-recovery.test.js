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

describe("createConversationRunner with codex harness", () => {
  it("shows a startup failure, clears the stale session, and recovers on the next turn", async () => {
    await seedChat("conv-codex-recover", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb,
          harness_session_id = 'sess-stale',
          harness_session_kind = 'codex'
      WHERE chat_id = 'conv-codex-recover'
    `;

    /** @type {Array<string | null>} */
    const seenSessionIds = [];
    let attemptCount = 0;
    registerHarness("codex", () => createCodexHarness({
      startRun: async (input) => {
        seenSessionIds.push(input.sessionId ?? null);
        attemptCount += 1;
        if (attemptCount === 1) {
          return {
            abortController: new AbortController(),
            done: Promise.reject(new Error("Codex Exec exited with code 1: Reading prompt from stdin...")),
          };
        }
        return {
          abortController: new AbortController(),
          done: (async () => {
            await input.hooks?.onLlmResponse?.("Recovered after clearing session");
            return {
              sessionId: "sess-fresh",
              result: {
                response: [{ type: "markdown", text: "Recovered after clearing session" }],
                messages: input.messages,
                usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
              },
            };
          })(),
        };
      },
    }));

    const firstTurn = createChatTurn({
      chatId: "conv-codex-recover",
      content: [{ type: "text", text: "Trigger the stale codex session" }],
    });
    await handleMessage(firstTurn.context);

    assert.ok(
      firstTurn.responses.some((response) => response.source === "error" && response.text.includes("Codex Exec exited with code 1")),
      `Expected the first turn to show the Codex startup failure, got: ${firstTurn.responses.map((response) => response.text).join(" | ")}`,
    );

    let chat = await store.getChat("conv-codex-recover");
    assert.equal(chat?.harness_session_id, null);
    assert.equal(chat?.harness_session_kind, null);

    const secondTurn = createChatTurn({
      chatId: "conv-codex-recover",
      content: [{ type: "text", text: "Try again after clearing the session" }],
    });
    await handleMessage(secondTurn.context);

    assert.ok(
      secondTurn.responses.some((response) => response.text.includes("Recovered after clearing session")),
      `Expected the second turn to recover cleanly, got: ${secondTurn.responses.map((response) => response.text).join(" | ")}`,
    );

    chat = await store.getChat("conv-codex-recover");
    assert.equal(chat?.harness_session_id, "sess-fresh");
    assert.equal(chat?.harness_session_kind, "codex");
    assert.deepEqual(seenSessionIds, ["sess-stale", null]);
  });
});

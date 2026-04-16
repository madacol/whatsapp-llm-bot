import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setDb } from "../db.js";
import { createTestDb, seedChat } from "./helpers.js";
import { createPiHarness } from "../harnesses/pi.js";

/**
 * @param {OutboundEvent} event
 * @returns {string}
 */
function getReplyText(event) {
  assert.equal(event.kind, "content");
  return typeof event.content === "string" ? event.content : JSON.stringify(event.content);
}

before(async () => {
  const db = await createTestDb();
  setDb("./pgdata/root", db);
});

describe("createPiHarness", () => {
  it("exposes the unified harness contract", () => {
    const harness = createPiHarness();

    assert.equal(harness.getName(), "pi");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");
    assert.equal(typeof harness.listSlashCommands, "function");
    assert.deepEqual(harness.getCapabilities(), {
      supportsResume: true,
      supportsCancel: true,
      supportsLiveInput: true,
      supportsApprovals: false,
      supportsWorkdir: true,
      supportsSandboxConfig: false,
      supportsModelSelection: true,
      supportsReasoningEffort: true,
      supportsSessionFork: true,
    });
    assert.deepEqual(harness.listSlashCommands(), [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
      { name: "fork", description: "Fork the current Pi session" },
      { name: "back", description: "Return to the previous Pi fork parent" },
      { name: "model", description: "Choose or set the Pi model" },
      { name: "effort", description: "Choose or set the Pi reasoning effort" },
    ]);
  });

  it("handles Pi-owned model commands", async () => {
    const db = await createTestDb();
    await seedChat(db, "pi-chat-1", { enabled: true });
    const harness = createPiHarness({
      getAvailableModels: async () => [
        { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      ],
    });
    /** @type {string[]} */
    const replies = [];

    const handled = await harness.handleCommand({
      chatId: "pi-chat-1",
      command: "model google/gemini-2.5-pro",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "pi-chat-1",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
    });

    const { rows: [chat] } = await db.sql`
      SELECT harness_config
      FROM chats
      WHERE chat_id = 'pi-chat-1'
    `;

    assert.equal(handled, true);
    assert.deepEqual(chat?.harness_config, {
      pi: {
        model: "google/gemini-2.5-pro",
      },
    });
    assert.ok(replies.at(-1)?.includes("Pi model set to `google/gemini-2.5-pro`"));
  });

  it("forks the active Pi session and switches the saved session path", async () => {
    const harness = createPiHarness({
      getAvailableModels: async () => [],
      getForkMessages: async (sessionPath) => {
        assert.equal(sessionPath, "/tmp/pi-parent.jsonl");
        return [{ entryId: "entry-1", text: "Refactor the worker pool" }];
      },
      forkSession: async (sessionPath, entryId) => {
        assert.equal(sessionPath, "/tmp/pi-parent.jsonl");
        assert.equal(entryId, "entry-1");
        return {
          sessionPath: "/tmp/pi-fork.jsonl",
          text: "Refactor the worker pool",
        };
      },
    });
    /** @type {Array<{ chatId: string, session: HarnessSessionRef | null }>} */
    const savedSessions = [];
    /** @type {Array<{ chatId: string, entry: HarnessForkStackEntry }>} */
    const pushedEntries = [];
    /** @type {string[]} */
    const replies = [];

    const handled = await harness.handleCommand({
      chatId: "pi-fork-1",
      chatInfo: /** @type {import("../store.js").ChatRow} */ ({
        chat_id: "pi-fork-1",
        harness_session_id: "/tmp/pi-parent.jsonl",
        harness_session_kind: "pi",
      }),
      command: "fork",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "pi-fork-1",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
      sessionForkControl: {
        save: async (chatId, session) => {
          savedSessions.push({ chatId, session });
        },
        push: async (chatId, entry) => {
          pushedEntries.push({ chatId, entry });
        },
        pop: async () => null,
      },
    });

    assert.equal(handled, true);
    assert.deepEqual(pushedEntries, [{
      chatId: "pi-fork-1",
      entry: { id: "/tmp/pi-parent.jsonl", kind: "pi", label: "Refactor the worker pool" },
    }]);
    assert.deepEqual(savedSessions, [{
      chatId: "pi-fork-1",
      session: { id: "/tmp/pi-fork.jsonl", kind: "pi" },
    }]);
    assert.ok(replies.at(-1)?.includes("Forked: Refactor the worker pool"));
  });
});

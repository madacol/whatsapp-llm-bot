import assert from "node:assert/strict";
import { readChatConfig, writeChatConfig } from "../../../chat-config.js";

/** @type {ActionDbTestFn[]} */
export default [
  async function shows_available_personas_when_no_args(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id) VALUES ('persona-test') ON CONFLICT DO NOTHING`;
    await writeChatConfig("persona-test", { chat_id: "persona-test" });
    const result = await action_fn(
      { chatId: "persona-test", rootDb: db },
      {},
    );
    assert.ok(typeof result === "string");
    assert.ok(result.includes("Current persona"));
    assert.ok(result.includes("Available personas"));
  },

  async function deactivates_persona_with_off(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id) VALUES ('persona-off') ON CONFLICT DO NOTHING`;
    await writeChatConfig("persona-off", { chat_id: "persona-off", active_persona: "test" });
    const result = await action_fn(
      { chatId: "persona-off", rootDb: db },
      { name: "off" },
    );
    assert.ok(typeof result === "string");
    assert.ok(result.includes("deactivated"));
    const chat = await readChatConfig("persona-off");
    assert.ok(chat, "expected chat config");
    assert.equal(chat.active_persona, null);
  },

  async function rejects_unknown_persona(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id) VALUES ('persona-unk') ON CONFLICT DO NOTHING`;
    await writeChatConfig("persona-unk", { chat_id: "persona-unk" });
    const result = await action_fn(
      { chatId: "persona-unk", rootDb: db },
      { name: "nonexistent_agent_xyz" },
    );
    assert.ok(typeof result === "string");
    assert.ok(result.includes("not found"));
  },
];

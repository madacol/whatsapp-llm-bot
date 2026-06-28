import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestDb, seedChat } from "./helpers.js";
import { readChatConfig } from "../chat-config.js";
import { runChatSettingsInteraction } from "../chat-settings-service.js";

describe("Chat Settings interaction", () => {
  /** @type {import("../sqlite-db.js").SqliteDb} */
  let db;

  before(async () => {
    db = await createTestDb();
  });

  it("owns picker interaction and persistence for selectable settings", async () => {
    await seedChat(db, "settings-interaction-chat", { enabled: true });
    const result = await runChatSettingsInteraction({
      chatId: "settings-interaction-chat",
      rootDb: db,
      senderIds: ["master-user"],
      select: async (_question, options, config) => {
        assert.deepEqual(options.map((option) => typeof option === "string" ? option : option.id), ["on", "off"]);
        assert.equal(config?.currentId, "off");
        return "on";
      },
    }, { setting: "memory" });

    assert.equal(result, "Long-term memory enabled for this chat.");
    const chat = await readChatConfig("settings-interaction-chat");
    assert.equal(chat?.memory, true);
  });
});

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createWhatsAppTransport,
  executeCommunityCreate,
  executeCommunityCreateGroup,
  executeGroupLinkedParentLookup,
} from "../whatsapp/create-whatsapp-transport.js";
import { setDb } from "../db.js";
import { createTestDb } from "./helpers.js";

/** @type {import("@electric-sql/pglite").PGlite | null} */
let testDb = null;

before(async () => {
  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
});

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} chatId
 * @returns {Promise<Array<{ id: number, chat_id: string, payload_json: unknown }>>}
 */
async function getQueuedRows(db, chatId) {
  const { rows } = await db.sql`
    SELECT id, chat_id, payload_json
    FROM whatsapp_outbound_queue
    WHERE chat_id = ${chatId}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    chat_id: String(row.chat_id),
    payload_json: row.payload_json,
  }));
}

describe("WhatsApp transport community creation", () => {
  it("replays queued outbound events when the connection opens again", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-transport-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection Closed");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
    });

    await transport.start(async () => {});
    await transport.sendEvent?.(chatId, {
      kind: "content",
      source: "llm",
      content: "queued on disconnect",
    });

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });

    assert.deepEqual(sentMessages, [{
      chatId,
      message: { text: "🤖 queued on disconnect" },
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("returns the created community id from Baileys community metadata", async () => {
    const socket = {
      communityCreate: async () => ({
        id: "community-12345",
        subject: "Project Main",
      }),
    };

    const result = await executeCommunityCreate(socket, "Project Main", "Primary workspace community");

    assert.deepEqual(result, {
      chatId: "community-12345@g.us",
      subject: "Project Main",
    });
  });

  it("throws when Baileys communityCreate returns no community id", async () => {
    const socket = {
      communityCreate: async () => ({ subject: "Project Main" }),
    };

    await assert.rejects(
      () => executeCommunityCreate(socket, "Project Main", "Primary workspace community"),
      /Baileys communityCreate returned no community id\./,
    );
  });

  it("returns the created subgroup id from Baileys group metadata", async () => {
    const socket = {
      communityCreateGroup: async () => ({
        id: "group-12345",
        subject: "payments",
      }),
    };

    const result = await executeCommunityCreateGroup(
      socket,
      "payments",
      ["user@s.whatsapp.net"],
      "community-12345@g.us",
    );

    assert.deepEqual(result, {
      chatId: "group-12345@g.us",
      subject: "payments",
    });
  });

  it("throws when Baileys communityCreateGroup returns no group id", async () => {
    const socket = {
      communityCreateGroup: async () => ({ subject: "payments" }),
    };

    await assert.rejects(
      () => executeCommunityCreateGroup(
        socket,
        "payments",
        ["user@s.whatsapp.net"],
        "community-12345@g.us",
      ),
      /Baileys communityCreateGroup returned no group id\./,
    );
  });

  it("returns the linked parent from Baileys group metadata", async () => {
    const socket = {
      groupMetadata: async () => ({
        linkedParent: "community-12345",
      }),
    };

    const result = await executeGroupLinkedParentLookup(socket, "group-12345@g.us");

    assert.equal(result, "community-12345@g.us");
  });

  it("returns null when Baileys group metadata has no linked parent", async () => {
    const socket = {
      groupMetadata: async () => ({
        linkedParent: null,
      }),
    };

    const result = await executeGroupLinkedParentLookup(socket, "group-12345@g.us");

    assert.equal(result, null);
  });
});

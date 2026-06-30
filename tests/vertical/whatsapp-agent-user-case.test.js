import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { updateChatConfig } from "../../chat-config.js";
import { setDb } from "../../db.js";
import { createMessageHandler } from "../../index.js";
import { initStore } from "../../store.js";
import { registerAcpTestHarness, ZERO_USAGE } from "../acp-test-harness.js";
import { createTestDb, createWAMessage, seedChat } from "../helpers.js";
import {
  createWhatsAppTransportTestbed,
  hasSentTextContaining,
  waitForCondition,
} from "./whatsapp-transport-testbed.js";

const originalTesting = process.env.TESTING;

describe("WhatsApp to agent user case", () => {
  /** @type {import("../../sqlite-db.js").SqliteDb} */
  let db;
  /** @type {import("../../store.js").Store} */
  let store;

  before(async () => {
    process.env.TESTING = "1";
    db = await createTestDb();
    setDb("./pgdata/root", db);
    store = await initStore(db);
  });

  after(() => {
    if (originalTesting === undefined) {
      delete process.env.TESTING;
    } else {
      process.env.TESTING = originalTesting;
    }
  });

  it("responds to a private WhatsApp text message through the selected agent harness", async () => {
    const harnessName = "vertical-user-case-agent";
    const senderId = "vertical-user-case";
    const chatId = `${senderId}@s.whatsapp.net`;
    const userText = "hello from whatsapp";
    const agentText = "hello from the fake agent";
    const harnessState = registerAcpTestHarness({
      name: harnessName,
      onSendTurn: (input) => ({
        response: [{ type: "markdown", text: agentText }],
        messages: input.messages ?? [],
        usage: ZERO_USAGE,
      }),
    });
    const testbed = await createWhatsAppTransportTestbed({ store });
    const { handleMessage } = createMessageHandler({
      store,
      llmClient: /** @type {LlmClient} */ ({}),
      transport: testbed.transport,
    });

    await seedChat(db, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({ ...current, harness: harnessName }));
    try {
      await testbed.start(handleMessage);
      await testbed.replayInboundCapture({
        type: "notify",
        messages: [createWAMessage({ chatId, senderId, text: userText })],
      });

      await waitForCondition(
        () => hasSentTextContaining(testbed.sentMessages, agentText),
        `Expected WhatsApp response containing ${JSON.stringify(agentText)}, got ${JSON.stringify(testbed.sentMessages)}`,
      );

      assert.equal(harnessState.turns.length, 1);
      assert.equal(harnessState.turns[0]?.input, userText);
    } finally {
      await testbed.stop();
    }
  });
});

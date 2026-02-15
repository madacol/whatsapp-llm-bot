import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// Env vars needed because whatsapp-adapter.js imports index.js which loads config.js
process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {typeof import("../whatsapp-adapter.js").getMessageContent} */
let getMessageContent;

before(async () => {
  // Seed DB cache so initStore() in index.js uses in-memory DB
  const testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  const adapter = await import("../whatsapp-adapter.js");
  getMessageContent = adapter.getMessageContent;
});

describe("getMessageContent", () => {
  it("extracts plain text (conversation)", async () => {
    const msg = /** @type {any} */ ({
      message: { conversation: "Hello world" },
    });
    const content = await getMessageContent(msg);

    assert.equal(content.length, 1);
    assert.equal(content[0].type, "text");
    assert.equal(/** @type {any} */ (content[0]).text, "Hello world");
  });

  it("extracts extendedTextMessage", async () => {
    const msg = /** @type {any} */ ({
      message: { extendedTextMessage: { text: "Extended" } },
    });
    const content = await getMessageContent(msg);

    assert.ok(content.some(b => b.type === "text" && /** @type {any} */ (b).text === "Extended"));
  });

  it("extracts quoted message with reply text", async () => {
    const msg = /** @type {any} */ ({
      message: {
        extendedTextMessage: {
          text: "My reply",
          contextInfo: {
            quotedMessage: { conversation: "Original" },
          },
        },
      },
    });
    const content = await getMessageContent(msg);

    assert.ok(content.some(b => b.type === "quote"), "Should have quote block");
    assert.ok(
      content.some(b => b.type === "text" && /** @type {any} */ (b).text === "My reply"),
      "Should have reply text",
    );

    const quote = /** @type {any} */ (content.find(b => b.type === "quote"));
    assert.ok(
      quote.content.some(b => b.type === "text" && b.text === "Original"),
      "Quote should contain original text",
    );
  });

  it("extracts quoted extendedTextMessage", async () => {
    const msg = /** @type {any} */ ({
      message: {
        extendedTextMessage: {
          text: "replying",
          contextInfo: {
            quotedMessage: {
              extendedTextMessage: { text: "original extended" },
            },
          },
        },
      },
    });
    const content = await getMessageContent(msg);

    const quote = /** @type {any} */ (content.find(b => b.type === "quote"));
    assert.ok(quote, "Should have quote block");
    assert.ok(
      quote.content.some(b => b.type === "text" && b.text === "original extended"),
    );
  });

  it("extracts image caption from quoted message", async () => {
    const msg = /** @type {any} */ ({
      message: {
        extendedTextMessage: {
          text: "About this image",
          contextInfo: {
            quotedMessage: {
              imageMessage: { caption: "Image caption" },
            },
          },
        },
      },
    });
    const content = await getMessageContent(msg);

    const quote = /** @type {any} */ (content.find(b => b.type === "quote"));
    assert.ok(quote);
    assert.ok(
      quote.content.some(b => b.type === "text" && b.text === "Image caption"),
    );
  });

  it("extracts document caption as text", async () => {
    const msg = /** @type {any} */ ({
      message: { documentMessage: { caption: "See attached" } },
    });
    const content = await getMessageContent(msg);

    assert.ok(
      content.some(b => b.type === "text" && /** @type {any} */ (b).text === "See attached"),
    );
  });

  it("returns empty array for unknown message type", async () => {
    const msg = /** @type {any} */ ({
      message: { stickerMessage: {} },
    });
    const content = await getMessageContent(msg);

    assert.equal(content.length, 0);
  });
});

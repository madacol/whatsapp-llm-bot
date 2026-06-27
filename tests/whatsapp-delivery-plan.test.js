import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildWhatsAppContentDeliveryPlan,
  buildWhatsAppEditDeliveryPlan,
} from "../whatsapp/outbound/delivery-plan.js";
import { executeWhatsAppDeliveryPlan } from "../whatsapp/outbound/delivery-plan-executor.js";

/**
 * @param {string} text
 * @returns {string}
 */
function base64(text) {
  return Buffer.from(text).toString("base64");
}

describe("WhatsAppDeliveryPlan", () => {
  it("renders rich send content into deterministic delivery steps before socket execution", async () => {
    const plan = await buildWhatsAppContentDeliveryPlan({
      source: "llm",
      content: [
        { type: "text", text: "hello" },
        { type: "image", encoding: "base64", data: base64("first"), mime_type: "image/png", alt: "first image" },
        { type: "image", encoding: "base64", data: base64("second"), mime_type: "image/png", alt: "second image" },
        { type: "file", encoding: "base64", data: base64("report"), mime_type: "text/plain", file_name: "report.txt" },
      ],
    });

    assert.deepEqual(plan.steps.map((step) => step.kind), ["send_text", "send_album", "send_file"]);
    assert.deepEqual(plan.steps.map((step) => step.id), ["step-1", "step-2", "step-3"]);
    assert.equal(plan.steps[0]?.kind === "send_text" ? plan.steps[0].text : "", "🤖 hello");
    assert.equal(plan.steps[1]?.kind === "send_album" ? plan.steps[1].items.length : 0, 2);
    assert.equal(plan.steps[2]?.kind === "send_file" ? plan.steps[2].fileName : "", "report.txt");
    assert.equal(plan.editableStepId, "step-1");
    assert.equal(plan.editableMessageKind, "text");
  });

  it("executes delivery plans without rebuilding presentation during socket delivery", async () => {
    /** @type {Array<{ chatId: string, msg: Record<string, unknown> }>} */
    const sent = [];
    /** @type {Array<{ chatId: string, msg: Record<string, unknown>, options: Record<string, unknown> }>} */
    const relayed = [];
    const sock = {
      sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg) => {
        sent.push({ chatId, msg });
        return { key: { id: `msg-${sent.length}`, remoteJid: chatId, fromMe: true } };
      },
      relayMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown>} */ options) => {
        relayed.push({ chatId, msg, options });
      },
      waUploadToServer: async () => ({ mediaUrl: "https://example.test/media", directPath: "/direct/path" }),
      user: { id: "bot@s.whatsapp.net" },
    };
    const editPlan = buildWhatsAppEditDeliveryPlan({
      text: "edited caption",
      target: {
        messageKey: { id: "image-msg", remoteJid: "chat-1", fromMe: true },
        messageKind: "image",
      },
    });

    const result = await executeWhatsAppDeliveryPlan(sock, "chat-1", {
      steps: [
        { id: "step-1", kind: "send_text", text: "hello", editable: true },
        ...editPlan.steps,
      ],
      editableStepId: "step-1",
      editableMessageKind: "text",
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.msg.text, "hello");
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0]?.msg.protocolMessage.editedMessage.imageMessage.caption, "edited caption");
    assert.equal(result.lastEditableKey?.id, "msg-1");
    assert.equal(result.lastEditableMessageKind, "text");
  });

  it("keeps presentation planning free of transport execution dependencies", async () => {
    const source = await readFile(new URL("../whatsapp/outbound/delivery-plan.js", import.meta.url), "utf8");
    const forbidden = [
      "@whiskeysockets/baileys",
      "sendMessage",
      "relayMessage",
      "queue-store",
      "persistent-queue",
      "queue-replay",
      "create-whatsapp-transport",
      "reactionRuntime",
      "Store",
    ];

    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `delivery-plan.js should not depend on ${token}`);
    }
  });

  it("routes simple text queue delivery through delivery plans", async () => {
    const durabilitySource = await readFile(new URL("../whatsapp/outbound/durability.js", import.meta.url), "utf8");

    assert.equal(durabilitySource.includes("makeTextMessage"), false, "durable delivery should not build raw text payloads");
    assert.equal(
      durabilitySource.includes("executeWhatsAppDeliveryPlan"),
      true,
      "durable delivery should execute text via WhatsAppDeliveryPlan",
    );
  });
});

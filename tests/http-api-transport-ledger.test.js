import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHttpTransportTurnLedger } from "../http-api-transport-ledger.js";

describe("HTTP API transport turn ledger", () => {
  it("owns request idempotency, active turn lookup, event cursors, and assistant text accumulation", () => {
    const ledger = createHttpTransportTurnLedger({
      createTurnId: () => "turn-1",
      now: () => "2026-06-16T00:00:00.000Z",
      maxEvents: 10,
    });
    const payload = {
      requestId: "request-1",
      chatId: "api:client-1",
      senderIds: ["user-1"],
      senderName: "User",
      timestamp: new Date("2026-06-16T00:00:00.000Z"),
      content: [{ type: "text", text: "hello" }],
      facts: { isGroup: false, addressedToBot: true, repliedToBot: false },
    };

    const first = ledger.createOrGetTurn("voice", payload);
    const duplicate = ledger.createOrGetTurn("voice", payload);

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.turnId, "turn-1");

    ledger.setActiveTurn(payload.chatId, first.record.turnId);
    ledger.appendEvent(payload.chatId, {
      kind: "content",
      source: "llm",
      content: [{ type: "text", text: "Done." }],
    }, ledger.getActiveTurnId(payload.chatId));

    assert.equal(first.record.text, "Done.");
    assert.deepEqual(ledger.listEvents(payload.chatId, 0).map((event) => event.eventId), ["1"]);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHttpApiTurnFlow } from "../http-api-turn-flow.js";

describe("HTTP API turn flow", () => {
  it("owns turn idempotency, active event correlation, assistant text, and stream fanout", async () => {
    const flow = createHttpApiTurnFlow({
      maxEvents: 10,
      createTurnId: () => "turn-1",
      now: () => "2026-06-27T00:00:00.000Z",
    });
    const payload = {
      requestId: "request-1",
      chatId: "api:client-1",
    };

    const first = flow.createOrGetTurn("voice", payload);
    const duplicate = flow.createOrGetTurn("voice", payload);

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.turnId, "turn-1");

    flow.setActiveTurn(payload.chatId, first.record.turnId);
    const io = flow.createChannelInputIo(payload.chatId, first.record.turnId);
    await io.reply({
      kind: "assistant_output",
      content: [{ type: "text", text: "Done." }],
    });

    assert.equal(first.record.text, "Done.");
    assert.equal(flow.getActiveTurnId(payload.chatId), "turn-1");
    assert.deepEqual(flow.listEvents(payload.chatId, 0).map((row) => row.turnId), ["turn-1"]);

    /** @type {ReturnType<typeof flow.listEvents>} */
    const streamed = [];
    const client = flow.openEventStream(payload.chatId, 0, (row) => {
      streamed.push(row);
    });
    await io.send({
      kind: "app_message",
      role: "plain",
      content: "Still here.",
    });
    flow.closeEventStream(client);

    assert.deepEqual(streamed.map((row) => row.eventId), ["1", "2"]);
    assert.equal(flow.getLastEventId(), "2");
  });
});

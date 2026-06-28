import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHttpApiTurnFlow } from "../http-api-turn-flow.js";
import { createHttpApiTurnIntake } from "../http-api-turn-intake.js";

/**
 * @param {string} [requestId]
 * @returns {{
 *   requestId: string,
 *   chatId: string,
 *   senderIds: string[],
 *   senderName: string,
 *   timestamp: Date,
 *   content: IncomingContentBlock[],
 *   facts: ChannelInputFacts,
 * }}
 */
function textPayload(requestId = "request-1") {
  return {
    requestId,
    chatId: "api:client-1",
    senderIds: ["user-1"],
    senderName: "User",
    timestamp: new Date("2026-06-27T00:00:00.000Z"),
    content: [{ type: "text", text: "hello" }],
    facts: { isGroup: false, addressedToBot: true, repliedToBot: false },
  };
}

describe("HTTP API turn intake", () => {
  it("owns wait-mode lifecycle, active correlation, status, and response text", async () => {
    const flow = createHttpApiTurnFlow({
      createTurnId: () => "turn-1",
      now: () => "2026-06-27T00:00:00.000Z",
      maxEvents: 10,
    });
    const intake = createHttpApiTurnIntake({
      turnFlow: flow,
      getBaseUrl: () => "http://127.0.0.1:3200",
      log: { error: () => {} },
    });
    /** @type {{ turn: ChannelInput | null }} */
    const received = { turn: null };

    const response = await intake.submitTurn({
      transportId: "voice",
      payload: textPayload(),
      waitForCompletion: true,
      runTurn: async (turn) => {
        received.turn = turn;
        assert.equal(flow.getActiveTurnId(turn.chatId), "turn-1");
        await turn.io.reply({
          kind: "assistant_output",
          content: [{ type: "text", text: "Done." }],
        });
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      turnId: "turn-1",
      requestId: "request-1",
      status: "completed",
      text: "Done.",
    });
    const receivedTurn = received.turn;
    assert.ok(receivedTurn);
    assert.equal(receivedTurn?.channelId, "api:client-1");
    assert.equal(flow.getActiveTurnId("api:client-1"), null);
  });

  it("does not invoke duplicate request ids twice", async () => {
    const flow = createHttpApiTurnFlow({
      createTurnId: () => "turn-1",
      now: () => "2026-06-27T00:00:00.000Z",
      maxEvents: 10,
    });
    const intake = createHttpApiTurnIntake({
      turnFlow: flow,
      getBaseUrl: () => "",
      log: { error: () => {} },
    });
    let runCount = 0;
    const first = await intake.submitTurn({
      transportId: "voice",
      payload: textPayload("duplicate"),
      waitForCompletion: true,
      runTurn: async () => {
        runCount += 1;
      },
    });
    const duplicate = await intake.submitTurn({
      transportId: "voice",
      payload: textPayload("duplicate"),
      waitForCompletion: true,
      runTurn: async () => {
        runCount += 1;
      },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(first.body.turnId, duplicate.body.turnId);
    assert.equal(runCount, 1);
  });
});

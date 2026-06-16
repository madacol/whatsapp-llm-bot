import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createAcpClientRequestHandler } from "../harnesses/acp-client-request-channel.js";

describe("ACP client request channel", () => {
  it("bridges ACP elicitation requests through the channel interface", async () => {
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const events = [];
    const handler = createAcpClientRequestHandler({
      hooks: {
        onAskUser: () => new Promise(() => {}),
      },
      emitRuntimeEvent: async (event) => {
        events.push(event);
      },
      userInputDecision: async (request) => {
        assert.equal(request.id, "acp-user-input:42");
        assert.deepEqual(request.questions.map((question) => question.id), ["strategy"]);
        return { action: "accept", content: { strategy: "complete" } };
      },
    });

    const result = await handler({
      id: 42,
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Choose strategy",
        requestedSchema: {
          properties: {
            strategy: {
              title: "Strategy",
              enum: ["complete", "decline"],
            },
          },
        },
      },
    });

    assert.deepEqual(result, { action: "accept", content: { strategy: "complete" } });
    assert.deepEqual(events.map((event) => event.type), [
      "user-input.requested",
      "user-input.resolved",
    ]);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAppOutputPort } from "../app-output-port.js";

/**
 * @param {string} transportHandleId
 * @returns {MessageHandle}
 */
function createReplyHandle(transportHandleId) {
  return {
    transportHandleId,
    update: async () => {},
    setInspect: () => {},
  };
}

/**
 * @returns {{
 *   context: ExecuteActionContext,
 *   replies: OutboundEvent[],
 * }}
 */
function createSubject() {
  /** @type {OutboundEvent[]} */
  const replies = [];
  const context = /** @type {ExecuteActionContext} */ ({
    chatId: "chat-1",
    senderIds: [],
    senderJids: [],
    content: [],
    getIsAdmin: async () => true,
    send: async () => undefined,
    reply: async (event) => {
      replies.push(event);
      return createReplyHandle(`reply-${replies.length}`);
    },
    reactToMessage: async () => {},
    select: async () => "",
    selectMany: async () => ({ kind: "cancelled" }),
    confirm: async () => true,
  });
  return { context, replies };
}

describe("createAppOutputPort", () => {
  it("creates app-owned command reply events through semantic methods", async () => {
    const { context, replies } = createSubject();
    const appOutput = createAppOutputPort(context);

    const handle = await appOutput.replyWithToolResult("Command completed.");
    await appOutput.replyWithError("Command failed.");

    assert.deepEqual(replies, [
      {
        kind: "app_message",
        role: "tool_result",
        content: "Command completed.",
      },
      {
        kind: "app_message",
        role: "error",
        content: "Command failed.",
      },
    ]);
    assert.equal(handle?.transportHandleId, "reply-1");
  });

  it("does not expose a generic outbound event creation method", () => {
    const { context } = createSubject();
    const appOutput = createAppOutputPort(context);

    assert.equal("emitOutboundEvent" in appOutput, false);
    assert.equal("runtimeEvent" in appOutput, false);
    assert.equal("contentEvent" in appOutput, false);
  });
});

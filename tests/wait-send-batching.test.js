import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createWaitSendBatchStore,
  parseWaitSendBatchCommandText,
} from "../conversation/wait-send-batching.js";
import { createChannelInput } from "./helpers.js";

describe("wait/send batching", () => {
  it("parses only explicit wait/send batch control commands", () => {
    assert.deepEqual(parseWaitSendBatchCommandText("/wait gather this"), {
      command: "wait",
    });
    assert.deepEqual(parseWaitSendBatchCommandText("/SEND"), {
      command: "send",
    });
    assert.deepEqual(parseWaitSendBatchCommandText("/cancel"), {
      command: "cancel",
    });
    assert.equal(parseWaitSendBatchCommandText("/waiting"), null);
    assert.equal(parseWaitSendBatchCommandText("/sendlater"), null);
    assert.equal(parseWaitSendBatchCommandText("/cancelled"), null);
  });

  it("commits one chat batch without leaking interleaved chat content", () => {
    const batches = createWaitSendBatchStore();
    const first = createChannelInput({
      chatId: "chat-a",
      senderIds: ["a"],
      content: [{ type: "text", text: "/wait" }],
    }).context;
    const second = createChannelInput({
      chatId: "chat-a",
      senderIds: ["a"],
      content: [{ type: "text", text: "second" }],
    }).context;
    const other = createChannelInput({
      chatId: "chat-b",
      senderIds: ["b"],
      content: [{ type: "text", text: "other" }],
    }).context;
    const send = createChannelInput({
      chatId: "chat-a",
      senderIds: ["a"],
      content: [{ type: "text", text: "/send" }],
    }).context;

    batches.startOrAppend(first, []);
    batches.append(second, second.content, "second");

    assert.equal(batches.commit(other, []), null);
    const committed = batches.commit(send, []);

    assert.deepEqual(committed?.turn.content, [{ type: "text", text: "second" }]);
    assert.deepEqual(committed?.turn.senderIds, ["a"]);
    assert.equal(committed?.turn.facts.addressedToBot, true);
    assert.equal(committed?.inputText, "second");
  });

  it("cancels a pending chat batch", () => {
    const batches = createWaitSendBatchStore();
    const first = createChannelInput({
      chatId: "chat-a",
      senderIds: ["a"],
      content: [{ type: "text", text: "/wait" }],
    }).context;
    const second = createChannelInput({
      chatId: "chat-a",
      senderIds: ["a"],
      content: [{ type: "text", text: "second" }],
    }).context;

    batches.startOrAppend(first, []);
    batches.append(second, second.content, "second");

    assert.deepEqual(batches.cancel("chat-a"), { messageCount: 1 });
    assert.equal(batches.commit(first, []), null);
  });
});

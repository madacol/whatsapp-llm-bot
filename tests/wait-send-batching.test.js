import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createWaitSendBatchStore,
  parseWaitSendBatchCommandText,
} from "../conversation/wait-send-batching.js";
import { createChannelInput } from "./helpers.js";

describe("wait/send batching", () => {
  it("parses only explicit /wait and /send commands", () => {
    assert.deepEqual(parseWaitSendBatchCommandText("/wait gather this"), {
      command: "wait",
    });
    assert.deepEqual(parseWaitSendBatchCommandText("/SEND"), {
      command: "send",
    });
    assert.equal(parseWaitSendBatchCommandText("/waiting"), null);
    assert.equal(parseWaitSendBatchCommandText("/sendlater"), null);
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
    batches.append(second, second.content);

    assert.equal(batches.commit(other, []), null);
    const committed = batches.commit(send, []);

    assert.deepEqual(committed?.content, [{ type: "text", text: "second" }]);
    assert.deepEqual(committed?.senderIds, ["a"]);
    assert.equal(committed?.facts.addressedToBot, true);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentEvent, fileChangeEvent, textUpdate } from "../outbound-events.js";
import { createSeedTurnIo } from "../conversation/seed-turn-io.js";

describe("seed turn io", () => {
  it("preserves semantic outbound events and returns transport handles when supported", async () => {
    /** @type {OutboundEvent[]} */
    const events = [];
    /** @type {MessageHandleUpdate[]} */
    const updates = [];
    /** @type {MessageInspectState[]} */
    const inspects = [];
    /** @type {MessageHandle} */
    const handle = {
      keyId: "seed-msg-1",
      isImage: false,
      update: async (update) => {
        updates.push(update);
      },
      setInspect: (inspect) => {
        if (inspect) {
          inspects.push(inspect);
        }
      },
    };

    const io = createSeedTurnIo({
      chatId: "workspace-chat",
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {
          assert.fail("sendText should not be used when transport.sendEvent is available");
        },
        sendEvent: async (_chatId, event) => {
          events.push(event);
          return handle;
        },
      },
    });

    const contentHandle = await io.reply(contentEvent("llm", [{ type: "text", text: "Thinking..." }]));
    assert.equal(contentHandle, handle);

    const fileHandle = await io.send(fileChangeEvent({
      path: "/repo/app.js",
      diff: "@@ -1 +1 @@\n-old\n+new",
      oldText: "old\n",
      newText: "new\n",
    }));
    assert.equal(fileHandle, handle);

    await fileHandle?.update(textUpdate("Thought"));
    fileHandle?.setInspect({ kind: "text", text: "full inspect text", persistOnInspect: true });

    assert.deepEqual(events, [
      contentEvent("llm", [{ type: "text", text: "Thinking..." }]),
      fileChangeEvent({
        path: "/repo/app.js",
        diff: "@@ -1 +1 @@\n-old\n+new",
        oldText: "old\n",
        newText: "new\n",
      }),
    ]);
    assert.deepEqual(updates, [{ kind: "text", text: "Thought" }]);
    assert.deepEqual(inspects, [{ kind: "text", text: "full inspect text", persistOnInspect: true }]);
  });

  it("falls back to plain text when the transport does not support semantic events", async () => {
    /** @type {Array<{ chatId: string, text: string }>} */
    const sentTexts = [];
    const io = createSeedTurnIo({
      chatId: "workspace-chat",
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async (chatId, text) => {
          sentTexts.push({ chatId, text });
        },
      },
    });

    const handle = await io.reply(fileChangeEvent({
      path: "/repo/app.js",
      summary: "Changed file",
    }));

    assert.equal(handle, undefined);
    assert.deepEqual(sentTexts, [{
      chatId: "workspace-chat",
      text: "🔧 Changed file",
    }]);
  });
});

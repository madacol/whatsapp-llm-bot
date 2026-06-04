import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAcpRuntimeModel } from "../harnesses/acp-events.js";
import { createHarnessRuntimeEventDispatcher } from "../harnesses/harness-runtime-event-dispatcher.js";
import { buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";
import { sendEvent } from "../whatsapp/outbound/send-content.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";

process.env.TESTING = "1";

/**
 * @returns {{
 *   sock: {
 *     sendMessage: (chatId: string, msg: Record<string, unknown>) => Promise<{ key: { id: string, remoteJid: string, fromMe: true } }>,
 *     relayMessage: (chatId: string, msg: Record<string, unknown>, opts: Record<string, unknown>) => Promise<void>,
 *     waUploadToServer: () => Promise<{ mediaUrl: string, directPath: string }>,
 *     user: { id: string },
 *   },
 *   sent: Array<{ chatId: string, msg: Record<string, unknown> }>,
 *   relayed: Array<{ chatId: string, msg: Record<string, unknown>, opts: Record<string, unknown> }>,
 * }}
 */
function createMockSock() {
  /** @type {Array<{ chatId: string, msg: Record<string, unknown> }>} */
  const sent = [];
  /** @type {Array<{ chatId: string, msg: Record<string, unknown>, opts: Record<string, unknown> }>} */
  const relayed = [];
  return {
    sent,
    relayed,
    sock: {
      sendMessage: async (chatId, msg) => {
        sent.push({ chatId, msg });
        return { key: { id: `msg-${sent.length}`, remoteJid: chatId, fromMe: true } };
      },
      relayMessage: async (chatId, msg, opts) => {
        relayed.push({ chatId, msg, opts });
      },
      waUploadToServer: async () => ({
        mediaUrl: "https://example.test/media",
        directPath: "/direct/path",
      }),
      user: { id: "test-user@s.whatsapp.net" },
    },
  };
}

/**
 * @param {Record<string, unknown>[]} payloads
 * @returns {Promise<{
 *   sent: Array<{ chatId: string, msg: Record<string, unknown> }>,
 *   runtimeEvents: Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>,
 * }>}
 */
async function observeAcpReadPayloadsThroughBaileys(payloads) {
  const chatId = "acp-read-presentation@s.whatsapp.net";
  const cwd = "/home/mada/whatsapp-llm-bot";
  const { sock, sent } = createMockSock();
  /** @type {Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>} */
  const runtimeEvents = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (event) => sendEvent(sock, chatId, event, undefined, undefined, {
        outputVisibility: DEFAULT_OUTPUT_VISIBILITY,
      }),
      reply: async (event) => sendEvent(sock, chatId, event, undefined, undefined, {
        outputVisibility: DEFAULT_OUTPUT_VISIBILITY,
      }),
      select: async () => "",
      confirm: async () => true,
    },
    cwd,
    DEFAULT_OUTPUT_VISIBILITY,
  );
  const dispatcher = createHarnessRuntimeEventDispatcher({
    provider: "acp",
    messages: [],
    hooks,
    workdir: cwd,
  });
  const model = createAcpRuntimeModel();

  for (const payload of payloads) {
    const events = model.acceptSessionUpdate(payload);
    runtimeEvents.push(...events);
    for (const event of events) {
      await dispatcher.handleEvent(event);
    }
  }

  return { sent, runtimeEvents };
}

/**
 * @param {Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>} events
 * @returns {Promise<{
 *   sent: Array<{ chatId: string, msg: Record<string, unknown> }>,
 *   outboundEvents: SendContent[],
 * }>}
 */
async function observeRuntimeReadEventsThroughBaileys(events) {
  const chatId = "runtime-read-presentation@s.whatsapp.net";
  const cwd = "/home/mada/whatsapp-llm-bot";
  const { sock, sent } = createMockSock();
  /** @type {SendContent[]} */
  const outboundEvents = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (event) => {
        outboundEvents.push(event);
        return sendEvent(sock, chatId, event, undefined, undefined, {
          outputVisibility: DEFAULT_OUTPUT_VISIBILITY,
        });
      },
      reply: async (event) => {
        outboundEvents.push(event);
        return sendEvent(sock, chatId, event, undefined, undefined, {
          outputVisibility: DEFAULT_OUTPUT_VISIBILITY,
        });
      },
      select: async () => "",
      confirm: async () => true,
    },
    cwd,
    DEFAULT_OUTPUT_VISIBILITY,
  );
  const dispatcher = createHarnessRuntimeEventDispatcher({
    provider: "acp",
    messages: [],
    hooks,
    workdir: cwd,
  });

  for (const event of events) {
    await dispatcher.handleEvent(event);
  }

  return { sent, outboundEvents };
}

describe("ACP read presentation vertical slice", () => {
  it("edits a live-shaped ACP read payload to completed Read text through Baileys", async () => {
    const chatId = "acp-read-presentation@s.whatsapp.net";
    const toolCallId = "call_live_read_shape";
    const { sent, runtimeEvents } = await observeAcpReadPayloadsThroughBaileys([
      {
        sessionId: "019e8e35-df8f-7f51-ace2-06b3f2d1f9d5",
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          status: "in_progress",
          kind: "read",
          title: "Read file",
          locations: [
            { path: "/home/mada/whatsapp-llm-bot/whatsapp/outbound/send-content.js" },
          ],
        },
      },
      {
        sessionId: "019e8e35-df8f-7f51-ace2-06b3f2d1f9d5",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          rawOutput: {
            formatted_output: "import { makeTextMessage } from \"../message-payloads.js\";\n",
            exit_code: 0,
          },
          _meta: {
            terminal_exit: {
              exit_code: 0,
              signal: null,
              terminal_id: toolCallId,
            },
          },
        },
      },
    ]);

    assert.deepEqual(runtimeEvents.map((event) => event.type), ["tool.started", "tool.completed"]);
    assert.deepEqual(sent.map((entry) => entry.chatId), [chatId, chatId]);
    assert.deepEqual(sent.map((entry) => entry.msg), [
      {
        text: "🔧 *Read*  `whatsapp/outbound/send-content.js`",
        linkPreview: null,
      },
      {
        text: "✅ *Read*  `whatsapp/outbound/send-content.js`",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("adds a line range when ACP read completion output includes line numbers", async () => {
    const chatId = "acp-read-presentation@s.whatsapp.net";
    const toolCallId = "call_line_numbered_read";
    const { sent, runtimeEvents } = await observeAcpReadPayloadsThroughBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          status: "in_progress",
          kind: "read",
          title: "Read file",
          locations: [
            { path: "/home/mada/whatsapp-llm-bot/src/app.js" },
          ],
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          rawOutput: {
            formatted_output: [
              "    10→function start() {",
              "    11→  return true;",
              "    12→}",
            ].join("\n"),
          },
        },
      },
    ]);

    assert.deepEqual(runtimeEvents.map((event) => event.type), ["tool.started", "tool.completed"]);
    assert.deepEqual(sent.map((entry) => entry.chatId), [chatId, chatId]);
    assert.deepEqual(sent.map((entry) => entry.msg), [
      {
        text: "🔧 *Read*  `src/app.js`",
        linkPreview: null,
      },
      {
        text: "✅ *Read*  `src/app.js`  *10-12*",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
  });

});

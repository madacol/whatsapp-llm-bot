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
async function observeAcpExecutePayloadsThroughBaileys(payloads) {
  const chatId = "acp-execute-presentation@s.whatsapp.net";
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
 * @param {string} toolCallId
 * @param {string} command
 * @returns {Record<string, unknown>}
 */
function createLoggedExecutePayload(toolCallId, command) {
  const cwd = "/home/mada/whatsapp-llm-bot";
  return {
    sessionId: "019e8e35-df8f-7f51-ace2-06b3f2d1f9d5",
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      status: "in_progress",
      kind: "execute",
      title: command,
      content: [{ type: "terminal", terminalId: toolCallId }],
      rawInput: { command, cwd },
      _meta: {
        terminal_info: {
          cwd,
          terminal_id: toolCallId,
        },
      },
    },
  };
}

describe("ACP execute presentation vertical slice", () => {
  it("renders logged ACP execute payloads as Shell rows through Baileys", async () => {
    const commands = [
      "git diff --check -- snapshot-ignore.txt harnesses/acp-file-changes.js tests/acp-file-changes.test.js",
      "git diff -- snapshot-ignore.txt harnesses/acp-file-changes.js tests/acp-file-changes.test.js",
      "git status --short",
    ];
    const { sent, runtimeEvents } = await observeAcpExecutePayloadsThroughBaileys(
      commands.map((command, index) => createLoggedExecutePayload(`call_logged_${index + 1}`, command)),
    );

    assert.deepEqual(runtimeEvents.map((event) => event.type), [
      "tool.started",
      "tool.started",
      "tool.started",
    ]);
    const renderedText = sent.map((entry) => String(entry.msg.text ?? "")).join("\n");
    for (const command of commands) {
      assert.ok(
        renderedText.includes(`🔧 *Shell*  \`${command}\``),
        `Expected Shell row for ${command}\n\nRendered:\n${renderedText}`,
      );
    }
    assert.equal(renderedText.includes("✅ git diff -- snapshot-ignore.txt"), false);
    assert.equal(renderedText.includes("✅ git status --short"), false);
  });

  it("preserves Shell row formatting when execute updates omit command input", async () => {
    const toolCallId = "call_execute_update";
    const command = "git status --short";
    const { sent, runtimeEvents } = await observeAcpExecutePayloadsThroughBaileys([
      createLoggedExecutePayload(toolCallId, command),
      {
        sessionId: "019e8e35-df8f-7f51-ace2-06b3f2d1f9d5",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          rawOutput: {
            formatted_output: " M tests/acp-execute-presentation-vertical.test.js\n",
          },
        },
      },
    ]);

    assert.deepEqual(runtimeEvents.map((event) => event.type), [
      "tool.started",
      "tool.updated",
    ]);
    const renderedText = sent.map((entry) => String(entry.msg.text ?? "")).join("\n");
    assert.equal(renderedText, `🔧 *Shell*  \`${command}\``);
    assert.equal(renderedText.includes("🔧 *git status --short*"), false);
  });
});

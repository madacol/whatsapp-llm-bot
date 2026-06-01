import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpHarness } from "../harnesses/acp.js";
import { createAcpRuntimeModel } from "../harnesses/acp-events.js";
import { createHarnessRuntimeEventDispatcher } from "../harnesses/harness-runtime-event-dispatcher.js";
import { buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";
import { sendEvent } from "../whatsapp/outbound/send-content.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";

process.env.TESTING = "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @returns {{
 *   sock: {
 *     sendMessage: (chatId: string, msg: Record<string, unknown>) => Promise<{ key: { id: string, remoteJid: string } }>,
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
  const sock = {
    sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg) => {
      sent.push({ chatId, msg });
      return { key: { id: `msg-${sent.length}`, remoteJid: chatId } };
    },
    relayMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown>} */ opts) => {
      relayed.push({ chatId, msg, opts });
    },
    waUploadToServer: async () => ({
      mediaUrl: "https://example.test/media",
      directPath: "/direct/path",
    }),
    user: { id: "test-user@s.whatsapp.net" },
  };
  return { sock, sent, relayed };
}

/**
 * @param {{
 *   sock: ReturnType<typeof createMockSock>["sock"],
 *   chatId: string,
 *   cwd: string | null,
 *   visibility: import("../chat-output-visibility.js").OutputVisibility,
 *   outboundEvents: Array<{ via: "send" | "reply", event: SendContent }>,
 * }} input
 * @returns {AgentIOHooks}
 */
function buildObservedWhatsAppHooks(input) {
  return buildAgentIoHooks(
    {
      send: async (event) => {
        input.outboundEvents.push({ via: "send", event });
        return sendEvent(input.sock, input.chatId, event, undefined, undefined, { outputVisibility: input.visibility });
      },
      reply: async (event) => {
        input.outboundEvents.push({ via: "reply", event });
        return sendEvent(input.sock, input.chatId, event, undefined, undefined, { outputVisibility: input.visibility });
      },
      select: async () => "",
      confirm: async () => true,
    },
    input.cwd,
    input.visibility,
  );
}

/**
 * @param {Record<string, unknown>[]} payloads
 * @param {{ chatId?: string, cwd?: string | null, visibility?: import("../chat-output-visibility.js").OutputVisibility }} [options]
 * @returns {Promise<{
 *   sent: Array<{ chatId: string, msg: Record<string, unknown> }>,
 *   relayed: Array<{ chatId: string, msg: Record<string, unknown>, opts: Record<string, unknown> }>,
 *   trace: {
 *     acpPayloads: Record<string, unknown>[],
 *     runtimeEvents: Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>,
 *     outboundEvents: Array<{ via: "send" | "reply", event: SendContent }>,
 *   },
 * }>}
 */
async function observeAcpPayloadSliceToBaileys(payloads, options = {}) {
  const chatId = options.chatId ?? `acp-payload-${Date.now()}@s.whatsapp.net`;
  const cwd = options.cwd ?? "/repo";
  const { sock, sent, relayed } = createMockSock();
  /** @type {Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>} */
  const runtimeEvents = [];
  /** @type {Array<{ via: "send" | "reply", event: SendContent }>} */
  const outboundEvents = [];
  const model = createAcpRuntimeModel();
  const hooks = buildObservedWhatsAppHooks({
    sock,
    chatId,
    cwd,
    visibility: options.visibility ?? DEFAULT_OUTPUT_VISIBILITY,
    outboundEvents,
  });
  const dispatcher = createHarnessRuntimeEventDispatcher({
    provider: "acp",
    messages: [],
    hooks,
    workdir: cwd,
  });

  for (const payload of payloads) {
    const events = model.acceptSessionUpdate(payload);
    runtimeEvents.push(...events);
    for (const event of events) {
      await dispatcher.handleEvent(event);
    }
  }
  const flushedEvents = model.flushAssistantSegment();
  runtimeEvents.push(...flushedEvents);
  for (const event of flushedEvents) {
    await dispatcher.handleEvent(event);
  }
  return {
    sent,
    relayed,
    trace: {
      acpPayloads: payloads,
      runtimeEvents,
      outboundEvents,
    },
  };
}

/**
 * @returns {Promise<{
 *   result: AgentResult,
 *   sent: Array<{ chatId: string, msg: Record<string, unknown> }>,
 *   relayed: Array<{ chatId: string, msg: Record<string, unknown>, opts: Record<string, unknown> }>,
 *   trace: {
 *     adapterEvents: Array<{ type: string, provider: string } & Record<string, unknown>>,
 *     outboundEvents: Array<{ via: "send" | "reply", event: SendContent }>,
 *   },
 * }>}
 */
async function runAcpMockProcessToWhatsApp() {
  const chatId = "acp-process-smoke@s.whatsapp.net";
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-process-smoke-"));
  const { sock, sent, relayed } = createMockSock();
  /** @type {Array<{ type: string, provider: string } & Record<string, unknown>>} */
  const adapterEvents = [];
  /** @type {Array<{ via: "send" | "reply", event: SendContent }>} */
  const outboundEvents = [];
  const hooks = buildObservedWhatsAppHooks({
    sock,
    chatId,
    cwd: workdir,
    visibility: { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true, usage: true },
    outboundEvents,
  });
  const dispatcher = createHarnessRuntimeEventDispatcher({
    provider: "acp",
    messages: [],
    hooks,
    workdir,
  });
  let eventQueue = Promise.resolve();
  const harness = createAcpHarness({
    name: "acp-process-smoke",
    config: {
      command: process.execPath,
      args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
    },
  });
  const adapter = harness.createAdapter?.({
    name: "acp-process-smoke",
    instanceId: "smoke",
    continuationKey: "acp-process-smoke:smoke",
  });
  assert.ok(adapter);
  const unsubscribe = adapter.subscribeEvents?.((event) => {
    adapterEvents.push(event);
    eventQueue = eventQueue.then(() => dispatcher.handleEvent(
      /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent} */ (event),
    ));
  });
  try {
    await adapter.startSession({ chatId, runConfig: { workdir } });
    const result = await adapter.sendTurn({
      chatId,
      input: "Run the mock",
      messages: [{ role: "user", content: [{ type: "text", text: "Run the mock" }] }],
      runConfig: { workdir },
    });
    await eventQueue;
    return {
      result,
      sent,
      relayed,
      trace: { adapterEvents, outboundEvents },
    };
  } finally {
    unsubscribe?.();
    await adapter.stopAll();
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

describe("ACP payload to WhatsApp socket vertical slices", () => {
  it("renders raw ACP tool lifecycle payloads as compact Baileys messages by default", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "toolu-review",
          title: "Review mock code",
          kind: "think",
          rawInput: {
            prompt: "Check the adapter boundary",
            subagent_type: "reviewer",
          },
          status: "in_progress",
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "toolu-review",
          status: "completed",
          content: [{ type: "text", text: "No issues found." }],
        },
      },
    ], { chatId: "acp-payload-tool@s.whatsapp.net" });

    assert.deepEqual(trace.acpPayloads.map((payload) => payload.update?.sessionUpdate), ["tool_call", "tool_call_update"]);
    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started", "tool.completed"]);
    assert.deepEqual(trace.outboundEvents.map((entry) => [entry.via, entry.event.kind]), [
      ["send", "runtime_event"],
      ["send", "runtime_event"],
    ]);
    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Task*  Review mock code", linkPreview: null },
      {
        text: "✅ *Task*  Review mock code",
        edit: { id: "msg-1", remoteJid: "acp-payload-tool@s.whatsapp.net", fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("renders raw ACP assistant, plan, diff, and usage payloads through Baileys", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Main result." },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Inspect payload", status: "completed" },
            { content: "Render WhatsApp output", status: "in_progress" },
          ],
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-1",
          title: "Edited app.js",
          status: "completed",
          content: [{
            type: "diff",
            path: "/repo/app.js",
            oldText: "old\n",
            newText: "new\n",
          }],
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "usage_update",
          input_tokens: 10,
          output_tokens: 4,
          cached_tokens: 2,
          cost: { amount: 0.0012, currency: "USD" },
        },
      },
    ], {
      chatId: "acp-payload-mixed@s.whatsapp.net",
      visibility: { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true },
    });

    const texts = sent.map((entry) => typeof entry.msg.text === "string" ? entry.msg.text : "");

    assert.deepEqual(trace.acpPayloads.map((payload) => payload.update?.sessionUpdate), [
      "agent_message_chunk",
      "plan",
      "tool_call_update",
      "usage_update",
    ]);
    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "item.started",
      "content.delta",
      "item.completed",
      "plan.updated",
      "tool.completed",
      "file-change.completed",
      "usage.updated",
    ]);
    assert.deepEqual(trace.outboundEvents.map((entry) => [entry.via, entry.event.kind]), [
      ["send", "runtime_event"],
      ["reply", "content"],
      ["reply", "plan"],
      ["send", "runtime_event"],
      ["send", "runtime_event"],
      ["send", "usage"],
    ]);
    assert.ok(texts.some((text) => text === "🤖 Main result."), `Expected assistant text, got ${JSON.stringify(sent)}`);
    assert.ok(texts.some((text) => text.includes("_Plan_") && text.includes("Inspect payload")), `Expected plan text, got ${JSON.stringify(sent)}`);
    assert.ok(sent.some((entry) => Buffer.isBuffer(entry.msg.image)
      && String(entry.msg.caption ?? "").includes("🔧 *Update*  `app.js`")
      && String(entry.msg.caption ?? "").includes("Edited app.js")), `Expected diff image, got ${JSON.stringify(sent)}`);
    assert.ok(texts.some((text) => text.includes("📊 Cost: 0.001200")), `Expected usage text, got ${JSON.stringify(sent)}`);
  });

  it("suppresses ACP editing placeholders and renders the completed diff through Baileys", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit-1",
          title: "Editing files",
          status: "in_progress",
          rawInput: {},
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-1",
          status: "completed",
          content: [{
            type: "diff",
            path: "/repo/src/app.js",
            oldText: "before\n",
            newText: "after\n",
            diff: [
              "--- a/src/app.js",
              "+++ b/src/app.js",
              "@@ -1 +1 @@",
              "-before",
              "+after",
            ].join("\n"),
          }],
        },
      },
    ], { chatId: "acp-payload-editing-placeholder@s.whatsapp.net" });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "tool.started",
      "tool.completed",
      "file-change.completed",
    ]);
    assert.deepEqual(trace.outboundEvents.map((entry) => entry.event.kind), [
      "runtime_event",
      "runtime_event",
      "runtime_event",
    ]);
    assert.equal(sent.length, 1, JSON.stringify(sent));
    assert.equal(sent[0]?.msg.caption, "🔧 *Update*  `src/app.js`", JSON.stringify(sent));
  });

  it("collapses only consecutive ACP tool progress before starting a new Baileys message", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read-1",
          title: "Read",
          status: "in_progress",
          rawInput: { file_path: "src/app.js" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "search-1",
          title: "Search",
          kind: "search",
          status: "in_progress",
          rawInput: { path: "src", pattern: "needle" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "Inspect output", status: "in_progress" }],
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "web-1",
          title: "WebSearch",
          status: "in_progress",
          rawInput: { query: "runtime migration" },
        },
      },
    ], { chatId: "acp-payload-consecutive-tools@s.whatsapp.net" });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "tool.started",
      "tool.started",
      "plan.updated",
      "tool.started",
    ]);

    const textMessages = sent.map((entry) => entry.msg);
    assert.equal(textMessages[0]?.text, "🔧 *Read*  `src/app.js`");
    const flushedMessages = sent.map((entry) => entry.msg);
    assert.equal(flushedMessages[1]?.edit?.id, "msg-1", JSON.stringify(flushedMessages));
    assert.ok(
      typeof flushedMessages[1]?.text === "string"
        && flushedMessages[1].text.includes("🔧 *Read*  `src/app.js`")
        && flushedMessages[1].text.includes("🔧 *Search*  `needle` in *src*"),
      `Expected consecutive tools to collapse into one edited message, got ${JSON.stringify(flushedMessages)}`,
    );
    assert.ok(
      typeof flushedMessages[2]?.text === "string" && flushedMessages[2].text.includes("_Plan_"),
      `Expected plan after compact close, got ${JSON.stringify(flushedMessages)}`,
    );
    assert.equal(flushedMessages[3]?.text, "🔧 *Search Web*  \"runtime migration\"");
    assert.equal(flushedMessages[3]?.edit, undefined);
  });

  it("renders ACP read tool locations in compact WhatsApp progress", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read-real-shape",
          title: "Read file",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/repo/src/app.js" }],
        },
      },
    ], {
      chatId: "acp-payload-read-location@s.whatsapp.net",
      workdir: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started"]);
    assert.equal(sent[0]?.msg.text, "🔧 *Read*  `src/app.js`");
  });

  it("keeps ACP read line ranges from raw tool input in compact WhatsApp progress", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read-real-shape-range",
          title: "Read file",
          kind: "read",
          status: "in_progress",
          rawInput: {
            path: "/repo/src/app.js",
            line: 10,
            limit: 3,
          },
          locations: [{ path: "/repo/src/app.js" }],
        },
      },
    ], {
      chatId: "acp-payload-read-location-range@s.whatsapp.net",
      workdir: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started"]);
    assert.equal(sent[0]?.msg.text, "🔧 *Read*  `src/app.js`  *10-12*");
  });

  it("adds ACP read line ranges from completed raw output", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read-range",
          title: "Read file",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/repo/src/app.js" }],
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "read-range",
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
    ], {
      chatId: "acp-payload-read-range@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started", "tool.completed"]);
    assert.equal(sent[0]?.msg.text, "🔧 *Read*  `src/app.js`");
    assert.equal(sent[1]?.msg.text, "✅ *Read*  `src/app.js`  *10-12*");
  });

  it("renders ACP search titles from raw WhatsApp payloads", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "search-real-shape",
          title: "Search for 'toolDetails|compact_tool_activity' in whatsapp-transport.test.js",
          kind: "search",
          status: "in_progress",
        },
      },
    ], {
      chatId: "acp-payload-search-title@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started"]);
    assert.equal(sent[0]?.msg.text, "🔧 *Search*  `toolDetails|compact_tool_activity` in *whatsapp-transport.test.js*");
  });

  it("renders Codex ACP web search actions from raw WhatsApp payloads", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "web-search-real-shape",
          title: "Web search: runtime migration",
          kind: "search",
          status: "completed",
          rawInput: {
            query: "runtime migration",
            action: {
              type: "search",
              query: "runtime migration",
              queries: ["runtime migration"],
            },
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "web-open-real-shape",
          title: "Open page: https://example.com/docs",
          kind: "search",
          status: "completed",
          rawInput: {
            query: "https://example.com/docs",
            action: {
              type: "openPage",
              url: "https://example.com/docs",
            },
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "web-find-real-shape",
          title: "Find in page for 'install' in https://example.com/docs",
          kind: "search",
          status: "completed",
          rawInput: {
            action: {
              type: "findInPage",
              pattern: "install",
              url: "https://example.com/docs",
            },
          },
        },
      },
    ], {
      chatId: "acp-payload-web-actions@s.whatsapp.net",
      cwd: "/repo",
      visibility: { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true },
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "tool.completed",
      "tool.completed",
      "tool.completed",
    ]);
    assert.equal(sent[0]?.msg.text, "✅ *Search Web*  \"runtime migration\"");
    assert.equal(sent[1]?.msg.text, "✅ *Open Link*  `example.com/docs`");
    assert.equal(sent[2]?.msg.text, "✅ *Find On Page*  \"install\" in `example.com/docs`");
  });

  it("renders ACP list-file titles with the listed path", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "list-real-shape",
          title: "List files in '.env'",
          kind: "read",
          status: "in_progress",
        },
      },
    ], {
      chatId: "acp-payload-list-title@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started"]);
    assert.equal(sent[0]?.msg.text, "🔧 *List*  `.env`");
  });

  it("renders ACP execute commands from raw WhatsApp payloads", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "execute-real-shape",
          title: "pnpm type-check",
          kind: "execute",
          status: "in_progress",
          rawInput: {
            command: "pnpm type-check",
            cwd: "/repo",
          },
        },
      },
    ], {
      chatId: "acp-payload-execute-command@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started"]);
    assert.equal(sent[0]?.msg.text, "🔧 *Shell*  `pnpm type-check`");
  });

  it("prefixes the tool call instead of sending Guardian approval review text", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "approved-command",
          title: "pnpm type-check",
          kind: "execute",
          status: "in_progress",
          rawInput: {
            command: "pnpm type-check",
            cwd: "/repo",
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Guardian warning: Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.\n\n",
          },
        },
      },
    ], {
      chatId: "acp-payload-guardian-approval@s.whatsapp.net",
      cwd: "/repo",
      visibility: { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true },
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "tool.started",
      "item.started",
      "content.delta",
      "item.completed",
    ]);
    assert.equal(sent[0]?.msg.text, "🔧 *Shell*  `pnpm type-check`");
    assert.equal(sent[1]?.msg.text, "👍 🔧 *Shell*  `pnpm type-check`");
    assert.equal(sent[1]?.msg.edit?.id, "msg-1");
    assert.equal(sent.some((entry) => String(entry.msg.text ?? "").includes("Guardian warning")), false);
  });

  it("prefixes the tool call with a denial emoji for denied Guardian approval reviews", async () => {
    const { sent } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "denied-command",
          title: "rm -rf actions",
          kind: "execute",
          status: "in_progress",
          rawInput: {
            command: "rm -rf actions",
            cwd: "/repo",
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Guardian warning: Automatic approval review denied (risk: high, authorization: low): This action is too broad.\n\n",
          },
        },
      },
    ], {
      chatId: "acp-payload-guardian-denial@s.whatsapp.net",
      cwd: "/repo",
      visibility: { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true },
    });

    assert.equal(sent[1]?.msg.text, "👎 🔧 *Shell*  `rm -rf actions`");
    assert.equal(sent[1]?.msg.edit?.id, "msg-1");
    assert.equal(sent.some((entry) => String(entry.msg.text ?? "").includes("Guardian warning")), false);
  });

  it("keeps Guardian prefixes when compact tool calls complete or fail", async () => {
    const approved = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "approved-compact-command",
          title: "pnpm type-check",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "pnpm type-check", cwd: "/repo" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Guardian warning: Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.\n\n",
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "approved-compact-command",
          status: "completed",
          rawOutput: { formatted_output: "ok\n" },
        },
      },
    ], {
      chatId: "acp-payload-guardian-compact-approved@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.equal(approved.sent[0]?.msg.text, "🔧 *Shell*  `pnpm type-check`");
    assert.equal(approved.sent[1]?.msg.text, "👍 🔧 *Shell*  `pnpm type-check`");
    assert.equal(approved.sent[2]?.msg.text, "👍 ✅ *Shell*  `pnpm type-check`");

    const denied = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "denied-compact-command",
          title: "rm -rf actions",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "rm -rf actions", cwd: "/repo" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Guardian warning: Automatic approval review denied (risk: high, authorization: low): This action is too broad.\n\n",
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "denied-compact-command",
          status: "failed",
          rawOutput: { formatted_output: "blocked\n" },
        },
      },
    ], {
      chatId: "acp-payload-guardian-compact-denied@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.equal(denied.sent[0]?.msg.text, "🔧 *Shell*  `rm -rf actions`");
    assert.equal(denied.sent[1]?.msg.text, "👎 🔧 *Shell*  `rm -rf actions`");
    assert.equal(denied.sent[2]?.msg.text, "👎 ❌ *Shell*  `rm -rf actions`");
  });

  it("smoke-tests a real ACP mock process through adapter events into Baileys output", async () => {
    const { result, sent, trace } = await runAcpMockProcessToWhatsApp();
    const eventTypes = trace.adapterEvents.map((event) => event.type);
    const outboundKinds = trace.outboundEvents.map((entry) => entry.event.kind);
    const texts = sent.map((entry) => typeof entry.msg.text === "string" ? entry.msg.text : "");

    assert.deepEqual(result.response, [{ type: "markdown", text: "Main result." }]);
    assert.ok(eventTypes.includes("plan.updated"), `Expected plan.updated in ${JSON.stringify(eventTypes)}`);
    assert.ok(eventTypes.includes("tool.started"), `Expected tool.started in ${JSON.stringify(eventTypes)}`);
    assert.ok(eventTypes.includes("subagent.completed"), `Expected subagent.completed in ${JSON.stringify(eventTypes)}`);
    assert.ok(eventTypes.includes("file-change.completed"), `Expected file-change.completed in ${JSON.stringify(eventTypes)}`);
    assert.ok(eventTypes.includes("usage.updated"), `Expected usage.updated in ${JSON.stringify(eventTypes)}`);
    assert.ok(outboundKinds.includes("plan"), `Expected plan outbound event in ${JSON.stringify(outboundKinds)}`);
    assert.ok(outboundKinds.includes("subagent_message"), `Expected subagent outbound event in ${JSON.stringify(outboundKinds)}`);
    // File changes cross the runtime/outbound boundary as runtime events; sendEvent owns
    // turning that runtime event into the final Baileys message shape.
    assert.ok(
      trace.outboundEvents.some((entry) => entry.event.kind === "runtime_event" && entry.event.event.type === "file-change.completed"),
      `Expected file-change.completed runtime outbound event in ${JSON.stringify(outboundKinds)}`,
    );
    assert.ok(outboundKinds.includes("usage"), `Expected usage outbound event in ${JSON.stringify(outboundKinds)}`);
    assert.ok(texts.some((text) => text.includes("Main result.")), `Expected assistant socket output, got ${JSON.stringify(sent)}`);
    assert.ok(texts.some((text) => text.includes("Subagent result.")), `Expected subagent socket output, got ${JSON.stringify(sent)}`);
    assert.ok(texts.some((text) => text.includes("mock.txt")), `Expected file-change socket output, got ${JSON.stringify(sent)}`);
    assert.ok(texts.some((text) => text.includes("Cost:")), `Expected usage socket output, got ${JSON.stringify(sent)}`);
  });
});

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
import { createReactionRuntime } from "../whatsapp/runtime/reaction-runtime.js";

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
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}

/**
 * @param {{
 *   sock: ReturnType<typeof createMockSock>["sock"],
 *   chatId: string,
 *   cwd: string | null,
 *   visibility: import("../chat-output-visibility.js").OutputVisibility,
 *   outboundEvents: Array<{ via: "send" | "reply", event: SendContent }>,
 *   pinnedStatusDelivery: Array<Record<string, unknown>>,
 *   reactionRuntime?: import("../whatsapp/runtime/reaction-runtime.js").ReactionRuntime,
 * }} input
 * @returns {AgentIOHooks}
 */
function buildObservedWhatsAppHooks(input) {
  return buildAgentIoHooks(
    {
      send: async (event) => {
        input.outboundEvents.push({ via: "send", event });
        return sendEvent(input.sock, input.chatId, event, undefined, input.reactionRuntime, {
          outputVisibility: input.visibility,
          pinnedStatusDeliveryObserver: (deliveryEvent) => {
            input.pinnedStatusDelivery.push(deliveryEvent);
          },
        });
      },
      reply: async (event) => {
        input.outboundEvents.push({ via: "reply", event });
        return sendEvent(input.sock, input.chatId, event, undefined, input.reactionRuntime, {
          outputVisibility: input.visibility,
          pinnedStatusDeliveryObserver: (deliveryEvent) => {
            input.pinnedStatusDelivery.push(deliveryEvent);
          },
        });
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
 * @param {{ chatId?: string, cwd?: string | null, visibility?: import("../chat-output-visibility.js").OutputVisibility, beforeEvents?: Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>, enableInspectReactions?: boolean }} [options]
 * @returns {Promise<{
 *   sent: Array<{ chatId: string, msg: Record<string, unknown> }>,
 *   relayed: Array<{ chatId: string, msg: Record<string, unknown>, opts: Record<string, unknown> }>,
 *   trace: {
 *     acpPayloads: Record<string, unknown>[],
 *     runtimeEvents: Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>,
 *     outboundEvents: Array<{ via: "send" | "reply", event: SendContent }>,
 *     pinnedStatusDelivery: Array<Record<string, unknown>>,
 *   },
 * }>}
 */
async function observeAcpPayloadSliceToBaileys(payloads, options = {}) {
  const chatId = options.chatId ?? `acp-payload-${Date.now()}@s.whatsapp.net`;
  const cwd = options.cwd ?? "/repo";
  const { sock, sent, relayed } = createMockSock();
  const reactionRuntime = options.enableInspectReactions ? createReactionRuntime() : undefined;
  /** @type {Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>} */
  const runtimeEvents = [];
  /** @type {Array<{ via: "send" | "reply", event: SendContent }>} */
  const outboundEvents = [];
  /** @type {Array<Record<string, unknown>>} */
  const pinnedStatusDelivery = [];
  const model = createAcpRuntimeModel();
  const hooks = buildObservedWhatsAppHooks({
    sock,
    chatId,
    cwd,
    visibility: options.visibility ?? DEFAULT_OUTPUT_VISIBILITY,
    outboundEvents,
    pinnedStatusDelivery,
    reactionRuntime,
  });
  const dispatcher = createHarnessRuntimeEventDispatcher({
    provider: "acp",
    messages: [],
    hooks,
    workdir: cwd,
  });

  for (const event of options.beforeEvents ?? []) {
    runtimeEvents.push(event);
    await dispatcher.handleEvent(event);
  }

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
      pinnedStatusDelivery,
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
 *     pinnedStatusDelivery: Array<Record<string, unknown>>,
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
  /** @type {Array<Record<string, unknown>>} */
  const pinnedStatusDelivery = [];
  const hooks = buildObservedWhatsAppHooks({
    sock,
    chatId,
    cwd: workdir,
    visibility: { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true, usage: true },
    outboundEvents,
    pinnedStatusDelivery,
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
      trace: { adapterEvents, outboundEvents, pinnedStatusDelivery },
    };
  } finally {
    unsubscribe?.();
    await adapter.stopAll();
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

describe("ACP payload to WhatsApp socket vertical slices", () => {
  it("renders Codex terminal interaction payloads as stdin rows", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "terminal-interaction:stdin-command-1",
          kind: "other",
          title: "stdin",
          status: "completed",
          rawInput: {
            stdin: "yes\n",
            payload: {
              threadId: "fake-thread-1",
              turnId: "fake-turn-1",
              itemId: "stdin-command-1",
              processId: "65440",
              stdin: "yes\n",
            },
            itemId: "stdin-command-1",
          },
        },
      },
    ]);

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.completed"]);
    assert.equal(String(sent[0]?.msg.text ?? ""), "✅ *stdin*  \"yes\\n\"");
  });

  it("does not render stdin payloads when stdin text is empty", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "terminal-interaction:stdin-command-1",
          kind: "other",
          title: "stdin",
          status: "completed",
          rawInput: {
            stdin: "",
            payload: {
              itemId: "stdin-command-1",
              input: "yes\n",
            },
          },
        },
      },
    ]);

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.completed"]);
    assert.equal(sent.length, 0, JSON.stringify(sent));
  });

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

  it("does not finalize assistant text chunks around long-running ACP tool updates", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "test-run",
          title: "pnpm test",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "pnpm test", cwd: "/repo" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The full " },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "test-run",
          status: "in_progress",
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "test runner is underway. I'll keep monitoring it " },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "test-run",
          status: "completed",
          rawOutput: { formatted_output: "ok\n" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "and report any failures with the exact failing test names." },
        },
      },
    ], {
      chatId: "acp-payload-long-running-tool@s.whatsapp.net",
      cwd: "/repo",
      visibility: { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true },
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "tool.started",
      "item.started",
      "content.delta",
      "tool.updated",
      "content.delta",
      "tool.completed",
      "content.delta",
      "item.completed",
    ]);
    assert.deepEqual(
      sent.map((entry) => entry.msg.text).filter((text) => typeof text === "string" && text.startsWith("🤖")),
      ["🤖 The full test runner is underway. I'll keep monitoring it and report any failures with the exact failing test names."],
    );
  });

  it("shows thinking in pinned status when an ACP thought chunk arrives", async () => {
    const chatId = "acp-payload-thinking-status@s.whatsapp.net";
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Inspecting the request." },
        },
      },
    ], {
      chatId,
      beforeEvents: [{
        type: "turn.started",
        provider: "acp",
        turn: { id: "turn-1", chatId, status: "started" },
      }],
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "turn.started",
      "reasoning.updated",
    ]);
    assert.equal(sent[2]?.msg.text, "💭 *LLM*  thinking");
    assert.deepEqual(trace.pinnedStatusDelivery.map((event) => [
      event.type,
      event.chatId,
      event.messageId,
      event.firstLine,
    ]), [
      ["status.created", chatId, "msg-1", "🔄 *ACP*  turn started"],
      ["pin.succeeded", chatId, "msg-1", undefined],
      ["status.edited", chatId, "msg-1", "💭 *LLM*  thinking"],
    ]);
  });

  it("makes the standalone thinking message inspectable when the assistant item completes", async () => {
    const chatId = "acp-payload-thinking-inspect@s.whatsapp.net";
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Inspecting the request." },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done." },
        },
      },
    ], {
      chatId,
      enableInspectReactions: true,
      beforeEvents: [{
        type: "turn.started",
        provider: "acp",
        turn: { id: "turn-1", chatId, status: "started" },
      }],
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "turn.started",
      "reasoning.updated",
      "item.started",
      "content.delta",
      "item.completed",
    ]);
    const thinkingMessageIndex = sent.findIndex((entry) => entry.msg.text === "🤖 Thinking...");
    assert.notEqual(thinkingMessageIndex, -1, `Expected standalone Thinking message, got ${JSON.stringify(sent)}`);
    const thinkingMessageId = `msg-${thinkingMessageIndex + 1}`;

    await waitFor(() => sent.some((entry) => {
      const react = /** @type {{ text?: unknown, key?: { id?: unknown } } | undefined} */ (entry.msg.react);
      return react?.text === "👁" && react.key?.id === thinkingMessageId;
    }));
  });

  it("updates or ignores pinned status intentionally for real ACP session update shapes", async () => {
    const chatId = "acp-real-status-shapes@s.whatsapp.net";
    const cwd = "/repo";
    const sessionId = "real-session-shape-audit";
    const { sock, sent } = createMockSock();
    /** @type {Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>} */
    const runtimeEvents = [];
    /** @type {Array<{ via: "send" | "reply", event: SendContent }>} */
    const outboundEvents = [];
    /** @type {Array<Record<string, unknown>>} */
    const pinnedStatusDelivery = [];
    const model = createAcpRuntimeModel();
    const hooks = buildObservedWhatsAppHooks({
      sock,
      chatId,
      cwd,
      visibility: { ...DEFAULT_OUTPUT_VISIBILITY, usage: true },
      outboundEvents,
      pinnedStatusDelivery,
    });
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks,
      workdir: cwd,
    });

    /**
     * @returns {string[]}
     */
    function pinnedStatusTexts() {
      const pinEntry = sent.find((entry) => entry.msg.pin && typeof entry.msg.pin === "object" && entry.msg.type === 1);
      const pinnedId = pinEntry && typeof pinEntry.msg.pin === "object"
        ? /** @type {{ id?: unknown }} */ (pinEntry.msg.pin).id
        : null;
      assert.equal(typeof pinnedId, "string", `Expected pinned status payload, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);
      return sent
        .filter((entry, index) => {
          if (typeof entry.msg.text !== "string") {
            return false;
          }
          if (`msg-${index + 1}` === pinnedId) {
            return true;
          }
          return typeof entry.msg.edit === "object"
            && entry.msg.edit !== null
            && /** @type {{ id?: unknown }} */ (entry.msg.edit).id === pinnedId;
        })
        .map((entry) => /** @type {string} */ (entry.msg.text));
    }

    /**
     * @param {Record<string, unknown>} update
     * @returns {Promise<{ eventTypes: string[], pinnedText: string }>}
     */
    async function sendAcpUpdate(update) {
      const events = model.acceptSessionUpdate({ sessionId, update });
      runtimeEvents.push(...events);
      for (const event of events) {
        await dispatcher.handleEvent(event);
      }
      return {
        eventTypes: events.map((event) => event.type),
        pinnedText: pinnedStatusTexts().at(-1) ?? "",
      };
    }

    await dispatcher.handleEvent({
      type: "turn.started",
      provider: "acp",
      turn: { id: "turn-1", chatId, status: "started" },
    });
    assert.equal(pinnedStatusTexts().at(-1), "🔄 *ACP*  turn started");

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "continue", description: "Continue" }],
    }), {
      eventTypes: [],
      pinnedText: "🔄 *ACP*  turn started",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Main result." },
    }), {
      eventTypes: ["item.started", "content.delta"],
      pinnedText: "🔄 *ACP*  turn started",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Inspecting status inputs" },
    }), {
      eventTypes: ["item.completed", "reasoning.updated"],
      pinnedText: "💭 *LLM*  thinking",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "plan",
      entries: [{ status: "in_progress", content: "Inspect execute update presentation path" }],
    }), {
      eventTypes: ["plan.updated"],
      pinnedText: "📋 *PLAN*  *Plan*  _Working on: Inspect execute update presentation path_",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "real-search-1",
      status: "in_progress",
      kind: "search",
      title: "Search",
      rawInput: { pattern: "pin|pinned", path: "tests" },
    }), {
      eventTypes: ["tool.started"],
      pinnedText: "📋 *PLAN*  *Plan*  _Working on: Inspect execute update presentation path_",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "real-search-1",
      status: "completed",
      rawOutput: { formatted_output: "tests/sendBlocks.test.js", exit_code: 0 },
    }), {
      eventTypes: ["tool.completed"],
      pinnedText: "📋 *PLAN*  *Plan*  _Working on: Inspect execute update presentation path_",
    });
    assert.ok(sent.some((entry) => entry.msg.text === "🔧 *Search*  `pin|pinned` in *tests*"), `Expected visible Search start row, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);
    assert.ok(sent.some((entry) => entry.msg.text === "✅ *Search*  `pin|pinned` in *tests*"), `Expected visible Search completion row, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "model_rerouted",
      fromModel: "model-a",
      toModel: "model-b",
      reason: "capacity",
    }), {
      eventTypes: ["model.rerouted"],
      pinnedText: "🔀 *ACP*  model model-a -> model-b",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "config_warning",
      summary: "Config fallback active",
      details: "mock config warning",
    }), {
      eventTypes: ["config.warning"],
      pinnedText: "⚠️ *ACP*  Config fallback active",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "runtime_warning",
      message: "Runtime warning sample",
      details: "mock runtime warning",
    }), {
      eventTypes: ["runtime.warning"],
      pinnedText: "⚠️ *ACP*  Runtime warning sample",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "runtime_error",
      message: "Runtime error sample",
      details: "mock runtime error",
    }), {
      eventTypes: ["runtime.error"],
      pinnedText: "❌ *ACP*  Runtime error sample",
    });

    assert.deepEqual(await sendAcpUpdate({
      sessionUpdate: "usage_update",
      input_tokens: 10,
      output_tokens: 4,
      cached_tokens: 2,
      cost: { amount: 0.0012, currency: "USD" },
    }), {
      eventTypes: ["usage.updated"],
      pinnedText: "📊 *USAGE*  cost 0.001200",
    });
  });

  it("renders pinned status for real ACP request-method runtime events through Baileys", async () => {
    const chatId = "acp-real-request-status-shapes@s.whatsapp.net";
    const cwd = "/repo";
    const { sock, sent } = createMockSock();

    /**
     * @returns {string[]}
     */
    function pinnedStatusTexts() {
      const pinEntry = sent.find((entry) => entry.msg.pin && typeof entry.msg.pin === "object" && entry.msg.type === 1);
      const pinnedId = pinEntry && typeof pinEntry.msg.pin === "object"
        ? /** @type {{ id?: unknown }} */ (pinEntry.msg.pin).id
        : null;
      assert.equal(typeof pinnedId, "string", `Expected pinned status payload, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);
      return sent
        .filter((entry, index) => {
          if (typeof entry.msg.text !== "string") {
            return false;
          }
          if (`msg-${index + 1}` === pinnedId) {
            return true;
          }
          return typeof entry.msg.edit === "object"
            && entry.msg.edit !== null
            && /** @type {{ id?: unknown }} */ (entry.msg.edit).id === pinnedId;
        })
        .map((entry) => /** @type {string} */ (entry.msg.text));
    }

    /**
     * @param {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent} event
     * @returns {Promise<string>}
     */
    async function sendRuntimeEvent(event) {
      await sendEvent(sock, chatId, {
        kind: "runtime_event",
        cwd,
        event,
      });
      return pinnedStatusTexts().at(-1) ?? "";
    }

    assert.equal(await sendRuntimeEvent({
      type: "turn.started",
      provider: "acp",
      turn: { id: "turn-1", chatId, status: "started" },
    }), "🔄 *ACP*  turn started");

    assert.equal(await sendRuntimeEvent({
      type: "request.opened",
      provider: "acp",
      request: {
        id: "acp-request:1",
        kind: "tool-user-input",
        summary: "Sensitive mock operation",
      },
    }), "⏳ *ACP*  approval needed: Sensitive mock operation");

    assert.equal(await sendRuntimeEvent({
      type: "request.resolved",
      provider: "acp",
      request: {
        id: "acp-request:1",
        kind: "tool-user-input",
        summary: "selected:allow-once",
      },
    }), "✅ *ACP*  approval resolved: Sensitive mock operation");

    assert.equal(await sendRuntimeEvent({
      type: "user-input.requested",
      provider: "acp",
      request: {
        id: "acp-user-input:2",
        questions: [{
          id: "strategy",
          question: "Migration Strategy",
          options: [{ label: "Conservative" }, { label: "Complete" }],
        }],
      },
    }), "⏳ *ACP*  input needed: Migration Strategy");

    assert.equal(await sendRuntimeEvent({
      type: "user-input.resolved",
      provider: "acp",
      request: {
        id: "acp-user-input:2",
        questions: [{
          id: "strategy",
          question: "Migration Strategy",
          options: [{ label: "Conservative" }, { label: "Complete" }],
        }],
      },
    }), "✅ *ACP*  input resolved: Migration Strategy");

    assert.equal(await sendRuntimeEvent({
      type: "command.started",
      provider: "acp",
      command: {
        command: "node -e process.stdout.write('terminal ok')",
        status: "started",
      },
    }), "✅ *ACP*  input resolved: Migration Strategy");

    assert.equal(await sendRuntimeEvent({
      type: "command.completed",
      provider: "acp",
      command: {
        command: "node -e process.stdout.write('terminal ok')",
        status: "completed",
      },
    }), "✅ *ACP*  input resolved: Migration Strategy");
    assert.ok(sent.some((entry) => entry.msg.text === "🔧 *Shell*  `node -e process.stdout.write('terminal ok')`"), `Expected visible Shell start row, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);
    assert.ok(sent.some((entry) => entry.msg.text === "✅ *Shell*  `node -e process.stdout.write('terminal ok')`"), `Expected visible Shell completion row, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);

    assert.equal(await sendRuntimeEvent({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: "/repo/acp-fs-write.txt",
        kind: "update",
        source: "direct-write",
        cwd,
      },
    }), "📝 *File*  `acp-fs-write.txt`");
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

  it("renders ACP tool progress as normal concise messages around non-tool updates", async () => {
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

    const flushedMessages = sent.map((entry) => entry.msg);
    assert.equal(flushedMessages[0]?.text, "🔧 *Read*  `src/app.js`", JSON.stringify(flushedMessages));
    assert.equal(flushedMessages[1]?.text, "🔧 *Search*  `needle` in *src*", JSON.stringify(flushedMessages));
    assert.ok(
      typeof flushedMessages[2]?.text === "string" && flushedMessages[2].text.includes("_Plan_"),
      `Expected plan after compact close, got ${JSON.stringify(flushedMessages)}`,
    );
    assert.equal(flushedMessages[3]?.text, "🔧 *Web search*  \"runtime migration\"");
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

  it("renders Codex ACP read line ranges from locations and metadata", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "codex-read-range",
          title: "Read sample-lines.txt",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/repo/sample-lines.txt", line: 10 }],
          rawInput: {
            commandAction: {
              type: "read",
              command: "sed -n '10,12p' sample-lines.txt",
              name: "sample-lines.txt",
              path: "/repo/sample-lines.txt",
            },
          },
          _meta: {
            codex: {
              lineRange: { start: 10, end: 12 },
            },
          },
        },
      },
    ], {
      chatId: "acp-payload-codex-read-location-range@s.whatsapp.net",
      workdir: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started"]);
    assert.equal(sent[0]?.msg.text, "🔧 *Read*  `sample-lines.txt`  *10-12*");
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

  it("keeps real ACP read payloads out of pinned status while rendering compact read activity", async () => {
    const chatId = "acp-payload-pinned-read@s.whatsapp.net";
    const toolCallId = "call_wp7MciriXBhbVOsDFY4b60pj";
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "019e8e35-df8f-7f51-ace2-06b3f2d1f9d5",
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          status: "in_progress",
          kind: "read",
          title: "Read file",
          locations: [{ path: "/repo/src/app.js" }],
        },
      },
      {
        sessionId: "019e8e35-df8f-7f51-ace2-06b3f2d1f9d5",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          _meta: {
            terminal_output_delta: {
              data: "    10→function start() {\n",
              terminal_id: toolCallId,
            },
          },
        },
      },
      {
        sessionId: "019e8e35-df8f-7f51-ace2-06b3f2d1f9d5",
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
    ], {
      chatId,
      cwd: "/repo",
      beforeEvents: [{
        type: "turn.started",
        provider: "acp",
        turn: { id: "turn-1", chatId, status: "started" },
      }],
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "turn.started",
      "tool.started",
      "tool.updated",
      "tool.completed",
    ]);
    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *ACP*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 86400,
      },
      { text: "🔧 *Read*  `src/app.js`", linkPreview: null },
      {
        text: "✅ *Read*  `src/app.js`  *10-12*",
        edit: { id: "msg-3", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
    assert.deepEqual(trace.pinnedStatusDelivery.map((event) => [
      event.type,
      event.chatId,
      event.messageId,
      event.firstLine,
      event.error,
    ]), [
      ["status.created", chatId, "msg-1", "🔄 *ACP*  turn started", undefined],
      ["pin.succeeded", chatId, "msg-1", undefined, undefined],
    ]);
  });

  it("keeps ACP read location details when a sparse completion edits the row", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read-sparse-completion",
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
          toolCallId: "read-sparse-completion",
          status: "completed",
          rawOutput: { formatted_output: "const app = true;\n" },
        },
      },
    ], {
      chatId: "acp-payload-read-sparse-completion@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started", "tool.completed"]);
    assert.equal(sent[0]?.msg.text, "🔧 *Read*  `src/app.js`");
    assert.equal(sent[1]?.msg.text, "✅ *Read*  `src/app.js`");
  });

  it("renders semantic ACP search tool payloads", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "search-real-shape",
          title: "Search for 'toolDetails|compact_tool_activity' in whatsapp-transport.test.js",
          kind: "search",
          status: "in_progress",
          rawInput: {
            pattern: "toolDetails|compact_tool_activity",
            path: "whatsapp-transport.test.js",
          },
        },
      },
    ], {
      chatId: "acp-payload-search-title@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started"]);
    assert.deepEqual(trace.runtimeEvents[0]?.tool, {
      id: "search-real-shape",
      name: "Search",
      arguments: {
        pattern: "toolDetails|compact_tool_activity",
        path: "whatsapp-transport.test.js",
      },
    });
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
              type: "open_page",
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
              type: "find_in_page",
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
    assert.equal(sent[0]?.msg.text, "✅ *Search*  \"runtime migration\"");
    assert.equal(sent[1]?.msg.text, "✅ *Open*  `example.com/docs`");
    assert.equal(sent[2]?.msg.text, "✅ *Find*  \"install\" in `example.com/docs`");
  });

  it("renders live Codex ACP webSearch update actions from raw WhatsApp payloads", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "live-web-search",
          kind: "search",
          title: "Web search",
          rawInput: {
            query: "",
            action: { type: "other" },
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "live-web-search",
          rawInput: {
            query: "OpenAI official website",
            action: {
              type: "search",
              query: "OpenAI official website",
              queries: ["OpenAI official website"],
            },
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "live-web-open",
          kind: "search",
          title: "Web search",
          rawInput: {
            query: "",
            action: { type: "other" },
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "live-web-open",
          rawInput: {
            query: "https://openai.com/",
            action: {
              type: "openPage",
              url: "https://openai.com/",
            },
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "live-web-find",
          kind: "search",
          title: "Web search",
          rawInput: {
            query: "",
            action: { type: "other" },
          },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "live-web-find",
          rawInput: {
            query: "'Codex' in https://openai.com/",
            action: {
              type: "findInPage",
              url: "https://openai.com/",
              pattern: "Codex",
            },
          },
        },
      },
    ], {
      chatId: "acp-payload-live-web-actions@s.whatsapp.net",
      cwd: "/repo",
      visibility: { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true },
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), [
      "tool.started",
      "tool.updated",
      "tool.started",
      "tool.updated",
      "tool.started",
      "tool.updated",
    ]);
    const renderedTexts = sent.map((entry) => entry.msg.text);
    assert.ok(
      renderedTexts.includes("🔧 *Web*"),
      JSON.stringify(renderedTexts),
    );
    assert.ok(
      renderedTexts.includes("🔧 *Search*  \"OpenAI official website\""),
      JSON.stringify(renderedTexts),
    );
    assert.ok(
      renderedTexts.includes("🔧 *Open*  `openai.com`"),
      JSON.stringify(renderedTexts),
    );
    assert.ok(
      renderedTexts.includes("🔧 *Find*  \"Codex\" in `openai.com`"),
      JSON.stringify(renderedTexts),
    );
  });

  it("renders ACP list-file locations with the listed path", async () => {
    const { sent, trace } = await observeAcpPayloadSliceToBaileys([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "list-real-shape",
          title: "List files",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/repo/.env" }],
        },
      },
    ], {
      chatId: "acp-payload-list-location@s.whatsapp.net",
      cwd: "/repo",
    });

    assert.deepEqual(trace.runtimeEvents.map((event) => event.type), ["tool.started"]);
    assert.equal(sent[0]?.msg.text, "🔧 *List*  `.env`", JSON.stringify(sent));
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

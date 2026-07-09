import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb } from "./helpers.js";
import { setDb } from "../db.js";
import { createReactionRuntime } from "../whatsapp/runtime/reaction-runtime.js";
import { appMessageEvent, runtimeEvent } from "../outbound-events.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";
import { createPlanPresentationFromState } from "../plan-presentation.js";
import { createRuntimeDiagnosticsState } from "../diagnostics-config.js";
import { createFixtureCapture, setDefaultFixtureCaptureForTesting } from "../diagnostics/capture.js";
import { createAcpRuntimeModel } from "../harnesses/acp-events.js";
import { MAX_RENDERED_IMAGES_PER_BLOCK } from "../message-renderer.js";

/** @type {import("../chat-output-visibility.js").OutputVisibility} */
const VISIBLE_TOOL_OUTPUT = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "fullDetails" };
/** @type {import("../chat-output-visibility.js").OutputVisibility} */
const COMPACT_TOOL_OUTPUT = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" };

/**
 * @param {Omit<FileChangeEvent, "kind" | "changeKind"> & { changeKind?: "add" | "delete" | "update" }} input
 * @returns {RuntimeEventOutboundEvent}
 */
function runtimeFileChangeEvent(input) {
  const { changeKind, ...rest } = input;
  return runtimeEvent({
    type: "file-change.completed",
    provider: "codex",
    change: {
      ...rest,
      ...(changeKind !== undefined && { kind: changeKind }),
    },
  });
}

/** @type {typeof import("../whatsapp/outbound/send-content.js").sendBlocks} */
let sendBlocks;
/** @type {typeof import("../whatsapp/outbound/send-content.js").sendEvent} */
let sendEvent;
/** @type {typeof import("../whatsapp/outbound/send-content.js").editWhatsAppMessage} */
let editWhatsAppMessage;
/** @type {typeof import("../whatsapp/outbound/send-content.js").editWhatsAppMessageByHandle} */
let editWhatsAppMessageByHandle;
/** @type {typeof import("../whatsapp/outbound/send-content.js").renderFileChangeContent} */
let renderFileChangeContent;

before(async () => {
  const testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
  const outbound = await import("../whatsapp/outbound/send-content.js");
  sendBlocks = outbound.sendBlocks;
  sendEvent = outbound.sendEvent;
  editWhatsAppMessage = outbound.editWhatsAppMessage;
  editWhatsAppMessageByHandle = outbound.editWhatsAppMessageByHandle;
  renderFileChangeContent = outbound.renderFileChangeContent;
});

/**
 * Create a mock socket that captures sent messages.
 * @returns {{
 *   sock: {
 *     sendMessage: (chatId: string, msg: Record<string, unknown>) => Promise<{ key: { id: string, remoteJid: string } }>,
 *     relayMessage: (chatId: string, msg: Record<string, unknown>, opts: Record<string, unknown>) => Promise<void>,
 *     waUploadToServer: (filePath: string, options: Record<string, unknown>) => Promise<{ mediaUrl: string, directPath: string }>,
 *     user: { id: string },
 *   },
 *   sent: Array<{ chatId: string; msg: Record<string, unknown> }>,
 *   relayed: Array<{ chatId: string; msg: Record<string, unknown>; opts: Record<string, unknown> }>,
 * }}
 */
function createMockSock() {
  /** @type {Array<{ chatId: string; msg: Record<string, unknown> }>} */
  const sent = [];
  /** @type {Array<{ chatId: string; msg: Record<string, unknown>; opts: Record<string, unknown> }>} */
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
 * @param {string} filePath
 * @returns {Promise<any[]>}
 */
async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for condition");
}

/**
 * @param {number} [linePairs]
 * @returns {string}
 */
function buildMultiBatchDiffText(linePairs = 320) {
  const diffLines = [`@@ -1,${linePairs} +1,${linePairs} @@`];
  for (let index = 0; index < linePairs; index += 1) {
    diffLines.push(`-const oldValue${index} = ${index};`);
    diffLines.push(`+const newValue${index} = ${index + 1};`);
  }
  return diffLines.join("\n");
}

describe("sendEvent – sub-agent messages", () => {
  it("renders sub-agent messages with their own header", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "test-chat", {
      kind: "subagent_message",
      text: "SUBAGENT_VISIBLE_TEST: hello from the spawned sub-agent.",
      agentNickname: "Mill",
      agentRole: "worker",
    });

    assert.equal(sent.length, 1);
    assert.equal(
      sent[0]?.msg.text,
      "🧩 *Sub-agent Mill*\n_worker_\nSUBAGENT_VISIBLE_TEST: hello from the spawned sub-agent.",
    );
  });
});

describe("sendEvent – runtime events", () => {
  it("renders ACP tool runtime progress inside WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-tool-chat", {
      kind: "runtime_event",
      event: {
        type: "tool.started",
        provider: "acp",
        tool: {
          id: "tool-1",
          name: "Task",
          arguments: { title: "Review mock code" },
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });
    await sendEvent(sock, "runtime-tool-chat", {
      kind: "runtime_event",
      event: {
        type: "tool.completed",
        provider: "acp",
        tool: {
          id: "tool-1",
          name: "Task",
          arguments: { title: "Review mock code" },
          output: "done",
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Task*  Review mock code", linkPreview: null },
      {
        text: "✅ *Task*  Review mock code",
        edit: { id: "msg-1", remoteJid: "runtime-tool-chat", fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("renders runtime tool progress as concise tool messages", async () => {
    const { sock, sent } = createMockSock();
    const baseTool = {
      id: "tool-compact-1",
      name: "Grep",
      arguments: { path: "src", pattern: "needle" },
    };

    await sendEvent(sock, "compact-runtime-tool-chat", {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.started",
        provider: "codex",
        tool: baseTool,
      },
    }, undefined, undefined, { outputVisibility: COMPACT_TOOL_OUTPUT });
    await sendEvent(sock, "compact-runtime-tool-chat", {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.updated",
        provider: "codex",
        tool: {
          ...baseTool,
          output: "in progress",
        },
      },
    }, undefined, undefined, { outputVisibility: COMPACT_TOOL_OUTPUT });
    await sendEvent(sock, "compact-runtime-tool-chat", {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.completed",
        provider: "codex",
        tool: {
          ...baseTool,
          output: "done",
        },
      },
    }, undefined, undefined, { outputVisibility: COMPACT_TOOL_OUTPUT });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Search*  `needle` in *src*", linkPreview: null },
      {
        text: "✅ *Search*  `needle` in *src*",
        edit: { id: "msg-1", remoteJid: "compact-runtime-tool-chat", fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("keeps an already-started standalone tool message when tools switch to pinned mid-item", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-tool-live-visibility-chat";
    const baseTool = {
      id: "tool-live-visibility-1",
      name: "Grep",
      arguments: { path: "src", pattern: "needle" },
    };

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.started",
        provider: "codex",
        tool: baseTool,
      },
    }, undefined, undefined, { outputVisibility: COMPACT_TOOL_OUTPUT });
    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.completed",
        provider: "codex",
        tool: {
          ...baseTool,
          output: "done",
        },
      },
    }, undefined, undefined, { outputVisibility: { ...DEFAULT_OUTPUT_VISIBILITY, tools: "pinnedIndicator" } });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Search*  `needle` in *src*", linkPreview: null },
      {
        text: "✅ *Search*  `needle` in *src*",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("keeps the started write-tool path when completion only changes the status icon", async () => {
    const { sock, sent } = createMockSock();
    const startedTool = {
      id: "write-tool-path",
      name: "Write",
      arguments: { file_path: "/home/mada/project/settings.json", content: "{}\n" },
    };

    await sendEvent(sock, "runtime-write-tool-chat", {
      kind: "runtime_event",
      event: {
        type: "tool.started",
        provider: "codex",
        tool: startedTool,
      },
    });
    await sendEvent(sock, "runtime-write-tool-chat", {
      kind: "runtime_event",
      cwd: "/home/mada/project",
      event: {
        type: "tool.completed",
        provider: "codex",
        tool: {
          id: "write-tool-path",
          name: "Write",
          arguments: { file_path: "settings.json", content: "{}\n" },
        },
      },
    });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 Writing `/home/mada/project/settings.json`", linkPreview: null },
      {
        text: "✅ Writing `/home/mada/project/settings.json`",
        edit: { id: "msg-1", remoteJid: "runtime-write-tool-chat", fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("suppresses low-signal ACP editing-files placeholders and renders the file-change diff instead", async () => {
    const { sock, sent } = createMockSock();
    const placeholder = {
      id: "editing-files-placeholder",
      name: "Editing files",
      arguments: {},
    };

    await sendEvent(sock, "compact-runtime-editing-files-chat", {
      kind: "runtime_event",
      cwd: "/tmp",
      event: {
        type: "tool.started",
        provider: "acp",
        tool: placeholder,
      },
    }, undefined, undefined, { outputVisibility: COMPACT_TOOL_OUTPUT });
    await sendEvent(sock, "compact-runtime-editing-files-chat", {
      kind: "runtime_event",
      cwd: "/tmp",
      event: {
        type: "tool.completed",
        provider: "acp",
        tool: placeholder,
      },
    }, undefined, undefined, { outputVisibility: COMPACT_TOOL_OUTPUT });
    await sendEvent(sock, "compact-runtime-editing-files-chat", {
      kind: "runtime_event",
      cwd: "/tmp",
      event: {
        type: "file-change.completed",
        provider: "acp",
        change: {
          path: "/tmp/src/app.js",
          cwd: "/tmp",
          source: "tool",
          kind: "update",
          summary: "Editing files",
          oldText: "before\n",
          newText: "after\n",
          diff: [
            "--- a/src/app.js",
            "+++ b/src/app.js",
            "@@ -1 +1 @@",
            "-before",
            "+after",
          ].join("\n"),
        },
      },
    }, undefined, undefined, { outputVisibility: COMPACT_TOOL_OUTPUT });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.msg.caption, "🔧 *Update*  `src/app.js`");
  });

  it("renders ACP runtime tool progress with semantic tool labels", async () => {
    const cases = [
      {
        name: "Read",
        args: { file_path: "src/app.js" },
        expected: "Read*  `src/app.js`",
      },
      {
        name: "Grep",
        args: { path: "src", pattern: "needle" },
        expected: "Search*  `needle` in *src*",
      },
      {
        name: "Search",
        args: { path: "src", pattern: "needle" },
        expected: "Search*  `needle` in *src*",
      },
      {
        name: "WebSearch",
        args: { query: "runtime migration" },
        expected: "Web search*  \"runtime migration\"",
      },
      {
        name: "spawn_agent",
        args: { message: "Review migration" },
        expected: "Start Agent*  _Review migration_",
      },
      {
        name: "parallel",
        args: { tool_uses: [{ recipient_name: "functions.exec_command" }, { recipient_name: "functions.exec_command" }] },
        expected: "Run Parallel*  _2 tools_",
      },
      {
        name: "open",
        args: { open: [{ ref_id: "https://openai.com" }] },
        expected: "Open*  `openai.com`",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { sock, sent } = createMockSock();
      const tool = {
        id: `runtime-semantic-tool-${index}`,
        name: testCase.name,
        arguments: testCase.args,
      };

      await sendEvent(sock, `runtime-semantic-tool-${index}`, {
        kind: "runtime_event",
        cwd: "/repo",
        event: {
          type: "tool.started",
          provider: "acp",
          tool,
        },
      }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });
      await sendEvent(sock, `runtime-semantic-tool-${index}`, {
        kind: "runtime_event",
        cwd: "/repo",
        event: {
          type: "tool.completed",
          provider: "acp",
          tool,
        },
      }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

      assert.equal(sent[0]?.msg.text, `🔧 *${testCase.expected}`);
      assert.equal(sent[1]?.msg.text, `✅ *${testCase.expected}`);
    }
  });

  it("renders generic fallback details for unrecognized runtime tools", async () => {
    const { sock, sent } = createMockSock();
    const tool = {
      id: "runtime-generic-tool-1",
      name: "mass_rename",
      arguments: {
        replacements: [{ from: "old-name", to: "new-name" }],
        dry_run: false,
      },
    };

    await sendEvent(sock, "runtime-generic-tool-chat", {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.started",
        provider: "acp",
        tool,
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });
    await sendEvent(sock, "runtime-generic-tool-chat", {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.completed",
        provider: "acp",
        tool,
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    assert.deepEqual(sent.map((entry) => entry.msg.text), [
      '🔧 *mass_rename*\nreplacements: [{"from":"old-name","to":"new-name"}], dry_run: false',
      '✅ *mass_rename*\nreplacements: [{"from":"old-name","to":"new-name"}], dry_run: false',
    ]);
  });

  it("renders ACP command runtime progress inside WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-command-chat", {
      kind: "runtime_event",
      event: {
        type: "command.started",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "started",
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });
    await sendEvent(sock, "runtime-command-chat", {
      kind: "runtime_event",
      event: {
        type: "command.completed",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "completed",
          output: "ok",
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Shell*  `pnpm type-check`", linkPreview: null },
      {
        text: "✅ *Shell*  `pnpm type-check`",
        edit: { id: "msg-1", remoteJid: "runtime-command-chat", fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("keeps an already-started standalone command message when tools switch to pinned mid-command", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-command-live-visibility-chat";

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.started",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "started",
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });
    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.completed",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "completed",
          output: "ok",
        },
      },
    }, undefined, undefined, { outputVisibility: { ...DEFAULT_OUTPUT_VISIBILITY, tools: "pinnedIndicator" } });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Shell*  `pnpm type-check`", linkPreview: null },
      {
        text: "✅ *Shell*  `pnpm type-check`",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("reuses the pending ACP command runtime message for duplicate starts", async () => {
    const { sock, sent } = createMockSock();
    const startEvent = /** @type {RuntimeEventOutboundEvent} */ ({
      kind: "runtime_event",
      event: {
        type: "command.started",
        provider: "acp",
        command: {
          command: "pnpm test tests/vertical/whatsapp-adapter-e2e.test.js",
          status: "started",
        },
      },
    });

    await sendEvent(sock, "runtime-command-duplicate-chat", startEvent, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });
    await sendEvent(sock, "runtime-command-duplicate-chat", startEvent, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });
    await sendEvent(sock, "runtime-command-duplicate-chat", {
      kind: "runtime_event",
      event: {
        type: "command.completed",
        provider: "acp",
        command: {
          command: "pnpm test tests/vertical/whatsapp-adapter-e2e.test.js",
          status: "completed",
          output: "ok",
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Shell*  `pnpm test tests/vertical/whatsapp-adapter-e2e.test.js`", linkPreview: null },
      {
        text: "✅ *Shell*  `pnpm test tests/vertical/whatsapp-adapter-e2e.test.js`",
        edit: { id: "msg-1", remoteJid: "runtime-command-duplicate-chat", fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("renders ACP file-change runtime events inside WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-file-change-chat", {
      kind: "runtime_event",
      event: {
        type: "file-change.completed",
        provider: "acp",
        change: {
          path: "/tmp/src/app.js",
          cwd: "/tmp",
          source: "snapshot",
          kind: "update",
          oldText: "before\n",
          newText: "after\n",
          diff: [
            "--- a/src/app.js",
            "+++ b/src/app.js",
            "@@ -1 +1 @@",
            "-before",
            "+after",
          ].join("\n"),
        },
      },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.msg.caption, "🔧 *Snapshot*  `src/app.js`");
  });

  it("pins and edits one lifecycle status message per turn", async () => {
    const { sock, sent } = createMockSock();

    const events = [
      {
        type: "session.started",
        provider: "codex",
        session: { chatId: "chat-1", harnessName: "codex", instanceId: "work", status: "running" },
      },
      {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId: "chat-1", status: "started" },
      },
      {
        type: "item.started",
        provider: "acp",
        item: { id: "assistant-1", kind: "assistant" },
      },
      {
        type: "item.started",
        provider: "acp",
        item: { id: "assistant-2", kind: "assistant" },
      },
      {
        type: "session.updated",
        provider: "codex",
        session: { chatId: "chat-1", harnessName: "codex", instanceId: "work", status: "ready" },
      },
      {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId: "chat-1", status: "completed" },
      },
      {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-2", chatId: "chat-1", status: "started" },
      },
    ];

    for (const runtimeEvent of events) {
      await sendEvent(sock, "runtime-noise-chat", {
        kind: "runtime_event",
        event: /** @type {RuntimeEventOutboundEvent["event"]} */ (runtimeEvent),
      });
    }

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: "runtime-noise-chat", fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        text: "✅ *CODEX*  turn completed",
        edit: { id: "msg-1", remoteJid: "runtime-noise-chat", fromMe: true },
        linkPreview: null,
      },
      {
        pin: { id: "msg-1", remoteJid: "runtime-noise-chat", fromMe: true },
        type: 2,
      },
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-5", remoteJid: "runtime-noise-chat", fromMe: true },
        type: 1,
        time: 3600,
      },
    ]);
  });

  it("unpins tracked status handles before starting a new turn status", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-status-new-turn-cleanup-chat";

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-2", chatId, status: "started" },
      },
    });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 2,
      },
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-4", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
    ]);
  });

  it("retries failed pre-turn cleanup unpins when the new turn completes", async () => {
    const { sock, sent } = createMockSock();
    const originalSendMessage = sock.sendMessage.bind(sock);
    let failedPreTurnUnpin = false;
    sock.sendMessage = async (chatId, msg) => {
      const pin = /** @type {{ id?: unknown } | undefined} */ (msg.pin);
      if (!failedPreTurnUnpin && msg.type === 2 && pin?.id === "msg-1") {
        failedPreTurnUnpin = true;
        throw new Error("temporary pre-turn unpin failure");
      }
      return originalSendMessage(chatId, msg);
    };
    const chatId = "runtime-failed-pre-turn-unpin-retry-chat";

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-2", chatId, status: "started" },
      },
    });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-2", chatId, status: "completed" },
      },
    });

    const unpinIds = sent
      .filter((entry) => entry.msg.type === 2 && entry.msg.pin && typeof entry.msg.pin === "object")
      .map((entry) => /** @type {{ id?: string }} */ (entry.msg.pin).id);

    assert.equal(failedPreTurnUnpin, true);
    assert.deepEqual(unpinIds, ["msg-1", "msg-3"]);
  });

  it("shows thinking in the pinned status when reasoning updates", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-thinking-status-chat";
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    const outputVisibility = { ...DEFAULT_OUTPUT_VISIBILITY, reasoning: "pinnedIndicator" };

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, { outputVisibility });
    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "reasoning.updated",
        provider: "acp",
        status: "updated",
        text: "Inspecting the request.",
        contentParts: ["Inspecting the request."],
        summaryParts: [],
      },
    }, undefined, undefined, { outputVisibility });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        text: "💭 *LLM*  thinking",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("routes categorized audio transcription app messages through pinned status when transcription is pinned", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-pinned-transcription-chat";
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    const outputVisibility = { ...DEFAULT_OUTPUT_VISIBILITY, transcription: "pinnedIndicator" };

    await sendEvent(sock, chatId, appMessageEvent("plain", "Transcribing audio...", {
      replyToTriggeringMessage: true,
      presentationCategory: "transcription",
      presentationStatus: "started",
    }), undefined, undefined, { outputVisibility });
    await sendEvent(sock, chatId, appMessageEvent("plain", "Transcribed", {
      presentationCategory: "transcription",
      presentationStatus: "completed",
    }), undefined, undefined, { outputVisibility });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🎙️ *AUDIO*  Transcribing audio...", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        text: "✅ *AUDIO*  Transcribed",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("shows streamed middle assistant messages in pinned status when configured", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-middle-assistant-status-chat";
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    const outputVisibility = { ...DEFAULT_OUTPUT_VISIBILITY, middleAssistantMessages: "pinned" };

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, { outputVisibility });
    await sendEvent(sock, chatId, {
      kind: "assistant_output",
      content: [{ type: "markdown", text: "Drafting answer" }],
      stream: { id: "assistant-1", status: "partial" },
    }, undefined, undefined, { outputVisibility });
    await sendEvent(sock, chatId, {
      kind: "assistant_output",
      content: [{ type: "markdown", text: "Drafting answer with details" }],
      stream: { id: "assistant-1", status: "final" },
    }, undefined, undefined, { outputVisibility });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        text: "💬 *LLM*  Drafting answer",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        text: "💬 *LLM*  Drafting answer with details",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("shows failed categorized transcription app messages in pinned status", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-transcription-status-chat";
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    const outputVisibility = { ...DEFAULT_OUTPUT_VISIBILITY, transcription: "pinnedIndicator" };

    await sendEvent(sock, chatId, appMessageEvent("plain", "Transcribing audio...", {
      replyToTriggeringMessage: true,
      presentationCategory: "transcription",
      presentationStatus: "started",
    }), undefined, undefined, { outputVisibility });
    await sendEvent(sock, chatId, appMessageEvent("plain", "Audio transcription failed.", {
      presentationCategory: "transcription",
      presentationStatus: "failed",
    }), undefined, undefined, { outputVisibility });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🎙️ *AUDIO*  Transcribing audio...", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        text: "❌ *AUDIO*  Audio transcription failed.",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 2,
      },
    ]);
  });

  it("keeps pinned status to the latest first line capped at 100 characters", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-status-short-line-chat";
    const longSummary = `This status line is intentionally long enough to exceed one hundred characters before the newline marker appears\nhidden detail`;

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    });
    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "runtime.warning",
        provider: "codex",
        summary: longSummary,
      },
    });

    const pinnedEdit = sent.find((entry) => typeof entry.msg.text === "string"
      && typeof entry.msg.edit === "object"
      && entry.msg.edit !== null
      && /** @type {{ id?: unknown }} */ (entry.msg.edit).id === "msg-1");
    const text = /** @type {string} */ (pinnedEdit?.msg.text);
    assert.equal(text.length, 100);
    assert.equal(text.includes("\n"), false);
    assert.equal(text, "⚠️ *CODEX*  This status line is intentionally long enough to exceed one hundred characters before...");
  });

  it("observes pinned status delivery at the socket boundary", async () => {
    const { sock } = createMockSock();
    /** @type {Array<Record<string, unknown>>} */
    const deliveryTrace = [];
    const sendOptions = {
      pinnedStatusDeliveryObserver: (/** @type {Record<string, unknown>} */ event) => {
        deliveryTrace.push(event);
      },
    };
    const chatId = "runtime-status-delivery-trace-chat";

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, sendOptions);

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.completed",
        provider: "codex",
        command: {
          command: "pnpm test:fast",
          status: "completed",
        },
      },
    }, undefined, undefined, sendOptions);

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "completed" },
      },
    }, undefined, undefined, sendOptions);

    assert.deepEqual(deliveryTrace.map((event) => [
      event.type,
      event.chatId,
      event.messageId,
      event.firstLine,
      event.error,
    ]), [
      ["status.created", chatId, "msg-1", "🔄 *CODEX*  turn started", undefined],
      ["pin.succeeded", chatId, "msg-1", undefined, undefined],
      ["status.edited", chatId, "msg-1", "✅ *CODEX*  turn completed", undefined],
      ["unpin.succeeded", chatId, "msg-1", undefined, undefined],
    ]);
  });

  it("observes live pin failures instead of silently trusting the payload shape", async () => {
    const { sock } = createMockSock();
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (chatId, msg) => {
      if (msg.pin && msg.type === 1) {
        throw new Error("not a group admin");
      }
      return originalSendMessage(chatId, msg);
    };
    /** @type {Array<Record<string, unknown>>} */
    const deliveryTrace = [];
    const chatId = "runtime-status-pin-failure-trace-chat";

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, {
      pinnedStatusDeliveryObserver: (event) => {
        deliveryTrace.push(event);
      },
    });

    assert.deepEqual(deliveryTrace.map((event) => [
      event.type,
      event.chatId,
      event.messageId,
      event.firstLine,
      event.error,
    ]), [
      ["status.created", chatId, "msg-1", "🔄 *CODEX*  turn started", undefined],
      ["pin.failed", chatId, "msg-1", undefined, "not a group admin"],
    ]);
  });

  it("pins replacement lifecycle status messages when the edit handle expired", async () => {
    const { sock, sent } = createMockSock();
    /** @type {import("../store.js").WhatsAppEditHandleRow | null} */
    let savedHandle = null;
    const expiredAt = "2000-01-01T00:00:00.000Z";
    const store = {
      saveWhatsAppEditHandle: async (/** @type {Parameters<import("../store.js").Store["saveWhatsAppEditHandle"]>[0]} */ input) => {
        savedHandle = {
          id: input.id,
          chat_id: input.chatId,
          message_key_json: input.messageKeyJson,
          message_kind: input.messageKind,
          created_at: input.createdAt,
          expires_at: input.expiresAt,
        };
        return savedHandle;
      },
      getWhatsAppEditHandle: async () => savedHandle ? { ...savedHandle, expires_at: expiredAt } : null,
      deleteExpiredWhatsAppEditHandles: async () => {},
    };
    const sendOptions = {
      editHandleStore: /** @type {import("../store.js").Store} */ (/** @type {unknown} */ (store)),
    };

    await sendEvent(sock, "runtime-expired-turn-chat", {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId: "runtime-expired-turn-chat", status: "started" },
      },
    }, undefined, undefined, sendOptions);

    await sendEvent(sock, "runtime-expired-turn-chat", {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId: "runtime-expired-turn-chat", status: "completed" },
      },
    }, undefined, undefined, sendOptions);

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: "runtime-expired-turn-chat", fromMe: true },
        type: 1,
        time: 3600,
      },
      { text: "✅ *CODEX*  turn completed", linkPreview: null },
      {
        pin: { id: "msg-3", remoteJid: "runtime-expired-turn-chat", fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        pin: { id: "msg-1", remoteJid: "runtime-expired-turn-chat", fromMe: true },
        type: 2,
      },
      {
        pin: { id: "msg-3", remoteJid: "runtime-expired-turn-chat", fromMe: true },
        type: 2,
      },
    ]);
  });

  it("retries failed stale replacement unpins when the turn completes", async () => {
    const { sock, sent } = createMockSock();
    const originalSendMessage = sock.sendMessage.bind(sock);
    let failedStaleUnpin = false;
    sock.sendMessage = async (chatId, msg) => {
      const pin = /** @type {{ id?: unknown } | undefined} */ (msg.pin);
      if (!failedStaleUnpin && msg.type === 2 && pin?.id === "msg-1") {
        failedStaleUnpin = true;
        throw new Error("temporary unpin failure");
      }
      return originalSendMessage(chatId, msg);
    };
    /** @type {import("../store.js").WhatsAppEditHandleRow | null} */
    let savedHandle = null;
    const expiredAt = "2000-01-01T00:00:00.000Z";
    const store = {
      saveWhatsAppEditHandle: async (/** @type {Parameters<import("../store.js").Store["saveWhatsAppEditHandle"]>[0]} */ input) => {
        savedHandle = {
          id: input.id,
          chat_id: input.chatId,
          message_key_json: input.messageKeyJson,
          message_kind: input.messageKind,
          created_at: input.createdAt,
          expires_at: input.expiresAt,
        };
        return savedHandle;
      },
      getWhatsAppEditHandle: async () => savedHandle ? { ...savedHandle, expires_at: expiredAt } : null,
      deleteExpiredWhatsAppEditHandles: async () => {},
    };
    const sendOptions = {
      editHandleStore: /** @type {import("../store.js").Store} */ (/** @type {unknown} */ (store)),
    };
    const chatId = "runtime-failed-stale-unpin-retry-chat";

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, sendOptions);

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "completed" },
      },
    }, undefined, undefined, sendOptions);

    assert.equal(failedStaleUnpin, true);
    assert.ok(
      sent.some((entry) => entry.msg.pin
        && typeof entry.msg.pin === "object"
        && /** @type {{ id?: unknown }} */ (entry.msg.pin).id === "msg-1"
        && entry.msg.type === 2),
      `Expected turn completion to retry stale status unpin, got ${JSON.stringify(sent.map((entry) => entry.msg))}`,
    );
    assert.ok(
      sent.some((entry) => entry.msg.pin
        && typeof entry.msg.pin === "object"
        && /** @type {{ id?: unknown }} */ (entry.msg.pin).id === "msg-3"
        && entry.msg.type === 2),
      `Expected turn completion to unpin replacement status, got ${JSON.stringify(sent.map((entry) => entry.msg))}`,
    );
  });

  it("keeps raw read-title tools out of pinned runtime status", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-raw-read-title-chat", {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId: "runtime-raw-read-title-chat", status: "started" },
      },
    });

    await sendEvent(sock, "runtime-raw-read-title-chat", {
      kind: "runtime_event",
      event: {
        type: "tool.started",
        provider: "codex",
        tool: {
          id: "read-title-1",
          name: "Read bang-command-router.js",
          arguments: {},
        },
      },
    });

    await sendEvent(sock, "runtime-raw-read-title-chat", {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId: "runtime-raw-read-title-chat", status: "completed" },
      },
    });

    const renderedTexts = sent
      .filter((entry) => typeof entry.msg.text === "string")
      .map((entry) => /** @type {string} */ (entry.msg.text));
    assert.ok(!renderedTexts.join("\n").includes("*Read bang-command-router.js*"), `Expected raw read title to be normalized, got ${JSON.stringify(renderedTexts)}`);
    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: "runtime-raw-read-title-chat", fromMe: true },
        type: 1,
        time: 3600,
      },
      { text: "🔧 *Read*  `bang-command-router.js`", linkPreview: null },
      {
        text: "✅ *CODEX*  turn completed",
        edit: { id: "msg-1", remoteJid: "runtime-raw-read-title-chat", fromMe: true },
        linkPreview: null,
      },
      {
        pin: { id: "msg-1", remoteJid: "runtime-raw-read-title-chat", fromMe: true },
        type: 2,
      },
    ]);
  });

  it("omits tool and command rows from pinned status when tool messages are visible", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-visible-tools-status-chat";

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.started",
        provider: "acp",
        tool: {
          id: "search-1",
          name: "Search",
          arguments: { pattern: "needle", path: "src" },
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.started",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "started",
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.completed",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "completed",
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "completed" },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    const pinEntry = sent.find((entry) => entry.msg.pin && typeof entry.msg.pin === "object" && entry.msg.type === 1);
    const pinnedId = pinEntry && typeof pinEntry.msg.pin === "object"
      ? /** @type {{ id?: unknown }} */ (pinEntry.msg.pin).id
      : null;
    assert.equal(typeof pinnedId, "string", `Expected pinned status payload, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);

    const pinnedTexts = sent
      .filter((entry, index) => (
        typeof entry.msg.text === "string"
        && (`msg-${index + 1}` === pinnedId
          || (typeof entry.msg.edit === "object"
            && entry.msg.edit !== null
            && /** @type {{ id?: unknown }} */ (entry.msg.edit).id === pinnedId))
      ))
      .map((entry) => /** @type {string} */ (entry.msg.text));

    assert.ok(sent.some((entry) => entry.msg.text === "🔧 *Search*  `needle` in *src*"), `Expected visible Search tool message, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);
    assert.ok(sent.some((entry) => entry.msg.text === "✅ *Shell*  `pnpm type-check`"), `Expected visible Shell command message, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);
    assert.deepEqual(pinnedTexts, [
      "🔄 *CODEX*  turn started",
      "✅ *CODEX*  turn completed",
    ]);
  });

  it("routes tool and command rows through pinned status when tool status is enabled", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-pinned-tool-status-chat";
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    const outputVisibility = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "pinnedIndicator" };

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.started",
        provider: "acp",
        tool: {
          id: "search-1",
          name: "Search",
          arguments: { pattern: "needle", path: "src" },
        },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.started",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "started",
        },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.completed",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "completed",
        },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "completed" },
      },
    }, undefined, undefined, { outputVisibility });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        text: "🔧 *Search*  `needle` in *src*",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        text: "🔧 *Shell*  `pnpm type-check`",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        text: "✅ *Shell*  `pnpm type-check`",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        text: "✅ *CODEX*  turn completed",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 2,
      },
    ]);
  });

  it("keeps tool-first pinned status and lifecycle status on the same message", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-tool-first-pinned-status-chat";
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    const outputVisibility = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "pinnedIndicator" };

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.started",
        provider: "acp",
        tool: {
          id: "search-1",
          name: "Search",
          arguments: { pattern: "needle", path: "src" },
        },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.completed",
        provider: "acp",
        command: {
          command: "pnpm type-check",
          status: "completed",
        },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "completed" },
      },
    }, undefined, undefined, { outputVisibility });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Search*  `needle` in *src*", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        text: "🔄 *CODEX*  turn started",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        text: "✅ *Shell*  `pnpm type-check`",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        text: "✅ *CODEX*  turn completed",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 2,
      },
    ]);
  });

  it("keeps final usage accounting in pinned status when usage is pinned", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-action-focused-usage-chat";
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    const outputVisibility = { ...DEFAULT_OUTPUT_VISIBILITY, usage: "pinned" };

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "command.completed",
        provider: "acp",
        command: {
          command: "/bin/zsh -lc 'pnpm exec node scripts/acp-adapter-smoke.js codex --prompt'",
          status: "completed",
        },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "usage",
      cost: "0.000000",
      tokens: { prompt: 12, completion: 8, cached: 0 },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "completed" },
      },
    }, undefined, undefined, { outputVisibility });

    const pinnedStatusTexts = sent
      .filter((entry) => typeof entry.msg.text === "string" && (
        typeof entry.msg.edit === "object"
        || entry.msg.text === "🔄 *CODEX*  turn started"
      ))
      .map((entry) => /** @type {string} */ (entry.msg.text));

    assert.equal(sent.some((entry) => typeof entry.msg.text === "string" && entry.msg.text.includes("Cost: 0.000000")), false);
    assert.deepEqual(pinnedStatusTexts, [
      "🔄 *CODEX*  turn started",
      "📊 *USAGE*  cost 0.000000",
      "✅ *CODEX*  turn completed",
    ]);
  });

  it("keeps the current plan step in pinned status when plans are pinned", async () => {
    const { sock, sent } = createMockSock();
    const chatId = "runtime-pinned-plan-chat";
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    const outputVisibility = { ...DEFAULT_OUTPUT_VISIBILITY, plans: "pinnedCurrentStep" };

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
    }, undefined, undefined, { outputVisibility });

    await sendEvent(sock, chatId, {
      kind: "plan",
      presentation: createPlanPresentationFromState({
        entries: [
          { text: "Inspect formatter", status: "completed" },
          { text: "Patch pinned plan status", status: "in_progress" },
          { text: "Run focused tests", status: "pending" },
        ],
      }),
    }, undefined, undefined, { outputVisibility });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔄 *CODEX*  turn started", linkPreview: null },
      {
        pin: { id: "msg-1", remoteJid: chatId, fromMe: true },
        type: 1,
        time: 3600,
      },
      {
        text: "📋 *PLAN*  *Plan*  _Working on: Patch pinned plan status_",
        edit: { id: "msg-1", remoteJid: chatId, fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("updates pinned status after each ACP payload through Baileys", async () => {
    const { sock, sent } = createMockSock();
    const model = createAcpRuntimeModel();
    const chatId = "runtime-acp-payload-status-chat";
    const sessionId = "session-status-1";
    const cwd = "/repo";

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.started",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "started" },
      },
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
     * @returns {Promise<string>}
     */
    async function sendAcpUpdate(update) {
      const runtimeEvents = model.acceptSessionUpdate({ sessionId, update });
      for (const event of runtimeEvents) {
        await sendEvent(sock, chatId, {
          kind: "runtime_event",
          cwd,
          event,
        });
      }
      return pinnedStatusTexts().at(-1) ?? "";
    }

    assert.equal(pinnedStatusTexts().at(-1), "🔄 *CODEX*  turn started");

    assert.equal(await sendAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "status-search-1",
      title: "Search package.json",
      kind: "search",
      rawInput: { pattern: "smoke|e2e|baileys|whatsapp|pin|pinned|ACP", path: "package.json" },
      status: "in_progress",
    }), "🔄 *CODEX*  turn started");

    assert.equal(await sendAcpUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "status-search-1",
      status: "completed",
    }), "🔄 *CODEX*  turn started");

    assert.equal(await sendAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "status-smoke-failed-1",
      title: "Shell",
      rawInput: { command: "pnpm exec node scripts/acp-adapter-smoke.js codex --prompt" },
      status: "in_progress",
    }), "🔄 *CODEX*  turn started");

    assert.equal(await sendAcpUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "status-smoke-failed-1",
      status: "failed",
      rawOutput: { exit_code: 1, formatted_output: "ACP connection closed" },
    }), "🔄 *CODEX*  turn started");

    assert.equal(await sendAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "status-smoke-success-1",
      title: "Shell",
      rawInput: { command: "/bin/zsh -lc 'pnpm exec node scripts/acp-adapter-smoke.js codex --prompt'" },
      status: "in_progress",
    }), "🔄 *CODEX*  turn started");

    assert.equal(await sendAcpUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "status-smoke-success-1",
      status: "completed",
      rawOutput: { exit_code: 0, formatted_output: "ok" },
    }), "🔄 *CODEX*  turn started");

    const renderedTexts = sent
      .map((entry) => typeof entry.msg.text === "string" ? entry.msg.text : "")
      .filter(Boolean);
    assert.ok(renderedTexts.includes("🔧 *Search*  `smoke|e2e|baileys|whatsapp|pin|pinned|ACP` in *package.json*"), `Expected Search tool message, got ${JSON.stringify(renderedTexts)}`);
    assert.ok(renderedTexts.includes("✅ *Search*  `smoke|e2e|baileys|whatsapp|pin|pinned|ACP` in *package.json*"), `Expected Search completion message, got ${JSON.stringify(renderedTexts)}`);
    assert.ok(renderedTexts.some((text) => text.startsWith("✅ *Shell*") && text.includes("acp-adapter-smoke.js codex --prompt")), `Expected Shell completion message, got ${JSON.stringify(renderedTexts)}`);

    await sendEvent(sock, chatId, {
      kind: "runtime_event",
      event: {
        type: "turn.completed",
        provider: "codex",
        turn: { id: "turn-1", chatId, status: "completed" },
      },
    });

    assert.equal(pinnedStatusTexts().at(-1), "✅ *CODEX*  turn completed");
    assert.ok(sent.some((entry) => entry.msg.pin && typeof entry.msg.pin === "object" && entry.msg.type === 2), `Expected final unpin payload, got ${JSON.stringify(sent.map((entry) => entry.msg))}`);
  });

  it("folds generic runtime events into one editable WhatsApp status", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-chat", {
      kind: "runtime_event",
      event: {
        type: "session.started",
        provider: "acp",
        session: {
          chatId: "runtime-chat",
          harnessName: "acp",
          instanceId: "session-1",
          status: "running",
        },
      },
    });
    await sendEvent(sock, "runtime-chat", {
      kind: "runtime_event",
      event: {
        type: "extension.notification",
        provider: "acp",
        method: "madabot/example",
        payload: { ok: true },
      },
    });

    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.msg.text, "🔄 *ACP*  session running");
    assert.deepEqual(sent[1]?.msg, {
      text: "🔄 *ACP*  session running\n🔄 *ACP*  extension notification: madabot/example",
      edit: { id: "msg-1", remoteJid: "runtime-chat", fromMe: true },
      linkPreview: null,
    });
  });

  it("renders generic fallback details for otherwise unhandled ACP item events", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-generic-item-chat", {
      kind: "runtime_event",
      event: {
        type: "item.started",
        provider: "acp",
        item: {
          id: "screenshot-capture-1",
          kind: "unknown",
          text: "Checking the running screenshot capture before rerunning checks.",
        },
      },
    });

    assert.equal(sent.length, 1);
    assert.equal(
      sent[0]?.msg.text,
      "🔄 *ACP*  unknown item started: Checking the running screenshot capture before rerunning checks.",
    );
  });

  it("starts a fresh runtime status message when the previous edit handle expired", async () => {
    const { sock, sent } = createMockSock();
    /** @type {import("../store.js").WhatsAppEditHandleRow | null} */
    let savedHandle = null;
    const expiredAt = "2000-01-01T00:00:00.000Z";
    const store = {
      saveWhatsAppEditHandle: async (/** @type {Parameters<import("../store.js").Store["saveWhatsAppEditHandle"]>[0]} */ input) => {
        savedHandle = {
          id: input.id,
          chat_id: input.chatId,
          message_key_json: input.messageKeyJson,
          message_kind: input.messageKind,
          created_at: input.createdAt,
          expires_at: input.expiresAt,
        };
        return savedHandle;
      },
      getWhatsAppEditHandle: async () => savedHandle ? { ...savedHandle, expires_at: expiredAt } : null,
      deleteExpiredWhatsAppEditHandles: async () => {},
    };

    await sendEvent(sock, "runtime-expired-chat", {
      kind: "runtime_event",
      event: {
        type: "session.started",
        provider: "acp",
        session: {
          chatId: "runtime-expired-chat",
          harnessName: "acp",
          instanceId: "session-1",
          status: "running",
        },
      },
    }, undefined, undefined, {
      editHandleStore: /** @type {import("../store.js").Store} */ (/** @type {unknown} */ (store)),
    });

    await sendEvent(sock, "runtime-expired-chat", {
      kind: "runtime_event",
      event: {
        type: "extension.notification",
        provider: "acp",
        method: "madabot/example",
        payload: { ok: true },
      },
    }, undefined, undefined, {
      editHandleStore: /** @type {import("../store.js").Store} */ (/** @type {unknown} */ (store)),
    });

    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.msg.text, "🔄 *ACP*  session running");
    assert.deepEqual(sent[1]?.msg, {
      text: "🔄 *ACP*  session running\n🔄 *ACP*  extension notification: madabot/example",
      linkPreview: null,
    });
  });

  it("renders runtime errors as standalone error messages", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-error-chat", {
      kind: "runtime_event",
      event: {
        type: "runtime.error",
        provider: "acp",
        message: "Provider crashed",
      },
    });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "❌ Provider crashed", linkPreview: null },
    ]);
  });
});

describe("sendEvent – presentation vertical slices", () => {
  it("renders explicit update file changes with a bold filename through WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "presentation-chat", runtimeFileChangeEvent({
      path: "/tmp/src/app.js",
      cwd: "/tmp",
      changeKind: "update",
      oldText: "before\n",
      newText: "after\n",
      diff: [
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
    }));

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.msg.caption, "🔧 *Update*  `src/app.js`");
  });

  it("renders snapshot-origin file changes with the Snapshot label through WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "presentation-chat", runtimeFileChangeEvent({
      path: "/tmp/src/app.js",
      cwd: "/tmp",
      source: "snapshot",
      changeKind: "update",
      oldText: "before\n",
      newText: "after\n",
      diff: [
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
    }));

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.msg.caption, "🔧 *Snapshot*  `src/app.js`");
  });

  it("drops generic editing summaries from file-change captions", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "presentation-chat", runtimeFileChangeEvent({
      path: "/tmp/src/app.js",
      cwd: "/tmp",
      source: "snapshot",
      summary: "Editing files",
      changeKind: "update",
      oldText: "before\n",
      newText: "after\n",
      diff: [
        "--- a/src/app.js",
        "+++ b/src/app.js",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
    }));

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.msg.caption, "🔧 *Snapshot*  `src/app.js`");
  });
});

describe("sendBlocks – markdown with code", () => {
  it("renders code blocks inside markdown as images", async () => {
    const { sock, sent } = createMockSock();

    const markdown = `Here is some code:

\`\`\`javascript
function greet(name) {
  const msg = "Hello, " + name;
  console.log(msg);
  return msg;
}
greet("world");
\`\`\`

And some text after.`;

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    // Should have sent at least 3 messages: text before, image, text after
    const textMessages = sent.filter(s => typeof s.msg.text === "string");
    const imageMessages = sent.filter(s => s.msg.image != null);

    assert.ok(
      imageMessages.length >= 1,
      `Expected at least 1 image message for code block, got ${imageMessages.length}. ` +
      `All messages: ${JSON.stringify(sent.map(s => Object.keys(s.msg)), null, 2)}`,
    );

    // The image should be a Buffer (PNG)
    const firstImage = imageMessages[0];
    assert.ok(
      Buffer.isBuffer(firstImage.msg.image),
      "Code block image should be a Buffer",
    );

    // Text parts should still be present
    assert.ok(
      textMessages.some(m => /** @type {string} */ (m.msg.text).includes("some code")),
      "Should have text before code block",
    );
    assert.ok(
      textMessages.some(m => /** @type {string} */ (m.msg.text).includes("text after")),
      "Should have text after code block",
    );
  });

  it("long code that splits into multiple images sends them in a single message", async () => {
    const { sock, sent, relayed } = createMockSock();

    // 100 lines of narrow code — fits in a single image after adaptive splitting
    const longCode = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join("\n");

    await sendBlocks(sock, "test-chat", "llm", [
      { type: "code", language: "javascript", code: longCode },
    ]);

    // The split images should be bundled into a single message, not sent as
    // separate sock.sendMessage calls — otherwise the user gets spammed with
    // individual image messages for what is conceptually one code block.
    const imageMessages = sent.filter(s => s.msg.image != null);
    assert.equal(imageMessages.length, 0, "Album sends should not fall back to separate sendMessage image calls");

    const albumHeaders = relayed.filter(({ msg }) => msg.albumMessage != null);
    assert.equal(albumHeaders.length, 1, `Expected one album header relay, got ${albumHeaders.length}`);

    const albumImages = relayed.filter(({ msg }) => msg.imageMessage != null);
    assert.ok(albumImages.length >= 2, `Expected relayed album images, got ${albumImages.length}`);
  });

  it("asks before rendering and sending the full truncated code image set", async () => {
    const { sock, sent, relayed } = createMockSock();
    const reactionRuntime = createReactionRuntime();
    const longCode = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`).join("\n");

    await sendBlocks(sock, "test-chat", "tool-call", [
      { type: "code", language: "javascript", code: longCode },
    ], undefined, reactionRuntime);

    const warning = sent.find((entry) => typeof entry.msg.text === "string"
      && entry.msg.text.includes("Code block truncated"));
    assert.ok(warning, "expected a continuation warning prompt");
    const warningText = /** @type {string} */ (warning.msg.text);
    const match = warningText.match(/showing (\d+) of (\d+) rendered images/);
    assert.ok(match, `expected warning to include visible and total image counts, got ${warningText}`);
    assert.equal(Number(match[1]), MAX_RENDERED_IMAGES_PER_BLOCK);
    const totalImages = Number(match[2]);
    assert.ok(totalImages > MAX_RENDERED_IMAGES_PER_BLOCK, "test fixture should produce hidden images");
    assert.ok(warningText.includes("React 👍 to send all"), "warning should ask whether to send the full image set");

    const initialAlbumHeaders = relayed.filter(({ msg }) => msg.albumMessage != null);
    assert.equal(initialAlbumHeaders.length, 1, "initial preview should be sent as one album");
    assert.equal(
      /** @type {{ expectedImageCount?: number }} */ (initialAlbumHeaders[0].msg.albumMessage).expectedImageCount,
      MAX_RENDERED_IMAGES_PER_BLOCK,
      "initial album should only contain preview images",
    );

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "test-chat" },
      reaction: { text: "👍" },
      senderId: "sender",
    }]);

    await waitFor(() => relayed.filter(({ msg }) => msg.albumMessage != null).length >= 2);
    const albumHeaders = relayed.filter(({ msg }) => msg.albumMessage != null);
    const continuationHeader = albumHeaders[albumHeaders.length - 1];
    assert.equal(
      /** @type {{ expectedImageCount?: number }} */ (continuationHeader.msg.albumMessage).expectedImageCount,
      totalImages,
      "continuation album should contain the full rendered image set",
    );
  });

  it("renders multiple code blocks as separate images", async () => {
    const { sock, sent } = createMockSock();

    const markdown = `First block:

\`\`\`python
def greet(name):
    msg = f"Hello, {name}!"
    print(msg)
    return msg

greet("world")
\`\`\`

Second block:

\`\`\`json
{
  "name": "test",
  "version": "1.0",
  "description": "example",
  "main": "index.js"
}
\`\`\``;

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    const imageMessages = sent.filter(s => s.msg.image != null);
    assert.equal(
      imageMessages.length, 2,
      `Expected 2 image messages, got ${imageMessages.length}`,
    );
  });

  it("falls back to text if code rendering fails", async () => {
    const { sock, sent } = createMockSock();

    // Empty code block — should still not crash
    const markdown = "Check this:\n\n```\n\n```\n\nDone.";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    // Should not crash, and should have sent something
    assert.ok(sent.length > 0, "Should have sent at least one message");
  });

  it("sends plain markdown without code as formatted text", async () => {
    const { sock, sent } = createMockSock();

    const markdown = "This is **bold** and *italic* text with a [link](https://example.com).";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    const textMessages = sent.filter(s => typeof s.msg.text === "string");
    assert.equal(textMessages.length, 1, "Should send one text message");

    // Should have WhatsApp formatting applied
    const text = /** @type {string} */ (textMessages[0].msg.text);
    assert.ok(text.includes("*bold*"), "Bold should be converted to WhatsApp format");
    assert.ok(text.includes("_italic_"), "Italic should be converted to WhatsApp format");
  });

  it("disables Baileys URL preview generation for text payloads", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "llm", [{ type: "text", text: "See https://example.com" }]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.linkPreview, null);
  });

  it("renders explicit markdown attachment directives for relative document paths", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "llm", [{
      type: "markdown",
      text: [
        "Before",
        "",
        "```attachment",
        "path: package.json",
        "caption: Project manifest",
        "```",
        "",
        "After",
      ].join("\n"),
    }]);

    const documentMessages = sent.filter((entry) => entry.msg.document != null);
    const textMessages = sent.filter((entry) => typeof entry.msg.text === "string");

    assert.equal(documentMessages.length, 1, "Should send one document message for the attachment directive");
    assert.ok(Buffer.isBuffer(documentMessages[0].msg.document), "Attachment directive should send a document buffer");
    assert.equal(documentMessages[0].msg.fileName, "package.json");
    assert.equal(documentMessages[0].msg.caption, "Project manifest");
    assert.ok(
      textMessages.some((entry) => /** @type {string} */ (entry.msg.text).includes("Before")),
      "Should preserve text before the attachment directive",
    );
    assert.ok(
      textMessages.some((entry) => /** @type {string} */ (entry.msg.text).includes("After")),
      "Should preserve text after the attachment directive",
    );
    assert.ok(
      textMessages.every((entry) => !/** @type {string} */ (entry.msg.text).includes("path: package.json")),
      "Should not leak attachment directive contents into text messages",
    );
  });

  it("resolves markdown attachment directives relative to assistant output cwd", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-cwd-"));
    await fs.writeFile(path.join(workdir, "website.json"), JSON.stringify({ title: "Demo" }), "utf8");
    const { sock, sent } = createMockSock();

    try {
      await sendEvent(sock, "test-chat", {
        kind: "assistant_output",
        cwd: workdir,
        content: [{
          type: "markdown",
          text: [
            "```attachment",
            "path: website.json",
            "caption: Website data",
            "```",
          ].join("\n"),
        }],
      });
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }

    const documentMessages = sent.filter((entry) => entry.msg.document != null);
    const textMessages = sent.filter((entry) => typeof entry.msg.text === "string");

    assert.equal(documentMessages.length, 1, "Should send one document message for the cwd-relative directive");
    assert.equal(documentMessages[0].msg.fileName, "website.json");
    assert.equal(documentMessages[0].msg.caption, "Website data");
    assert.equal(textMessages.length, 0, "Should not fall back to an attachment failure warning");
  });

  it("renders explicit markdown attachment directives for relative image paths", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "llm", [{
      type: "markdown",
      text: [
        "```attachment",
        "path: tests/fixtures/pizza.jpg",
        "caption: Pizza via directive",
        "```",
      ].join("\n"),
    }]);

    const imageMessages = sent.filter((entry) => entry.msg.image != null);
    const textMessages = sent.filter((entry) => typeof entry.msg.text === "string");

    assert.equal(imageMessages.length, 1, "Should send one image message for an image attachment directive");
    assert.ok(Buffer.isBuffer(imageMessages[0].msg.image), "Image attachment directive should send an image buffer");
    assert.equal(imageMessages[0].msg.caption, "Pizza via directive");
    assert.equal(imageMessages[0].msg.jpegThumbnail, "");
    assert.equal(textMessages.length, 0, "Attachment-only markdown should not fall back to text");
  });

  it("surfaces attachment directive failures as a visible warning instead of silently echoing the directive", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "llm", [{
      type: "markdown",
      text: [
        "Before",
        "",
        "```attachment",
        "path: artifacts/does-not-exist.wav",
        "caption: Missing audio",
        "```",
        "",
        "After",
      ].join("\n"),
    }]);

    const textMessages = sent.filter((entry) => typeof entry.msg.text === "string");
    const fullText = textMessages.map((entry) => /** @type {string} */ (entry.msg.text)).join("\n");

    assert.equal(sent.filter((entry) => entry.msg.audio != null || entry.msg.document != null || entry.msg.image != null || entry.msg.video != null).length, 0);
    assert.ok(fullText.includes("Before"), "Should preserve text before the failed directive");
    assert.ok(fullText.includes("After"), "Should preserve text after the failed directive");
    assert.ok(fullText.includes("Attachment send failed"), "Should surface a visible attachment failure warning");
    assert.ok(fullText.includes("does-not-exist.wav"), "Should identify which attachment failed");
    assert.ok(!fullText.includes("```attachment"), "Should not leak the raw attachment directive block");
    assert.ok(!fullText.includes("caption: Missing audio"), "Should not echo directive internals back to chat");
  });

  it("logs attachment resolution and outbound send attempts for explicit directives", async () => {
    const { sock } = createMockSock();
    const originalLevel = process.env.LOG_LEVEL;
    const originalLog = console.log;
    /** @type {string[]} */
    const captured = [];

    process.env.LOG_LEVEL = "info";
    console.log = (...args) => {
      captured.push(args.map((value) => String(value)).join(" "));
    };

    try {
      await sendBlocks(sock, "test-chat", "llm", [{
        type: "markdown",
        text: [
          "```attachment",
          "path: package.json",
          "caption: Project manifest",
          "```",
        ].join("\n"),
      }]);
    } finally {
      if (originalLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = originalLevel;
      }
      console.log = originalLog;
    }

    assert.ok(
      captured.some((line) => line.includes("[message-renderer] Resolving attachment directive")),
      `Expected attachment resolution log. Captured logs:\n${captured.join("\n")}`,
    );
    assert.ok(
      captured.some((line) => line.includes("[message-renderer] Resolved attachment directive")),
      `Expected attachment resolution success log. Captured logs:\n${captured.join("\n")}`,
    );
    assert.ok(
      captured.some((line) => line.includes("[whatsapp:outbound] Sending attachment instruction")),
      `Expected outbound attachment send log. Captured logs:\n${captured.join("\n")}`,
    );
    assert.ok(
      captured.some((line) => line.includes("[whatsapp:outbound] Sent attachment instruction")),
      `Expected outbound attachment success log. Captured logs:\n${captured.join("\n")}`,
    );
  });

  it("renders display math blocks in markdown as WhatsApp images", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "llm", [{
      type: "markdown",
      text: [
        "Before",
        "",
        "$$",
        "\\text{Risk after cleaning }R(r)=q\\left(1-e^{-kD_0 10^{-r}}\\right)",
        "$$",
        "",
        "After",
      ].join("\n"),
    }]);

    const imageMessages = sent.filter((entry) => entry.msg.image != null);
    const textMessages = sent.filter((entry) => typeof entry.msg.text === "string");

    assert.equal(imageMessages.length, 1, "Should send display math as an image");
    assert.ok(Buffer.isBuffer(imageMessages[0].msg.image), "Math render should produce a PNG buffer");
    assert.ok(
      textMessages.some((entry) => /** @type {string} */ (entry.msg.text).includes("Before")),
      "Should preserve text before the math block",
    );
    assert.ok(
      textMessages.some((entry) => /** @type {string} */ (entry.msg.text).includes("After")),
      "Should preserve text after the math block",
    );
    assert.ok(
      textMessages.every((entry) => !/** @type {string} */ (entry.msg.text).includes("\\text{Risk after cleaning }")),
      "Should not leak raw LaTeX into WhatsApp text messages",
    );
  });

  it("renders mixed markdown segments in order across tables, math, and embedded images", async () => {
    const { sock, sent } = createMockSock();
    const imagePath = path.resolve("tests/fixtures/pizza.jpg");

    await sendBlocks(sock, "test-chat", "llm", [{
      type: "markdown",
      text: [
        "Intro",
        "",
        "| item | qty |",
        "| --- | --- |",
        "| apples | 2 |",
        "| pears | 3 |",
        "| plums | 4 |",
        "",
        "Between",
        "",
        "$$",
        "R(r)=q\\left(1-e^{-kD_0 10^{-r}}\\right)",
        "$$",
        "",
        "Then image",
        "",
        "```attachment",
        "path: tests/fixtures/pizza.jpg",
        "caption: Pizza",
        "```",
        "",
        "Done",
      ].join("\n"),
    }]);

    const imageMessages = sent.filter((entry) => entry.msg.image != null);
    const textPayloads = sent
      .filter((entry) => typeof entry.msg.text === "string")
      .map((entry) => /** @type {string} */ (entry.msg.text));

    assert.equal(imageMessages.length, 3, "Should render table, math, and embedded image as separate images");
    assert.equal(imageMessages[2].msg.caption, "Pizza", "Embedded markdown image should preserve its alt text as caption");
    assert.ok(textPayloads.some((text) => text.includes("Intro")), "Should preserve text before the table");
    assert.ok(textPayloads.some((text) => text.includes("Between")), "Should preserve text between the table and math");
    assert.ok(textPayloads.some((text) => text.includes("Then image")), "Should preserve text before the embedded image");
    assert.ok(textPayloads.some((text) => text.includes("Done")), "Should preserve trailing text");
    assert.ok(textPayloads.every((text) => !text.includes("| item | qty |")), "Should not leak rendered table markdown into text messages");
    assert.ok(textPayloads.every((text) => !text.includes("R(r)=q\\left")), "Should not leak rendered display math into text messages");
    assert.ok(textPayloads.every((text) => !text.includes(imagePath)), "Should not leak embedded image paths into text messages");
  });

  it("omits absolute paths when rendering local file links for WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    const markdown = "Updated [prepare-run-messages.js](/home/mada/whatsapp-llm-bot/conversation/prepare-run-messages.js) and [message-formatting.js](/home/mada/whatsapp-llm-bot/message-formatting.js#L326).";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    const textMessages = sent.filter(s => typeof s.msg.text === "string");
    assert.equal(textMessages.length, 1, "Should send one text message");

    const text = /** @type {string} */ (textMessages[0].msg.text);
    assert.ok(text.includes("`prepare-run-messages.js`"), "Should render local file labels as inline code");
    assert.ok(text.includes("`message-formatting.js:326`"), "Should preserve line context as inline code");
    assert.ok(!text.includes("/home/mada/whatsapp-llm-bot/"), "Should not leak absolute file paths into WhatsApp text");
  });

  it("keeps one inline code wrapper when local file link labels are already backticked", async () => {
    const { sock, sent } = createMockSock();

    const markdown = "Updated [`message-formatting.js`](/home/mada/whatsapp-llm-bot/message-formatting.js#L326).";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    const textMessages = sent.filter(s => typeof s.msg.text === "string");
    assert.equal(textMessages.length, 1, "Should send one text message");

    const text = /** @type {string} */ (textMessages[0].msg.text);
    assert.ok(text.includes("`message-formatting.js:326`"), "Should keep a single inline code wrapper");
    assert.ok(!text.includes("``message-formatting.js"), "Should not double-wrap the inline code span");
  });

  it("does not duplicate line numbers when a local file link already has an explicit suffix", async () => {
    const { sock, sent } = createMockSock();

    const markdown = "Changed [message-formatting.js](/home/mada/whatsapp-llm-bot/message-formatting.js#L326):326.";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    const textMessages = sent.filter(s => typeof s.msg.text === "string");
    assert.equal(textMessages.length, 1, "Should send one text message");

    const text = /** @type {string} */ (textMessages[0].msg.text);
    assert.ok(text.includes("`message-formatting.js:326`"), "Should keep one compact inline code line reference");
    assert.ok(!text.includes("message-formatting.js:326:326"), "Should not duplicate the line number");
  });

  it("sends one-line diff as a single image message with caption", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "tool-call", [
      { type: "diff", oldStr: "const x = 1;", newStr: "const x = 2;", language: "javascript", caption: "*Edit*  `foo.js`" },
    ]);

    // Should send exactly one image message (not a separate text + image)
    assert.equal(sent.length, 1, `Expected 1 message, got ${sent.length}`);
    const msg = sent[0].msg;
    assert.ok(Buffer.isBuffer(msg.image), "Should be an image buffer");
    assert.ok(
      typeof msg.caption === "string" && msg.caption.includes("Edit"),
      "Caption should contain the header text",
    );
  });

  it("sends diff without caption when no caption is provided", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "tool-call", [
      { type: "diff", oldStr: "a", newStr: "b", language: "python" },
    ]);

    assert.equal(sent.length, 1);
    const msg = sent[0].msg;
    assert.ok(Buffer.isBuffer(msg.image), "Should be an image buffer");
    assert.equal(msg.caption, undefined);
  });

  it("renders an apply_patch update through sendBlocks as a diff image", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendblocks-apply-patch-"));
    const targetPath = path.join(tempDir, "render-target.md");
    const beforeText = [
      "# Minimal Reproduction",
      "",
      "Expected: updating this file renders a WhatsApp diff image.",
      "Observed: only the update activity line was visible.",
      "",
    ].join("\n");
    await fs.writeFile(targetPath, beforeText, "utf8");
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${targetPath}`,
      "@@",
      " # Minimal Reproduction",
      " ",
      " Expected: updating this file renders a WhatsApp diff image.",
      "-Observed: only the update activity line was visible.",
      "+Observed: the update activity line and diff image are visible.",
      " ",
      "*** End Patch",
    ].join("\n");
    try {
      const model = createAcpRuntimeModel();
      model.acceptSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "patch-plan",
          title: "Update render-target.md",
          status: "in_progress",
          rawInput: { patch },
        },
      });
      const events = model.acceptSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "patch-plan",
          title: "Update render-target.md",
          status: "completed",
          rawInput: { patch },
          content: [],
        },
      });

      const fileChange = events.find((event) => event.type === "file-change.completed");
      assert.equal(fileChange?.type, "file-change.completed");
      assert.equal(fileChange.change.kind, "update");
      assert.equal(fileChange.change.path, targetPath);
      assert.equal(fileChange.change.source, "tool");
      assert.match(String(fileChange.change.diff ?? ""), /-Observed: only the update activity line was visible\./);
      assert.match(String(fileChange.change.diff ?? ""), /\+Observed: the update activity line and diff image are visible\./);

      const content = renderFileChangeContent({
        kind: "file_change",
        path: fileChange.change.path,
        cwd: tempDir,
        summary: fileChange.change.summary,
        changeKind: fileChange.change.kind,
        source: fileChange.change.source,
        diff: fileChange.change.diff,
        oldText: fileChange.change.oldText,
        newText: fileChange.change.newText,
      });
      const { sock, sent } = createMockSock();
      await sendBlocks(sock, "test-chat", "tool-call", content);

      assert.equal(sent.length, 1, JSON.stringify(sent));
      assert.ok(Buffer.isBuffer(sent[0]?.msg.image), "Expected sendBlocks to send a diff image");
      assert.match(String(sent[0]?.msg.caption ?? ""), /\*Update\*  `render-target\.md`/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("limits multi-batch non-snapshot diff blocks without a truncation prompt", async () => {
    const { sock, sent, relayed } = createMockSock();

    await sendBlocks(sock, "test-chat", "tool-call", [{
      type: "diff",
      oldStr: "",
      newStr: "",
      diffText: buildMultiBatchDiffText(),
      language: "javascript",
      caption: "*Update*  `huge.js`",
    }]);

    const imageMessages = relayed.filter((entry) => entry.msg.imageMessage != null);
    const textMessages = sent.filter((entry) => typeof entry.msg.text === "string");
    assert.equal(imageMessages.length, MAX_RENDERED_IMAGES_PER_BLOCK);
    const firstImage = /** @type {{ imageMessage?: { caption?: string } }} */ (imageMessages[0]?.msg ?? {});
    assert.match(String(firstImage.imageMessage?.caption ?? ""), /\*Update\*  `huge\.js`/);
    assert.equal(textMessages.length, 0, JSON.stringify(sent));
  });

  it("asks from WhatsApp snapshot diff batching without blocking execution", async () => {
    const { sock, sent, relayed } = createMockSock();
    const reactionRuntime = createReactionRuntime();
    const sendPromise = sendEvent(sock, "test-chat", runtimeFileChangeEvent({
      path: "/tmp/huge.js",
      cwd: "/tmp",
      source: "snapshot",
      changeKind: "update",
      diff: [
        "--- a/huge.js",
        "+++ b/huge.js",
        buildMultiBatchDiffText(640),
      ].join("\n"),
    }), undefined, reactionRuntime);

    await waitFor(() => sent.some((entry) => /Continue rendering/.test(String(entry.msg.text ?? ""))));
    await sendPromise;
    const prompt = sent.find((entry) => /Continue rendering/.test(String(entry.msg.text ?? "")));
    assert.match(String(prompt?.msg.text ?? ""), /Snapshot diff rendered 1000 of \d+ lines/);
    assert.match(String(prompt?.msg.text ?? ""), /React 👍 to continue or 👎 to stop/);
    assert.equal(
      relayed.filter((entry) => entry.msg.imageMessage != null).length,
      MAX_RENDERED_IMAGES_PER_BLOCK,
    );

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "test-chat" },
      reaction: { text: "👍" },
      senderId: "user-1",
    }]);
    await waitFor(() => relayed.filter((entry) => entry.msg.imageMessage != null).length > MAX_RENDERED_IMAGES_PER_BLOCK);

    assert.ok(
      relayed.filter((entry) => entry.msg.imageMessage != null).length > MAX_RENDERED_IMAGES_PER_BLOCK,
      "Expected snapshot continuation to render more images after approval",
    );
    assert.equal(
      sent.filter((entry) => /Continue rendering/.test(String(entry.msg.text ?? ""))).length,
      1,
    );
    assert.equal(
      sent.some((entry) => /Diff truncated/.test(String(entry.msg.text ?? ""))),
      false,
    );
  });

  it("renders file-change diff blocks from unified diff hunks without expanding the full file", () => {
    const content = renderFileChangeContent({
      kind: "file_change",
      path: "/tmp/plain.txt",
      cwd: "/tmp",
      changeKind: "update",
      oldText: "before\nline 2\nline 3\n",
      newText: "after\nline 2\nline 3\n",
      diff: [
        "--- a/plain.txt",
        "+++ b/plain.txt",
        "@@ -1,3 +1,3 @@",
        "-before",
        "+after",
        " line 2",
        " line 3",
      ].join("\n"),
    });

    assert.ok(Array.isArray(content), "Expected diff content blocks");
    const diffBlock = /** @type {DiffContentBlock} */ (content[0]);
    assert.equal(diffBlock.type, "diff");
    assert.equal(diffBlock.diffText, [
      "@@ -1,3 +1,3 @@",
      "-before",
      "+after",
      " line 2",
      " line 3",
    ].join("\n"));
    assert.equal(diffBlock.caption, "*Update*  `plain.txt`");
  });

  it("renders old/new file-change text as a bounded contextual diff when no prebuilt diff is present", () => {
    const oldText = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const newText = [...oldText];
    newText[19] = "changed line 20";
    const content = renderFileChangeContent({
      kind: "file_change",
      path: "/tmp/plain.txt",
      cwd: "/tmp",
      changeKind: "update",
      oldText: `${oldText.join("\n")}\n`,
      newText: `${newText.join("\n")}\n`,
    });

    assert.ok(Array.isArray(content), "Expected diff content blocks");
    const diffBlock = /** @type {DiffContentBlock} */ (content[0]);
    assert.equal(diffBlock.type, "diff");
    assert.equal(diffBlock.oldStr, "");
    assert.equal(diffBlock.newStr, "");
    assert.match(diffBlock.diffText ?? "", /@@ -12,17 \+12,17 @@/);
    assert.match(diffBlock.diffText ?? "", / line 12/);
    assert.match(diffBlock.diffText ?? "", / line 28/);
    assert.match(diffBlock.diffText ?? "", /-line 20/);
    assert.match(diffBlock.diffText ?? "", /\+changed line 20/);
    assert.doesNotMatch(diffBlock.diffText ?? "", / line 11/);
    assert.doesNotMatch(diffBlock.diffText ?? "", / line 29/);
    assert.equal(diffBlock.caption, "*Update*  `plain.txt`");
  });

  it("renders brand-new file writes as code blocks instead of diffs", () => {
    const content = renderFileChangeContent({
      kind: "file_change",
      path: "/tmp/src/new-file.js",
      cwd: "/tmp",
      changeKind: "add",
      newText: "export const value = 1;\n",
      diff: [
        "--- /dev/null",
        "+++ b/src/new-file.js",
        "@@ -0,0 +1 @@",
        "+export const value = 1;",
      ].join("\n"),
    });

    assert.ok(Array.isArray(content), "Expected file-change content blocks");
    const codeBlock = /** @type {CodeContentBlock} */ (content[0]);
    assert.equal(codeBlock.type, "code");
    assert.equal(codeBlock.language, "javascript");
    assert.equal(codeBlock.code, "export const value = 1;\n");
    assert.equal(codeBlock.caption, "*Add*  `src/new-file.js`");
  });

  it("renders writes labeled add as diffs when prior text exists", () => {
    const content = renderFileChangeContent({
      kind: "file_change",
      path: "/tmp/src/existing.js",
      cwd: "/tmp",
      changeKind: "add",
      oldText: "export const value = 1;\n",
      newText: "export const value = 2;\n",
      diff: [
        "--- a/src/existing.js",
        "+++ b/src/existing.js",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
      ].join("\n"),
    });

    assert.ok(Array.isArray(content), "Expected file-change content blocks");
    const diffBlock = /** @type {DiffContentBlock} */ (content[0]);
    assert.equal(diffBlock.type, "diff");
    assert.equal(diffBlock.caption, "*Update*  `src/existing.js`");
  });

  it("renders deleted files with an explicit delete label", () => {
    const content = renderFileChangeContent({
      kind: "file_change",
      path: "/tmp/src/delete-me.js",
      cwd: "/tmp",
      changeKind: "delete",
      oldText: "export const value = 1;\n",
      diff: [
        "--- a/src/delete-me.js",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const value = 1;",
      ].join("\n"),
    });

    assert.ok(Array.isArray(content), "Expected file-change content blocks");
    const diffBlock = /** @type {DiffContentBlock} */ (content[0]);
    assert.equal(diffBlock.type, "diff");
    assert.equal(diffBlock.diffText, [
      "@@ -1 +0,0 @@",
      "-export const value = 1;",
    ].join("\n"));
    assert.equal(diffBlock.caption, "*Delete*  `src/delete-me.js`");
  });

  it("uses deletion diff headers over stale update labels", () => {
    const content = renderFileChangeContent({
      kind: "file_change",
      path: "/tmp/src/delete-me.js",
      cwd: "/tmp",
      changeKind: "update",
      oldText: "export const value = 1;\n",
      newText: "",
      diff: [
        "--- a/src/delete-me.js",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const value = 1;",
      ].join("\n"),
    });

    assert.ok(Array.isArray(content), "Expected file-change content blocks");
    const diffBlock = /** @type {DiffContentBlock} */ (content[0]);
    assert.equal(diffBlock.type, "diff");
    assert.equal(diffBlock.caption, "*Delete*  `src/delete-me.js`");
  });

  it("renders proposed file changes with a lifecycle-specific title even without a diff", () => {
    const content = renderFileChangeContent({
      kind: "file_change",
      path: "/tmp/src/file.js",
      cwd: "/tmp",
      stage: "proposed",
      changeKind: "update",
      summary: "/tmp/src/file.js (update)",
    });

    assert.equal(content, "*Proposed File Change*  `src/file.js`");
  });

  it("handles type 'text' without image rendering", async () => {
    const { sock, sent } = createMockSock();

    const textWithCode = "Here is ```console.log('hi')``` inline.";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "text", text: textWithCode }]);

    const imageMessages = sent.filter(s => s.msg.image != null);
    assert.equal(imageMessages.length, 0, "Text blocks should NOT render images");
    assert.equal(sent.length, 1, "Should send one text message");
  });
});

describe("sendBlocks – file attachments", () => {
  it("sends file blocks as WhatsApp documents", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "tool-result", [{
      type: "file",
      encoding: "base64",
      mime_type: "application/pdf",
      file_name: "report.pdf",
      data: Buffer.from("fake-pdf").toString("base64"),
    }]);

    assert.equal(sent.length, 1);
    assert.ok(Buffer.isBuffer(sent[0].msg.document), "Document payload should be a Buffer");
    assert.equal(sent[0].msg.mimetype, "application/pdf");
    assert.equal(sent[0].msg.fileName, "report.pdf");
  });
});

describe("sendBlocks – MessageHandle tracking", () => {
  it("returns handle for text blocks with a transport handle id", async () => {
    const { sock } = createMockSock();

    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "text", text: "hello" },
    ]);

    assert.ok(handle, "Should return a handle");
    assert.equal(typeof handle, "object", "Handle should be an object");
    assert.equal(typeof handle.update, "function", "Handle should have update method");
    assert.equal(typeof handle.setInspect, "function", "Handle should have setInspect method");
    assert.equal(typeof handle.transportHandleId, "string");
  });

  it("returns handle for code image blocks with a transport handle id", async () => {
    const { sock } = createMockSock();

    // 6-line JS code will trigger image rendering
    const code = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;";
    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "code", language: "javascript", code },
    ]);

    assert.ok(handle, "Should return a handle for code images");
    assert.equal(typeof handle.transportHandleId, "string");
  });

  it("tracks the last editable message when multiple blocks are sent", async () => {
    const { sock } = createMockSock();

    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);

    assert.ok(handle, "Should return a handle");
    assert.equal(typeof handle.transportHandleId, "string");
  });

  it("returns undefined when no editable messages are sent", async () => {
    const { sock } = createMockSock();

    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "audio", encoding: "base64", data: Buffer.from("fake").toString("base64"), mime_type: "audio/mp4" },
    ]);

    assert.equal(handle, undefined);
  });

  it("handle.update calls editWhatsAppMessage when invoked", async () => {
    const { sock, sent } = createMockSock();

    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "text", text: "original" },
    ]);

    assert.ok(handle);
    await handle.update({ kind: "text", text: "updated" });

    const editCall = sent[1];
    assert.ok(editCall, "Handle.update should have sent an edit");
    assert.ok(
      typeof editCall.msg.text === "string" && editCall.msg.text.includes("updated"),
      "Edit should contain the new text",
    );
    assert.deepEqual(editCall.msg.edit, { id: "msg-1", remoteJid: "test-chat", fromMe: true });
  });
});

describe("sendBlocks – options propagation", () => {
  it("passes quoted option to all sock.sendMessage calls", async () => {
    /** @type {Array<{ chatId: string; msg: Record<string, unknown>; opts?: Record<string, unknown> }>} */
    const sent = [];
    const sock = {
      sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown> | undefined} */ opts) => {
        sent.push({ chatId, msg, opts });
        return { key: { id: `msg-${sent.length}`, remoteJid: chatId } };
      },
    };

    const quotedMsg = { key: { id: "original-msg", remoteJid: "test-chat" } };
    await sendBlocks(sock, "test-chat", "llm", [
      { type: "text", text: "reply" },
    ], { quoted: /** @type {BaileysMessage} */ (quotedMsg) });

    assert.ok(sent[0].opts?.quoted === quotedMsg, "Should pass quoted to sock.sendMessage");
  });
});

describe("sendBlocks – outbound diagnostics", () => {
  it("captures a runtime-gated outgoing send, edit, and inspect reaction timeline", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-diagnostics-"));
    const captureDir = path.join(tempDir, "capture");
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    const fixtureCapture = createFixtureCapture({
      diagnosticsState: diagnostics,
      baseDir: captureDir,
      now: () => new Date("2026-06-21T09:00:00.000Z"),
    });
    const { sock, sent } = createMockSock();
    const reactionRuntime = createReactionRuntime();

    setDefaultFixtureCaptureForTesting(fixtureCapture);
    try {
      await sendBlocks(
        sock,
        "diag-chat",
        "plain",
        [{ type: "text", text: "Thinking..." }],
        undefined,
        reactionRuntime,
      );
      await fixtureCapture.waitForIdle();
      await assert.rejects(() => fs.readdir(captureDir), { code: "ENOENT" });

      await diagnostics.update({
        capture: {
          seams: {
            "whatsapp.outbound": {
              enabledUntil: "2026-06-21T09:05:00.000Z",
              rotateMinutes: 1,
              retentionHours: 24,
              queueLimit: 100,
            },
          },
        },
      });
      const handle = await sendBlocks(
        sock,
        "diag-chat",
        "plain",
        [{ type: "text", text: "Thinking..." }],
        undefined,
        reactionRuntime,
      );
      assert.ok(handle);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "**Finalizing documentation details**\n\nI need to keep this concise.",
      });
      reactionRuntime.handleReactions([{
        key: { id: "msg-2", remoteJid: "diag-chat" },
        reaction: { text: "👁" },
        senderId: "diag-chat",
        fromMe: true,
      }]);
      await handle.update({ kind: "text", text: "Thought" });

      await waitFor(() => sent.some((entry) => entry.msg.react));
      await fixtureCapture.waitForIdle();
    } finally {
      setDefaultFixtureCaptureForTesting(null);
    }

    const records = await readJsonl(path.join(captureDir, "whatsapp-outbound.2026-06-21T09-00Z.ndjson"));
    const entries = records.filter((entry) => entry.recordType === "fixtureCapture.event").map((entry) => entry.payload);
    assert.ok(entries.some((entry) => entry.transport === "sendMessage"
      && entry.phase === "sent"
      && entry.chatId === "diag-chat"
      && entry.message?.text === "Thinking..."));
    assert.ok(entries.some((entry) => entry.transport === "sendMessage"
      && entry.phase === "sent"
      && entry.message?.react?.text === "👁"
      && entry.message?.react?.key?.id === "msg-2"));
    assert.ok(entries.some((entry) => entry.transport === "messageHandle"
      && entry.phase === "attached"
      && entry.trace?.cause === "handle.setInspect"
      && entry.trace?.willEditVisibleMessage === false
      && entry.message?.text?.includes("Finalizing documentation details")));
    assert.ok(entries.some((entry) => entry.transport === "messageHandle"
      && entry.phase === "ignored"
      && entry.trace?.cause === "reaction.inspect"
      && entry.trace?.reason === "reaction-from-me"
      && entry.trace?.reactionFromMe === true
      && entry.message?.react?.key?.id === "msg-2"));
    assert.ok(entries.some((entry) => entry.transport === "sendMessage"
      && entry.phase === "sent"
      && entry.message?.text === "Thought"
      && entry.message?.edit?.id === "msg-2"));
    assert.equal(entries.some((entry) => entry.transport === "sendMessage"
      && entry.message?.text?.includes("Finalizing documentation details")), false);
  });

  it("observes message-handle edit queue replacement before the socket send", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-diagnostics-"));
    const captureDir = path.join(tempDir, "capture");
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    await diagnostics.update({
      capture: {
        seams: {
          "whatsapp.outbound": {
            enabledUntil: "2026-06-21T09:05:00.000Z",
            rotateMinutes: 1,
            retentionHours: 24,
            queueLimit: 100,
          },
        },
      },
    });
    const fixtureCapture = createFixtureCapture({
      diagnosticsState: diagnostics,
      baseDir: captureDir,
      now: () => new Date("2026-06-21T09:00:00.000Z"),
    });
    const previousDelay = process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
    process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = "20";
    const { sock } = createMockSock();

    setDefaultFixtureCaptureForTesting(fixtureCapture);
    try {
      const handle = await sendBlocks(
        sock,
        "diag-chat",
        "plain",
        [{ type: "text", text: "running" }],
      );
      assert.ok(handle);

      const firstUpdate = handle.update({ kind: "text", text: "first progress" });
      const secondUpdate = handle.update({ kind: "text", text: "second progress" });
      const finalUpdate = handle.update({ kind: "text", text: "final progress" });
      await Promise.all([firstUpdate, secondUpdate, finalUpdate]);
      await fixtureCapture.waitForIdle();
    } finally {
      setDefaultFixtureCaptureForTesting(null);
      if (previousDelay === undefined) {
        delete process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
      } else {
        process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = previousDelay;
      }
    }

    const records = await readJsonl(path.join(captureDir, "whatsapp-outbound.2026-06-21T09-00Z.ndjson"));
    const entries = records.filter((entry) => entry.recordType === "fixtureCapture.event").map((entry) => entry.payload);
    assert.ok(entries.some((entry) => entry.transport === "messageHandle"
      && entry.phase === "queued"
      && entry.trace?.cause === "handle.update"
      && entry.trace?.renderMode === "visible"
      && entry.message?.text === "first progress"));
    assert.equal(entries.filter((entry) => entry.transport === "messageHandle"
      && entry.phase === "replaced"
      && entry.trace?.replacedQueuedEdit === true).length, 2);
    assert.ok(entries.some((entry) => entry.transport === "messageHandle"
      && entry.phase === "flushing"
      && entry.message?.text === "final progress"));
    assert.ok(entries.some((entry) => entry.transport === "sendMessage"
      && entry.phase === "sent"
      && entry.message?.text === "final progress"));
    assert.equal(entries.some((entry) => entry.transport === "sendMessage"
      && entry.message?.text === "first progress"), false);
    assert.equal(entries.some((entry) => entry.transport === "sendMessage"
      && entry.message?.text === "second progress"), false);
  });
});

describe("sendBlocks – tool-call → edit pipeline", () => {
  /**
   * Create a mock socket that records both sendMessage and relayMessage calls.
   * @returns {{ sock: WhatsAppOutboundSocketPort & WhatsAppSocketRelayMessagePort, calls: Array<{ method: string; args: unknown[] }> }}
   */
  function createCaptureSock() {
    /** @type {Array<{ method: string; args: unknown[] }>} */
    const calls = [];
    let counter = 0;
    /** @type {WhatsAppOutboundSocketPort & WhatsAppSocketRelayMessagePort} */
    const sock = {
      sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown> | undefined} */ opts) => {
        calls.push({ method: "sendMessage", args: [chatId, msg, opts] });
        counter++;
        return /** @type {BaileysMessage} */ ({ key: { id: `msg-${counter}`, remoteJid: chatId } });
      },
      relayMessage: async (/** @type {string} */ jid, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown>} */ opts) => {
        calls.push({ method: "relayMessage", args: [jid, msg, opts] });
      },
    };
    return { sock, calls };
  }

  /**
   * @param {Array<{ method: string; args: unknown[] }>} calls
   * @returns {Array<Record<string, unknown> & { text: string, edit?: unknown }>}
   */
  function sentTextMessages(calls) {
    return calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => /** @type {Record<string, unknown>} */ (call.args[1]))
      .filter((msg) => typeof msg.text === "string")
      .map((msg) => /** @type {Record<string, unknown> & { text: string, edit?: unknown }} */ (msg));
  }

  it("text tool-call: send → progress update → final update uses sendMessage with edit key", async () => {
    const { sock, calls } = createCaptureSock();

    // Step 1: Send initial tool-call message
    const handle = await sendBlocks(sock, "chat-1", "tool-call", [
      { type: "text", text: "Read file.js" },
    ]);

    assert.ok(handle, "Should return a handle");
    assert.equal(typeof handle.transportHandleId, "string");
    assert.equal(calls.length, 1, "Should have sent 1 message");

    // Step 2: Simulate progress update (tool still running)
    await handle.update({ kind: "text", text: "Read (3s…)" });
    assert.equal(calls.length, 2, "Should have 2 calls after progress update");

    const progressCall = calls[1];
    assert.equal(progressCall.method, "sendMessage", "Progress update should use sendMessage");
    const progressMsg = /** @type {Record<string, unknown>} */ (progressCall.args[1]);
    assert.ok(typeof progressMsg.text === "string" && progressMsg.text.includes("Read (3s…)"), "Progress text should be in edit");
    assert.ok(progressMsg.edit != null, "Should include edit key for in-place update");

    // Step 3: Simulate final result
    await handle.update({ kind: "text", text: "Read · file.js (42 lines)" });
    assert.equal(calls.length, 3, "Should have 3 calls after final update");

    const finalCall = calls[2];
    const finalMsg = /** @type {Record<string, unknown>} */ (finalCall.args[1]);
    assert.ok(typeof finalMsg.text === "string" && finalMsg.text.includes("Read · file.js"), "Final text should be in edit");
    const editKey = /** @type {{ id: string, fromMe?: boolean }} */ (finalMsg.edit);
    assert.equal(editKey.id, "msg-1", "Edit key should reference the original message");
    assert.equal(editKey.fromMe, true, "Edit key should be an outgoing message key");
  });

  it("debounces rapid updates to the same text message handle", async () => {
    const previousDelay = process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
    process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = "20";
    try {
      const { sock, calls } = createCaptureSock();
      const handle = await sendBlocks(sock, "chat-1", "tool-call", [
        { type: "text", text: "running" },
      ]);

      assert.ok(handle);
      const firstUpdate = handle.update({ kind: "text", text: "first progress" });
      const secondUpdate = handle.update({ kind: "text", text: "second progress" });
      const finalUpdate = handle.update({ kind: "text", text: "final progress" });

      assert.equal(calls.length, 1, "Updates should not edit immediately while debounced");
      await Promise.all([firstUpdate, secondUpdate, finalUpdate]);

      assert.equal(calls.length, 2, "Rapid updates should be coalesced into one edit");
      const editMsg = /** @type {Record<string, unknown>} */ (calls[1].args[1]);
      assert.ok(typeof editMsg.text === "string" && editMsg.text.includes("final progress"));
      assert.ok(typeof editMsg.text === "string" && !editMsg.text.includes("first progress"));
      assert.ok(typeof editMsg.text === "string" && !editMsg.text.includes("second progress"));
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
      } else {
        process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = previousDelay;
      }
    }
  });

  it("lets inspected mode replace queued visible edits with the latest inspect render", async () => {
    const previousDelay = process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
    process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = "20";
    try {
      const { sock, calls } = createCaptureSock();
      const reactionRuntime = createReactionRuntime();
      const handle = await sendBlocks(
        sock,
        "chat-1",
        "llm",
        [{ type: "text", text: "Thinking..." }],
        undefined,
        reactionRuntime,
      );

      assert.ok(handle);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "Inspectable reasoning",
      });
      await waitFor(() => calls.some((call) => {
        const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
        return typeof msg.react === "object" && msg.react !== null;
      }));

      const pendingUpdate = handle.update({ kind: "text", text: "late visible chunk" });
      reactionRuntime.handleReactions([{
        key: { id: "msg-1", remoteJid: "chat-1" },
        reaction: { text: "👁" },
        senderId: "user-1",
      }]);

      await pendingUpdate;
      await handle.update({ kind: "text", text: "newer visible chunk" });
      await new Promise((resolve) => setTimeout(resolve, 30));

      const editMessages = sentTextMessages(calls).filter((msg) => msg.edit);
      assert.equal(editMessages.length, 2);
      const texts = editMessages.map((msg) => msg.text).filter((text) => typeof text === "string");
      assert.ok(texts.some((text) => text.includes("Inspectable reasoning")));
      assert.equal(texts.some((text) => text.includes("late visible chunk")), false);
      assert.equal(texts.some((text) => text.includes("newer visible chunk")), false);
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
      } else {
        process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = previousDelay;
      }
    }
  });

  it("coalesces inspected updates to the latest attached inspect data", async () => {
    const previousDelay = process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
    process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = "20";
    try {
      const { sock, calls } = createCaptureSock();
      const reactionRuntime = createReactionRuntime();
      const handle = await sendBlocks(
        sock,
        "chat-1",
        "llm",
        [{ type: "text", text: "Thinking..." }],
        undefined,
        reactionRuntime,
      );

      assert.ok(handle);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "first inspect chunk",
      });
      await waitFor(() => calls.some((call) => {
        const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
        return typeof msg.react === "object" && msg.react !== null;
      }));

      reactionRuntime.handleReactions([{
        key: { id: "msg-1", remoteJid: "chat-1" },
        reaction: { text: "👁" },
        senderId: "user-1",
      }]);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "second inspect chunk",
      });
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "final inspect chunk",
      });

      await waitFor(() => sentTextMessages(calls).length >= 2);
      const editMessages = sentTextMessages(calls).filter((msg) => msg.edit);
      assert.equal(editMessages.length, 1);
      assert.ok(editMessages[0]?.text?.includes("final inspect chunk"));
      assert.equal(editMessages[0]?.text?.includes("first inspect chunk"), false);
      assert.equal(editMessages[0]?.text?.includes("second inspect chunk"), false);
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
      } else {
        process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = previousDelay;
      }
    }
  });

  it("does not queue duplicate inspected renders for unchanged inspect data", async () => {
    const previousDelay = process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
    process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = "20";
    try {
      const { sock, calls } = createCaptureSock();
      const reactionRuntime = createReactionRuntime();
      const handle = await sendBlocks(
        sock,
        "chat-1",
        "llm",
        [{ type: "text", text: "Thinking..." }],
        undefined,
        reactionRuntime,
      );

      assert.ok(handle);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "_Reasoning details are not displayed._",
      });
      await waitFor(() => calls.some((call) => {
        const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
        return typeof msg.react === "object" && msg.react !== null;
      }));

      reactionRuntime.handleReactions([{
        key: { id: "msg-1", remoteJid: "chat-1" },
        reaction: { text: "👁" },
        senderId: "user-1",
      }]);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "_Reasoning details are not displayed._",
      });
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "_Reasoning details are not displayed._",
      });

      await waitFor(() => sentTextMessages(calls).length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const editMessages = sentTextMessages(calls).filter((msg) => msg.edit);
      assert.equal(editMessages.length, 1);
      assert.ok(editMessages[0]?.text?.includes("_Reasoning details are not displayed._"));
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
      } else {
        process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = previousDelay;
      }
    }
  });

  it("image tool-call: send → edit uses relayMessage for caption update", async () => {
    const { sock, calls } = createCaptureSock();

    // Send a code block that renders as an image (6+ lines triggers image rendering)
    const code = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;";
    const handle = await sendBlocks(sock, "chat-1", "tool-call", [
      { type: "code", language: "javascript", code },
    ]);

    assert.ok(handle, "Should return a handle for code image");
    assert.equal(typeof handle.transportHandleId, "string");

    const initialCallCount = calls.length;

    // Edit the image caption
    await handle.update({ kind: "text", text: "Edit · foo.js" });

    // Image edits use relayMessage, not sendMessage
    const editCall = calls[initialCallCount];
    assert.equal(editCall.method, "relayMessage", "Image caption edit should use relayMessage");
    const relayMsg = /** @type {Record<string, unknown>} */ (editCall.args[1]);
    const protoMsg = /** @type {Record<string, unknown>} */ (relayMsg.protocolMessage);
    assert.ok(protoMsg, "Should contain protocolMessage");
    const editedMsg = /** @type {Record<string, unknown>} */ (protoMsg.editedMessage);
    const imageMsg = /** @type {{ caption: string }} */ (editedMsg.imageMessage);
    assert.ok(imageMsg.caption.includes("Edit · foo.js"), "Caption should contain the new text");
  });

  it("handle.update prepends source prefix on every edit", async () => {
    const { sock, calls } = createCaptureSock();

    const handle = await sendBlocks(sock, "chat-1", "tool-call", [
      { type: "text", text: "running" },
    ]);

    assert.ok(handle);
    await handle.update({ kind: "text", text: "done" });

    const editMsg = /** @type {Record<string, unknown>} */ (calls[1].args[1]);
    const editText = /** @type {string} */ (editMsg.text);
    // "tool-call" prefix is "🔧"
    assert.ok(editText.startsWith("🔧"), `Edit text should start with tool-call prefix, got: ${editText}`);
    assert.ok(editText.includes("done"), "Edit text should contain new content");
  });

  it("plain source sends and edits text without an automatic prefix", async () => {
    const { sock, calls } = createCaptureSock();

    const handle = await sendBlocks(sock, "chat-1", "plain", [
      { type: "text", text: "🔧Read `src/app.js`" },
    ]);

    assert.ok(handle);
    const firstMsg = /** @type {Record<string, unknown>} */ (calls[0].args[1]);
    assert.equal(firstMsg.text, "🔧Read `src/app.js`");

    await handle.update({ kind: "text", text: "🔧Read `src/app.js`\n🔧Bash `git diff`" });

    const editMsg = /** @type {Record<string, unknown>} */ (calls[1].args[1]);
    assert.equal(editMsg.text, "🔧Read `src/app.js`\n🔧Bash `git diff`");
  });

  it("reacts with the inspect emoji when a sent message becomes inspectable", async () => {
    const { sock, calls } = createCaptureSock();
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "chat-1",
      "plain",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspectable reasoning",
    });
    await waitFor(() => calls.some((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    }));

    const reactionCall = calls.find((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    });
    assert.ok(reactionCall);
    const reactionMsg = /** @type {{ react: { text: string, key: Record<string, unknown> } }} */ (reactionCall.args[1]);
    assert.equal(reactionMsg.react.text, "👁");
    assert.deepEqual(reactionMsg.react.key, { id: "msg-1", remoteJid: "chat-1" });

    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Updated inspectable reasoning",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reactionCalls = calls.filter((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    });
    assert.equal(reactionCalls.length, 1);
  });

  it("ignores bot-authored inspect marker reactions", async () => {
    const { sock, calls } = createCaptureSock();
    sock.user = { id: "bot-123:1@s.whatsapp.net" };
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "chat-1",
      "plain",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspectable reasoning",
    });
    await waitFor(() => calls.some((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    }));

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "bot-123:1",
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentTextMessages(calls).length, 1);
    assert.equal(sentTextMessages(calls)[0]?.text, "Thinking...");
  });

  it("ignores inspect marker echoes flagged as fromMe", async () => {
    const { sock, calls } = createCaptureSock();
    sock.user = { id: "bot-123:1@s.whatsapp.net" };
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "chat-1",
      "plain",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspectable reasoning",
    });
    await waitFor(() => calls.some((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    }));

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "chat-1",
      fromMe: true,
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentTextMessages(calls).length, 1);
    assert.equal(sentTextMessages(calls)[0]?.text, "Thinking...");
  });

  it("ignores inspect marker echoes whose alternate sender id matches the bot", async () => {
    const { sock, calls } = createCaptureSock();
    sock.user = { id: "393792375735:1@s.whatsapp.net" };
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "120363042584279820@g.us",
      "plain",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspectable reasoning",
    });
    await waitFor(() => calls.some((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    }));

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "120363042584279820@g.us" },
      reaction: { text: "👁" },
      senderId: "147025689575646",
      senderIds: ["147025689575646", "393792375735"],
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentTextMessages(calls).length, 1);
    assert.equal(sentTextMessages(calls)[0]?.text, "Thinking...");
  });

  it("ignores inspect marker echoes that only identify the group chat", async () => {
    const { sock, calls } = createCaptureSock();
    sock.user = { id: "393792375735:1@s.whatsapp.net" };
    const reactionRuntime = createReactionRuntime();
    const chatId = "120363042584279820@g.us";

    const handle = await sendBlocks(
      sock,
      chatId,
      "plain",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspectable reasoning should stay hidden.",
    });
    await waitFor(() => calls.some((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    }));

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: chatId },
      reaction: { text: "👁" },
      senderId: "120363042584279820",
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentTextMessages(calls).length, 1);
    assert.equal(sentTextMessages(calls)[0]?.text, "Thinking...");
  });

  it("does not arm pending inspect mode from group-only marker echoes", async () => {
    const { sock, calls } = createCaptureSock();
    sock.user = { id: "393792375735:1@s.whatsapp.net" };
    const reactionRuntime = createReactionRuntime();
    const chatId = "120363042584279820@g.us";

    const handle = await sendBlocks(
      sock,
      chatId,
      "plain",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: chatId },
      reaction: { text: "👁" },
      senderId: "120363042584279820",
    }]);

    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspect data arrived later.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentTextMessages(calls).length, 1);
    assert.equal(sentTextMessages(calls)[0]?.text, "Thinking...");

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: chatId },
      reaction: { text: "👁" },
      senderId: "213597330374785",
    }]);

    await waitFor(() => sentTextMessages(calls).some((msg) =>
      msg.edit && msg.text?.includes("Inspect data arrived later.")));
  });

  it("keeps audio transcription inspect hidden for marker echoes whose alternate sender id matches the bot", async () => {
    const { sock, calls } = createCaptureSock();
    sock.user = { id: "393792375735:1@s.whatsapp.net" };
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "120363042584279820@g.us",
      "plain",
      [{ type: "text", text: "Transcribing audio..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "text",
      text: "Audio transcript should stay hidden until user inspection.",
    });
    await handle.update({ kind: "text", text: "Transcribed" });
    await waitFor(() => calls.some((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    }));

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "120363042584279820@g.us" },
      reaction: { text: "👁" },
      senderId: "147025689575646",
      senderIds: ["147025689575646", "393792375735"],
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentTextMessages(calls).length, 2);
    assert.equal(sentTextMessages(calls)[0]?.text, "Transcribing audio...");
    assert.equal(sentTextMessages(calls)[1]?.text, "Transcribed");
  });

  it("keeps audio transcription inspect hidden for marker echoes that only identify the group chat", async () => {
    const { sock, calls } = createCaptureSock();
    sock.user = { id: "393792375735:1@s.whatsapp.net" };
    const reactionRuntime = createReactionRuntime();
    const chatId = "120363042584279820@g.us";

    const handle = await sendBlocks(
      sock,
      chatId,
      "plain",
      [{ type: "text", text: "Transcribing audio..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "text",
      text: "Audio transcript should stay hidden until user inspection.",
    });
    await handle.update({ kind: "text", text: "Transcribed" });
    await waitFor(() => calls.some((call) => {
      const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
      return typeof msg.react === "object" && msg.react !== null;
    }));

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: chatId },
      reaction: { text: "👁" },
      senderId: "120363042584279820",
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentTextMessages(calls).length, 2);
    assert.equal(sentTextMessages(calls)[0]?.text, "Transcribing audio...");
    assert.equal(sentTextMessages(calls)[1]?.text, "Transcribed");
  });

  it("edits the original message to full plain-text inspect output after user 👁 reactions", async () => {
    const { sock, calls } = createCaptureSock();
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "chat-1",
      "plain",
      [{ type: "text", text: "🔧 *Read*  `src/app.js`" }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "text",
      text: [
        "🔧 *Read*  `src/app.js`",
        "🔧 *Shell*  `pnpm type-check`",
      ].join("\n"),
    });

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "user-1",
    }]);

    await waitFor(() => sentTextMessages(calls).length >= 2);
    const inspectMsg = sentTextMessages(calls)[1];
    assert.equal(
      inspectMsg.text,
      "🔧 *Read*  `src/app.js`\n🔧 *Shell*  `pnpm type-check`",
    );

    handle.setInspect({
      kind: "text",
      text: [
        "🔧 *Read*  `src/app.js`",
        "🔧 *Shell*  `pnpm type-check`",
        "🔧 *Shell*  `git diff`",
      ].join("\n"),
    });

    await waitFor(() => sentTextMessages(calls).length >= 3);
    const persistedEditMsg = sentTextMessages(calls)[2];
    assert.equal(
      persistedEditMsg.text,
      "🔧 *Read*  `src/app.js`\n🔧 *Shell*  `pnpm type-check`\n🔧 *Shell*  `git diff`",
    );
  });

  it("reveals long plain-text inspect output in full after user 👁 reactions", async () => {
    const { sock, calls } = createCaptureSock();
    const reactionRuntime = createReactionRuntime();
    const longInspectText = Array.from(
      { length: 500 },
      (_, index) => `🔧 *Shell*  \`command ${String(index).padStart(3, "0")}\``,
    ).join("\n");
    assert.ok(longInspectText.length > 10_000, "test fixture should exceed the old and proposed inspect caps");

    const handle = await sendBlocks(
      sock,
      "chat-1",
      "plain",
      [{ type: "text", text: "🔧 *Shell*  `command 000`" }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "text",
      text: longInspectText,
    });

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "user-1",
    }]);

    await waitFor(() => sentTextMessages(calls).length >= 2);
    const inspectMsg = sentTextMessages(calls)[1];
    assert.equal(typeof inspectMsg.text, "string");
    assert.equal(inspectMsg.text, longInspectText);

    const updatedInspectText = `${longInspectText}\n🔧 *Shell*  \`command 500\``;
    handle.setInspect({
      kind: "text",
      text: updatedInspectText,
    });

    await waitFor(() => sentTextMessages(calls).length >= 3);
    const persistedEditMsg = sentTextMessages(calls)[2];
    assert.equal(typeof persistedEditMsg.text, "string");
    assert.equal(persistedEditMsg.text, updatedInspectText);
  });

  it("formats reasoning inspect text when the user reacts with 👁", async () => {
    const { sock, calls } = createCaptureSock();
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "chat-1",
      "llm",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspect the file, then patch the bug.",
    });

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "user-1",
    }]);

    await waitFor(() => sentTextMessages(calls).length >= 2);
    assert.equal(sentTextMessages(calls).length, 2, "Expected one initial text send and one inspect edit");
    const inspectMsg = sentTextMessages(calls)[1];
    assert.ok(typeof inspectMsg.text === "string" && inspectMsg.text.includes("*Thinking*"));
    assert.ok(typeof inspectMsg.text === "string" && inspectMsg.text.includes("Inspect the file, then patch the bug."));
  });

  it("reveals user-triggered inspect without waiting for the edit debounce", async () => {
    const previousDelay = process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
    process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = "1000";
    try {
      const { sock, calls } = createCaptureSock();
      const reactionRuntime = createReactionRuntime();

      const handle = await sendBlocks(
        sock,
        "chat-1",
        "llm",
        [{ type: "text", text: "Thinking..." }],
        undefined,
        reactionRuntime,
      );

      assert.ok(handle);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "Inspect immediately.",
      });

      reactionRuntime.handleReactions([{
        key: { id: "msg-1", remoteJid: "chat-1" },
        reaction: { text: "👁" },
        senderId: "user-1",
      }]);

      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.ok(
        sentTextMessages(calls).some((msg) => msg.edit && msg.text?.includes("Inspect immediately.")),
        "Expected user inspect to edit immediately instead of waiting for the debounce",
      );
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
      } else {
        process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = previousDelay;
      }
    }
  });

  it("reveals inspect data attached after an earlier user 👁 reaction", async () => {
    const { sock, calls } = createCaptureSock();
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "chat-1",
      "llm",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "user-1",
    }]);

    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspect data arrived later.",
    });

    await waitFor(() => sentTextMessages(calls).some((msg) => msg.edit && msg.text?.includes("Inspect data arrived later.")));
    const inspectMsg = sentTextMessages(calls).find((msg) => msg.edit && msg.text?.includes("Inspect data arrived later."));
    assert.ok(inspectMsg);
    assert.ok(typeof inspectMsg.text === "string" && inspectMsg.text.includes("*Thinking*"));
  });

  it("sends inspect output as a new message when editing the original fails", async () => {
    const { sock, calls } = createCaptureSock();
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (chatId, msg, opts) => {
      if (msg.edit) {
        throw new Error("edit window closed");
      }
      return originalSendMessage(chatId, msg, opts);
    };
    const reactionRuntime = createReactionRuntime();

    const handle = await sendBlocks(
      sock,
      "chat-1",
      "llm",
      [{ type: "text", text: "Thinking..." }],
      undefined,
      reactionRuntime,
    );

    assert.ok(handle);
    handle.setInspect({
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Fallback inspect details.",
    });

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "user-1",
    }]);

    await waitFor(() => sentTextMessages(calls).some((msg) => msg.text?.includes("Fallback inspect details.")));
    const fallbackMsg = sentTextMessages(calls).find((msg) => msg.text?.includes("Fallback inspect details."));
    assert.ok(fallbackMsg);
    assert.equal(fallbackMsg.edit, undefined);
  });

  it("sends only the latest inspect fallback when replaced debounced inspect edits fail", async () => {
    const previousDelay = process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
    process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = "20";
    try {
      const { sock, calls } = createCaptureSock();
      const originalSendMessage = sock.sendMessage.bind(sock);
      sock.sendMessage = async (chatId, msg, opts) => {
        if (msg.edit) {
          throw new Error("edit window closed");
        }
        return originalSendMessage(chatId, msg, opts);
      };
      const reactionRuntime = createReactionRuntime();

      const handle = await sendBlocks(
        sock,
        "chat-1",
        "llm",
        [{ type: "text", text: "Thinking..." }],
        undefined,
        reactionRuntime,
      );

      assert.ok(handle);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "first inspect detail",
      });
      await waitFor(() => calls.some((call) => {
        const msg = /** @type {Record<string, unknown>} */ (call.args[1]);
        return typeof msg.react === "object" && msg.react !== null;
      }));

      reactionRuntime.handleReactions([{
        key: { id: "msg-1", remoteJid: "chat-1" },
        reaction: { text: "👁" },
        senderId: "user-1",
      }]);
      handle.setInspect({
        kind: "reasoning",
        summary: "*Thinking*",
        text: "final inspect detail",
      });

      await waitFor(() => sentTextMessages(calls).some((msg) => msg.text?.includes("final inspect detail")));
      await new Promise((resolve) => setTimeout(resolve, 30));

      const fallbackMessages = sentTextMessages(calls).filter((msg) => !msg.edit && msg.text?.includes("inspect detail"));
      assert.equal(fallbackMessages.length, 1);
      assert.ok(fallbackMessages[0]?.text?.includes("final inspect detail"));
      assert.equal(fallbackMessages[0]?.text?.includes("first inspect detail"), false);
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS;
      } else {
        process.env.MADABOT_WHATSAPP_EDIT_DEBOUNCE_MS = previousDelay;
      }
    }
  });

  it("editWhatsAppMessage directly: text path sends edit key", async () => {
    const { sock, calls } = createCaptureSock();
    const key = { id: "msg-abc", remoteJid: "chat-1" };

    await editWhatsAppMessage(sock, "chat-1", "updated text", { fallbackKeyId: key.id });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "sendMessage");
    const msg = /** @type {Record<string, unknown>} */ (calls[0].args[1]);
    assert.equal(msg.text, "updated text");
    assert.deepEqual(msg.edit, { id: "msg-abc", remoteJid: "chat-1", fromMe: true });
  });

  it("editWhatsAppMessage directly: image path uses relayMessage with protocolMessage", async () => {
    const { sock, calls } = createCaptureSock();
    const key = { id: "msg-xyz", remoteJid: "chat-1" };

    await editWhatsAppMessage(sock, "chat-1", "new caption", {
      messageKey: key,
      messageKind: "image",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "relayMessage");
    const relayMsg = /** @type {Record<string, unknown>} */ (calls[0].args[1]);
    const proto = /** @type {Record<string, unknown>} */ (relayMsg.protocolMessage);
    assert.ok(proto, "Should have protocolMessage");
    assert.deepEqual(proto.key, { ...key, fromMe: true }, "Should reference the original outgoing message key");
    const edited = /** @type {Record<string, unknown>} */ (proto.editedMessage);
    const imgMsg = /** @type {{ caption: string }} */ (edited.imageMessage);
    assert.equal(imgMsg.caption, "new caption");
    // Check additionalAttributes
    const opts = /** @type {{ additionalAttributes: Record<string, string> }} */ (calls[0].args[2]);
    assert.equal(opts.additionalAttributes.edit, "1", "Should have edit='1' attribute");
  });

  it("editWhatsAppMessageByHandle rejects when the WhatsApp edit handle is expired", async () => {
    const { sock, calls } = createCaptureSock();
    const now = new Date("2026-05-26T12:15:00.000Z");

    await assert.rejects(
      () => editWhatsAppMessageByHandle(sock, "expired-handle", "Restarted.", {
        now,
        store: /** @type {import("../store.js").Store} */ (/** @type {unknown} */ ({
          getWhatsAppEditHandle: async () => ({
            id: "expired-handle",
            chat_id: "chat-1",
            message_key_json: { id: "msg-old", remoteJid: "chat-1" },
            message_kind: "text",
            created_at: "2026-05-26T12:00:00.000Z",
            expires_at: "2026-05-26T12:14:00.000Z",
          }),
        })),
      }),
      /WhatsApp edit handle expired-handle expired\./,
    );

    assert.equal(calls.length, 0);
  });

  it("editWhatsAppMessageByHandle reads persisted JSON string message keys", async () => {
    const { sock, calls } = createCaptureSock();

    await editWhatsAppMessageByHandle(sock, "persisted-handle", "Restarted.", {
      now: new Date("2026-05-26T12:05:00.000Z"),
      store: /** @type {import("../store.js").Store} */ (/** @type {unknown} */ ({
        getWhatsAppEditHandle: async () => ({
          id: "persisted-handle",
          chat_id: "chat-1",
          message_key_json: JSON.stringify({ id: "msg-persisted", remoteJid: "chat-1", fromMe: true }),
          message_kind: "text",
          created_at: "2026-05-26T12:00:00.000Z",
          expires_at: "2026-05-26T12:14:00.000Z",
        }),
      })),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "sendMessage");
    const msg = /** @type {Record<string, unknown>} */ (calls[0].args[1]);
    assert.equal(msg.text, "Restarted.");
    assert.deepEqual(msg.edit, { id: "msg-persisted", remoteJid: "chat-1", fromMe: true });
  });
});

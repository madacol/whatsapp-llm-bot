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
import { runtimeEvent } from "../outbound-events.js";
import { buildToolPresentation } from "../whatsapp/tool-presentation-model.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";
import { createAcpRuntimeModel } from "../harnesses/acp-events.js";
import { MAX_RENDERED_IMAGES_PER_BLOCK } from "../message-renderer.js";

const VISIBLE_TOOL_OUTPUT = { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: true };
const COMPACT_TOOL_OUTPUT = { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false };

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
 * @returns {string}
 */
function buildMultiBatchDiffText() {
  const diffLines = ["@@ -1,320 +1,320 @@"];
  for (let index = 0; index < 320; index += 1) {
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

describe("sendEvent – compact tool activity", () => {
  it("renders compact activity state inside WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "compact-chat", {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: {
        type: "file_read",
        status: "started",
        command: "sed -n '1,20p' src/app.js",
        paths: ["src/app.js"],
        line: 1,
        limit: 20,
      },
    });
    await sendEvent(sock, "compact-chat", {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: {
        type: "command",
        status: "started",
        command: "pnpm type-check",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Read*  `src/app.js`  *1-20*", linkPreview: null },
      {
        text: "🔧 *Read*  `src/app.js`  *1-20*\n🔧 *Shell*  `pnpm type-check`",
        edit: { id: "msg-1", remoteJid: "compact-chat", fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("closes compact activity before the next progress group", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "compact-close-chat", {
      kind: "compact_tool_activity",
      activity: { type: "command", status: "started", command: "pwd" },
    });
    await sendEvent(sock, "compact-close-chat", {
      kind: "compact_tool_activity",
      activity: { type: "command", status: "started", command: "git diff" },
    });
    await sendEvent(sock, "compact-close-chat", {
      kind: "compact_tool_activity",
      activity: { type: "close" },
    });
    await sendEvent(sock, "compact-close-chat", {
      kind: "compact_tool_activity",
      activity: { type: "command", status: "started", command: "ls" },
    });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Shell*  `pwd`", linkPreview: null },
      {
        text: "🔧 *Shell*  `pwd`\n🔧 *Shell*  `git diff`",
        edit: { id: "msg-1", remoteJid: "compact-close-chat", fromMe: true },
        linkPreview: null,
      },
      { text: "🔧 *Shell*  `ls`", linkPreview: null },
    ]);
  });

  it("formats compact generic tool names inside WhatsApp", async () => {
    const { sock, sent } = createMockSock();
    const readTool = {
      id: "read-file-generic",
      name: "Read file",
      arguments: JSON.stringify({ path: "/repo/whatsapp/tool-presenter.js" }),
    };
    const searchTool = {
      id: "search-generic",
      name: "Search for 'create.*File|Edit|Write' in tool-presentation-model.js",
      arguments: "{}",
    };
    const listTool = {
      id: "list-generic",
      name: "List",
      arguments: JSON.stringify({ path: "/repo/docs" }),
    };

    await sendEvent(sock, "compact-generic-chat", {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: { type: "tool", status: "started", toolCall: readTool },
    });
    await sendEvent(sock, "compact-generic-chat", {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: { type: "tool", status: "completed", toolCall: readTool },
    });
    await sendEvent(sock, "compact-generic-chat", {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: { type: "tool", status: "started", toolCall: searchTool },
    });
    await sendEvent(sock, "compact-generic-chat", {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: { type: "tool", status: "completed", toolCall: searchTool },
    });
    await sendEvent(sock, "compact-generic-chat", {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: { type: "tool", status: "started", toolCall: listTool },
    });
    await sendEvent(sock, "compact-generic-chat", {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: { type: "tool", status: "completed", toolCall: listTool },
    });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Read*  `whatsapp/tool-presenter.js`", linkPreview: null },
      {
        text: "✅ *Read*  `whatsapp/tool-presenter.js`",
        edit: { id: "msg-1", remoteJid: "compact-generic-chat", fromMe: true },
        linkPreview: null,
      },
      {
        text: "✅ *Read*  `whatsapp/tool-presenter.js`\n✅ *Search*  `create.*File|Edit|Write` in *tool-presentation-model.js*",
        edit: { id: "msg-1", remoteJid: "compact-generic-chat", fromMe: true },
        linkPreview: null,
      },
      {
        text: "✅ *Read*  `whatsapp/tool-presenter.js`\n✅ *Search*  `create.*File|Edit|Write` in *tool-presentation-model.js*\n✅ *List*  `docs`",
        edit: { id: "msg-1", remoteJid: "compact-generic-chat", fromMe: true },
        linkPreview: null,
      },
    ]);
  });

  it("formats compact tool rows with the shared semantic tool presentation", async () => {
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
        expected: "Search Web*  \"runtime migration\"",
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
        expected: "Open Link*  `openai.com`",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { sock, sent } = createMockSock();
      const toolCall = {
        id: `compact-runtime-style-${index}`,
        name: testCase.name,
        arguments: JSON.stringify(testCase.args),
      };

      await sendEvent(sock, `compact-runtime-style-${index}`, {
        kind: "compact_tool_activity",
        cwd: "/repo",
        activity: {
          type: "tool",
          status: "started",
          toolCall,
        },
      });
      await sendEvent(sock, `compact-runtime-style-${index}`, {
        kind: "compact_tool_activity",
        cwd: "/repo",
        activity: { type: "tool", status: "completed", toolCall },
      });

      assert.equal(sent[0]?.msg.text, `🔧 *${testCase.expected}`);
      assert.equal(sent[1]?.msg.text, `✅ *${testCase.expected}`);
    }
  });

  it("keeps only recent compact activity rows inside WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    for (const command of ["pwd", "pnpm type-check", "sed -n '1,20p' src/app.js", "git diff"]) {
      await sendEvent(sock, "compact-limit-chat", {
        kind: "compact_tool_activity",
        activity: { type: "command", status: "started", command },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(sent.at(-1)?.msg, {
      text: "... +1 earlier tools\n🔧 *Shell*  `pnpm type-check`\n🔧 *Shell*  `sed -n '1,20p' src/app.js`\n🔧 *Shell*  `git diff`",
      edit: { id: "msg-1", remoteJid: "compact-limit-chat", fromMe: true },
      linkPreview: null,
    });
  });

  it("marks compact command failures inside WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "compact-fail-chat", {
      kind: "compact_tool_activity",
      activity: { type: "command", status: "started", command: "pnpm test" },
    });
    await sendEvent(sock, "compact-fail-chat", {
      kind: "compact_tool_activity",
      activity: { type: "command", status: "failed", command: "pnpm test", output: "boom" },
    });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Shell*  `pnpm test`", linkPreview: null },
      {
        text: "❌ *Shell*  `pnpm test`",
        edit: { id: "msg-1", remoteJid: "compact-fail-chat", fromMe: true },
        linkPreview: null,
      },
    ]);
  });
});

describe("sendEvent – runtime events", () => {
  it("renders ACP file-read runtime progress inside WhatsApp", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-read-chat", {
      kind: "runtime_event",
      event: {
        type: "file-read.started",
        provider: "acp",
        fileRead: {
          command: "sed -n '1,20p' src/app.js",
          paths: ["src/app.js"],
          line: 1,
          limit: 20,
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Read*  `src/app.js`  *1-20*", linkPreview: null },
    ]);
  });

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

  it("renders runtime tool progress as the normal compact tool display", async () => {
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

  it("suppresses compact ACP editing-files placeholders and renders the file-change diff instead", async () => {
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
          source: "provider",
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
        expected: "Search Web*  \"runtime migration\"",
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
        expected: "Open Link*  `openai.com`",
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

  it("reuses the pending ACP command runtime message for duplicate starts", async () => {
    const { sock, sent } = createMockSock();
    const startEvent = /** @type {RuntimeEventOutboundEvent} */ ({
      kind: "runtime_event",
      event: {
        type: "command.started",
        provider: "acp",
        command: {
          command: "pnpm test tests/e2e-adapter.test.js",
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
          command: "pnpm test tests/e2e-adapter.test.js",
          status: "completed",
          output: "ok",
        },
      },
    }, undefined, undefined, { outputVisibility: VISIBLE_TOOL_OUTPUT });

    assert.deepEqual(sent.map((entry) => entry.msg), [
      { text: "🔧 *Shell*  `pnpm test tests/e2e-adapter.test.js`", linkPreview: null },
      {
        text: "✅ *Shell*  `pnpm test tests/e2e-adapter.test.js`",
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

  it("suppresses noisy lifecycle runtime events except turn start", async () => {
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

    assert.deepEqual(sent.map((entry) => entry.msg.text), [
      "🔄 *CODEX*  turn started",
      "🔄 *CODEX*  turn started",
    ]);
  });

  it("folds generic runtime events into one editable WhatsApp status", async () => {
    const { sock, sent } = createMockSock();

    await sendEvent(sock, "runtime-chat", {
      kind: "runtime_event",
      event: {
        type: "session.started",
        provider: "acp",
        session: { id: "session-1", status: "running" },
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
        session: { id: "session-1", status: "running" },
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

  it("resolves markdown attachment directives relative to content event cwd", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-cwd-"));
    await fs.writeFile(path.join(workdir, "website.json"), JSON.stringify({ title: "Demo" }), "utf8");
    const { sock, sent } = createMockSock();

    try {
      await sendEvent(sock, "test-chat", {
        kind: "content",
        source: "llm",
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

  it("asks from WhatsApp snapshot diff batching before rendering remaining lines", async () => {
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
        buildMultiBatchDiffText(),
      ].join("\n"),
    }), undefined, reactionRuntime);

    await waitFor(() => sent.some((entry) => /Continue rendering/.test(String(entry.msg.text ?? ""))));
    const prompt = sent.find((entry) => /Continue rendering/.test(String(entry.msg.text ?? "")));
    assert.match(String(prompt?.msg.text ?? ""), /Snapshot diff rendered 250 of \d+ lines/);
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
    await waitFor(() => sent.filter((entry) => /Continue rendering/.test(String(entry.msg.text ?? ""))).length >= 2);
    reactionRuntime.handleReactions([{
      key: { id: "msg-2", remoteJid: "test-chat" },
      reaction: { text: "👎" },
      senderId: "user-1",
    }]);
    await sendPromise;

    assert.ok(
      relayed.filter((entry) => entry.msg.imageMessage != null).length > MAX_RENDERED_IMAGES_PER_BLOCK,
      "Expected snapshot continuation to render more images after approval",
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
      { type: "audio", data: Buffer.from("fake").toString("base64"), mime_type: "audio/mp4" },
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

describe("sendBlocks – tool-call → edit pipeline", () => {
  /**
   * Create a mock socket that records both sendMessage and relayMessage calls.
   * @returns {{ sock: any, calls: Array<{ method: string; args: unknown[] }> }}
   */
  function createCaptureSock() {
    /** @type {Array<{ method: string; args: unknown[] }>} */
    const calls = [];
    let counter = 0;
    const sock = {
      sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown> | undefined} */ opts) => {
        calls.push({ method: "sendMessage", args: [chatId, msg, opts] });
        counter++;
        return { key: { id: `msg-${counter}`, remoteJid: chatId } };
      },
      relayMessage: async (/** @type {string} */ jid, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown>} */ opts) => {
        calls.push({ method: "relayMessage", args: [jid, msg, opts] });
      },
    };
    return { sock, calls };
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

  it("persists full plain-text inspect output after 👁 reactions", async () => {
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
      persistOnInspect: true,
    });

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "user-1",
    }]);

    const inspectMsg = /** @type {Record<string, unknown>} */ (calls[1].args[1]);
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
      persistOnInspect: true,
    });
    await handle.update({
      kind: "text",
      text: "... +1 earlier tools\n🔧 *Shell*  `pnpm type-check`\n🔧 *Shell*  `git diff`",
    });

    const persistedEditMsg = /** @type {Record<string, unknown>} */ (calls[2].args[1]);
    assert.equal(
      persistedEditMsg.text,
      "🔧 *Read*  `src/app.js`\n🔧 *Shell*  `pnpm type-check`\n🔧 *Shell*  `git diff`",
    );
  });

  it("truncates long plain-text inspect output after 👁 reactions", async () => {
    const { sock, calls } = createCaptureSock();
    const reactionRuntime = createReactionRuntime();
    const longInspectText = Array.from(
      { length: 220 },
      (_, index) => `🔧 *Shell*  \`command ${String(index).padStart(3, "0")}\``,
    ).join("\n");

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
      persistOnInspect: true,
    });

    reactionRuntime.handleReactions([{
      key: { id: "msg-1", remoteJid: "chat-1" },
      reaction: { text: "👁" },
      senderId: "user-1",
    }]);

    const inspectMsg = /** @type {Record<string, unknown>} */ (calls[1].args[1]);
    assert.equal(typeof inspectMsg.text, "string");
    assert.ok(inspectMsg.text.startsWith("🔧 *Shell*  `command 000`"));
    assert.ok(inspectMsg.text.includes("_… truncated ("));
    assert.ok(inspectMsg.text.length < longInspectText.length);

    await handle.update({
      kind: "text",
      text: "... +217 earlier tools\n🔧 *Shell*  `command 217`\n🔧 *Shell*  `command 218`\n🔧 *Shell*  `command 219`",
    });

    const persistedEditMsg = /** @type {Record<string, unknown>} */ (calls[2].args[1]);
    assert.equal(typeof persistedEditMsg.text, "string");
    assert.ok(persistedEditMsg.text.includes("_… truncated ("));
    assert.ok(persistedEditMsg.text.length < longInspectText.length);
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

    assert.equal(calls.length, 2, "Expected one initial send and one inspect edit");
    const inspectCall = calls[1];
    assert.equal(inspectCall.method, "sendMessage");
    const inspectMsg = /** @type {Record<string, unknown>} */ (inspectCall.args[1]);
    assert.ok(typeof inspectMsg.text === "string" && inspectMsg.text.includes("*Thinking*"));
    assert.ok(typeof inspectMsg.text === "string" && inspectMsg.text.includes("Inspect the file, then patch the bug."));
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
        store: /** @type {import("../store.js").Store} */ ({
          getWhatsAppEditHandle: async () => ({
            id: "expired-handle",
            chat_id: "chat-1",
            message_key_json: { id: "msg-old", remoteJid: "chat-1" },
            message_kind: "text",
            created_at: "2026-05-26T12:00:00.000Z",
            expires_at: "2026-05-26T12:14:00.000Z",
          }),
        }),
      }),
      /WhatsApp edit handle expired-handle expired\./,
    );

    assert.equal(calls.length, 0);
  });

  it("editWhatsAppMessageByHandle reads persisted JSON string message keys", async () => {
    const { sock, calls } = createCaptureSock();

    await editWhatsAppMessageByHandle(sock, "persisted-handle", "Restarted.", {
      now: new Date("2026-05-26T12:05:00.000Z"),
      store: /** @type {import("../store.js").Store} */ ({
        getWhatsAppEditHandle: async () => ({
          id: "persisted-handle",
          chat_id: "chat-1",
          message_key_json: JSON.stringify({ id: "msg-persisted", remoteJid: "chat-1", fromMe: true }),
          message_kind: "text",
          created_at: "2026-05-26T12:00:00.000Z",
          expires_at: "2026-05-26T12:14:00.000Z",
        }),
      }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "sendMessage");
    const msg = /** @type {Record<string, unknown>} */ (calls[0].args[1]);
    assert.equal(msg.text, "Restarted.");
    assert.deepEqual(msg.edit, { id: "msg-persisted", remoteJid: "chat-1", fromMe: true });
  });
});

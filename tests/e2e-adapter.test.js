process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMockLlmServer,
  createMockBaileysSocket,
  createWAMessage,
  createTestDb,
  seedChat,
} from "./helpers.js";
import { registerAcpTestHarness, ZERO_USAGE } from "./acp-test-harness.js";
import { setDb } from "../db.js";
import { adaptIncomingMessage } from "../whatsapp/inbound/chat-turn.js";
import { createConfirmRuntime } from "../whatsapp/runtime/confirm-runtime.js";
import { createSelectRuntime } from "../whatsapp/runtime/select-runtime.js";
import { updateChatConfig } from "../chat-config.js";
import { codexAcpEntryPoint, fakeCodexPath } from "./codex-acp-patch-fixture.js";

const testConfirmRegistry = createConfirmRuntime();
const testUserResponseRegistry = createSelectRuntime();

/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;
/** @type {import("@electric-sql/pglite").PGlite} */
let testDb;
/** @type {import("../store.js").Store} */
let testStore;

const CACHE_PATH = path.resolve("data/models.json");

// ── Full e2e: WAMessage → adapter → handleMessage → mock LLM → socket output ──

describe("e2e adapter", { concurrency: 1 }, () => {

before(async () => {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify([
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
  ]));

  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;

  const { initStore } = await import("../store.js");
  testStore = await initStore(testDb);
  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();
  const { createMessageHandler } = await import("../index.js");
  ({ handleMessage } = createMessageHandler({
    store: testStore,
    llmClient,
  }));
});

after(async () => {
  await mockServer?.close();
  await fs.rm(CACHE_PATH, { force: true });
});

// ═══════════════════════════════════════════════════════════════════
// 1. No harness selected
// ═══════════════════════════════════════════════════════════════════
describe("no selected ACP harness", () => {
  // senderId "e2e-user" → chatId "e2e-user@s.whatsapp.net"
  const senderId = "e2e-user";
  const chatId = `${senderId}@s.whatsapp.net`;

  before(async () => {
    await seedChat(testDb, chatId, { enabled: true });
  });

  it("does not fall back to the legacy app loop when the central default is disabled", async () => {
    const savedDefaultHarness = process.env.DEFAULT_HARNESS;
    process.env.DEFAULT_HARNESS = "";
    const { sock, getTextMessages } = createMockBaileysSocket();
    const msg = createWAMessage({ text: "Hey there", senderId });

    try {
      await adaptIncomingMessage(msg, sock, handleMessage, testConfirmRegistry, testUserResponseRegistry);
    } finally {
      if (savedDefaultHarness === undefined) delete process.env.DEFAULT_HARNESS;
      else process.env.DEFAULT_HARNESS = savedDefaultHarness;
    }

    const texts = getTextMessages();
    assert.ok(
      texts.some(t => t.includes("No ACP harness is selected")),
      `Expected no-harness error in socket output, got: ${JSON.stringify(texts)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1b. Codex /status through the full WhatsApp transport boundary
// ═══════════════════════════════════════════════════════════════════
describe("Codex /status through WhatsApp transport", () => {
  const senderId = "e2e-codex-status-user";
  const chatId = `${senderId}@s.whatsapp.net`;
  const harnessName = "e2e-codex-status";
  let readStatusCalls = 0;

  before(async () => {
    const { registerHarnessDriver } = await import("../harnesses/index.js");
    const { createAcpHarness } = await import("../harnesses/acp.js");
    registerHarnessDriver({
      name: harnessName,
      displayName: "Codex",
      supportsInstances: true,
      createInstance: () => ({
        harness: createAcpHarness({
          name: harnessName,
          label: "Codex",
          sessionKind: "codex",
          config: {
            command: process.execPath,
            args: [path.resolve("tests", "fixtures", "acp-mock-agent.js")],
          },
          readCodexStatus: async () => {
            readStatusCalls += 1;
            return [
              ">_ OpenAI Codex (v0.139.0)",
              "Visit https://chatgpt.com/codex/settings/usage for up-to-date",
              "information on rate limits and credits",
              "Model: gpt-5.5 (reasoning high, summaries auto)",
              "Directory: ~/whatsapp-llm-bot",
              "Permissions: Workspace (Approve for me)",
              "Agents.md: /home/mada/.codex/AGENTS.md, AGENTS.md",
              "Account: user@example.com (Pro)",
              "Collaboration mode: Default",
              "Session: 019eb2c4-454a-7653-8fb8-47899ac79a7d",
              "5h limit: [██████████████░░░░░░] 69% left (resets 21:09)",
              "Weekly limit: [███░░░░░░░░░░░░░░░░░] 13% left (resets 00:35 on 11 Jun)",
              "GPT-5.3-Codex-Spark limit:",
              "5h limit: [████████████████████] 100% left (resets 23:21)",
              "Weekly limit: [████████████████████] 100% left (resets 18:21 on 17 Jun)",
            ].join("\n");
          },
        }),
      }),
    });

    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({ ...current, harness: harnessName }));
  });

  it("renders parsed Codex CLI status from an incoming /status message in mocked Baileys", async () => {
    readStatusCalls = 0;
    const captures = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "/status", senderId }),
      captures.sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      undefined,
      { outboundStore: testStore },
    );

    assert.equal(readStatusCalls, 1);
    const rendered = captures.getRenderedMessages().join("\n---\n");
    assert.match(rendered, /Codex status:/);
    assert.match(rendered, /\*\*Model:\*\* gpt-5\.5 \(reasoning high, summaries auto\)/);
    assert.match(rendered, /\*\*Account:\*\* user@example\.com \(Pro\)/);
    assert.match(rendered, /\*\*Session:\*\* `019eb2c4-454a-7653-8fb8-47899ac79a7d`/);
    assert.match(rendered, /\*\*5h limit:\*\* 69% left \(resets 21:09\)/);
    assert.match(rendered, /\*\*Weekly limit:\*\* 13% left \(resets 00:35 on 11 Jun\)/);
    assert.match(rendered, /\*\*GPT-5\.3-Codex-Spark 5h limit:\*\* 100% left \(resets 23:21\)/);
    assert.match(rendered, /\*\*GPT-5\.3-Codex-Spark Weekly limit:\*\* 100% left \(resets 18:21 on 17 Jun\)/);
    assert.ok(!rendered.includes("```"), `Expected parsed status instead of raw fenced output, got ${JSON.stringify(rendered)}`);
    assert.ok(!rendered.includes("████"), `Expected progress bars to be removed from parsed output, got ${JSON.stringify(rendered)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1c. Provider runtime events through the full WhatsApp transport boundary
// ═══════════════════════════════════════════════════════════════════
describe("provider runtime events", () => {
  const senderId = "e2e-provider-user";
  const chatId = `${senderId}@s.whatsapp.net`;
  const harnessName = "e2e-runtime-events";

  before(async () => {
    registerAcpTestHarness({
      name: harnessName,
      errorMessage: "provider runtime e2e should use the semantic adapter",
      onSendTurn: async (input, { emitRuntimeEvent }) => {
        await emitRuntimeEvent({
          type: "tool.started",
          tool: { id: "read-provider-1", name: "Read", arguments: { file_path: "package.json" } },
        });
        await emitRuntimeEvent({
          type: "tool.completed",
          tool: { id: "read-provider-1", name: "Read", arguments: { file_path: "package.json" } },
        });
        await emitRuntimeEvent({
          type: "command.started",
          command: {
            command: "pnpm type-check",
            status: "started",
          },
        });
        await emitRuntimeEvent({
          type: "command.completed",
          command: {
            command: "pnpm type-check",
            status: "completed",
            output: "ok",
          },
        });
        await emitRuntimeEvent({
          type: "assistant.completed",
          text: "Provider runtime answer.",
          contentType: "markdown",
          usage: {
            promptTokens: 12,
            completionTokens: 3,
            cachedTokens: 2,
            cost: 0.0042,
          },
        });
        return {
          response: [{ type: "markdown", text: "legacy fallback should not display" }],
          messages: input.messages ?? [],
          usage: ZERO_USAGE,
        };
      },
    });

    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      output_visibility: { toolDetails: false },
    }));
  });

  it("projects provider runtime progress as the normal tool display", async () => {
    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Use provider runtime events", senderId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      undefined,
      { outboundStore: testStore },
    );

    const sentMessages = getSentMessages();
    const textMessages = sentMessages
      .map((entry) => typeof entry.msg.text === "string" ? entry.msg.text : "")
      .filter(Boolean);
    const compactMessages = sentMessages.filter((entry) => (
      typeof entry.msg.text === "string"
      && (entry.msg.text.includes("*Read*") || entry.msg.text.includes("*Shell*"))
    ));

    assert.ok(compactMessages.some((entry) => String(entry.msg.text).includes("*Read*") && String(entry.msg.text).includes("package.json")), `Expected read progress, got ${JSON.stringify(textMessages)}`);
    assert.ok(compactMessages.some((entry) => String(entry.msg.text).includes("*Shell*") && String(entry.msg.text).includes("pnpm type-check")), `Expected shell progress, got ${JSON.stringify(textMessages)}`);
    assert.ok(textMessages.some((text) => text.includes("Provider runtime answer.")), `Expected provider answer, got ${JSON.stringify(textMessages)}`);
    assert.ok(textMessages.some((text) => text.includes("Cost: 0.004200")), `Expected provider usage cost, got ${JSON.stringify(textMessages)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1cc. Dummy runtime tools through the full WhatsApp transport boundary
// ═══════════════════════════════════════════════════════════════════
describe("dummy runtime tools", () => {
  const senderId = "e2e-dummy-tools-user";
  const chatId = `${senderId}@s.whatsapp.net`;
  const harnessName = "e2e-dummy-runtime-tools";

  before(async () => {
    registerAcpTestHarness({
      name: harnessName,
      errorMessage: "dummy runtime tool e2e should use the semantic adapter",
      onSendTurn: async (input, { emitRuntimeEvent }) => {
        const tools = [
          { id: "read-1", name: "Read", arguments: { file_path: "src/app.js" }, output: "read ok" },
          { id: "grep-1", name: "Grep", arguments: { path: "src", pattern: "needle" }, output: "grep ok" },
          { id: "task-1", name: "Task", arguments: { title: "Review migration" }, output: "task ok" },
          { id: "web-1", name: "WebSearch", arguments: { query: "runtime migration" }, output: "web ok" },
        ];

        for (const tool of tools) {
          await emitRuntimeEvent({ type: "tool.started", provider: "acp", tool });
          await emitRuntimeEvent({ type: "tool.completed", provider: "acp", tool });
        }

        await emitRuntimeEvent({
          type: "assistant.completed",
          text: "Dummy tools done.",
          contentType: "markdown",
        });

        return {
          response: [{ type: "markdown", text: "legacy fallback should not display" }],
          messages: input.messages ?? [],
          usage: ZERO_USAGE,
        };
      },
    });

    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      output_visibility: { toolDetails: true },
    }));
  });

  it("renders multiple ACP runtime tool shapes through WhatsApp", async () => {
    const captures = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Run dummy tools", senderId }),
      captures.sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      undefined,
      { outboundStore: testStore },
    );

    const rendered = captures.getRenderedMessages();
    assert.ok(rendered.some((text) => text.includes("🔧 *Read*") && text.includes("`src/app.js`")), `Expected Read start, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("✅ *Read*") && text.includes("`src/app.js`")), `Expected Read completion, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("✅ *Search*") && text.includes("`needle` in *src*")), `Expected Search completion, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("✅ *Task*") && text.includes("Review migration")), `Expected Task completion, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("✅ *Web search*") && text.includes("\"runtime migration\"")), `Expected Web search completion, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("Dummy tools done.")), `Expected final answer, got ${JSON.stringify(rendered)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1d. ACP file-change parity through the full WhatsApp transport boundary
// ═══════════════════════════════════════════════════════════════════
describe("ACP file changes through WhatsApp transport", () => {
  const harnessName = "e2e-acp-file-changes";
  let nextSender = 0;

  before(async () => {
    const { registerHarnessDriver } = await import("../harnesses/index.js");
    const { createAcpHarness } = await import("../harnesses/acp.js");
    registerHarnessDriver({
      name: harnessName,
      supportsInstances: true,
      createInstance: () => ({
        harness: createAcpHarness({
          name: harnessName,
          config: {
            command: process.execPath,
            args: [path.resolve("tests", "fixtures", "acp-mock-agent.js")],
          },
        }),
      }),
    });
  });

  /**
   * @param {string} prompt
   * @param {(workdir: string) => Promise<void>} [setup]
   * @returns {Promise<{ rendered: string[], sentMessages: ReturnType<ReturnType<typeof createMockBaileysSocket>["getSentMessages"]> }>}
   */
  async function runAcpPrompt(prompt, setup) {
    const senderId = `e2e-acp-files-${nextSender++}`;
    const chatId = `${senderId}@s.whatsapp.net`;
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-acp-files-"));
    await setup?.(workdir);
    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      harness_cwd: workdir,
      output_visibility: { changes: true, toolDetails: false },
    }));

    const captures = createMockBaileysSocket();
    await adaptIncomingMessage(
      createWAMessage({ text: prompt, senderId }),
      captures.sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      undefined,
      { outboundStore: testStore },
    );

    return {
      rendered: captures.getRenderedMessages(),
      sentMessages: captures.getSentMessages(),
    };
  }

  /**
   * @param {string[]} rendered
   * @param {string} title
   * @param {string} fileName
   */
  function assertOneFileChange(rendered, title, fileName) {
    const matches = rendered.filter((text) => text.startsWith(`🔧 *${title}*`) && text.includes(`\`${fileName}\``));
    assert.equal(matches.length, 1, `Expected one ${title} caption for ${fileName}, got ${JSON.stringify(rendered)}`);
  }

  it("sends ACP adds, updates, deletes, and unified diffs with the expected transport labels", async () => {
    const add = await runAcpPrompt("fs write");
    assertOneFileChange(add.rendered, "Add", "acp-fs-write.txt");

    const update = await runAcpPrompt("fs update", async (workdir) => {
      await fs.writeFile(path.join(workdir, "acp-fs-update.txt"), "old content through acp fs\n", "utf8");
    });
    assertOneFileChange(update.rendered, "Update", "acp-fs-update.txt");

    const correctedUpdate = await runAcpPrompt("mislabel existing add", async (workdir) => {
      await fs.writeFile(path.join(workdir, "existing-mislabel.js"), "export const value = 1;\n", "utf8");
    });
    assertOneFileChange(correctedUpdate.rendered, "Update", "existing-mislabel.js");

    const deleted = await runAcpPrompt("direct delete", async (workdir) => {
      await fs.writeFile(path.join(workdir, "direct-delete.txt"), "delete me\n", "utf8");
    });
    assertOneFileChange(deleted.rendered, "Snapshot", "direct-delete.txt");

    const diffAdd = await runAcpPrompt("diff only add");
    assertOneFileChange(diffAdd.rendered, "Add", "diff-only-add.js");

    const diffUpdate = await runAcpPrompt("diff only update");
    assertOneFileChange(diffUpdate.rendered, "Update", "diff-only-update.js");

    const diffDelete = await runAcpPrompt("diff only delete");
    assertOneFileChange(diffDelete.rendered, "Delete", "diff-only-delete.js");

    const fileChangeImages = [
      ...add.sentMessages,
      ...update.sentMessages,
      ...correctedUpdate.sentMessages,
      ...deleted.sentMessages,
      ...diffAdd.sentMessages,
      ...diffUpdate.sentMessages,
      ...diffDelete.sentMessages,
    ].filter((entry) => Buffer.isBuffer(entry.msg.image) && typeof entry.msg.caption === "string");
    assert.ok(fileChangeImages.length >= 7, `Expected file changes to render as sendable image content, got ${JSON.stringify(fileChangeImages)}`);
  });
});

describe("Codex ACP file changes through WhatsApp transport", () => {
  const harnessName = "e2e-codex-acp-file-changes";
  let nextSender = 0;

  before(async () => {
    const { registerHarnessDriver } = await import("../harnesses/index.js");
    const { createAcpHarness } = await import("../harnesses/acp.js");
    registerHarnessDriver({
      name: harnessName,
      supportsInstances: true,
      createInstance: () => ({
        harness: createAcpHarness({
          name: harnessName,
          sessionKind: "codex",
          config: {
            command: process.execPath,
            args: [codexAcpEntryPoint],
            env: {
              ...process.env,
              CODEX_PATH: fakeCodexPath,
            },
          },
        }),
      }),
    });
  });

  /**
   * @param {string} prompt
   * @param {(workdir: string) => Promise<void>} [setup]
   * @returns {Promise<string[]>}
   */
  async function runCodexAcpFileChangePrompt(prompt, setup) {
    const senderId = `e2e-codex-acp-files-${nextSender++}`;
    const chatId = `${senderId}@s.whatsapp.net`;
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-codex-acp-files-"));
    await setup?.(workdir);
    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      harness_cwd: workdir,
      output_visibility: { changes: true, toolDetails: false },
    }));

    const captures = createMockBaileysSocket();
    await adaptIncomingMessage(
      createWAMessage({ text: prompt, senderId }),
      captures.sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      undefined,
      { outboundStore: testStore },
    );

    return captures.getRenderedMessages();
  }

  it("renders captured Codex delete-plus-add rewrites of existing files as updates", async () => {
    const rendered = await runCodexAcpFileChangePrompt("delete add rewrite fixture", async (workdir) => {
      await fs.writeFile(
        path.join(workdir, "approval-delete-add.md"),
        "# Original approval file\nThis file must be rewritten through one delete-plus-add apply_patch.\n",
        "utf8",
      );
    });
    const matchingUpdates = rendered.filter((text) => (
      text.startsWith("🔧 *Update*")
      && text.includes("`approval-delete-add.md`")
    ));
    const matchingAdds = rendered.filter((text) => (
      text.startsWith("🔧 *Add*")
      && text.includes("`approval-delete-add.md`")
    ));

    assert.equal(matchingUpdates.length, 1, `Expected one Update caption for approval-delete-add.md, got ${JSON.stringify(rendered)}`);
    assert.equal(matchingAdds.length, 0, `Expected no Add caption for approval-delete-add.md, got ${JSON.stringify(rendered)}`);
  });

  it("renders Codex delete-plus-add rewrites of files created earlier in the turn as updates", async () => {
    const rendered = await runCodexAcpFileChangePrompt("create then delete add rewrite fixture");
    const matchingAdds = rendered.filter((text) => (
      text.startsWith("🔧 *Add*")
      && text.includes("`generated-delete-add.md`")
    ));
    const matchingUpdates = rendered.filter((text) => (
      text.startsWith("🔧 *Update*")
      && text.includes("`generated-delete-add.md`")
    ));

    assert.equal(matchingAdds.length, 1, `Expected one Add caption for generated-delete-add.md creation, got ${JSON.stringify(rendered)}`);
    assert.equal(matchingUpdates.length, 1, `Expected one Update caption for generated-delete-add.md rewrite, got ${JSON.stringify(rendered)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1e. ACP non-file workflows through the full WhatsApp transport boundary
// ═══════════════════════════════════════════════════════════════════
describe("ACP runtime events through WhatsApp transport", () => {
  const harnessName = "e2e-acp-runtime";
  let nextSender = 0;

  async function registerRuntimeHarness() {
    const { registerHarnessDriver } = await import("../harnesses/index.js");
    const { createAcpHarness } = await import("../harnesses/acp.js");
    registerHarnessDriver({
      name: harnessName,
      supportsInstances: true,
      createInstance: () => ({
        harness: createAcpHarness({
          name: harnessName,
          config: {
            command: process.execPath,
            args: [path.resolve("tests", "fixtures", "acp-mock-agent.js")],
          },
        }),
      }),
    });
  }

  before(async () => {
    await registerRuntimeHarness();
  });

  /**
   * @param {string} prompt
   * @param {{ pollChoice?: string, pollChoices?: string[] }} [options]
   * @returns {Promise<{ rendered: string[], sentMessages: ReturnType<ReturnType<typeof createMockBaileysSocket>["getSentMessages"]> }>}
   */
  async function runAcpPrompt(prompt, options = {}) {
    await registerRuntimeHarness();
    const senderId = `e2e-acp-runtime-${nextSender++}`;
    const chatId = `${senderId}@s.whatsapp.net`;
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-acp-runtime-"));
    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      harness_cwd: workdir,
      output_visibility: { thinking: true, changes: true, toolDetails: true, usage: true, subagents: true },
    }));

    const captures = createMockBaileysSocket();
    const turn = adaptIncomingMessage(
      createWAMessage({ text: prompt, senderId }),
      captures.sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      undefined,
      { outboundStore: testStore },
    );
    const pollChoices = options.pollChoices ?? (options.pollChoice ? [options.pollChoice] : []);
    const votedPollIndexes = new Set();
    for (const pollChoice of pollChoices) {
      let voted = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const sentMessages = captures.getSentMessages();
        const pollIndex = sentMessages.findIndex((entry, index) => entry.msg.poll && !votedPollIndexes.has(index));
        const poll = pollIndex >= 0 ? sentMessages[pollIndex] : undefined;
        if (poll && poll.msg.poll && typeof poll.msg.poll === "object" && Array.isArray(/** @type {{ values?: unknown }} */ (poll.msg.poll).values)) {
          testUserResponseRegistry.handlePollVote({
            chatId,
            pollMsgId: `sent-msg-${pollIndex}`,
            selectedOptions: [pollChoice],
          });
          votedPollIndexes.add(pollIndex);
          voted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(voted, `Expected poll choice ${pollChoice} to be available`);
    }
    await turn;
    return {
      rendered: captures.getRenderedMessages(),
      sentMessages: captures.getSentMessages(),
    };
  }

  /**
   * @param {ReturnType<ReturnType<typeof createMockBaileysSocket>["getSentMessages"]>} sentMessages
   * @returns {string[]}
   */
  function getPinnedStatusTexts(sentMessages) {
    const pinEntry = sentMessages.find((entry) => entry.msg.pin && typeof entry.msg.pin === "object");
    const pinnedId = pinEntry && typeof pinEntry.msg.pin === "object"
      ? /** @type {{ id?: unknown }} */ (pinEntry.msg.pin).id
      : null;
    assert.equal(typeof pinnedId, "string", `Expected pinned status payload, got ${JSON.stringify(sentMessages.map((entry) => entry.msg))}`);
    return sentMessages
      .filter((entry, index) => {
        if (typeof entry.msg.text !== "string") {
          return false;
        }
        if (`sent-msg-${index}` === pinnedId) {
          return true;
        }
        return typeof entry.msg.edit === "object"
          && entry.msg.edit !== null
          && /** @type {{ id?: unknown }} */ (entry.msg.edit).id === pinnedId;
      })
      .map((entry) => /** @type {string} */ (entry.msg.text));
  }

  /**
   * @param {string[]} statusTexts
   * @param {string[]} snippets
   * @returns {void}
   */
  function assertPinnedTimelineIncludes(statusTexts, snippets) {
    const timeline = statusTexts.join("\n---\n");
    for (const snippet of snippets) {
      assert.ok(timeline.includes(snippet), `Expected pinned status timeline to include ${JSON.stringify(snippet)}, got ${JSON.stringify(statusTexts)}`);
    }
  }

  /**
   * @param {ReturnType<ReturnType<typeof createMockBaileysSocket>["getSentMessages"]>} sentMessages
   * @returns {void}
   */
  function assertPinnedStatusUnpinned(sentMessages) {
    const pinEntry = sentMessages.find((entry) => entry.msg.pin && typeof entry.msg.pin === "object" && entry.msg.type === 1);
    const pinnedId = pinEntry && typeof pinEntry.msg.pin === "object"
      ? /** @type {{ id?: unknown }} */ (pinEntry.msg.pin).id
      : null;
    assert.equal(typeof pinnedId, "string", `Expected pinned status payload, got ${JSON.stringify(sentMessages.map((entry) => entry.msg))}`);
    assert.ok(
      sentMessages.some((entry) => entry.msg.pin
        && typeof entry.msg.pin === "object"
        && /** @type {{ id?: unknown }} */ (entry.msg.pin).id === pinnedId
        && entry.msg.type === 2),
      `Expected pinned status ${pinnedId} to be unpinned at turn end, got ${JSON.stringify(sentMessages.map((entry) => entry.msg))}`,
    );
  }

  it("renders assistant, subagent, plan, tool, file-change, usage, and pinned turn status events distinctly", async () => {
    const { rendered, sentMessages } = await runAcpPrompt("Run the mock");

    assert.ok(rendered.some((text) => text.includes("Main result.")), `Expected assistant output, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("Subagent result.")), `Expected subagent output, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("Mock ACP work")), `Expected plan output, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("Review mock code") || text.includes("*Task*")), `Expected tool output, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("Update") && text.includes("mock.txt")), `Expected file-change output, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("Cost:")), `Expected usage output, got ${JSON.stringify(rendered)}`);

    const statusIndex = sentMessages.findIndex((entry) => entry.msg.text === "🔄 *E2E-ACP-RUNTIME*  turn started");
    assert.notEqual(statusIndex, -1, `Expected turn status message, got ${JSON.stringify(sentMessages.map((entry) => entry.msg))}`);
    const pinnedStatus = sentMessages.find((entry) => entry.msg.pin);
    assert.deepEqual(pinnedStatus?.msg, {
      pin: { id: `sent-msg-${statusIndex}`, remoteJid: "e2e-acp-runtime-0@s.whatsapp.net", fromMe: true },
      type: 1,
      time: 86400,
    });
    assert.ok(
      sentMessages.some((entry) => entry.msg.edit
        && typeof entry.msg.text === "string"
        && entry.msg.text.includes("✅ *E2E-ACP-RUNTIME*  turn completed")),
      `Expected final turn status edit, got ${JSON.stringify(sentMessages.map((entry) => entry.msg))}`,
    );
    assertPinnedStatusUnpinned(sentMessages);
  });

  it("updates pinned status for every supported ACP status category and suppresses read noise", async () => {
    const { rendered, sentMessages } = await runAcpPrompt("all statuses", {
      pollChoices: ["Allow once", "Complete", "✅ Allow"],
    });
    const statusTexts = getPinnedStatusTexts(sentMessages);
    const timeline = statusTexts.join("\n---\n");

    assert.ok(rendered.some((text) => text.includes("All statuses done.")), `Expected final assistant output, got ${JSON.stringify(rendered)}`);
    assertPinnedTimelineIncludes(statusTexts, [
      "🔄 *E2E-ACP-RUNTIME*  turn started",
      "💭 *LLM*  thinking",
      "📋 *PLAN*  *Plan*",
      "🔀 *ACP*  model model-a -> model-b",
      "⚠️ *ACP*  Config fallback active",
      "⚠️ *ACP*  Runtime warning sample",
      "⏳ *ACP*  approval needed: Run status command",
      "✅ *ACP*  approval resolved: Run status command",
      "⏳ *ACP*  input needed",
      "✅ *ACP*  input resolved",
      "🧵 *SUBAGENT*  Reviewer replied",
      "📝 *File*  `status.txt`",
      "📊 *USAGE*  cost",
      "✅ *E2E-ACP-RUNTIME*  turn completed",
    ]);
    assert.ok(rendered.some((text) => text.includes("*Shell*")), `Expected Shell row in normal WhatsApp output, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("*Task*")), `Expected Task row in normal WhatsApp output, got ${JSON.stringify(rendered)}`);
    assert.ok(!timeline.includes("*Shell*"), `Expected Shell rows to stay out of pinned status, got ${JSON.stringify(statusTexts)}`);
    assert.ok(!timeline.includes("*Task*"), `Expected Task rows to stay out of pinned status, got ${JSON.stringify(statusTexts)}`);
    assert.ok(!timeline.includes("Read file"), `Expected read actions to be suppressed from pinned status, got ${JSON.stringify(statusTexts)}`);
    assert.ok(!timeline.includes("List files"), `Expected list actions to be suppressed from pinned status, got ${JSON.stringify(statusTexts)}`);
    assert.ok(!timeline.includes("noise.js"), `Expected read/list paths to be suppressed from pinned status, got ${JSON.stringify(statusTexts)}`);
    assertPinnedStatusUnpinned(sentMessages);
  });

  it("keeps tool status out of the pinned status across ACP protocol and Baileys", async () => {
    const { rendered, sentMessages } = await runAcpPrompt("action focused pinned status");
    const statusTexts = getPinnedStatusTexts(sentMessages);
    const timeline = statusTexts.join("\n---\n");

    assert.ok(rendered.some((text) => text.includes("Action-focused status done.")), `Expected final assistant output, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("✅ *Shell*") && text.includes("acp-adapter-smoke.js codex --prompt")), `Expected visible successful Shell row, got ${JSON.stringify(rendered)}`);
    assert.ok(rendered.some((text) => text.includes("✅ *Search*")), `Expected visible Search row, got ${JSON.stringify(rendered)}`);
    assertPinnedTimelineIncludes(statusTexts, [
      "🔄 *E2E-ACP-RUNTIME*  turn started",
      "📊 *USAGE*  cost",
      "✅ *E2E-ACP-RUNTIME*  turn completed",
    ]);
    assert.ok(!timeline.includes("*Shell*"), `Pinned status should not include Shell rows, got ${JSON.stringify(statusTexts)}`);
    assert.ok(!timeline.includes("*Search*"), `Pinned status should not include Search rows, got ${JSON.stringify(statusTexts)}`);
    assertPinnedStatusUnpinned(sentMessages);
  });

  it("updates pinned status for ACP runtime errors", async () => {
    const { rendered, sentMessages } = await runAcpPrompt("runtime error status");
    const statusTexts = getPinnedStatusTexts(sentMessages);

    assert.ok(rendered.some((text) => text.includes("Runtime error status done.")), `Expected final assistant output, got ${JSON.stringify(rendered)}`);
    assertPinnedTimelineIncludes(statusTexts, [
      "🔄 *E2E-ACP-RUNTIME*  turn started",
      "❌ *ACP*  Runtime error sample",
    ]);
  });

  it("renders ACP terminal command output through command transport messages", async () => {
    const { rendered } = await runAcpPrompt("terminal", { pollChoice: "✅ Allow" });

    assert.ok(rendered.some((text) => text.includes("*Shell*") || text.includes("terminal ok")), `Expected command output, got ${JSON.stringify(rendered)}`);
  });

  it("resolves ACP permission polls and preserves the final response", async () => {
    const { rendered, sentMessages } = await runAcpPrompt("permission", { pollChoice: "Allow once" });
    const poll = sentMessages.find((entry) => entry.msg.poll);

    assert.ok(poll, "Expected permission poll to be sent");
    assert.ok(rendered.some((text) => text.includes("\"optionId\":\"allow-once\"")), `Expected permission result, got ${JSON.stringify(rendered)}`);
  });

  it("resolves ACP elicitation polls and preserves the final response", async () => {
    const { rendered, sentMessages } = await runAcpPrompt("elicitation", { pollChoice: "Complete" });
    const poll = sentMessages.find((entry) => entry.msg.poll);

    assert.ok(poll, "Expected elicitation poll to be sent");
    assert.ok(rendered.some((text) => text.includes("\"strategy\":\"complete\"")), `Expected elicitation result, got ${JSON.stringify(rendered)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1f. Pi RPC events through the full WhatsApp transport boundary
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// 1g. WhatsApp audio through media-to-text into provider input
// ═══════════════════════════════════════════════════════════════════
describe("audio media-to-text provider input", () => {
  const senderId = "e2e-audio-user";
  const chatId = `${senderId}@s.whatsapp.net`;
  const harnessName = "e2e-audio-provider";
  /** @type {string[]} */
  const capturedInputs = [];

  before(async () => {
    registerAcpTestHarness({
      name: harnessName,
      errorMessage: "audio provider e2e should use the semantic adapter",
      onSendTurn: (input) => {
        capturedInputs.push(input.input ?? "");
        return {
          response: [{ type: "markdown", text: "Audio provider response." }],
          messages: input.messages ?? [],
          usage: ZERO_USAGE,
        };
      },
    });

    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      media_to_text_models: { audio: "audio/model" },
    }));
  });

  it("transcribes incoming WhatsApp audio before sending the provider turn", async () => {
    capturedInputs.length = 0;
    mockServer.addResponses("Audio asks for the current status.");

    const { sock, getSentMessages } = createMockBaileysSocket();
    const audioMessage = createWAMessage({ audio: { mimetype: "audio/mp3" }, senderId });
    await adaptIncomingMessage(
      audioMessage,
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      async () => Buffer.from("e2e audio bytes"),
      { outboundStore: testStore },
    );

    assert.equal(capturedInputs.length, 1);
    assert.ok(capturedInputs[0]?.includes("[Audio description: Audio asks for the current status.]"), capturedInputs[0]);
    assert.ok(capturedInputs[0]?.includes("Media file available in this request:"), capturedInputs[0]);
    const transcriptionStatus = getSentMessages().find((entry) => entry.msg.text === "Transcribing audio...");
    assert.equal(transcriptionStatus?.options?.quoted, audioMessage);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Sender ID extraction (phone + LID)
// ═══════════════════════════════════════════════════════════════════
describe("sender ID extraction", () => {
  it("extracts both phone ID and LID from private chat message", async () => {
    /** @type {string[][]} */
    const capturedSenderIds = [];
    const { sock } = createMockBaileysSocket();

    // In private chats, remoteJid IS the sender's JID
    await adaptIncomingMessage(
      createWAMessage({ text: "hi", senderId: "12345", senderLid: "lid-abc" }),
      sock,
      async (ctx) => { capturedSenderIds.push(ctx.senderIds); },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.ok(capturedSenderIds.length > 0, "Should have captured senderIds");
    const ids = capturedSenderIds[0];
    assert.ok(ids.includes("12345"), `Should contain phone ID, got: ${ids}`);
    assert.ok(ids.includes("lid-abc"), `Should contain LID, got: ${ids}`);
  });

  it("extracts participant IDs from group message", async () => {
    /** @type {string[][]} */
    const capturedSenderIds = [];
    const { sock } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({
        text: "hello group",
        chatId: "e2e-group-sender@g.us",
        senderId: "55555",
        senderLid: "lid-group",
        isGroup: true,
      }),
      sock,
      async (ctx) => { capturedSenderIds.push(ctx.senderIds); },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const ids = capturedSenderIds[0];
    assert.ok(ids.includes("55555"), `Should contain participant phone ID, got: ${ids}`);
    assert.ok(ids.includes("lid-group"), `Should contain participant LID, got: ${ids}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Filtering: status broadcasts and fromMe messages
// ═══════════════════════════════════════════════════════════════════
describe("message filtering", () => {
  it("ignores status@broadcast messages", async () => {
    let handlerCalled = false;
    const { sock } = createMockBaileysSocket();
    const msg = createWAMessage({ text: "status update", chatId: "status@broadcast" });

    await adaptIncomingMessage(msg, sock, async () => {
      handlerCalled = true;
    }, testConfirmRegistry, testUserResponseRegistry);

    assert.equal(handlerCalled, false, "Handler should not be called for status broadcasts");
  });

  it("ignores messages with empty content", async () => {
    let handlerCalled = false;
    const { sock } = createMockBaileysSocket();
    // Message with no text, no media — empty message field
    const msg = /** @type {BaileysMessage} */ (/** @type {unknown} */ ({
      key: { remoteJid: "test@s.whatsapp.net", fromMe: false, id: "msg-empty" },
      message: {},
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: "User",
    }));

    await adaptIncomingMessage(msg, sock, async () => {
      handlerCalled = true;
    }, testConfirmRegistry, testUserResponseRegistry);

    assert.equal(handlerCalled, false, "Handler should not be called for empty messages");
  });

  it("ignores reaction-message upserts when called directly", async () => {
    let handlerCalled = false;
    const { sock } = createMockBaileysSocket();
    const msg = /** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "120363042584279820@g.us",
        fromMe: false,
        id: "reaction-upsert-1",
        participant: "213597330374785@lid",
      },
      message: {
        reactionMessage: {
          key: {
            remoteJid: "120363042584279820@g.us",
            fromMe: true,
            id: "3EB059407A39C3E611C2B4",
          },
          text: "👁",
        },
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: "Marco D'Agostini",
    });

    await adaptIncomingMessage(msg, sock, async () => {
      handlerCalled = true;
    }, testConfirmRegistry, testUserResponseRegistry);

    assert.equal(handlerCalled, false, "Handler should not be called for reaction upserts");
  });

  it("drops group text messages prefixed with // before they reach the app", async () => {
    const chatId = "e2e-ignore-text@g.us";
    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({ ...current, respond_on: "any" }));

    mockServer.clearRequests();
    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({
        text: "// operator note",
        chatId,
        isGroup: true,
        senderId: "e2e-ignore-user",
      }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const { rows } = await testDb.sql`SELECT COUNT(*) AS count FROM messages WHERE chat_id = ${chatId}`;
    const messageCount = /** @type {{ count: number }} */ (rows[0]).count;

    assert.equal(messageCount, 0, "Ignored messages should not be persisted");
    assert.deepEqual(getSentMessages(), [], "Ignored messages should not produce socket output");
    assert.deepEqual(mockServer.getRequests(), [], "Ignored messages should not call the LLM");
  });

  it("drops media captions prefixed with // before downloading or storing media", async () => {
    const chatId = "e2e-ignore-caption@g.us";
    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({ ...current, respond_on: "any" }));

    let downloadCalled = false;
    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({
        chatId,
        isGroup: true,
        senderId: "e2e-ignore-user",
        image: { mimetype: "image/jpeg", caption: "// hidden caption" },
      }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      async () => {
        downloadCalled = true;
        return Buffer.from("ignored-image");
      },
    );

    const { rows } = await testDb.sql`SELECT COUNT(*) AS count FROM messages WHERE chat_id = ${chatId}`;
    const messageCount = /** @type {{ count: number }} */ (rows[0]).count;

    assert.equal(downloadCalled, false, "Ignored captions should short-circuit before media download");
    assert.equal(messageCount, 0, "Ignored captioned media should not be persisted");
    assert.deepEqual(getSentMessages(), [], "Ignored captioned media should not produce socket output");
    assert.deepEqual(mockServer.getRequests(), [], "Ignored captioned media should not call the LLM");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Group detection
// ═══════════════════════════════════════════════════════════════════
describe("group detection", () => {
  it("sets isGroup=true for @g.us JIDs", async () => {
    /** @type {boolean | null} */
    let capturedIsGroup = null;
    const { sock } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "hi", chatId: "e2e-group-detect@g.us", isGroup: true }),
      sock,
      async (ctx) => { capturedIsGroup = ctx.facts.isGroup; },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.equal(capturedIsGroup, true);
  });

  it("sets isGroup=false for @s.whatsapp.net JIDs", async () => {
    /** @type {boolean | null} */
    let capturedIsGroup = null;
    const { sock } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "hi", chatId: "e2e-private-detect@s.whatsapp.net" }),
      sock,
      async (ctx) => { capturedIsGroup = ctx.facts.isGroup; },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.equal(capturedIsGroup, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Quote / reply-to extraction
// ═══════════════════════════════════════════════════════════════════
describe("quote extraction", () => {
  it("passes current and quoted identity through the adapter", async () => {
    /** @type {ChatTurn | null} */
    let capturedCtx = null;
    const { sock } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({
        text: "What did they say?",
        chatId: "e2e-quote@s.whatsapp.net",
        senderName: "Current User",
        quotedText: "Original message",
        quotedSenderId: "99999",
      }),
      sock,
      async (ctx) => { capturedCtx = ctx; },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.ok(capturedCtx, "Handler should have been called");
    assert.equal(capturedCtx.senderName, "Current User");
    assert.equal(capturedCtx.facts.quotedSenderId, "99999");
    assert.equal(capturedCtx.facts.quotedSenderJid, "99999@s.whatsapp.net");

    const quoteBlock = capturedCtx.content.find(b => b.type === "quote");
    assert.ok(quoteBlock, "Should have a quote content block");
    assert.ok(
      /** @type {QuoteContentBlock} */ (quoteBlock).content.some(
        b => b.type === "text" && /** @type {TextContentBlock} */ (b).text === "Original message",
      ),
      "Quote should contain the original text",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Command execution through full pipeline
// ═══════════════════════════════════════════════════════════════════
describe("command through adapter", () => {
  // In private chats, chatId = senderId@s.whatsapp.net — sender must be master
  const chatId = "master-user@s.whatsapp.net";

  before(async () => {
    await seedChat(testDb, chatId);
  });

  it("processes !s command sent as a WAMessage", async () => {
    const { sock, getTextMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "!s enabled on" }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const texts = getTextMessages();
    assert.ok(
      texts.some(t => t.toLowerCase().includes("enabled")),
      `Should confirm enabling, got: ${JSON.stringify(texts)}`,
    );
  });

  it("processes idle !c as a command without starting or pinning a provider turn", async () => {
    const harnessName = "e2e-idle-cancel";
    const cancelChatId = "e2e-idle-cancel@s.whatsapp.net";
    const state = registerAcpTestHarness({
      name: harnessName,
      capabilities: { supportsCancel: true },
    });
    await seedChat(testDb, cancelChatId, { enabled: true });
    await updateChatConfig(cancelChatId, (current) => ({
      ...current,
      is_enabled: true,
      harness: harnessName,
    }));
    const { sock, getTextMessages, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "!c", chatId: cancelChatId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const texts = getTextMessages();
    assert.ok(texts.some((text) => text.includes("Nothing to cancel.")), `Expected idle cancel response, got ${JSON.stringify(texts)}`);
    assert.equal(state.turns.length, 0, "!c should not start a provider turn");
    assert.ok(!getSentMessages().some((entry) => entry.msg.pin), `!c should not create a pinned status, got ${JSON.stringify(getSentMessages().map((entry) => entry.msg))}`);
  });

  it("processes !c while a provider turn is active", async () => {
    const harnessName = "e2e-active-cancel";
    const cancelChatId = "e2e-active-cancel@s.whatsapp.net";
    /** @type {(value?: void) => void} */
    let markStarted = () => {};
    /** @type {(value?: void) => void} */
    let releaseRun = () => {};
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise((resolve) => {
      releaseRun = resolve;
    });
    const state = registerAcpTestHarness({
      name: harnessName,
      capabilities: { supportsCancel: true },
      onSendTurn: async (input) => {
        markStarted();
        await released;
        return {
          response: [{ type: "text", text: `Finished: ${input.input ?? ""}` }],
          messages: input.messages ?? [],
          usage: ZERO_USAGE,
        };
      },
      onCancel: async () => {
        releaseRun();
        return true;
      },
    });
    await seedChat(testDb, cancelChatId, { enabled: true });
    await updateChatConfig(cancelChatId, (current) => ({
      ...current,
      is_enabled: true,
      harness: harnessName,
    }));
    const { sock, getTextMessages } = createMockBaileysSocket();
    const activeTurn = adaptIncomingMessage(
      createWAMessage({ text: "long running provider turn", chatId: cancelChatId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );
    await Promise.race([
      started,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for active provider turn")), 1000)),
    ]);

    await adaptIncomingMessage(
      createWAMessage({ text: "!c", chatId: cancelChatId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );
    await activeTurn;

    const texts = getTextMessages();
    assert.ok(texts.some((text) => text.includes("Cancelled.")), `Expected active cancel response, got ${JSON.stringify(texts)}`);
    assert.ok(state.cancelledSessions.includes(cancelChatId), `Expected harness cancel for ${cancelChatId}, got ${JSON.stringify(state.cancelledSessions)}`);
  });

  it("enabled chats still require an explicit or central ACP harness", async () => {
    const savedDefaultHarness = process.env.DEFAULT_HARNESS;
    process.env.DEFAULT_HARNESS = "";
    const { sock, getTextMessages } = createMockBaileysSocket();

    try {
      await seedChat(testDb, chatId, { enabled: true });
      await updateChatConfig(chatId, (current) => ({
        ...current,
        is_enabled: true,
        harness: "",
      }));
      await adaptIncomingMessage(
        createWAMessage({ text: "Hey" }),
        sock,
        handleMessage,
        testConfirmRegistry,
        testUserResponseRegistry,
      );
    } finally {
      if (savedDefaultHarness === undefined) delete process.env.DEFAULT_HARNESS;
      else process.env.DEFAULT_HARNESS = savedDefaultHarness;
    }

    const texts = getTextMessages();
    assert.ok(
      texts.some(t => t.includes("No ACP harness is selected")),
      `Expected no-harness error, got: ${JSON.stringify(texts)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Presence updates flow through the socket
// ═══════════════════════════════════════════════════════════════════
describe("presence updates", () => {
  // Use default senderId (master-user) so chatId = master-user@s.whatsapp.net
  const chatId = "master-user@s.whatsapp.net";
  const harnessName = "e2e-presence-provider";

  before(async () => {
    registerAcpTestHarness({
      name: harnessName,
      errorMessage: "presence e2e should use the semantic adapter",
      onSendTurn: (input) => ({
        response: [{ type: "markdown", text: "Presence provider response." }],
        messages: input.messages ?? [],
        usage: ZERO_USAGE,
      }),
    });
  });

  it("sends composing and paused presence updates via socket", async () => {
    // Chat was already enabled by the command test above; ensure it exists
    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({ ...current, harness: harnessName }));

    const { sock, getPresenceUpdates } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "hi" }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const updates = getPresenceUpdates();
    assert.ok(
      updates.some(u => u.presence === "composing" && u.chatId === chatId),
      `Should have sent composing update, got: ${JSON.stringify(updates)}`,
    );
    assert.ok(
      updates.some(u => u.presence === "paused" && u.chatId === chatId),
      `Should have sent paused update, got: ${JSON.stringify(updates)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. Timestamp parsing
// ═══════════════════════════════════════════════════════════════════
describe("timestamp parsing", () => {
  it("parses numeric timestamp from WAMessage", async () => {
    const unixTime = 1700000000;

    /** @type {Date | null} */
    let capturedTimestamp = null;
    const { sock } = createMockBaileysSocket();

    const msg = createWAMessage({ text: "time check", chatId: "e2e-ts@s.whatsapp.net", timestamp: unixTime });

    await adaptIncomingMessage(msg, sock, async (ctx) => {
      capturedTimestamp = ctx.timestamp;
    }, testConfirmRegistry, testUserResponseRegistry);

    assert.ok(capturedTimestamp, "Should have captured timestamp");
    assert.equal(capturedTimestamp.getTime(), unixTime * 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. Bot identity extraction stays behind the semantic facts boundary
// ═══════════════════════════════════════════════════════════════════
describe("bot mention detection", () => {
  it("marks both phone ID and LID mentions as addressedToBot and strips the prefix", async () => {
    /** @type {ChatTurn[]} */
    const capturedTurns = [];
    const { sock } = createMockBaileysSocket({ selfId: "bot-123", selfLid: "bot-lid-456" });

    await adaptIncomingMessage(
      createWAMessage({ text: "@bot-123 hi", chatId: "e2e-self@g.us", isGroup: true }),
      sock,
      async (ctx) => {
        capturedTurns.push(ctx);
      },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    await adaptIncomingMessage(
      createWAMessage({ text: "@bot-lid-456 hi", chatId: "e2e-self@g.us", isGroup: true }),
      sock,
      async (ctx) => {
        capturedTurns.push(ctx);
      },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.equal(capturedTurns.length, 2, "Should have captured both turns");
    assert.equal(capturedTurns[0].facts.addressedToBot, true);
    assert.equal(capturedTurns[1].facts.addressedToBot, true);
    assert.equal(capturedTurns[0].content[0].type, "text");
    assert.equal(capturedTurns[1].content[0].type, "text");
    assert.equal(/** @type {TextContentBlock} */ (capturedTurns[0].content[0]).text, "hi");
    assert.equal(/** @type {TextContentBlock} */ (capturedTurns[1].content[0]).text, "hi");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 11. Markdown with code → socket receives [text, image, text]
// ═══════════════════════════════════════════════════════════════════
describe("markdown code renders as image in socket output", () => {
  const senderId = "e2e-md-code";
  const chatId = `${senderId}@s.whatsapp.net`;
  const harnessName = "e2e-markdown-provider";

  before(async () => {
    registerAcpTestHarness({
      name: harnessName,
      errorMessage: "markdown e2e should use the semantic adapter",
      onSendTurn: (input) => {
        const responseText = input.input?.includes("Show me code")
          ? `Here is a snippet:

\`\`\`javascript
function greet(name) {
  const msg = "Hello, " + name;
  console.log(msg);
  return msg;
}
greet("world");
\`\`\`

Hope that helps!`
          : "Just **bold** and _italic_ text, no code.";
        return {
          response: [{ type: "markdown", text: responseText }],
          messages: input.messages ?? [],
          usage: ZERO_USAGE,
        };
      },
    });
    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({ ...current, harness: harnessName }));
  });

  it("provider markdown with code block produces [text, image, text] on socket", async () => {

    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Show me code", senderId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const msgs = getSentMessages();

    // Classify each socket message
    const classified = msgs.map(m => {
      if (m.msg.image != null) return "image";
      if (typeof m.msg.text === "string") return "text";
      return "other";
    });

    // There should be at least: text (before code), image (code), text (after code)
    const textMsgs = classified.filter(t => t === "text");
    const imageMsgs = classified.filter(t => t === "image");

    assert.ok(
      imageMsgs.length >= 1,
      `Expected at least 1 image for code block, got ${imageMsgs.length}. Classified: ${JSON.stringify(classified)}`,
    );

    assert.ok(
      textMsgs.length >= 2,
      `Expected at least 2 text messages (before+after code), got ${textMsgs.length}. Classified: ${JSON.stringify(classified)}`,
    );

    // Image should be a Buffer (PNG)
    const imageMsg = msgs.find(m => m.msg.image != null);
    assert.ok(
      Buffer.isBuffer(imageMsg?.msg.image),
      "Code block image should be a Buffer",
    );

    // Verify order: first text before first image, last text after last image
    const firstImageIdx = classified.indexOf("image");
    const firstTextIdx = classified.indexOf("text");
    const lastTextIdx = classified.lastIndexOf("text");

    assert.ok(
      firstTextIdx < firstImageIdx,
      `Text should appear before image. Order: ${JSON.stringify(classified)}`,
    );
    assert.ok(
      lastTextIdx > firstImageIdx,
      `Text should appear after image. Order: ${JSON.stringify(classified)}`,
    );
  });

  it("provider markdown without code block sends only text (no images)", async () => {
    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Tell me something", senderId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const msgs = getSentMessages();
    const imageMsgs = msgs.filter(m => m.msg.image != null);
    const textMsgs = msgs.filter(m => typeof m.msg.text === "string");

    assert.equal(
      imageMsgs.length, 0,
      `Should have 0 images for plain markdown, got ${imageMsgs.length}`,
    );
    assert.ok(
      textMsgs.length >= 1,
      `Should have at least 1 text message, got ${textMsgs.length}`,
    );
  });
});

}); // end describe("e2e adapter")

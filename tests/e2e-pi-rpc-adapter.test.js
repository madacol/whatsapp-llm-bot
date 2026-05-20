process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createMockBaileysSocket,
  createMockLlmServer,
  createTestDb,
  createWAMessage,
  seedChat,
} from "./helpers.js";
import { setDb } from "../db.js";
import { adaptIncomingMessage } from "../whatsapp/inbound/chat-turn.js";
import { createConfirmRuntime } from "../whatsapp/runtime/confirm-runtime.js";
import { createSelectRuntime } from "../whatsapp/runtime/select-runtime.js";
import { updateChatConfig } from "../chat-config.js";

const testConfirmRegistry = createConfirmRuntime();
const testUserResponseRegistry = createSelectRuntime();
const CACHE_PATH = path.resolve("data/models.json");

/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;
/** @type {import("../sqlite-db.js").SqliteDb} */
let testDb;

describe("Pi RPC adapter e2e", { concurrency: 1 }, () => {
  const senderId = "e2e-pi-rpc-user";
  const chatId = `${senderId}@s.whatsapp.net`;

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
    const store = await initStore(testDb);
    const { createLlmClient } = await import("../llm.js");
    const llmClient = createLlmClient();
    const { createMessageHandler } = await import("../index.js");
    const { getActions, executeAction } = await import("../actions.js");
    ({ handleMessage } = createMessageHandler({
      store,
      llmClient,
      getActionsFn: getActions,
      executeActionFn: executeAction,
    }));

    const { registerHarnessDriver } = await import("../harnesses/index.js");
    const { createPiHarness } = await import("../harnesses/pi.js");
    const { startPiRpcRun } = await import("../harnesses/pi-runner.js");

    registerHarnessDriver({
      name: "pi",
      displayName: "Pi",
      supportsInstances: true,
      createInstance: () => ({
        harness: createPiHarness({
          startRun: (input) => startPiRpcRun(input, {
            openConnection: async () => ({
              sendRequest: async (message) => {
                if (message.type === "get_state") {
                  return {
                    id: message.id,
                    type: "response",
                    command: "get_state",
                    success: true,
                    data: {
                      sessionFile: "/tmp/pi-rpc-e2e-session.jsonl",
                      sessionId: "pi-rpc-e2e",
                      isStreaming: false,
                    },
                  };
                }
                return {
                  id: message.id,
                  type: "response",
                  command: typeof message.type === "string" ? message.type : "unknown",
                  success: true,
                };
              },
              notifications: (async function* () {
                yield {
                  type: "tool_execution_start",
                  toolCallId: "read-1",
                  toolName: "read",
                  args: { path: "README.md" },
                };
                yield {
                  type: "tool_execution_end",
                  toolCallId: "read-1",
                  toolName: "read",
                  result: { content: [{ type: "text", text: "# Project\n" }] },
                  isError: false,
                };
                yield {
                  type: "tool_execution_start",
                  toolCallId: "bash-1",
                  toolName: "bash",
                  args: { command: "pwd" },
                };
                yield {
                  type: "tool_execution_update",
                  toolCallId: "bash-1",
                  toolName: "bash",
                  args: { command: "pwd" },
                  partialResult: { content: [{ type: "text", text: "/repo\n" }] },
                };
                yield {
                  type: "tool_execution_end",
                  toolCallId: "bash-1",
                  toolName: "bash",
                  result: { content: [{ type: "text", text: "/repo\n" }] },
                  isError: false,
                };
                yield {
                  type: "tool_execution_start",
                  toolCallId: "edit-1",
                  toolName: "edit",
                  args: {
                    path: "src/app.js",
                    edits: [{ oldText: "const value = 1;\n", newText: "const value = 2;\n" }],
                  },
                };
                yield {
                  type: "tool_execution_end",
                  toolCallId: "edit-1",
                  toolName: "edit",
                  result: { content: [{ type: "text", text: "Edited src/app.js" }] },
                  isError: false,
                };
                yield {
                  type: "tool_execution_start",
                  toolCallId: "write-1",
                  toolName: "write",
                  args: {
                    path: "generated.txt",
                    content: "generated smoke content",
                  },
                };
                yield {
                  type: "tool_execution_end",
                  toolCallId: "write-1",
                  toolName: "write",
                  result: { content: [{ type: "text", text: "Successfully wrote 23 bytes to generated.txt" }] },
                  isError: false,
                };
                yield {
                  type: "tool_execution_start",
                  toolCallId: "bash-fail-1",
                  toolName: "bash",
                  args: { command: "cat missing-file-for-rpc-smoke" },
                };
                yield {
                  type: "tool_execution_update",
                  toolCallId: "bash-fail-1",
                  toolName: "bash",
                  args: { command: "cat missing-file-for-rpc-smoke" },
                  partialResult: {
                    content: [{ type: "text", text: "cat: missing-file-for-rpc-smoke: No such file or directory\n" }],
                    details: {},
                  },
                };
                yield {
                  type: "tool_execution_end",
                  toolCallId: "bash-fail-1",
                  toolName: "bash",
                  result: {
                    content: [{
                      type: "text",
                      text: "cat: missing-file-for-rpc-smoke: No such file or directory\n\n\nCommand exited with code 1",
                    }],
                    details: {},
                  },
                  isError: true,
                };
                yield {
                  type: "agent_end",
                  messages: [{
                    role: "assistant",
                    content: [{ type: "text", text: "Pi RPC answer." }],
                    usage: {
                      input: 20,
                      output: 5,
                      cacheRead: 3,
                      cost: { total: 0.0025 },
                    },
                  }],
                };
              })(),
              close: async () => {},
            }),
          }),
          getAvailableModels: async () => [],
        }),
      }),
    });

    await seedChat(testDb, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: "pi",
      output_visibility: { toolDetails: false },
    }));
  });

  after(async () => {
    await mockServer?.close();
    await fs.rm(CACHE_PATH, { force: true });
  });

  it("projects Pi RPC read, bash, file, error, answer, and usage events to WhatsApp messages", async () => {
    const { sock, getRenderedMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Use Pi RPC", senderId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const textMessages = getRenderedMessages();

    assert.ok(textMessages.some((text) => text.includes("*Read*  `README.md`")), `Expected Pi read progress, got ${JSON.stringify(textMessages)}`);
    assert.ok(textMessages.some((text) => text.includes("*Shell*  `pwd`")), `Expected Pi bash progress, got ${JSON.stringify(textMessages)}`);
    assert.ok(textMessages.some((text) => text.includes("*Update File*  `src/app.js`")), `Expected Pi file change, got ${JSON.stringify(textMessages)}`);
    assert.ok(textMessages.some((text) => text.includes("*Add File*  `generated.txt`")), `Expected Pi write file change, got ${JSON.stringify(textMessages)}`);
    assert.ok(textMessages.some((text) => text.includes("missing-file-for-rpc-smoke") || text.includes("Command exited with code 1")), `Expected Pi failed bash output, got ${JSON.stringify(textMessages)}`);
    assert.ok(textMessages.some((text) => text.includes("Pi RPC answer.")), `Expected Pi answer, got ${JSON.stringify(textMessages)}`);
    assert.ok(textMessages.some((text) => text.includes("Cost: 0.002500")), `Expected Pi usage cost, got ${JSON.stringify(textMessages)}`);
  });
});

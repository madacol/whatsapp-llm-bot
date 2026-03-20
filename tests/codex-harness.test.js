import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { setDb } from "../db.js";
import { createTestDb, seedChat } from "./helpers.js";
import {
  buildCodexExecArgs,
  createCodexHarness,
} from "../harnesses/codex.js";

before(async () => {
  const db = await createTestDb();
  setDb("./pgdata/root", db);
});

describe("createCodexHarness", () => {
  it("exposes the unified harness contract", () => {
    const harness = createCodexHarness();

    assert.equal(harness.getName(), "codex");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");
    assert.deepEqual(harness.getCapabilities(), {
      supportsResume: true,
      supportsCancel: true,
      supportsLiveInput: false,
      supportsApprovals: true,
      supportsWorkdir: true,
      supportsSandboxConfig: true,
      supportsModelSelection: true,
      supportsReasoningEffort: false,
      supportsSessionFork: false,
    });
  });

  it("handles codex-owned model command", async () => {
    const db = await createTestDb();
    await seedChat(db, "codex-chat-1", { enabled: true });
    const harness = createCodexHarness();
    /** @type {string[]} */
    const replies = [];
    const handled = await harness.handleCommand({
      chatId: "codex-chat-1",
      command: "model gpt-5.4",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "codex-chat-1",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (_source, content) => {
          replies.push(typeof content === "string" ? content : JSON.stringify(content));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
    });

    assert.equal(handled, true);
    assert.ok(replies[0]?.includes("Codex model set"));
  });

  it("lets the user choose from valid codex model options when no model is provided", async () => {
    const db = await createTestDb();
    await seedChat(db, "codex-chat-2", { enabled: true });
    const harness = createCodexHarness();
    /** @type {string[]} */
    const replies = [];
    /** @type {SelectOption[] | null} */
    let selectedOptions = null;

    const handled = await harness.handleCommand({
      chatId: "codex-chat-2",
      command: "model",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "codex-chat-2",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (_source, content) => {
          replies.push(typeof content === "string" ? content : JSON.stringify(content));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async (_question, options) => {
          selectedOptions = options;
          return "gpt-5.3-codex";
        },
        confirm: async () => true,
      }),
    });

    assert.equal(handled, true);
    assert.deepEqual(selectedOptions, [
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      { id: "gpt-5-codex", label: "GPT-5 Codex" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "off", label: "Default" },
    ]);
    assert.ok(replies.at(-1)?.includes("Codex model: `gpt-5.3-codex`"));
  });
});

describe("buildCodexExecArgs", () => {
  it("builds args for a new run with model and sandbox config", () => {
    const args = buildCodexExecArgs({
      prompt: "Fix the failing test",
      runConfig: {
        workdir: "/repo",
        model: "gpt-5.4-codex",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      },
      outputLastMessagePath: "/tmp/final.txt",
    });

    assert.deepEqual(args, [
      "-m", "gpt-5.4-codex",
      "-s", "workspace-write",
      "-a", "never",
      "-C", "/repo",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--output-last-message", "/tmp/final.txt",
      "-",
    ]);
  });

  it("builds args for a resumed run", () => {
    const args = buildCodexExecArgs({
      prompt: "Continue",
      sessionId: "sess-123",
      outputLastMessagePath: "/tmp/final.txt",
    });

    assert.deepEqual(args, [
      "exec",
      "resume",
      "sess-123",
      "--json",
      "--skip-git-repo-check",
      "--output-last-message", "/tmp/final.txt",
      "-",
    ]);
  });
});

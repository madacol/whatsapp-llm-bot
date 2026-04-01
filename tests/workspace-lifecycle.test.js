import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createChatTurn, createMockLlmServer, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { setDb } from "../db.js";

const execFileAsync = promisify(execFile);

/** @type {PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {string[]} */
let tempDirs = [];

/**
 * @returns {Promise<{
 *   transport: ChatTransport,
 *   createdGroups: Array<{ subject: string, participants: string[], chatId: string }>,
 *   promotedParticipants: Array<{ chatId: string, participants: string[] }>,
 *   sentTexts: Array<{ chatId: string, text: string }>,
 *   renamedGroups: Array<{ chatId: string, subject: string }>,
 *   announcementChanges: Array<{ chatId: string, enabled: boolean }>,
 * }>}
 */
function createFakeTransport() {
  /** @type {Array<{ subject: string, participants: string[], chatId: string }>} */
  const createdGroups = [];
  /** @type {Array<{ chatId: string, participants: string[] }>} */
  const promotedParticipants = [];
  /** @type {Array<{ chatId: string, text: string }>} */
  const sentTexts = [];
  /** @type {Array<{ chatId: string, subject: string }>} */
  const renamedGroups = [];
  /** @type {Array<{ chatId: string, enabled: boolean }>} */
  const announcementChanges = [];

  let groupCounter = 0;
  const instanceId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  return {
    createdGroups,
    promotedParticipants,
    sentTexts,
    renamedGroups,
    announcementChanges,
    transport: {
      start: async () => {},
      stop: async () => {},
      sendText: async (chatId, text) => {
        sentTexts.push({ chatId, text });
      },
      createGroup: async (subject, participants) => {
        groupCounter += 1;
        const chatId = `${subject}-${instanceId}-${groupCounter}@g.us`;
        createdGroups.push({ subject, participants, chatId });
        return { chatId, subject };
      },
      promoteParticipants: async (chatId, participants) => {
        promotedParticipants.push({ chatId, participants });
      },
      renameGroup: async (chatId, subject) => {
        renamedGroups.push({ chatId, subject });
      },
      setAnnouncementOnly: async (chatId, enabled) => {
        announcementChanges.push({ chatId, enabled });
      },
    },
  };
}

/**
 * @param {string} message
 * @returns {ChatTransport}
 */
function createFailingGroupTransport(message) {
  return {
    start: async () => {},
    stop: async () => {},
    sendText: async () => {},
    createGroup: async () => {
      throw new Error(message);
    },
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function runGit(cwd, args) {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  return `${stdout}${stderr}`;
}

/**
 * @param {string} cwd
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeTrackedFile(cwd, content) {
  await fs.writeFile(path.join(cwd, "app.txt"), `${content}\n`);
}

/**
 * @returns {Promise<string>}
 */
async function createRepoFixture() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-lifecycle-"));
  tempDirs.push(tempDir);

  await runGit(tempDir, ["init", "--initial-branch=master"]);
  await runGit(tempDir, ["config", "user.email", "test@example.com"]);
  await runGit(tempDir, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({
    name: "workspace-fixture",
    version: "1.0.0",
    type: "module",
    scripts: {
      "type-check": "node -e \"\"",
      "test": "node --test",
    },
  }, null, 2));
  await writeTrackedFile(tempDir, "base");
  await runGit(tempDir, ["add", "."]);
  await runGit(tempDir, ["commit", "-m", "Initial commit"]);
  return tempDir;
}

/**
 * @param {string} chatId
 * @param {{ harnessCwd?: string }} [options]
 * @returns {Promise<void>}
 */
async function seedChat(chatId, options = {}) {
  await seedChat_(db, chatId, { enabled: true });
  if (options.harnessCwd) {
    await db.sql`UPDATE chats SET harness_cwd = ${options.harnessCwd} WHERE chat_id = ${chatId}`;
  }
}

/**
 * @param {{ transport?: ChatTransport }} [options]
 * @returns {Promise<(msg: ChatTurn) => Promise<void>>}
 */
async function createHandler(options = {}) {
  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();
  const { createMessageHandler } = await import("../index.js");
  const { getActions, executeAction } = await import("../actions.js");
  const handler = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
    transport: options.transport,
  });
  return handler.handleMessage;
}

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);
  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;
  const { initStore } = await import("../store.js");
  store = await initStore(db);
});

after(async () => {
  await mockServer?.close();
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("workspace lifecycle", () => {
  it("surfaces WhatsApp group creation failures with context", async () => {
    const repoRoot = await createRepoFixture();
    const handleMessage = await createHandler({
      transport: createFailingGroupTransport("bad-request"),
    });

    await seedChat("repo-create-fail-chat", { harnessCwd: repoRoot });

    const turn = createChatTurn({
      chatId: "repo-create-fail-chat",
      content: [{ type: "text", text: "!new asd" }],
    });
    await handleMessage(turn.context);

    assert.ok(
      turn.responses.some((response) => response.text.includes("WhatsApp group creation failed: bad-request")),
      "expected !new to explain that WhatsApp group creation failed",
    );
  });

  it("creates a workspace chat, worktree, and branch from !new", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });

    await seedChat("repo-create-chat", { harnessCwd: repoRoot });
    await db.sql`
      UPDATE chats
      SET
        model = 'openai/gpt-4.1-mini',
        system_prompt = 'Be concise',
        respond_on = 'any',
        debug = true,
        memory = true,
        memory_threshold = 0.42,
        enabled_actions = '["fetch_url"]'::jsonb,
        model_roles = '{"coding":"openai/gpt-4.1"}'::jsonb,
        harness = 'codex',
        output_visibility = '{"thinking":true}'::jsonb,
        harness_config = '{"codex":{"model":"openai/gpt-4.1","sandboxMode":"workspace-write"}}'::jsonb,
        media_to_text_models = '{"general":"openai/gpt-4.1-mini","image":"openai/gpt-4.1"}'::jsonb
      WHERE chat_id = 'repo-create-chat'
    `;

    const { context, responses } = createChatTurn({
      chatId: "repo-create-chat",
      content: [{ type: "text", text: "!new payments" }],
    });
    await handleMessage(context);

    const repo = await store.getRepoByRootPath(repoRoot);
    assert.ok(repo, "repo should be inferred from the root cwd");
    const workspace = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.ok(workspace, "workspace should be created");
    assert.equal(workspace?.branch, "ws/payments");
    assert.equal(workspace?.base_branch, "master");
    assert.equal(transportState.createdGroups.length, 1);
    assert.equal(transportState.createdGroups[0]?.subject, "ws/payments");
    assert.deepEqual(transportState.createdGroups[0]?.participants, ["master-user@s.whatsapp.net"]);
    assert.deepEqual(transportState.promotedParticipants, [{
      chatId: workspace.workspace_chat_id,
      participants: ["master-user@s.whatsapp.net"],
    }]);
    assert.ok(transportState.sentTexts[0]?.text.includes("Workspace: payments"));
    const enabledChat = await store.getChat(workspace.workspace_chat_id);
    assert.equal(enabledChat?.is_enabled, true);
    assert.equal(enabledChat?.model, "openai/gpt-4.1-mini");
    assert.equal(enabledChat?.system_prompt, "Be concise");
    assert.equal(enabledChat?.respond_on, "any");
    assert.equal(enabledChat?.debug, true);
    assert.equal(enabledChat?.memory, true);
    assert.equal(enabledChat?.memory_threshold, 0.42);
    assert.deepEqual(enabledChat?.enabled_actions, ["fetch_url"]);
    assert.deepEqual(enabledChat?.model_roles, { coding: "openai/gpt-4.1" });
    assert.equal(enabledChat?.harness, "codex");
    assert.deepEqual(enabledChat?.output_visibility, { thinking: true });
    assert.deepEqual(enabledChat?.harness_config, {
      codex: { model: "openai/gpt-4.1", sandboxMode: "workspace-write" },
    });
    assert.deepEqual(enabledChat?.media_to_text_models, {
      general: "openai/gpt-4.1-mini",
      image: "openai/gpt-4.1",
    });
    assert.equal(enabledChat?.harness_cwd, null);
    assert.ok(responses.some((response) => response.text.includes("Created workspace `payments`.")));

    const branchName = (await execFileAsync("git", ["branch", "--show-current"], { cwd: workspace?.worktree_path })).stdout.trim();
    assert.equal(branchName, "ws/payments");
  });

  it("runs !diff, !test, !commit, and !merge successfully", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });

    await seedChat("repo-happy-chat", { harnessCwd: repoRoot });

    await handleMessage(createChatTurn({
      chatId: "repo-happy-chat",
      content: [{ type: "text", text: "!new payments" }],
    }).context);

    const repo = await store.getRepoByRootPath(repoRoot);
    assert.ok(repo, "repo should be inferred from the root cwd");
    const workspace = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.ok(workspace, "workspace should exist after !new");
    await writeTrackedFile(workspace.worktree_path, "workspace change");

    let turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!diff" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("app.txt")));

    turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!test" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Type-check passed.")));
    assert.ok(turn.responses.some((response) => response.text.includes("Tests passed.")));

    turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!commit Update app" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Committed on `ws/payments`.")));

    turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!merge" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Merged `ws/payments` into `master`.")));

    const mergedText = await fs.readFile(path.join(repoRoot, "app.txt"), "utf8");
    assert.equal(mergedText, "workspace change\n");
  });

  it("surfaces conflicts, shows conflicted files, and can abort", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });

    await seedChat("repo-conflict-chat", { harnessCwd: repoRoot });

    await handleMessage(createChatTurn({
      chatId: "repo-conflict-chat",
      content: [{ type: "text", text: "!new payments" }],
    }).context);
    const repo = await store.getRepoByRootPath(repoRoot);
    assert.ok(repo, "repo should be inferred from the root cwd");
    const workspace = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.ok(workspace);

    await writeTrackedFile(workspace.worktree_path, "workspace side");
    await runGit(workspace.worktree_path, ["add", "app.txt"]);
    await runGit(workspace.worktree_path, ["commit", "-m", "workspace change"]);

    await writeTrackedFile(repoRoot, "base side");
    await runGit(repoRoot, ["add", "app.txt"]);
    await runGit(repoRoot, ["commit", "-m", "base change"]);

    let turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!merge" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Merge blocked by conflicts")));

    let updatedWorkspace = await store.getWorkspace(workspace.workspace_id);
    assert.equal(updatedWorkspace?.status, "conflicted");
    assert.deepEqual(updatedWorkspace?.conflicted_files, ["app.txt"]);

    turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!show conflict" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("`app.txt`")));

    turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!abort merge" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Aborted merge attempt")));

    updatedWorkspace = await store.getWorkspace(workspace.workspace_id);
    assert.equal(updatedWorkspace?.status, "ready");
  });

  it("resolves simple conflicts automatically and archives the workspace chat", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });

    await seedChat("repo-resolve-chat", { harnessCwd: repoRoot });

    await handleMessage(createChatTurn({
      chatId: "repo-resolve-chat",
      content: [{ type: "text", text: "!new payments" }],
    }).context);
    const repo = await store.getRepoByRootPath(repoRoot);
    assert.ok(repo, "repo should be inferred from the root cwd");
    const workspace = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.ok(workspace);

    await writeTrackedFile(workspace.worktree_path, "workspace side");
    await runGit(workspace.worktree_path, ["add", "app.txt"]);
    await runGit(workspace.worktree_path, ["commit", "-m", "workspace change"]);

    await writeTrackedFile(repoRoot, "base side");
    await runGit(repoRoot, ["add", "app.txt"]);
    await runGit(repoRoot, ["commit", "-m", "base change"]);

    await handleMessage(createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!merge" }],
    }).context);

    let turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!resolve conflicts" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Resolved conflicts in `ws/payments`.")));

    turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!merge" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Merged `ws/payments` into `master`.")));

    turn = createChatTurn({
      chatId: workspace.workspace_chat_id,
      content: [{ type: "text", text: "!archive" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Archived workspace `payments`.")));
    assert.deepEqual(transportState.renamedGroups, [{ chatId: workspace.workspace_chat_id, subject: "ws/payments (archived)" }]);
    assert.deepEqual(transportState.announcementChanges, [{ chatId: workspace.workspace_chat_id, enabled: true }]);
  });
});

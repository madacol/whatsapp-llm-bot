import { after, afterEach, before, describe, it } from "node:test";
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
import { contentEvent } from "../outbound-events.js";
import { getChatWorkDir } from "../utils.js";

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
 *   createdCommunities: Array<{ subject: string, description: string, chatId: string }>,
 *   linkedGroups: Array<{ chatId: string, communityChatId: string }>,
 *   promotedParticipants: Array<{ chatId: string, participants: string[] }>,
 *   sentTexts: Array<{ chatId: string, text: string }>,
 *   sentEvents: Array<{ chatId: string, event: OutboundEvent }>,
 *   renamedGroups: Array<{ chatId: string, subject: string }>,
 *   announcementChanges: Array<{ chatId: string, enabled: boolean }>,
 * }>}
 */
function createFakeTransport() {
  /** @type {Array<{ subject: string, participants: string[], chatId: string }>} */
  const createdGroups = [];
  /** @type {Array<{ subject: string, description: string, chatId: string }>} */
  const createdCommunities = [];
  /** @type {Array<{ chatId: string, communityChatId: string }>} */
  const linkedGroups = [];
  /** @type {Array<{ chatId: string, participants: string[] }>} */
  const promotedParticipants = [];
  /** @type {Array<{ chatId: string, text: string }>} */
  const sentTexts = [];
  /** @type {Array<{ chatId: string, event: OutboundEvent }>} */
  const sentEvents = [];
  /** @type {Array<{ chatId: string, subject: string }>} */
  const renamedGroups = [];
  /** @type {Array<{ chatId: string, enabled: boolean }>} */
  const announcementChanges = [];

  let groupCounter = 0;
  const instanceId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  return {
    createdGroups,
    createdCommunities,
    linkedGroups,
    promotedParticipants,
    sentTexts,
    sentEvents,
    renamedGroups,
    announcementChanges,
    transport: {
      start: async () => {},
      stop: async () => {},
      sendText: async (chatId, text) => {
        sentTexts.push({ chatId, text });
      },
      sendEvent: async (chatId, event) => {
        sentEvents.push({ chatId, event });
        return {
          keyId: `event-${sentEvents.length}`,
          isImage: false,
          update: async () => {},
          setInspect: () => {},
        };
      },
      createGroup: async (subject, participants) => {
        groupCounter += 1;
        const chatId = `group-${instanceId}-${groupCounter}@g.us`;
        createdGroups.push({ subject, participants, chatId });
        return { chatId, subject };
      },
      createCommunity: async (subject, description) => {
        groupCounter += 1;
        const chatId = `community-${instanceId}-${groupCounter}@g.us`;
        createdCommunities.push({ subject, description, chatId });
        return { chatId, subject };
      },
      createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
        groupCounter += 1;
        const chatId = `group-${instanceId}-${groupCounter}@g.us`;
        createdGroups.push({ subject, participants, chatId });
        return { chatId, subject };
      },
      linkExistingGroupToCommunity: async (chatId, communityChatId) => {
        linkedGroups.push({ chatId, communityChatId });
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
 * @param {string} workspaceId
 * @returns {Promise<WhatsAppWorkspacePresentationRow>}
 */
async function getWorkspaceSurface(workspaceId) {
  const presentation = await store.getWhatsAppWorkspacePresentation(workspaceId);
  assert.ok(presentation, `workspace ${workspaceId} should have a WhatsApp presentation`);
  return presentation;
}

/**
 * @param {{ transport?: ChatTransport }} [options]
 * @returns {Promise<(msg: ChatTurn) => Promise<void>>}
 */
async function createHandler(options = {}) {
  process.env.BASE_URL = mockServer.url;
  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();
  const { createMessageHandler } = await import("../index.js");
  const { getActions, executeAction } = await import("../actions.js");
  const { createWhatsAppWorkspacePresenter } = await import("../whatsapp/workspace-presenter.js");
  const handler = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
    transport: options.transport,
    workspacePresentation: options.transport
      ? createWhatsAppWorkspacePresenter({ transport: options.transport, store })
      : undefined,
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
  afterEach(() => {
    const pending = mockServer.pendingResponses();
    assert.equal(pending, 0, `Mock response queue should be empty after each test, but has ${pending} unconsumed response(s).`);
  });

  it("surfaces WhatsApp chat creation failures with context", async () => {
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
      turn.responses.some((response) => response.text.includes("WhatsApp chat creation failed: bad-request")),
      "expected !new to explain that WhatsApp chat creation failed",
    );
  });

  it("offers replace/new/cancel and reuses the same group on replace", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });
    const repoChatName = "Original Group";

    await seedChat("repo-duplicate-chat", { harnessCwd: repoRoot });

    await handleMessage(createChatTurn({
      chatId: "repo-duplicate-chat",
      chatName: repoChatName,
      content: [{ type: "text", text: "!new payments" }],
    }).context);

    const repo = await store.getProjectByRootPath(repoRoot);
    assert.ok(repo);
    const originalWorkspace = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.ok(originalWorkspace);
    await fs.writeFile(path.join(originalWorkspace.worktree_path, "replace-marker.txt"), "old workspace\n");

    const turn = createChatTurn({
      chatId: "repo-duplicate-chat",
      chatName: repoChatName,
      content: [{ type: "text", text: "!new payments" }],
    });
    turn.context.io.select = async (question, options) => {
      turn.responses.push({ type: "select", text: JSON.stringify({ question, options }) });
      return "replace";
    };
    await handleMessage(turn.context);

    assert.ok(
      turn.responses.some((response) =>
        response.type === "select"
        && response.text.includes("replace")
        && response.text.includes("new")
        && response.text.includes("cancel"),
      ),
      `expected duplicate !new to offer replace/new/cancel, got: ${turn.responses.map((response) => response.text).join(" | ")}`,
    );
    const replacedWorkspace = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.ok(replacedWorkspace);
    const originalSurface = await getWorkspaceSurface(originalWorkspace.workspace_id);
    const replacedSurface = await getWorkspaceSurface(replacedWorkspace.workspace_id);
    assert.equal(replacedSurface.workspace_chat_id, originalSurface.workspace_chat_id);
    assert.equal(transportState.createdGroups.length, 1);
    assert.ok(turn.responses.some((response) => response.text.includes("Replaced workspace `payments`.")));
    assert.deepEqual(transportState.renamedGroups, [{
      chatId: originalSurface.workspace_chat_id,
      subject: "[payments] Original Group",
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Chat: `[payments] Original Group`")));
    await assert.rejects(() => fs.access(path.join(replacedWorkspace.worktree_path, "replace-marker.txt")));
  });

  it("uses the source chat name when naming a new workspace chat", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });

    await seedChat("repo-named-chat", { harnessCwd: repoRoot });

    const { context, responses } = createChatTurn({
      chatId: "repo-named-chat",
      chatName: "Original Group",
      content: [{ type: "text", text: "!new payments" }],
    });
    await handleMessage(context);

    assert.equal(transportState.createdGroups[0]?.subject, "[payments] Original Group");
    assert.ok(responses.some((response) => response.text.includes("Chat: `[payments] Original Group`")));
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

    const repo = await store.getProjectByRootPath(repoRoot);
    assert.ok(repo, "repo should be inferred from the root cwd");
    const workspace = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.ok(workspace, "workspace should be created");
    const workspaceSurface = await getWorkspaceSurface(workspace.workspace_id);
    assert.equal(workspace?.branch, "payments");
    assert.equal(workspace?.base_branch, "master");
    assert.equal(transportState.createdGroups.length, 1);
    assert.equal(transportState.createdGroups[0]?.subject, "payments");
    assert.deepEqual(transportState.createdGroups[0]?.participants, ["master-user@s.whatsapp.net"]);
    assert.deepEqual(transportState.promotedParticipants, [{
      chatId: workspaceSurface.workspace_chat_id,
      participants: ["master-user@s.whatsapp.net"],
    }]);
    const workspaceBootstrapEvent = transportState.sentEvents.find((entry) => entry.chatId === workspaceSurface.workspace_chat_id);
    assert.deepEqual(workspaceBootstrapEvent, {
      chatId: workspaceSurface.workspace_chat_id,
      event: contentEvent("plain", [{ type: "text", text: [
        "Workspace: payments",
        "Base: master",
        "Branch: payments",
        "Status: ready",
        "Last test: not run",
        "Last commit: none",
      ].join("\n") }]),
    });
    assert.deepEqual(transportState.sentTexts, []);
    const enabledChat = await store.getChat(workspaceSurface.workspace_chat_id);
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
    assert.equal(branchName, "payments");
  });

  it("creates a multi-word workspace and seeds the first prompt", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });
    mockServer.addResponses("Seed received.");

    await seedChat("repo-seeded-chat", { harnessCwd: repoRoot });

    const { context, responses } = createChatTurn({
      chatId: "repo-seeded-chat",
      content: [{ type: "text", text: "!new multi word branch: investigate duplicate charges" }],
    });
    await handleMessage(context);

    const repo = await store.getProjectByRootPath(repoRoot);
    assert.ok(repo, "repo should be inferred from the root cwd");
    const workspace = await store.getWorkspaceByName(repo.repo_id, "multi word branch");
    assert.ok(workspace, "workspace should be created");
    const workspaceSurface = await getWorkspaceSurface(workspace.workspace_id);
    assert.equal(workspace?.branch, "multi-word-branch");
    assert.equal(workspace?.base_branch, "master");
    assert.equal(transportState.createdGroups[0]?.subject, "multi word branch");
    const workspaceEvents = transportState.sentEvents
      .filter((entry) => entry.chatId === workspaceSurface.workspace_chat_id)
      .map((entry) => entry.event);
    assert.deepEqual(workspaceEvents[0], contentEvent("plain", [{ type: "text", text: [
      "Workspace: multi word branch",
      "Base: master",
      "Branch: multi-word-branch",
      "Status: ready",
      "Last test: not run",
      "Last commit: none",
    ].join("\n") }]));
    assert.deepEqual(workspaceEvents[1], contentEvent("plain", [{ type: "text", text: "Prompt: investigate duplicate charges" }]));
    assert.equal(transportState.sentTexts.length, 0);
    const seededReply = workspaceEvents.find((event) => (
      event.kind === "content"
      && Array.isArray(event.content)
      && event.content.some((block) => block.type === "markdown" && block.text === "Seed received.")
    ));
    assert.ok(seededReply, "expected seeded workspace reply to use semantic content events");
    if (!seededReply || seededReply.kind !== "content") {
      assert.fail("expected seeded workspace reply to use semantic content events");
    }
    assert.deepEqual(seededReply.content, [{ type: "markdown", text: "Seed received." }]);
    const workspaceMessages = await store.getMessages(workspaceSurface.workspace_chat_id, new Date(0));
    const userMessages = workspaceMessages
      .map((row) => row.message_data)
      .filter((message) => message?.role === "user");
    assert.ok(
      userMessages.some((message) =>
        message.content.some((block) => block.type === "text" && block.text.includes("investigate duplicate charges")),
      ),
      "expected the seed prompt to be stored as the first user message in the workspace chat",
    );
    assert.ok(responses.some((response) => response.text.includes("Created workspace `multi word branch`.")));
  });

  it("bases !new from the current workspace branch when run inside a workspace chat", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });

    await seedChat("repo-parent-chat", { harnessCwd: repoRoot });

    await handleMessage(createChatTurn({
      chatId: "repo-parent-chat",
      content: [{ type: "text", text: "!new parent branch" }],
    }).context);

    const repo = await store.getProjectByRootPath(repoRoot);
    assert.ok(repo, "repo should be inferred from the root cwd");
    const parentWorkspace = await store.getWorkspaceByName(repo.repo_id, "parent branch");
    assert.ok(parentWorkspace, "parent workspace should exist");
    const parentSurface = await getWorkspaceSurface(parentWorkspace.workspace_id);

    const { context, responses } = createChatTurn({
      chatId: parentSurface.workspace_chat_id,
      content: [{ type: "text", text: "!new child branch" }],
    });
    await handleMessage(context);

    const childWorkspace = await store.getWorkspaceByName(repo.repo_id, "child branch");
    assert.ok(childWorkspace, "child workspace should be created");
    assert.equal(childWorkspace?.base_branch, parentWorkspace.branch);
    assert.equal(childWorkspace?.branch, "child-branch");
    assert.ok(responses.some((response) => response.text.includes("Created workspace `child branch`.")));
  });

  it("auto-adopts a fresh group chat and upgrades to a community on the first !new", async () => {
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });
    const chatId = "fresh-group-chat";
    const chatName = "Original Group";

    const { context, responses } = createChatTurn({
      chatId,
      chatName,
      content: [{ type: "text", text: "!new payments" }],
      facts: { isGroup: true },
    });
    await handleMessage(context);

    const adoptedRootPath = getChatWorkDir(chatId, undefined, chatName);
    const repo = await store.getProjectByRootPath(adoptedRootPath);
    assert.ok(repo, "expected the fresh chat to be adopted into a project");

    const originalBinding = await store.getChatBinding(chatId);
    assert.equal(originalBinding?.binding_kind, "workspace");
    assert.ok(originalBinding?.workspace_id, "expected the original chat to be bound as a workspace");

    const originalWorkspace = await store.getWorkspace(originalBinding?.workspace_id ?? "");
    assert.ok(originalWorkspace, "expected the original chat workspace to exist");
    assert.equal(originalWorkspace?.worktree_path, adoptedRootPath);
    assert.equal(originalWorkspace?.branch, "master");
    assert.equal(originalWorkspace?.base_branch, "master");

    const childWorkspace = await store.getWorkspaceByName(repo?.repo_id ?? "", "payments");
    assert.ok(childWorkspace, "expected the sibling workspace created by !new");
    assert.equal(childWorkspace?.branch, "payments");
    assert.equal(childWorkspace?.base_branch, "master");

    assert.equal(transportState.createdCommunities.length, 1);
    assert.equal(transportState.createdCommunities[0]?.subject, chatName);
    assert.equal(transportState.createdGroups.length, 1);
    assert.equal(transportState.createdGroups[0]?.subject, "payments");
    assert.deepEqual(transportState.linkedGroups, [{
      chatId,
      communityChatId: transportState.createdCommunities[0]?.chatId ?? "",
    }]);
    assert.deepEqual(transportState.renamedGroups, [{
      chatId,
      subject: "main",
    }]);
    assert.ok(responses.some((response) => response.text.includes("Created workspace `payments`.")));

    const currentBranch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: adoptedRootPath })).stdout.trim();
    assert.equal(currentBranch, "master");
  });

  it("does not offer replace for the primary chat workspace name", async () => {
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });
    const chatId = "primary-workspace-chat";
    const chatName = "Original Group";

    const turn = createChatTurn({
      chatId,
      chatName,
      content: [{ type: "text", text: `!new ${chatName}` }],
      facts: { isGroup: true },
    });
    turn.context.io.select = async (question, options) => {
      turn.responses.push({ type: "select", text: JSON.stringify({ question, options }) });
      return "new";
    };
    await handleMessage(turn.context);

    const selectResponse = turn.responses.find((response) => response.type === "select");
    assert.ok(selectResponse, "expected duplicate workspace prompt");
    assert.ok(!selectResponse?.text.includes("\"replace\""), `expected no replace option, got: ${selectResponse?.text}`);
    assert.ok(turn.responses.some((response) => response.text.includes("Use `!new <different-name>`")));

    const adoptedRootPath = getChatWorkDir(chatId, undefined, chatName);
    await fs.access(adoptedRootPath);
    assert.equal(transportState.createdGroups.length, 0);
    assert.equal(transportState.createdCommunities.length, 0);
  });

  it("runs !diff and rejects !commit as an unknown command", async () => {
    const repoRoot = await createRepoFixture();
    const transportState = createFakeTransport();
    const handleMessage = await createHandler({ transport: transportState.transport });

    await seedChat("repo-happy-chat", { harnessCwd: repoRoot });

    await handleMessage(createChatTurn({
      chatId: "repo-happy-chat",
      content: [{ type: "text", text: "!new payments" }],
    }).context);

    const repo = await store.getProjectByRootPath(repoRoot);
    assert.ok(repo, "repo should be inferred from the root cwd");
    const workspace = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.ok(workspace, "workspace should exist after !new");
    const workspaceSurface = await getWorkspaceSurface(workspace.workspace_id);
    await writeTrackedFile(workspace.worktree_path, "workspace change");

    let turn = createChatTurn({
      chatId: workspaceSurface.workspace_chat_id,
      content: [{ type: "text", text: "!diff" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("app.txt")));

    turn = createChatTurn({
      chatId: workspaceSurface.workspace_chat_id,
      content: [{ type: "text", text: "!commit Update app" }],
    });
    await handleMessage(turn.context);
    assert.ok(turn.responses.some((response) => response.text.includes("Unknown command: commit")));
  });
});

import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createChatTurn, createMockLlmServer, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);

  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;

  const { initStore } = await import("../store.js");
  store = await initStore(db);

  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();

  const { createMessageHandler } = await import("../index.js");
  const { getActions, executeAction } = await import("../actions.js");

  const handler = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
  });
  handleMessage = handler.handleMessage;
});

after(async () => {
  await mockServer?.close();
});

/**
 * @param {string} chatId
 * @param {{ enabled?: boolean }} [options]
 */
async function seedChat(chatId, options = {}) {
  await seedChat_(db, chatId, { enabled: options.enabled ?? true });
}

describe("workspace commands", () => {
  afterEach(() => {
    const pending = mockServer.pendingResponses();
    assert.equal(pending, 0, `Mock response queue should be empty after each test, but has ${pending} unconsumed response(s).`);
  });

  it("lists active workspaces from the repo chat", async () => {
    await seedChat("repo-list-chat");
    await seedChat("ws-payments-chat");
    await seedChat("ws-auth-chat");

    const repo = await store.createRepo({
      name: "main",
      rootPath: "/repo/main",
      defaultBaseBranch: "master",
      controlChatId: "repo-list-chat",
    });
    await store.createWorkspace({
      repoId: repo.repo_id,
      name: "payments",
      branch: "payments",
      baseBranch: "master",
      worktreePath: "/repo/main/.madabot/worktrees/payments",
      workspaceChatId: "ws-payments-chat",
      workspaceChatSubject: "payments",
      status: "ready",
    });
    await store.createWorkspace({
      repoId: repo.repo_id,
      name: "auth",
      branch: "auth",
      baseBranch: "master",
      worktreePath: "/repo/main/.madabot/worktrees/auth",
      workspaceChatId: "ws-auth-chat",
      workspaceChatSubject: "auth",
      status: "busy",
    });

    const { context, responses } = createChatTurn({
      chatId: "repo-list-chat",
      content: [{ type: "text", text: "!list" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some((response) => response.text.includes("Active workspaces:")),
      `Expected workspace list response, got: ${responses.map((response) => response.text).join(" | ")}`,
    );
    assert.ok(responses.some((response) => response.text.includes("payments") && response.text.includes("ready")));
    assert.ok(responses.some((response) => response.text.includes("auth") && response.text.includes("busy")));
  });

  it("shows workspace status in a workspace chat", async () => {
    await seedChat("repo-status-chat");
    await seedChat("ws-status-chat");

    const repo = await store.createRepo({
      name: "status-repo",
      rootPath: "/repo/status",
      defaultBaseBranch: "master",
      controlChatId: "repo-status-chat",
    });
    await store.createWorkspace({
      repoId: repo.repo_id,
      name: "payments",
      branch: "payments",
      baseBranch: "master",
      worktreePath: "/repo/status/.madabot/worktrees/payments",
      workspaceChatId: "ws-status-chat",
      workspaceChatSubject: "payments",
      status: "ready",
    });

    const { context, responses } = createChatTurn({
      chatId: "ws-status-chat",
      content: [{ type: "text", text: "!status" }],
    });
    await handleMessage(context);

    assert.ok(responses.some((response) => response.text.includes("Workspace: payments")));
    assert.ok(responses.some((response) => response.text.includes("Base: master")));
    assert.ok(responses.some((response) => response.text.includes("Branch: payments")));
    assert.ok(responses.some((response) => response.text.includes("Status: ready")));
  });

  it("rejects workspace-only commands in the repo chat", async () => {
    await seedChat("repo-command-chat");
    await store.createRepo({
      name: "repo-command",
      rootPath: "/repo/command",
      defaultBaseBranch: "master",
      controlChatId: "repo-command-chat",
    });

    const { context, responses } = createChatTurn({
      chatId: "repo-command-chat",
      content: [{ type: "text", text: "!status" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some((response) => response.text.includes("Workspace commands must be run inside a workspace chat.")),
      `Expected repo-chat rejection, got: ${responses.map((response) => response.text).join(" | ")}`,
    );
  });

  it("archives the named workspace from the repo chat", async () => {
    await seedChat("repo-archive-chat");
    await seedChat("ws-archive-target");

    const repo = await store.createRepo({
      name: "archive-repo",
      rootPath: "/repo/archive",
      defaultBaseBranch: "master",
      controlChatId: "repo-archive-chat",
    });
    await store.createWorkspace({
      repoId: repo.repo_id,
      name: "payments",
      branch: "payments",
      baseBranch: "master",
      worktreePath: "/repo/archive/.madabot/worktrees/payments",
      workspaceChatId: "ws-archive-target",
      workspaceChatSubject: "payments",
      status: "ready",
    });

    const { context, responses } = createChatTurn({
      chatId: "repo-archive-chat",
      content: [{ type: "text", text: "!archive payments" }],
    });
    await handleMessage(context);

    const archived = await store.getWorkspaceByName(repo.repo_id, "payments");
    assert.equal(archived?.status, "archived");
    assert.ok(responses.some((response) => response.type === "confirm" && response.text.includes("Archive workspace `payments`?")));
    assert.ok(responses.some((response) => response.text.includes("Archived workspace `payments`.")));
  });

  it("archives the current workspace from the workspace chat", async () => {
    await seedChat("repo-current-archive-chat");
    await seedChat("ws-current-archive-chat");

    const repo = await store.createRepo({
      name: "current-archive-repo",
      rootPath: "/repo/current-archive",
      defaultBaseBranch: "master",
      controlChatId: "repo-current-archive-chat",
    });
    const workspace = await store.createWorkspace({
      repoId: repo.repo_id,
      name: "payments",
      branch: "payments",
      baseBranch: "master",
      worktreePath: "/repo/current-archive/.madabot/worktrees/payments",
      workspaceChatId: "ws-current-archive-chat",
      workspaceChatSubject: "payments",
      status: "ready",
    });

    const { context, responses } = createChatTurn({
      chatId: "ws-current-archive-chat",
      content: [{ type: "text", text: "!archive" }],
    });
    await handleMessage(context);

    const archived = await store.getWorkspace(workspace.workspace_id);
    assert.equal(archived?.status, "archived");
    assert.ok(responses.some((response) => response.type === "confirm" && response.text.includes("Archive this workspace?")));
    assert.ok(responses.some((response) => response.text.includes("Archived workspace `payments`.")));
  });

  it("rejects freeform work in archived workspace chats", async () => {
    await seedChat("repo-archived-chat");
    await seedChat("ws-archived-chat");

    const repo = await store.createRepo({
      name: "archived-repo",
      rootPath: "/repo/archived",
      defaultBaseBranch: "master",
      controlChatId: "repo-archived-chat",
    });
    const workspace = await store.createWorkspace({
      repoId: repo.repo_id,
      name: "payments",
      branch: "payments",
      baseBranch: "master",
      worktreePath: "/repo/archived/.madabot/worktrees/payments",
      workspaceChatId: "ws-archived-chat",
      workspaceChatSubject: "payments",
      status: "ready",
    });
    await store.archiveWorkspace(workspace.workspace_id);

    const requestCountBefore = mockServer.getRequests().length;
    const { context, responses } = createChatTurn({
      chatId: "ws-archived-chat",
      content: [{ type: "text", text: "implement retry logic" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some((response) => response.text.includes("This workspace is archived and no longer accepts work.")),
      `Expected archived-workspace rejection, got: ${responses.map((response) => response.text).join(" | ")}`,
    );
    assert.equal(
      mockServer.getRequests().length,
      requestCountBefore,
      "Archived workspace freeform should not hit the LLM",
    );
  });
});

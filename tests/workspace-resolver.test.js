import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { initStore } from "../store.js";
import { createTestDb } from "./helpers.js";
import { createWorkspaceBindingService } from "../workspace-binding-service.js";
import { getChatWorkDir } from "../utils.js";

const execFileAsync = promisify(execFile);

/** @type {string[]} */
let tempDirs = [];

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function runGit(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

/**
 * @returns {Promise<{ repoRoot: string, worktreePath: string }>}
 */
async function createRepoWithWorktree() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-resolver-"));
  tempDirs.push(repoRoot);
  await runGit(repoRoot, ["init", "--initial-branch=master"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(repoRoot, "app.txt"), "base\n");
  await runGit(repoRoot, ["add", "app.txt"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  const worktreePath = path.join(repoRoot, "..", `ws-${path.basename(repoRoot)}`);
  await runGit(repoRoot, ["worktree", "add", "-b", "payments", worktreePath, "master"]);
  return { repoRoot, worktreePath };
}

/**
 * @param {Awaited<ReturnType<typeof initStore>>} store
 * @param {{
 *   projectId: string,
 *   name: string,
 *   branch: string,
 *   baseBranch: string,
 *   worktreePath: string,
 *   workspaceChatId: string,
 *   workspaceChatSubject: string,
 *   status?: WorkspaceStatus,
 * }} input
 * @returns {Promise<WorkspaceRow>}
 */
async function createWorkspaceFixture(store, {
  projectId,
  name,
  branch,
  baseBranch,
  worktreePath,
  workspaceChatId,
  workspaceChatSubject,
  status,
}) {
  const workspaceId = `ws-${projectId}-${name}`.replace(/\s+/g, "-");
  await store.saveWhatsAppWorkspacePresentation({
    projectId,
    workspaceId,
    workspaceChatId,
    workspaceChatSubject,
  });
  return store.createWorkspace({
    workspaceId,
    projectId,
    name,
    branch,
    baseBranch,
    worktreePath,
    status,
  });
}

describe("workspace resolver foundation", () => {
  /** @type {Awaited<ReturnType<typeof initStore>>} */
  let store;
  /** @type {ReturnType<typeof createWorkspaceBindingService>} */
  let bindingService;

  before(async () => {
    const db = await createTestDb();
    store = await initStore(db);
    bindingService = createWorkspaceBindingService(store);
  });

  after(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("resolves project-chat bindings", async () => {
    const project = await store.createProject({
      name: "resolver-main",
      rootPath: "/repo/main",
      defaultBaseBranch: "master",
      controlChatId: "repo-chat",
    });

    const resolved = await bindingService.resolveChatBinding("repo-chat");

    assert.deepEqual(resolved, {
      kind: "project",
      project,
    });
  });

  it("lets explicit folder settings bypass existing chat bindings", async () => {
    await store.createProject({
      name: "folder-override-bound-project",
      rootPath: "/repo/folder-override-bound",
      defaultBaseBranch: "master",
      controlChatId: "folder-override-chat",
    });
    const explicitFolder = await fs.mkdtemp(path.join(os.tmpdir(), "folder-override-"));
    tempDirs.push(explicitFolder);

    const resolved = await bindingService.resolveChatBinding(
      "folder-override-chat",
      explicitFolder,
      "Folder Override",
      false,
    );

    assert.deepEqual(resolved, { kind: "unbound" });
  });

  it("resolves workspace-chat bindings with project context", async () => {
    const project = await store.createProject({
      name: "payments-repo",
      rootPath: "/repo/payments",
      defaultBaseBranch: "main",
      controlChatId: "payments-control",
    });
    const workspace = await createWorkspaceFixture(store, {
      projectId: project.project_id,
      name: "payments",
      branch: "payments",
      baseBranch: "main",
      worktreePath: "/repo/payments/.madabot/worktrees/payments",
      workspaceChatId: "payments-chat",
      workspaceChatSubject: "payments",
      status: "ready",
    });

    const resolved = await bindingService.resolveChatBinding("payments-chat");

    assert.deepEqual(resolved, {
      kind: "workspace",
      project,
      workspace,
    });
  });

  it("lists only active workspaces for a repo", async () => {
    const repo = await store.createProject({
      name: "list-repo",
      rootPath: "/repo/list",
      defaultBaseBranch: "master",
      controlChatId: "list-control",
    });
    const activeWorkspace = await createWorkspaceFixture(store, {
      projectId: repo.project_id,
      name: "active",
      branch: "active",
      baseBranch: "master",
      worktreePath: "/repo/list/.madabot/worktrees/active",
      workspaceChatId: "active-chat",
      workspaceChatSubject: "active",
      status: "ready",
    });
    const archivedWorkspace = await createWorkspaceFixture(store, {
      projectId: repo.project_id,
      name: "archived",
      branch: "archived",
      baseBranch: "master",
      worktreePath: "/repo/list/.madabot/worktrees/archived",
      workspaceChatId: "archived-chat",
      workspaceChatSubject: "archived",
      status: "archived",
    });

    await store.archiveWorkspace(archivedWorkspace.workspace_id);

    const listed = await store.listActiveWorkspaces(repo.project_id);

    assert.deepEqual(listed, [activeWorkspace]);
  });

  it("infers project chats from a git root cwd without explicit registration", async () => {
    const { repoRoot } = await createRepoWithWorktree();

    const resolved = await bindingService.resolveChatBinding("git-root-chat", repoRoot);

    assert.equal(resolved.kind, "project");
    if (resolved.kind !== "project") {
      throw new Error("Expected project binding");
    }
    assert.equal(resolved.project.root_path, repoRoot);
    assert.equal(resolved.project.control_chat_id, null);
  });

  it("infers workspace chats from a worktree cwd when a workspace row exists", async () => {
    const { repoRoot, worktreePath } = await createRepoWithWorktree();
    const project = await store.createProject({
      name: `manual-${Date.now()}`,
      rootPath: repoRoot,
      defaultBaseBranch: "master",
    });
    const workspace = await createWorkspaceFixture(store, {
      projectId: project.project_id,
      name: "payments",
      branch: "payments",
      baseBranch: "master",
      worktreePath,
      workspaceChatId: "ws-chat-bound",
      workspaceChatSubject: "payments",
      status: "ready",
    });

    const resolved = await bindingService.resolveChatBinding("worktree-chat", worktreePath);

    assert.deepEqual(resolved, {
      kind: "workspace",
      project,
      workspace,
    });
  });

  it("auto-adopts a first-seen group chat as a workspace binding", async () => {
    const chatId = "resolver-fresh-group-chat";
    const chatName = "Billing Squad";

    const resolved = await bindingService.resolveChatBinding(chatId, undefined, chatName, true);

    assert.equal(resolved.kind, "workspace");
    if (resolved.kind !== "workspace") {
      throw new Error("Expected workspace binding");
    }

    const expectedRootPath = getChatWorkDir(chatId, undefined, chatName);
    assert.equal(resolved.project.root_path, expectedRootPath);
    assert.equal(resolved.workspace.worktree_path, expectedRootPath);
    assert.equal(resolved.workspace.name, chatName);
    assert.equal(resolved.workspace.branch, "master");
    assert.equal(resolved.workspace.base_branch, "master");

    const binding = await store.getChatBinding(chatId);
    assert.deepEqual(binding && {
      bindingKind: binding.binding_kind,
      projectId: binding.project_id,
      workspaceId: binding.workspace_id,
    }, {
      bindingKind: "workspace",
      projectId: resolved.project.project_id,
      workspaceId: resolved.workspace.workspace_id,
    });

    const presentation = await store.getWhatsAppWorkspacePresentationByChat(chatId);
    assert.ok(presentation);
    assert.equal(presentation?.workspace_id, resolved.workspace.workspace_id);
    assert.equal(presentation?.workspace_chat_subject, chatName);
  });
});

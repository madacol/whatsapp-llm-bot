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
 *   repoId: string,
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
  repoId,
  name,
  branch,
  baseBranch,
  worktreePath,
  workspaceChatId,
  workspaceChatSubject,
  status,
}) {
  const workspaceId = `ws-${repoId}-${name}`.replace(/\s+/g, "-");
  await store.saveWhatsAppWorkspacePresentation({
    repoId,
    workspaceId,
    workspaceChatId,
    workspaceChatSubject,
  });
  return store.createWorkspace({
    workspaceId,
    repoId,
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

  it("resolves repo-chat bindings", async () => {
    const repo = await store.createRepo({
      name: "resolver-main",
      rootPath: "/repo/main",
      defaultBaseBranch: "master",
      controlChatId: "repo-chat",
    });

    const resolved = await bindingService.resolveChatBinding("repo-chat");

    assert.deepEqual(resolved, {
      kind: "repo",
      repo,
    });
  });

  it("resolves workspace-chat bindings with repo context", async () => {
    const repo = await store.createRepo({
      name: "payments-repo",
      rootPath: "/repo/payments",
      defaultBaseBranch: "main",
      controlChatId: "payments-control",
    });
    const workspace = await createWorkspaceFixture(store, {
      repoId: repo.repo_id,
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
      repo,
      workspace,
    });
  });

  it("lists only active workspaces for a repo", async () => {
    const repo = await store.createRepo({
      name: "list-repo",
      rootPath: "/repo/list",
      defaultBaseBranch: "master",
      controlChatId: "list-control",
    });
    const activeWorkspace = await createWorkspaceFixture(store, {
      repoId: repo.repo_id,
      name: "active",
      branch: "active",
      baseBranch: "master",
      worktreePath: "/repo/list/.madabot/worktrees/active",
      workspaceChatId: "active-chat",
      workspaceChatSubject: "active",
      status: "ready",
    });
    const archivedWorkspace = await createWorkspaceFixture(store, {
      repoId: repo.repo_id,
      name: "archived",
      branch: "archived",
      baseBranch: "master",
      worktreePath: "/repo/list/.madabot/worktrees/archived",
      workspaceChatId: "archived-chat",
      workspaceChatSubject: "archived",
      status: "archived",
    });

    await store.archiveWorkspace(archivedWorkspace.workspace_id);

    const listed = await store.listActiveWorkspaces(repo.repo_id);

    assert.deepEqual(listed, [activeWorkspace]);
  });

  it("infers repo chats from a git root cwd without explicit registration", async () => {
    const { repoRoot } = await createRepoWithWorktree();

    const resolved = await bindingService.resolveChatBinding("git-root-chat", repoRoot);

    assert.equal(resolved.kind, "repo");
    if (resolved.kind !== "repo") {
      throw new Error("Expected repo binding");
    }
    assert.equal(resolved.repo.root_path, repoRoot);
    assert.equal(resolved.repo.control_chat_id, null);
  });

  it("infers workspace chats from a worktree cwd when a workspace row exists", async () => {
    const { repoRoot, worktreePath } = await createRepoWithWorktree();
    const repo = await store.createRepo({
      name: `manual-${Date.now()}`,
      rootPath: repoRoot,
      defaultBaseBranch: "master",
    });
    const workspace = await createWorkspaceFixture(store, {
      repoId: repo.repo_id,
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
      repo,
      workspace,
    });
  });
});

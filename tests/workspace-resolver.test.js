import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { initStore } from "../store.js";
import { createTestDb } from "./helpers.js";
import { resolveChatBinding } from "../workspace-resolver.js";

describe("workspace resolver foundation", () => {
  /** @type {Awaited<ReturnType<typeof initStore>>} */
  let store;

  before(async () => {
    const db = await createTestDb();
    store = await initStore(db);
  });

  it("resolves repo-chat bindings", async () => {
    const repo = await store.createRepo({
      name: "main",
      rootPath: "/repo/main",
      defaultBaseBranch: "master",
      controlChatId: "repo-chat",
    });

    const resolved = await resolveChatBinding(store, "repo-chat");

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
    const workspace = await store.createWorkspace({
      repoId: repo.repo_id,
      name: "payments",
      branch: "ws/payments",
      baseBranch: "main",
      worktreePath: "/repo/payments/.madabot/worktrees/payments",
      workspaceChatId: "payments-chat",
      status: "ready",
    });

    const resolved = await resolveChatBinding(store, "payments-chat");

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
    const activeWorkspace = await store.createWorkspace({
      repoId: repo.repo_id,
      name: "active",
      branch: "ws/active",
      baseBranch: "master",
      worktreePath: "/repo/list/.madabot/worktrees/active",
      workspaceChatId: "active-chat",
      status: "ready",
    });
    const archivedWorkspace = await store.createWorkspace({
      repoId: repo.repo_id,
      name: "archived",
      branch: "ws/archived",
      baseBranch: "master",
      worktreePath: "/repo/list/.madabot/worktrees/archived",
      workspaceChatId: "archived-chat",
      status: "archived",
    });

    await store.archiveWorkspace(archivedWorkspace.workspace_id);

    const listed = await store.listActiveWorkspaces(repo.repo_id);

    assert.deepEqual(listed, [activeWorkspace]);
  });
});

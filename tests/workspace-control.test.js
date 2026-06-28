import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceControl } from "../workspace-control.js";

/**
 * @param {Partial<Parameters<typeof createWorkspaceControl>[0]["store"]>} [overrides]
 * @returns {Parameters<typeof createWorkspaceControl>[0]["store"]}
 */
function createStore(overrides = {}) {
  return {
    listActiveWorkspaces: async () => [],
    getWorkspaceByName: async () => null,
    createWorkspace: async () => {
      throw new Error("createWorkspace not implemented by this test");
    },
    resetWorkspace: async () => {
      throw new Error("resetWorkspace not implemented by this test");
    },
    archiveWorkspace: async () => null,
    copyChatCustomizations: async () => {},
    setChatEnabled: async () => {},
    ...overrides,
  };
}

/**
 * @param {Partial<NonNullable<Parameters<typeof createWorkspaceControl>[0]["workspacePresentation"]>>} [overrides]
 * @returns {NonNullable<Parameters<typeof createWorkspaceControl>[0]["workspacePresentation"]>}
 */
function createWorkspacePresentation(overrides = {}) {
  return {
    ensureWorkspaceVisible: async () => {
      throw new Error("ensureWorkspaceVisible not implemented by this test");
    },
    presentWorkspaceBootstrap: async () => {},
    archiveWorkspaceSurface: async () => {},
    ...overrides,
  };
}

/**
 * @param {Partial<NonNullable<Parameters<typeof createWorkspaceControl>[0]["workspaceRepo"]>>} [overrides]
 * @returns {NonNullable<Parameters<typeof createWorkspaceControl>[0]["workspaceRepo"]>}
 */
function createWorkspaceRepo(overrides = {}) {
  return {
    createWorkspaceCheckout: async () => {
      throw new Error("createWorkspaceCheckout not implemented by this test");
    },
    replaceWorkspaceCheckout: async () => {
      throw new Error("replaceWorkspaceCheckout not implemented by this test");
    },
    diffWorkspace: async () => "",
    ...overrides,
  };
}

describe("workspace control", () => {
  it("replaces duplicate workspaces when create is called unbound", async () => {
    /** @type {WorkspaceRow} */
    const existing = {
      workspace_id: "ws-existing",
      project_id: "repo-1",
      name: "payments",
      branch: "payments",
      base_branch: "main",
      worktree_path: "/repo/.madabot/worktrees/payments",
      status: "ready",
      last_test_status: "not_run",
      last_commit_oid: null,
      conflicted_files: [],
      archived_at: null,
      timestamp: new Date().toISOString(),
    };
    /** @type {WorkspaceRow} */
    const replaced = {
      ...existing,
      branch: "payments-refresh",
      base_branch: "develop",
      worktree_path: "/repo/.madabot/worktrees/payments-refresh",
    };
    /** @type {string[]} */
    const calls = [];

    const control = createWorkspaceControl({
      store: createStore({
        getWorkspaceByName: async () => existing,
        resetWorkspace: async () => {
          calls.push("resetWorkspace");
          return replaced;
        },
        copyChatCustomizations: async () => {
          calls.push("copyChatCustomizations");
        },
        setChatEnabled: async () => {
          calls.push("setChatEnabled");
        },
      }),
      workspacePresentation: createWorkspacePresentation({
        ensureWorkspaceVisible: async () => {
          calls.push("ensureWorkspaceVisible");
          return {
            surfaceId: "workspace-chat",
            surfaceName: "[payments] Project Chat",
          };
        },
        presentWorkspaceBootstrap: async () => {
          calls.push("presentWorkspaceBootstrap");
        },
      }),
      workspaceRepo: createWorkspaceRepo({
        replaceWorkspaceCheckout: async () => {
          calls.push("replaceWorkspaceCheckout");
          return {
            branch: "payments-refresh",
            worktreePath: "/repo/.madabot/worktrees/payments-refresh",
          };
        },
      }),
    });

    const { create } = control;
    const result = await create(
      /** @type {ProjectRow} */ ({
        project_id: "repo-1",
        name: "repo",
        root_path: "/repo",
        default_base_branch: "main",
        control_chat_id: null,
        timestamp: new Date().toISOString(),
      }),
      /** @type {ExecuteActionContext} */ ({
        chatId: "control-chat",
        chatName: "Project Chat",
        senderIds: ["user"],
        senderJids: ["user@s.whatsapp.net"],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        reactToMessage: async () => {},
        select: async () => "replace",
        selectMany: async () => ({ kind: "cancelled" }),
        confirm: async () => true,
      }),
      "payments",
      "develop",
    );

    assert.equal(result.workspace?.workspace_id, "ws-existing");
    assert.ok(result.message.includes("Replaced workspace `payments`."));
    assert.deepEqual(calls, [
      "replaceWorkspaceCheckout",
      "ensureWorkspaceVisible",
      "resetWorkspace",
      "copyChatCustomizations",
      "setChatEnabled",
      "presentWorkspaceBootstrap",
    ]);
  });

  it("archives by name when archiveByName is called unbound", async () => {
    /** @type {WorkspaceRow} */
    const workspace = {
      workspace_id: "ws-archive",
      project_id: "repo-1",
      name: "payments",
      branch: "payments",
      base_branch: "main",
      worktree_path: "/repo/.madabot/worktrees/payments",
      status: "ready",
      last_test_status: "not_run",
      last_commit_oid: null,
      conflicted_files: [],
      archived_at: null,
      timestamp: new Date().toISOString(),
    };
    /** @type {string[]} */
    const calls = [];

    const control = createWorkspaceControl({
      store: createStore({
        getWorkspaceByName: async () => workspace,
        archiveWorkspace: async () => {
          calls.push("archiveWorkspace");
          return workspace;
        },
      }),
      workspacePresentation: createWorkspacePresentation({
        archiveWorkspaceSurface: async () => {
          calls.push("archiveWorkspaceSurface");
        },
      }),
    });

    const { archiveByName } = control;
    const result = await archiveByName(
      /** @type {ProjectRow} */ ({
        project_id: "repo-1",
        name: "repo",
        root_path: "/repo",
        default_base_branch: "main",
        control_chat_id: null,
        timestamp: new Date().toISOString(),
      }),
      "payments",
    );

    assert.equal(result, "Archived workspace `payments`.");
    assert.deepEqual(calls, ["archiveWorkspaceSurface", "archiveWorkspace"]);
  });
});

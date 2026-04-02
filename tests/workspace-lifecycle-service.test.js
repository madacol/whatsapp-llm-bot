import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentEvent } from "../outbound-events.js";
import { createWorkspaceLifecycleService } from "../workspace-lifecycle-service.js";

describe("workspace lifecycle service", () => {
  it("owns create plus seed orchestration as one workspace use case", async () => {
    /** @type {Array<{ repo: RepoRow, context: ExecuteActionContext, workspaceName: string, baseBranch: string }>} */
    const createCalls = [];
    /** @type {Array<{ surfaceId: string, promptText: string }>} */
    const presentedPrompts = [];
    /** @type {ChatTurn[]} */
    const dispatchedTurns = [];
    /** @type {Array<{ surfaceId: string, event: OutboundEvent }>} */
    const workspaceEvents = [];
    /** @type {WorkspaceRow} */
    const workspace = {
      workspace_id: "ws-1",
      repo_id: "repo-1",
      name: "payments",
      branch: "payments",
      base_branch: "main",
      worktree_path: "/repo/.madabot/worktrees/payments",
      workspace_chat_id: "workspace-chat",
      workspace_chat_subject: "[payments] Original Group",
      status: "ready",
      last_test_status: "not_run",
      last_commit_oid: null,
      conflicted_files: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const service = createWorkspaceLifecycleService({
      workspaceControl: {
        list: async () => "",
        create: async (repo, context, workspaceName, baseBranch) => {
          createCalls.push({ repo, context, workspaceName, baseBranch });
          return { message: "Created", workspace };
        },
        status: async () => "",
        diff: async () => "",
        test: async () => "",
        commit: async () => "",
        archiveByName: async () => "",
        archiveCurrent: async () => "",
        merge: async () => "",
        showConflict: async () => "",
        resolveConflicts: async () => "",
        abortMerge: async () => "",
      },
      workspacePresentation: {
        provisionWorkspaceSurface: async () => {
          throw new Error("should not be called by the lifecycle service directly");
        },
        reopenWorkspaceSurface: async () => {
          throw new Error("should not be called by the lifecycle service directly");
        },
        presentWorkspaceBootstrap: async () => {
          throw new Error("should not be called by the lifecycle service directly");
        },
        presentSeedPrompt: async (input) => {
          presentedPrompts.push(input);
        },
        sendWorkspaceEvent: async (input) => {
          workspaceEvents.push(input);
          return undefined;
        },
        archiveWorkspaceSurface: async () => {
          throw new Error("should not be called by the lifecycle service directly");
        },
      },
      dispatchTurn: async (turn) => {
        dispatchedTurns.push(turn);
      },
    });

    const repo = /** @type {RepoRow} */ ({
      repo_id: "repo-1",
      name: "repo",
      root_path: "/repo",
      default_base_branch: "main",
      control_chat_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const context = /** @type {ExecuteActionContext} */ ({
      chatId: "repo-chat",
      chatName: "Original Group",
      senderIds: ["user"],
      senderJids: ["user@s.whatsapp.net"],
      content: [],
      getIsAdmin: async () => true,
      send: async () => undefined,
      reply: async () => undefined,
      reactToMessage: async () => {},
      select: async () => "",
      selectMany: async () => ({ kind: "cancelled" }),
      confirm: async () => true,
    });

    const result = await service.createWorkspace({
      repo,
      context,
      workspaceName: "payments",
      baseBranch: "main",
      seedPrompt: "Investigate duplicate charges",
      sourceTurn: {
        senderIds: ["user"],
        senderJids: ["user@s.whatsapp.net"],
        senderName: "User",
      },
    });

    assert.equal(result.workspace, workspace);
    assert.equal(createCalls.length, 1);
    assert.deepEqual(presentedPrompts, [{
      surfaceId: "workspace-chat",
      promptText: "Prompt: Investigate duplicate charges",
    }]);
    assert.equal(dispatchedTurns.length, 1);
    assert.equal(dispatchedTurns[0]?.chatId, "workspace-chat");
    assert.deepEqual(dispatchedTurns[0]?.content, [{ type: "text", text: "Investigate duplicate charges" }]);
    await dispatchedTurns[0]?.io.reply(contentEvent("llm", [{ type: "text", text: "Thinking..." }]));
    assert.deepEqual(workspaceEvents, [{
      surfaceId: "workspace-chat",
      event: contentEvent("llm", [{ type: "text", text: "Thinking..." }]),
    }]);
  });
});

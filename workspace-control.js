import {
  abortWorkspaceMerge,
  cleanupWorkspaceWorktree,
  commitWorkspaceChanges,
  createWorkspaceWorktree,
  formatDiffSummary,
  hasUncommittedChanges,
  isValidWorkspaceName,
  listConflictedFiles,
  mergeWorkspaceBranch,
  resolveWorkspaceConflictsAutomatically,
  runWorkspaceVerification,
} from "./workspace-git.js";
import { formatWorkspaceStatus, listRepoWorkspaces } from "./workspace-service.js";

/**
 * @typedef {import("./store.js").Store} Store
 */

/**
 * @param {Store} store
 * @param {string} chatId
 * @returns {Promise<RepoRow>}
 */
async function getRepoForControlChatOrThrow(store, chatId) {
  const repo = await store.getRepoByControlChat(chatId);
  if (!repo) {
    throw new Error(`Chat ${chatId} is not bound to a repo.`);
  }
  return repo;
}

/**
 * @param {Store} store
 * @param {string} chatId
 * @returns {Promise<WorkspaceRow>}
 */
async function getWorkspaceForChatOrThrow(store, chatId) {
  const workspace = await store.getWorkspaceByChat(chatId);
  if (!workspace) {
    throw new Error(`Chat ${chatId} is not bound to a workspace.`);
  }
  return workspace;
}

/**
 * @param {ExecuteActionContext} context
 * @returns {string[]}
 */
function getInitialWorkspaceParticipants(context) {
  const jids = context.senderJids ?? [];
  const preferred = jids.find((jid) => typeof jid === "string" && jid.includes("@"));
  if (preferred) {
    return [preferred];
  }
  const senderId = context.senderIds[0];
  if (!senderId) {
    return [];
  }
  return [`${senderId}@s.whatsapp.net`];
}

/**
 * @param {WorkspaceRow["last_test_status"]} lastTestStatus
 * @returns {string}
 */
function formatLastTestStatus(lastTestStatus) {
  return lastTestStatus === "not_run" ? "not run" : lastTestStatus;
}

/**
 * @param {{ store: Store, transport?: ChatTransport }} input
 */
export function createWorkspaceControl({ store, transport }) {
  return {
    /**
     * @param {string} chatId
     * @returns {Promise<string>}
     */
    async list(chatId) {
      return listRepoWorkspaces(store, chatId);
    },

    /**
     * @param {ExecuteActionContext} context
     * @param {string} workspaceName
     * @param {string | undefined} explicitBaseBranch
     * @returns {Promise<string>}
     */
    async create(context, workspaceName, explicitBaseBranch) {
      if (!transport?.createGroup) {
        throw new Error("Workspace creation requires transport group creation support.");
      }
      if (!isValidWorkspaceName(workspaceName)) {
        throw new Error("Workspace name is invalid. Use letters, numbers, `-`, and `_`.");
      }

      const repo = await getRepoForControlChatOrThrow(store, context.chatId);
      const existing = await store.getWorkspaceByName(repo.repo_id, workspaceName);
      if (existing) {
        throw new Error(`Workspace \`${workspaceName}\` already exists.`);
      }

      const baseBranch = explicitBaseBranch ?? repo.default_base_branch;
      const participants = getInitialWorkspaceParticipants(context);
      if (participants.length === 0) {
        throw new Error("Could not determine which WhatsApp user to add to the workspace group.");
      }

      const { branch, worktreePath } = await createWorkspaceWorktree(repo, workspaceName, baseBranch);
      try {
        const group = await transport.createGroup(`ws/${workspaceName}`, participants);
        const workspace = await store.createWorkspace({
          repoId: repo.repo_id,
          name: workspaceName,
          branch,
          baseBranch,
          worktreePath,
          workspaceChatId: group.chatId,
          status: "ready",
        });
        await transport.sendText(group.chatId, await formatWorkspaceStatus(store, workspace.workspace_chat_id));
        return [
          `Created workspace \`${workspace.name}\`.`,
          `Branch: \`${workspace.branch}\``,
          `Base: \`${workspace.base_branch}\``,
          `Chat: \`${group.subject}\``,
        ].join("\n");
      } catch (error) {
        await cleanupWorkspaceWorktree(repo, branch, worktreePath);
        throw error;
      }
    },

    /**
     * @param {string} chatId
     * @returns {Promise<string>}
     */
    async status(chatId) {
      return formatWorkspaceStatus(store, chatId);
    },

    /**
     * @param {string} chatId
     * @returns {Promise<string>}
     */
    async diff(chatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, chatId);
      return formatDiffSummary(workspace.worktree_path);
    },

    /**
     * @param {string} chatId
     * @returns {Promise<string>}
     */
    async test(chatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, chatId);
      await store.setWorkspaceStatus(workspace.workspace_id, "busy");
      try {
        const result = await runWorkspaceVerification(workspace.worktree_path);
        await store.updateWorkspaceLastTestStatus(workspace.workspace_id, result.passed ? "passed" : "failed");
        await store.setWorkspaceStatus(workspace.workspace_id, "ready");
        return result.summary;
      } catch (error) {
        await store.setWorkspaceStatus(workspace.workspace_id, "ready");
        throw error;
      }
    },

    /**
     * @param {string} chatId
     * @param {string} message
     * @returns {Promise<string>}
     */
    async commit(chatId, message) {
      const workspace = await getWorkspaceForChatOrThrow(store, chatId);
      if (!message.trim()) {
        return "Use `!commit <message>`.";
      }
      if (!await hasUncommittedChanges(workspace.worktree_path)) {
        return "Nothing to commit.";
      }
      const oid = await commitWorkspaceChanges(workspace.worktree_path, message.trim());
      await store.updateWorkspaceLastCommitOid(workspace.workspace_id, oid);
      await store.updateWorkspaceLastTestStatus(workspace.workspace_id, "not_run");
      return `Committed on \`${workspace.branch}\`.\nCommit: \`${oid} ${message.trim()}\``;
    },

    /**
     * @param {string} repoChatId
     * @param {string} workspaceName
     * @returns {Promise<string>}
     */
    async archiveByName(repoChatId, workspaceName) {
      const repo = await getRepoForControlChatOrThrow(store, repoChatId);
      const workspace = await store.getWorkspaceByName(repo.repo_id, workspaceName);
      if (!workspace) {
        throw new Error(`Workspace \`${workspaceName}\` does not exist.`);
      }
      return this.archiveCurrent(workspace.workspace_chat_id);
    },

    /**
     * @param {string} workspaceChatId
     * @returns {Promise<string>}
     */
    async archiveCurrent(workspaceChatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, workspaceChatId);
      if (workspace.status === "archived") {
        return `Workspace \`${workspace.name}\` is already archived.`;
      }
      if (transport?.renameGroup) {
        await transport.renameGroup(workspace.workspace_chat_id, `ws/${workspace.name} (archived)`);
      }
      if (transport?.setAnnouncementOnly) {
        await transport.setAnnouncementOnly(workspace.workspace_chat_id, true);
      }
      await store.archiveWorkspace(workspace.workspace_id);
      return `Archived workspace \`${workspace.name}\`.`;
    },

    /**
     * @param {string} workspaceChatId
     * @returns {Promise<string>}
     */
    async merge(workspaceChatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, workspaceChatId);
      const repo = await store.getRepo(workspace.repo_id);
      if (!repo) {
        throw new Error(`Repo ${workspace.repo_id} does not exist.`);
      }
      await store.setWorkspaceStatus(workspace.workspace_id, "busy");
      try {
        const result = await mergeWorkspaceBranch(repo.root_path, workspace);
        if (result.kind === "conflicted") {
          await store.setWorkspaceStatus(workspace.workspace_id, "conflicted", { conflictedFiles: result.files });
          return [
            `Merge blocked by conflicts with \`${workspace.base_branch}\`.`,
            "Conflicted files:",
            ...result.files.map((file) => `- \`${file}\``),
            "",
            "Use `!show conflict`, `!resolve conflicts`, or `!abort merge`.",
          ].join("\n");
        }
        await store.updateWorkspaceLastCommitOid(workspace.workspace_id, result.lastCommitOid);
        if (result.kind === "blocked") {
          await store.updateWorkspaceLastTestStatus(workspace.workspace_id, "failed");
          await store.setWorkspaceStatus(workspace.workspace_id, "ready");
          return result.summary;
        }
        await store.updateWorkspaceLastTestStatus(workspace.workspace_id, "passed");
        await store.setWorkspaceStatus(workspace.workspace_id, "ready");
        return `Merged \`${workspace.branch}\` into \`${workspace.base_branch}\`.\n${result.summary}`;
      } catch (error) {
        await store.setWorkspaceStatus(workspace.workspace_id, "ready");
        throw error;
      }
    },

    /**
     * @param {string} workspaceChatId
     * @returns {Promise<string>}
     */
    async showConflict(workspaceChatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, workspaceChatId);
      const conflictedFiles = workspace.conflicted_files.length > 0
        ? workspace.conflicted_files
        : await listConflictedFiles(workspace.worktree_path);
      if (conflictedFiles.length === 0) {
        return "This workspace is not in a conflicted state.";
      }
      return [
        "Conflicts:",
        ...conflictedFiles.map((file) => `- \`${file}\``),
        "",
        `Current branch: \`${workspace.branch}\``,
        `Base branch: \`${workspace.base_branch}\``,
      ].join("\n");
    },

    /**
     * @param {string} workspaceChatId
     * @returns {Promise<string>}
     */
    async resolveConflicts(workspaceChatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, workspaceChatId);
      await store.setWorkspaceStatus(workspace.workspace_id, "busy", { conflictedFiles: workspace.conflicted_files });
      try {
        const result = await resolveWorkspaceConflictsAutomatically(workspace);
        const remaining = await listConflictedFiles(workspace.worktree_path);
        if (result.lastCommitOid) {
          await store.updateWorkspaceLastCommitOid(workspace.workspace_id, result.lastCommitOid);
        }
        await store.updateWorkspaceLastTestStatus(
          workspace.workspace_id,
          result.summary.includes("failed") ? "failed" : "passed",
        );
        await store.setWorkspaceStatus(
          workspace.workspace_id,
          remaining.length === 0 ? "ready" : "conflicted",
          { conflictedFiles: remaining },
        );
        return result.summary;
      } catch (error) {
        const remaining = await listConflictedFiles(workspace.worktree_path);
        await store.setWorkspaceStatus(
          workspace.workspace_id,
          remaining.length === 0 ? "ready" : "conflicted",
          { conflictedFiles: remaining },
        );
        throw error;
      }
    },

    /**
     * @param {string} workspaceChatId
     * @returns {Promise<string>}
     */
    async abortMerge(workspaceChatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, workspaceChatId);
      await abortWorkspaceMerge(workspace);
      await store.setWorkspaceStatus(workspace.workspace_id, "ready");
      return `Aborted merge attempt in \`${workspace.branch}\`.`;
    },

    /**
     * @param {string} workspaceChatId
     * @returns {Promise<{ archived: boolean, conflicted: boolean, busy: boolean }>}
     */
    async getState(workspaceChatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, workspaceChatId);
      return {
        archived: workspace.status === "archived",
        conflicted: workspace.status === "conflicted",
        busy: workspace.status === "busy",
      };
    },

    /**
     * @param {string} workspaceChatId
     * @returns {Promise<string>}
     */
    async statusSummary(workspaceChatId) {
      const workspace = await getWorkspaceForChatOrThrow(store, workspaceChatId);
      return [
        `Workspace: ${workspace.name}`,
        `Base: ${workspace.base_branch}`,
        `Branch: ${workspace.branch}`,
        `Status: ${workspace.status}`,
        `Last test: ${formatLastTestStatus(workspace.last_test_status)}`,
        `Last commit: ${workspace.last_commit_oid ?? "none"}`,
      ].join("\n");
    },
  };
}

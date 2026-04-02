import {
  cleanupWorkspaceWorktree,
  isValidWorkspaceName,
} from "./workspace-git.js";
import { randomUUID } from "node:crypto";
import { formatWorkspaceStatus, listRepoWorkspaces } from "./workspace-service.js";
import { errorToString } from "./utils.js";
import { createWorkspaceRepoService } from "./workspace-repo-service.js";

/**
 * @typedef {import("./store.js").Store} Store
 *
 * @typedef {{
 *   message: string,
 *   workspace: WorkspaceRow | null,
 * }} WorkspaceCreationResult
 */

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
 * @param {string} workspaceName
 * @returns {SelectOption[]}
 */
function buildDuplicateWorkspaceOptions(workspaceName) {
  return [
    { id: "replace", label: `Replace ${workspaceName}` },
    { id: "new", label: "Pick another name" },
    { id: "cancel", label: "Cancel" },
  ];
}

/**
 * @param {{ store: Store, workspacePresentation?: WorkspacePresentationPort, workspaceRepo?: ReturnType<typeof createWorkspaceRepoService> }} input
 */
export function createWorkspaceControl({ store, workspacePresentation, workspaceRepo = createWorkspaceRepoService() }) {
  return {
    /**
     * @param {RepoRow} repo
     * @returns {Promise<string>}
     */
    async list(repo) {
      return listRepoWorkspaces(store, repo);
    },

    /**
     * @param {RepoRow} repo
     * @param {ExecuteActionContext} context
     * @param {string} workspaceName
     * @param {string} baseBranch
     * @returns {Promise<WorkspaceCreationResult>}
     */
    async create(repo, context, workspaceName, baseBranch) {
      if (!workspacePresentation) {
        throw new Error("Workspace creation requires workspace presentation support.");
      }
      if (!isValidWorkspaceName(workspaceName)) {
        throw new Error("Workspace name is invalid. Use letters, numbers, spaces, `-`, and `_`.");
      }

      const existing = await store.getWorkspaceByName(repo.repo_id, workspaceName);
      if (existing) {
        const choice = await context.select(
          `Workspace \`${workspaceName}\` already exists. Choose what to do:`,
          buildDuplicateWorkspaceOptions(workspaceName),
          { deleteOnSelect: true, cancelIds: ["cancel"] },
        );
        if (choice === "replace") {
          return this.replace(repo, context, existing, baseBranch);
        }
        if (choice === "new") {
          return {
            message: "Use `!new <different-name>` to create another workspace without replacing the current one.",
            workspace: null,
          };
        }
        return { message: "Workspace creation cancelled.", workspace: null };
      }

      const participants = getInitialWorkspaceParticipants(context);
      if (participants.length === 0) {
        throw new Error("Could not determine which WhatsApp user to add to the workspace group.");
      }

      const { branch, worktreePath } = await workspaceRepo.createWorkspaceCheckout(repo, workspaceName, baseBranch);
      const workspaceId = randomUUID();
      try {
        const surface = await workspacePresentation.ensureWorkspaceVisible({
          repoId: repo.repo_id,
          workspaceId,
          workspaceName,
          sourceChatName: context.chatName,
          requesterJids: participants,
        });
        const workspace = await store.createWorkspace({
          workspaceId,
          repoId: repo.repo_id,
          name: workspaceName,
          branch,
          baseBranch,
          worktreePath,
          status: "ready",
        });
        await store.copyChatCustomizations(context.chatId, surface.surfaceId);
        await store.setChatEnabled(surface.surfaceId, true);
        await workspacePresentation.presentWorkspaceBootstrap({
          workspaceId: workspace.workspace_id,
          statusText: await formatWorkspaceStatus(workspace),
        });
        return {
          message: [
            `Created workspace \`${workspace.name}\`.`,
            `Branch: \`${workspace.branch}\``,
            `Base: \`${workspace.base_branch}\``,
            `Chat: \`${surface.surfaceName}\``,
          ].join("\n"),
          workspace,
        };
      } catch (error) {
        await cleanupWorkspaceWorktree(repo, branch, worktreePath);
        throw new Error(`WhatsApp group creation failed: ${errorToString(error)}`);
      }
    },

    /**
     * @param {RepoRow} repo
     * @param {ExecuteActionContext} context
     * @param {WorkspaceRow} existing
     * @param {string} baseBranch
     * @returns {Promise<WorkspaceCreationResult>}
     */
    async replace(repo, context, existing, baseBranch) {
      if (!workspacePresentation) {
        throw new Error("Workspace replacement requires workspace presentation support.");
      }
      const participants = getInitialWorkspaceParticipants(context);

      const { branch, worktreePath } = await workspaceRepo.replaceWorkspaceCheckout(repo, existing, baseBranch);
      const surface = await workspacePresentation.ensureWorkspaceVisible({
        repoId: repo.repo_id,
        workspaceId: existing.workspace_id,
        workspaceName: existing.name,
        sourceChatName: context.chatName,
        requesterJids: participants,
      });
      const workspace = await store.resetWorkspace({
        workspaceId: existing.workspace_id,
        branch,
        baseBranch,
        worktreePath,
      });
      await store.copyChatCustomizations(context.chatId, surface.surfaceId);
      await store.setChatEnabled(surface.surfaceId, true);
      await workspacePresentation.presentWorkspaceBootstrap({
        workspaceId: workspace.workspace_id,
        statusText: await formatWorkspaceStatus(workspace),
      });
      return {
        message: [
          `Replaced workspace \`${workspace.name}\`.`,
          `Branch: \`${workspace.branch}\``,
          `Base: \`${workspace.base_branch}\``,
          `Chat: \`${surface.surfaceName}\``,
        ].join("\n"),
        workspace,
      };
    },

    /**
     * @param {WorkspaceRow} workspace
     * @returns {Promise<string>}
     */
    async status(workspace) {
      return formatWorkspaceStatus(workspace);
    },

    /**
     * @param {WorkspaceRow} workspace
     * @returns {Promise<string>}
     */
    async diff(workspace) {
      return workspaceRepo.diffWorkspace(workspace);
    },

    /**
     * @param {RepoRow} repo
     * @param {string} workspaceName
     * @returns {Promise<string>}
     */
    async archiveByName(repo, workspaceName) {
      const workspace = await store.getWorkspaceByName(repo.repo_id, workspaceName);
      if (!workspace) {
        throw new Error(`Workspace \`${workspaceName}\` does not exist.`);
      }
      return this.archiveCurrent(workspace);
    },

    /**
     * @param {WorkspaceRow} workspace
     * @returns {Promise<string>}
     */
    async archiveCurrent(workspace) {
      if (workspace.status === "archived") {
        return `Workspace \`${workspace.name}\` is already archived.`;
      }
      if (workspacePresentation) {
        await workspacePresentation.archiveWorkspaceSurface({
          workspaceId: workspace.workspace_id,
        });
      }
      await store.archiveWorkspace(workspace.workspace_id);
      return `Archived workspace \`${workspace.name}\`.`;
    },
  };
}

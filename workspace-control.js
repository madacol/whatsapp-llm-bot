import {
  cleanupWorkspaceWorktree,
  isValidWorkspaceName,
} from "./workspace-git.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { formatWorkspaceStatus, listProjectWorkspaces } from "./workspace-service.js";
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
 * @param {{ canReplace: boolean }} input
 * @returns {SelectOption[]}
 */
function buildDuplicateWorkspaceOptions(workspaceName, { canReplace }) {
  return [
    ...(canReplace ? [{ id: "replace", label: `Replace ${workspaceName}` }] : []),
    { id: "new", label: "Pick another name" },
    { id: "cancel", label: "Cancel" },
  ];
}

/**
 * The primary chat workspace points at the project root instead of a disposable
 * git worktree, so it must never flow through "replace workspace" teardown.
 * @param {ProjectRow} repo
 * @param {WorkspaceRow} workspace
 * @returns {boolean}
 */
function canReplaceWorkspace(repo, workspace) {
  return path.resolve(workspace.worktree_path) !== path.resolve(repo.root_path);
}

/**
 * @param {{ store: Store, workspacePresentation?: WorkspacePresentationPort, workspaceRepo?: ReturnType<typeof createWorkspaceRepoService> }} input
 */
export function createWorkspaceControl({ store, workspacePresentation, workspaceRepo = createWorkspaceRepoService() }) {
  return {
    /**
     * @param {ProjectRow} repo
     * @returns {Promise<string>}
     */
    async list(repo) {
      return listProjectWorkspaces(store, repo);
    },

    /**
     * @param {ProjectRow} repo
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

      const existing = await store.getWorkspaceByName(repo.project_id, workspaceName);
      if (existing) {
        const canReplace = canReplaceWorkspace(repo, existing);
        const choice = await context.select(
          `Workspace \`${workspaceName}\` already exists. Choose what to do:`,
          buildDuplicateWorkspaceOptions(workspaceName, { canReplace }),
          { deleteOnSelect: true, cancelIds: ["cancel"] },
        );
        if (choice === "replace" && canReplace) {
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
        throw new Error("Could not determine which WhatsApp user to add to the workspace chat.");
      }

      const { branch, worktreePath } = await workspaceRepo.createWorkspaceCheckout(repo, workspaceName, baseBranch);
      const workspaceId = randomUUID();
      try {
        const surface = await workspacePresentation.ensureWorkspaceVisible({
          projectId: repo.project_id,
          workspaceId,
          workspaceName,
          sourceChatName: context.chatName,
          requesterJids: participants,
        });
        const workspace = await store.createWorkspace({
          workspaceId,
          projectId: repo.project_id,
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
        throw new Error(`WhatsApp chat creation failed: ${errorToString(error)}`);
      }
    },

    /**
     * @param {ProjectRow} repo
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
        projectId: repo.project_id,
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
     * @param {ProjectRow} repo
     * @param {string} workspaceName
     * @returns {Promise<string>}
     */
    async archiveByName(repo, workspaceName) {
      const workspace = await store.getWorkspaceByName(repo.project_id, workspaceName);
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

import { randomUUID } from "node:crypto";
import {
  normalizeChatBindingRow,
  normalizeProjectRow,
  normalizeWorkspaceRow,
} from "../normalizers.js";

/** @typedef {import("../../store.js").Store} Store */

/**
 * @typedef {{
 *   db: PGlite;
 *   ensureChatExists: (chatId: string) => Promise<void>;
 *   ensureWhatsAppProjectPresentationCacheExists: (projectId: string) => Promise<void>;
 *   getRequiredWhatsAppWorkspacePresentation: (workspaceId: string) => Promise<WhatsAppWorkspacePresentationRow>;
 * }} ProjectStoreDeps
 */

/**
 * Build project, workspace, and chat-binding store methods.
 * @param {ProjectStoreDeps} deps
 * @returns {Pick<Store,
 *   "createProject"
 *   | "getProject"
 *   | "getProjectByChat"
 *   | "getProjectByRootPath"
 *   | "createWorkspace"
 *   | "getWorkspace"
 *   | "getWorkspaceByName"
 *   | "getWorkspaceByWorktreePath"
 *   | "listActiveWorkspaces"
 *   | "resetWorkspace"
 *   | "bindChatToProject"
 *   | "bindChatToWorkspace"
 *   | "getChatBinding"
 *   | "archiveWorkspace"
 *   | "setWorkspaceStatus"
 *   | "updateWorkspaceLastTestStatus"
 *   | "updateWorkspaceLastCommitOid"
 * >}
 */
export function createProjectStore({
  db,
  ensureChatExists,
  ensureWhatsAppProjectPresentationCacheExists,
  getRequiredWhatsAppWorkspacePresentation,
}) {
  /**
   * @param {{
   *   chatId: string,
   *   bindingKind: ChatBindingKind,
   *   projectId?: string | null,
   *   workspaceId?: string | null,
   * }} input
   * @returns {Promise<ChatBindingRow>}
   */
  async function upsertChatBinding({ chatId, bindingKind, projectId = null, workspaceId = null }) {
    await ensureChatExists(chatId);

    const { rows: [row] } = await db.sql`
      INSERT INTO chat_bindings (chat_id, binding_kind, project_id, workspace_id)
      VALUES (${chatId}, ${bindingKind}, ${projectId}, ${workspaceId})
      ON CONFLICT (chat_id) DO UPDATE SET
        binding_kind = EXCLUDED.binding_kind,
        project_id = EXCLUDED.project_id,
        workspace_id = EXCLUDED.workspace_id
      RETURNING *
    `;
    const binding = normalizeChatBindingRow(row);
    if (!binding) {
      throw new Error("Failed to normalize chat binding row");
    }
    return binding;
  }

  /**
   * @param {string} workspaceId
   * @returns {Promise<WorkspaceRow | null>}
   */
  async function getWorkspace(workspaceId) {
    const { rows: [row] } = await db.sql`
      SELECT * FROM workspaces
      WHERE workspace_id = ${workspaceId}
      LIMIT 1
    `;
    return normalizeWorkspaceRow(row);
  }

  return {
    /**
     * @param {{
     *   name: string,
     *   rootPath: string,
     *   defaultBaseBranch: string,
     *   controlChatId?: string | null,
     * }} input
     * @returns {Promise<ProjectRow>}
     */
    async createProject({ name, rootPath, defaultBaseBranch, controlChatId = null }) {
      if (controlChatId) {
        await ensureChatExists(controlChatId);
      }

      const projectId = randomUUID();
      const { rows: [row] } = await db.sql`
        INSERT INTO projects (project_id, name, root_path, default_base_branch, control_chat_id)
        VALUES (${projectId}, ${name}, ${rootPath}, ${defaultBaseBranch}, ${controlChatId})
        RETURNING *
      `;
      const project = normalizeProjectRow(row);
      if (!project) {
        throw new Error("Failed to normalize project row");
      }

      if (controlChatId) {
        await upsertChatBinding({
          chatId: controlChatId,
          bindingKind: "project",
          projectId: project.project_id,
        });
      }

      return project;
    },

    /**
     * @param {string} projectId
     * @returns {Promise<ProjectRow | null>}
     */
    async getProject(projectId) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM projects
        WHERE project_id = ${projectId}
        LIMIT 1
      `;
      return normalizeProjectRow(row);
    },

    /**
     * @param {string} chatId
     * @returns {Promise<ProjectRow | null>}
     */
    async getProjectByChat(chatId) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM projects
        WHERE control_chat_id = ${chatId}
        LIMIT 1
      `;
      return normalizeProjectRow(row);
    },

    /**
     * @param {string} rootPath
     * @returns {Promise<ProjectRow | null>}
     */
    async getProjectByRootPath(rootPath) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM projects
        WHERE root_path = ${rootPath}
        LIMIT 1
      `;
      return normalizeProjectRow(row);
    },

    /**
     * @param {{
     *   workspaceId?: string,
     *   projectId: string,
     *   name: string,
     *   branch: string,
     *   baseBranch: string,
     *   worktreePath: string,
     *   status?: WorkspaceStatus,
     * }} input
     * @returns {Promise<WorkspaceRow>}
     */
    async createWorkspace({
      workspaceId: providedWorkspaceId,
      projectId,
      name,
      branch,
      baseBranch,
      worktreePath,
      status = "ready",
    }) {
      const workspaceId = providedWorkspaceId ?? randomUUID();
      const presentation = await getRequiredWhatsAppWorkspacePresentation(workspaceId);

      const { rows: [row] } = await db.sql`
        INSERT INTO workspaces (
          workspace_id,
          project_id,
          name,
          branch,
          base_branch,
          worktree_path,
          status,
          workspace_chat_id,
          workspace_chat_subject
        )
        VALUES (
          ${workspaceId},
          ${projectId},
          ${name},
          ${branch},
          ${baseBranch},
          ${worktreePath},
          ${status},
          ${presentation.workspace_chat_id},
          ${presentation.workspace_chat_subject}
        )
        RETURNING *
      `;
      const workspace = normalizeWorkspaceRow(row);
      if (!workspace) {
        throw new Error("Failed to normalize workspace row");
      }

      await upsertChatBinding({
        chatId: presentation.workspace_chat_id,
        bindingKind: "workspace",
        projectId,
        workspaceId,
      });
      await ensureWhatsAppProjectPresentationCacheExists(projectId);
      return workspace;
    },

    /**
     * @param {string} workspaceId
     * @returns {Promise<WorkspaceRow | null>}
     */
    getWorkspace,

    /**
     * @param {string} projectId
     * @param {string} name
     * @returns {Promise<WorkspaceRow | null>}
     */
    async getWorkspaceByName(projectId, name) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM workspaces
        WHERE project_id = ${projectId}
          AND name = ${name}
        LIMIT 1
      `;
      return normalizeWorkspaceRow(row);
    },

    /**
     * @param {string} worktreePath
     * @returns {Promise<WorkspaceRow | null>}
     */
    async getWorkspaceByWorktreePath(worktreePath) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM workspaces
        WHERE worktree_path = ${worktreePath}
        LIMIT 1
      `;
      return normalizeWorkspaceRow(row);
    },

    /**
     * @param {string} projectId
     * @returns {Promise<WorkspaceRow[]>}
     */
    async listActiveWorkspaces(projectId) {
      const { rows } = await db.sql`
        SELECT * FROM workspaces
        WHERE project_id = ${projectId}
          AND archived_at IS NULL
          AND status <> 'archived'
        ORDER BY name
      `;
      return rows
        .map(normalizeWorkspaceRow)
        .filter(/** @returns {row is WorkspaceRow} */ (row) => row !== null);
    },

    /**
     * Reset a workspace row to point at a freshly recreated worktree while preserving its chat binding.
     * @param {{
     *   workspaceId: string,
     *   branch: string,
     *   baseBranch: string,
     *   worktreePath: string,
     *   status?: WorkspaceStatus,
     * }} input
     * @returns {Promise<WorkspaceRow>}
     */
    async resetWorkspace({
      workspaceId,
      branch,
      baseBranch,
      worktreePath,
      status = "ready",
    }) {
      const presentation = await getRequiredWhatsAppWorkspacePresentation(workspaceId);
      const { rows: [row] } = await db.sql`
        UPDATE workspaces
        SET
          branch = ${branch},
          base_branch = ${baseBranch},
          worktree_path = ${worktreePath},
          workspace_chat_id = ${presentation.workspace_chat_id},
          workspace_chat_subject = ${presentation.workspace_chat_subject},
          status = ${status},
          last_test_status = 'not_run',
          last_commit_oid = NULL,
          conflicted_files = '[]'::jsonb,
          archived_at = NULL
        WHERE workspace_id = ${workspaceId}
        RETURNING *
      `;
      const workspace = normalizeWorkspaceRow(row);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} does not exist.`);
      }
      return workspace;
    },

    /**
     * @param {string} chatId
     * @param {string} projectId
     * @returns {Promise<ChatBindingRow>}
     */
    async bindChatToProject(chatId, projectId) {
      return upsertChatBinding({
        chatId,
        bindingKind: "project",
        projectId,
      });
    },

    /**
     * @param {string} chatId
     * @param {string} workspaceId
     * @returns {Promise<ChatBindingRow>}
     */
    async bindChatToWorkspace(chatId, workspaceId) {
      const workspace = await getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} does not exist.`);
      }

      return upsertChatBinding({
        chatId,
        bindingKind: "workspace",
        projectId: workspace.project_id,
        workspaceId,
      });
    },

    /**
     * @param {string} chatId
     * @returns {Promise<ChatBindingRow | null>}
     */
    async getChatBinding(chatId) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM chat_bindings
        WHERE chat_id = ${chatId}
        LIMIT 1
      `;
      return normalizeChatBindingRow(row);
    },

    /**
     * @param {string} workspaceId
     * @returns {Promise<WorkspaceRow | null>}
     */
    async archiveWorkspace(workspaceId) {
      const { rows: [row] } = await db.sql`
        UPDATE workspaces
        SET status = 'archived',
            conflicted_files = '[]'::jsonb,
            archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP)
        WHERE workspace_id = ${workspaceId}
        RETURNING *
      `;
      return normalizeWorkspaceRow(row);
    },

    /**
     * @param {string} workspaceId
     * @param {WorkspaceStatus} status
     * @param {{ conflictedFiles?: string[] }} [options]
     * @returns {Promise<WorkspaceRow | null>}
     */
    async setWorkspaceStatus(workspaceId, status, options = {}) {
      const conflictedFiles = options.conflictedFiles ?? [];
      const { rows: [row] } = await db.sql`
        UPDATE workspaces
        SET status = ${status},
            conflicted_files = ${JSON.stringify(conflictedFiles)}::jsonb
        WHERE workspace_id = ${workspaceId}
        RETURNING *
      `;
      return normalizeWorkspaceRow(row);
    },

    /**
     * @param {string} workspaceId
     * @param {WorkspaceRow["last_test_status"]} lastTestStatus
     * @returns {Promise<WorkspaceRow | null>}
     */
    async updateWorkspaceLastTestStatus(workspaceId, lastTestStatus) {
      const { rows: [row] } = await db.sql`
        UPDATE workspaces
        SET last_test_status = ${lastTestStatus}
        WHERE workspace_id = ${workspaceId}
        RETURNING *
      `;
      return normalizeWorkspaceRow(row);
    },

    /**
     * @param {string} workspaceId
     * @param {string | null} lastCommitOid
     * @returns {Promise<WorkspaceRow | null>}
     */
    async updateWorkspaceLastCommitOid(workspaceId, lastCommitOid) {
      const { rows: [row] } = await db.sql`
        UPDATE workspaces
        SET last_commit_oid = ${lastCommitOid}
        WHERE workspace_id = ${workspaceId}
        RETURNING *
      `;
      return normalizeWorkspaceRow(row);
    },
  };
}

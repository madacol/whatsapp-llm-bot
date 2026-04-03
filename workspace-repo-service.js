import {
  cleanupWorkspaceWorktree,
  createWorkspaceWorktree,
  ensureGitRepoInitialized,
  formatDiffSummary,
} from "./workspace-git.js";
import path from "node:path";

/**
 * App-facing seam over git/worktree mechanics for workspace lifecycle flows.
 * This keeps `workspace-control` focused on orchestration instead of shelling
 * out to git directly.
 */
export function createWorkspaceRepoService() {
  return {
    /**
     * @param {RepoRow} repo
     * @param {string} workspaceName
     * @param {string} baseBranch
     * @returns {Promise<{ branch: string, worktreePath: string }>}
     */
    async createWorkspaceCheckout(repo, workspaceName, baseBranch) {
      await ensureGitRepoInitialized(repo.root_path, baseBranch);
      return createWorkspaceWorktree(repo, workspaceName, baseBranch);
    },

    /**
     * @param {RepoRow} repo
     * @param {WorkspaceRow} workspace
     * @param {string} baseBranch
     * @returns {Promise<{ branch: string, worktreePath: string }>}
     */
    async replaceWorkspaceCheckout(repo, workspace, baseBranch) {
      if (path.resolve(workspace.worktree_path) === path.resolve(repo.root_path)) {
        throw new Error("The primary chat workspace cannot be replaced. Create another workspace with a different name.");
      }
      await ensureGitRepoInitialized(repo.root_path, baseBranch);
      await cleanupWorkspaceWorktree(repo, workspace.branch, workspace.worktree_path);
      return createWorkspaceWorktree(repo, workspace.name, baseBranch);
    },

    /**
     * @param {WorkspaceRow} workspace
     * @returns {Promise<string>}
     */
    async diffWorkspace(workspace) {
      await ensureGitRepoInitialized(workspace.worktree_path, workspace.base_branch);
      return formatDiffSummary(workspace.worktree_path);
    },
  };
}

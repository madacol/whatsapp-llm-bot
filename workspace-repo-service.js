import {
  cleanupWorkspaceWorktree,
  createWorkspaceWorktree,
  ensureGitRepoInitialized,
  formatDiffSummary,
} from "./workspace-git.js";

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
      await cleanupWorkspaceWorktree(repo, workspace.branch, workspace.worktree_path);
      return createWorkspaceWorktree(repo, workspace.name, baseBranch);
    },

    /**
     * @param {WorkspaceRow} workspace
     * @returns {Promise<string>}
     */
    diffWorkspace(workspace) {
      return formatDiffSummary(workspace.worktree_path);
    },
  };
}

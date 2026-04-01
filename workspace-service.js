/**
 * Workspace control-plane operations that sit above generic chat settings.
 */

/**
 * @typedef {import("./store.js").Store} Store
 */

/**
 * @param {WorkspaceRow["last_test_status"]} lastTestStatus
 * @returns {string}
 */
function formatLastTestStatus(lastTestStatus) {
  if (lastTestStatus === "not_run") {
    return "not run";
  }
  return lastTestStatus;
}

/**
 * @param {Store} store
 * @param {RepoRow} repo
 * @returns {Promise<string>}
 */
export async function listRepoWorkspaces(store, repo) {
  const workspaces = await store.listActiveWorkspaces(repo.repo_id);
  if (workspaces.length === 0) {
    return "No active workspaces.\nUse `!new <name>` to create one.";
  }
  return `Active workspaces:\n${workspaces.map((workspace) => `- ${workspace.name}  ${workspace.status}`).join("\n")}`;
}

/**
 * @param {WorkspaceRow} workspace
 * @returns {Promise<string>}
 */
export async function formatWorkspaceStatus(workspace) {
  const lastCommit = workspace.last_commit_oid ?? "none";
  return [
    `Workspace: ${workspace.name}`,
    `Base: ${workspace.base_branch}`,
    `Branch: ${workspace.branch}`,
    `Status: ${workspace.status}`,
    `Last test: ${formatLastTestStatus(workspace.last_test_status)}`,
    `Last commit: ${lastCommit}`,
  ].join("\n");
}

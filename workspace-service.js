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
 * @param {Store} store
 * @param {string} chatId
 * @returns {Promise<string>}
 */
export async function listRepoWorkspaces(store, chatId) {
  const repo = await getRepoForControlChatOrThrow(store, chatId);
  const workspaces = await store.listActiveWorkspaces(repo.repo_id);
  if (workspaces.length === 0) {
    return "No active workspaces.\nUse `!new <name>` to create one.";
  }
  return `Active workspaces:\n${workspaces.map((workspace) => `- ${workspace.name}  ${workspace.status}`).join("\n")}`;
}

/**
 * @param {Store} store
 * @param {string} chatId
 * @returns {Promise<string>}
 */
export async function formatWorkspaceStatus(store, chatId) {
  const workspace = await getWorkspaceForChatOrThrow(store, chatId);
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

/**
 * @param {Store} store
 * @param {string} repoChatId
 * @param {string} workspaceName
 * @returns {Promise<WorkspaceRow | null>}
 */
export async function getWorkspaceForArchiveByName(store, repoChatId, workspaceName) {
  const repo = await getRepoForControlChatOrThrow(store, repoChatId);
  return store.getWorkspaceByName(repo.repo_id, workspaceName);
}

/**
 * @param {Store} store
 * @param {string} workspaceId
 * @returns {Promise<WorkspaceRow>}
 */
export async function archiveWorkspaceById(store, workspaceId) {
  const workspace = await store.archiveWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} does not exist.`);
  }
  return workspace;
}

/**
 * @param {Store} store
 * @param {string} workspaceChatId
 * @returns {Promise<WorkspaceRow>}
 */
export async function getWorkspaceForCurrentArchive(store, workspaceChatId) {
  return getWorkspaceForChatOrThrow(store, workspaceChatId);
}

/**
 * Resolve repo/workspace binding semantics for a chat.
 */

/**
 * @param {{
 *   getChatBinding: (chatId: string) => Promise<ChatBindingRow | null>,
 *   getRepo: (repoId: string) => Promise<RepoRow | null>,
 *   getWorkspace: (workspaceId: string) => Promise<WorkspaceRow | null>,
 * }} store
 * @param {string} chatId
 * @returns {Promise<ResolvedChatBinding>}
 */
export async function resolveChatBinding(store, chatId) {
  const binding = await store.getChatBinding(chatId);
  if (!binding) {
    return { kind: "unbound" };
  }

  if (binding.binding_kind === "repo") {
    if (!binding.repo_id) {
      throw new Error(`Chat binding for ${chatId} is missing repo_id.`);
    }
    const repo = await store.getRepo(binding.repo_id);
    if (!repo) {
      throw new Error(`Repo ${binding.repo_id} referenced by chat ${chatId} does not exist.`);
    }
    return {
      kind: "repo",
      repo,
    };
  }

  if (!binding.repo_id || !binding.workspace_id) {
    throw new Error(`Workspace binding for ${chatId} is missing repo_id or workspace_id.`);
  }

  const [repo, workspace] = await Promise.all([
    store.getRepo(binding.repo_id),
    store.getWorkspace(binding.workspace_id),
  ]);
  if (!repo) {
    throw new Error(`Repo ${binding.repo_id} referenced by chat ${chatId} does not exist.`);
  }
  if (!workspace) {
    throw new Error(`Workspace ${binding.workspace_id} referenced by chat ${chatId} does not exist.`);
  }

  return {
    kind: "workspace",
    repo,
    workspace,
  };
}

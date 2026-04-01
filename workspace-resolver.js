import { createHash } from "node:crypto";
import path from "node:path";
import { getChatWorkDir } from "./utils.js";
import { inspectGitWorkspace } from "./workspace-git.js";

/**
 * @param {string} rootPath
 * @returns {string}
 */
function buildRepoName(rootPath) {
  const base = path.basename(rootPath) || "repo";
  const digest = createHash("sha1").update(rootPath).digest("hex").slice(0, 8);
  return `${base}-${digest}`;
}

/**
 * @param {string | null} branch
 * @returns {string}
 */
function defaultBaseBranch(branch) {
  return branch && branch.trim() ? branch.trim() : "master";
}

/**
 * @param {{
 *   getChatBinding: (chatId: string) => Promise<ChatBindingRow | null>,
 *   getRepo: (repoId: string) => Promise<RepoRow | null>,
 *   getWorkspace: (workspaceId: string) => Promise<WorkspaceRow | null>,
 *   getRepoByRootPath?: (rootPath: string) => Promise<RepoRow | null>,
 *   getWorkspaceByWorktreePath?: (worktreePath: string) => Promise<WorkspaceRow | null>,
 *   createRepo?: (input: { name: string, rootPath: string, defaultBaseBranch: string, controlChatId?: string | null }) => Promise<RepoRow>,
 * }} store
 * @param {string} chatId
 * @param {string | null | undefined} [explicitCwd]
 * @param {string | null | undefined} [chatName]
 * @returns {Promise<ResolvedChatBinding>}
 */
export async function resolveChatBinding(store, chatId, explicitCwd, chatName) {
  const binding = await store.getChatBinding(chatId);
  if (binding?.binding_kind === "workspace") {
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
    return { kind: "workspace", repo, workspace };
  }

  if (binding?.binding_kind === "repo" && binding.repo_id) {
    const repo = await store.getRepo(binding.repo_id);
    if (repo) {
      return { kind: "repo", repo };
    }
  }

  const cwd = getChatWorkDir(chatId, explicitCwd, chatName);
  const inferred = await inspectGitWorkspace(cwd);
  if (!inferred) {
    return { kind: "unbound" };
  }

  const repoLookup = store.getRepoByRootPath;
  const createRepo = store.createRepo;
  let repo = repoLookup ? await repoLookup(inferred.kind === "repo" ? inferred.rootPath : path.dirname(inferred.commonDir)) : null;

  if (!repo && createRepo) {
    repo = await createRepo({
      name: buildRepoName(inferred.kind === "repo" ? inferred.rootPath : path.dirname(inferred.commonDir)),
      rootPath: inferred.kind === "repo" ? inferred.rootPath : path.dirname(inferred.commonDir),
      defaultBaseBranch: defaultBaseBranch(inferred.branch),
      controlChatId: null,
    });
  }

  if (!repo) {
    return { kind: "unbound" };
  }

  if (inferred.kind === "repo") {
    return { kind: "repo", repo };
  }

  const workspace = store.getWorkspaceByWorktreePath
    ? await store.getWorkspaceByWorktreePath(inferred.rootPath)
    : null;
  if (!workspace) {
    return { kind: "unbound" };
  }

  return { kind: "workspace", repo, workspace };
}

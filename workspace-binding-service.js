import { createHash } from "node:crypto";
import path from "node:path";
import { getChatWorkDir } from "./utils.js";
import { inspectGitWorkspace } from "./workspace-git.js";

/**
 * @param {string} rootPath
 * @returns {string}
 */
function buildRepoName(rootPath) {
  const base = path.basename(rootPath) || "project";
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
 * @param {string | null | undefined} chatName
 * @returns {string}
 */
function buildChatWorkspaceName(chatName) {
  const trimmed = chatName?.trim();
  return trimmed || "main";
}

/**
 * Resolve or create the default workspace that uses the chat's own workdir as
 * its workspace folder.
 * @param {{
 *   chatId: string,
 *   chatName?: string | null,
 *   explicitCwd?: string | null | undefined,
 *   store: {
 *     getProjectByRootPath?: (rootPath: string) => Promise<ProjectRow | null>,
 *     getWorkspaceByName?: (projectId: string, name: string) => Promise<WorkspaceRow | null>,
 *     createProject?: (input: { name: string, rootPath: string, defaultBaseBranch: string, controlChatId?: string | null }) => Promise<ProjectRow>,
 *     createWorkspace?: (input: {
 *       workspaceId?: string,
 *       projectId: string,
 *       name: string,
 *       branch: string,
 *       baseBranch: string,
 *       worktreePath: string,
 *       status?: WorkspaceStatus,
 *     }) => Promise<WorkspaceRow>,
 *     saveWhatsAppWorkspacePresentation?: (input: {
 *       projectId: string,
 *       workspaceId: string,
 *       workspaceChatId: string,
 *       workspaceChatSubject: string,
 *       role?: WhatsAppWorkspacePresentationRole,
 *       linkedCommunityChatId?: string | null,
 *     }) => Promise<WhatsAppWorkspacePresentationRow>,
 *     upsertWhatsAppProjectPresentation?: (input: {
 *       projectId: string,
 *       topologyKind?: WhatsAppProjectTopologyKind,
 *       communityChatId?: string | null,
 *       mainWorkspaceId?: string | null,
 *     }) => Promise<WhatsAppProjectPresentationRow>,
 *   },
 * }} input
 * @returns {Promise<{ project: ProjectRow, workspace: WorkspaceRow } | null>}
 */
async function resolveOrAdoptChatWorkspace({ chatId, chatName, explicitCwd, store }) {
  const projectLookup = store.getProjectByRootPath;
  const createProject = store.createProject;
  const createWorkspace = store.createWorkspace;
  const getWorkspaceByName = store.getWorkspaceByName;
  const saveWhatsAppWorkspacePresentation = store.saveWhatsAppWorkspacePresentation;

  if (!projectLookup || !createProject || !createWorkspace || !getWorkspaceByName || !saveWhatsAppWorkspacePresentation) {
    return null;
  }

  const rootPath = getChatWorkDir(chatId, explicitCwd, chatName);
  let project = await projectLookup(rootPath);
  if (!project) {
    project = await createProject({
      name: buildRepoName(rootPath),
      rootPath,
      defaultBaseBranch: defaultBaseBranch(null),
      controlChatId: null,
    });
  }

  const workspaceName = buildChatWorkspaceName(chatName);
  const existingWorkspace = await getWorkspaceByName(project.project_id, workspaceName);
  if (existingWorkspace) {
    return { project, workspace: existingWorkspace };
  }

  const workspaceId = chatId;
  await saveWhatsAppWorkspacePresentation({
    projectId: project.project_id,
    workspaceId,
    workspaceChatId: chatId,
    workspaceChatSubject: workspaceName,
  });
  const workspace = await createWorkspace({
    workspaceId,
    projectId: project.project_id,
    name: workspaceName,
    branch: project.default_base_branch,
    baseBranch: project.default_base_branch,
    worktreePath: rootPath,
    status: "ready",
  });
  await store.upsertWhatsAppProjectPresentation?.({
    projectId: project.project_id,
    topologyKind: "groups",
    mainWorkspaceId: workspace.workspace_id,
  });
  return { project, workspace };
}

/**
 * Dedicated app-side binding service for resolving the workspace identity of a
 * chat independent of adapter presentation details.
 * @param {{
 *   getChatBinding: (chatId: string) => Promise<ChatBindingRow | null>,
 *   getProject: (projectId: string) => Promise<ProjectRow | null>,
 *   getWorkspace: (workspaceId: string) => Promise<WorkspaceRow | null>,
 *   getProjectByRootPath?: (rootPath: string) => Promise<ProjectRow | null>,
 *   getWorkspaceByWorktreePath?: (worktreePath: string) => Promise<WorkspaceRow | null>,
 *   getWorkspaceByName?: (projectId: string, name: string) => Promise<WorkspaceRow | null>,
 *   createProject?: (input: { name: string, rootPath: string, defaultBaseBranch: string, controlChatId?: string | null }) => Promise<ProjectRow>,
 *   createWorkspace?: (input: {
 *     workspaceId?: string,
 *     projectId: string,
 *     name: string,
 *     branch: string,
 *     baseBranch: string,
 *     worktreePath: string,
 *     status?: WorkspaceStatus,
 *   }) => Promise<WorkspaceRow>,
 *   saveWhatsAppWorkspacePresentation?: (input: {
 *     projectId: string,
 *     workspaceId: string,
 *     workspaceChatId: string,
 *     workspaceChatSubject: string,
 *     role?: WhatsAppWorkspacePresentationRole,
 *     linkedCommunityChatId?: string | null,
 *   }) => Promise<WhatsAppWorkspacePresentationRow>,
 *   upsertWhatsAppProjectPresentation?: (input: {
 *     projectId: string,
 *     topologyKind?: WhatsAppProjectTopologyKind,
 *     communityChatId?: string | null,
 *     mainWorkspaceId?: string | null,
 *   }) => Promise<WhatsAppProjectPresentationRow>,
 * }} store
 */
export function createWorkspaceBindingService(store) {
  return {
    /**
     * @param {string} chatId
     * @param {string | null | undefined} [explicitCwd]
     * @param {string | null | undefined} [chatName]
     * @param {boolean | null | undefined} [isGroupChat]
     * @returns {Promise<ResolvedChatBinding>}
     */
    async resolveChatBinding(chatId, explicitCwd, chatName, isGroupChat) {
      const binding = await store.getChatBinding(chatId);
      if (binding?.binding_kind === "workspace") {
        if (!binding.project_id || !binding.workspace_id) {
          throw new Error(`Workspace binding for ${chatId} is missing project_id or workspace_id.`);
        }
        const [project, workspace] = await Promise.all([
          store.getProject(binding.project_id),
          store.getWorkspace(binding.workspace_id),
        ]);
        if (!project) {
          throw new Error(`Project ${binding.project_id} referenced by chat ${chatId} does not exist.`);
        }
        if (!workspace) {
          throw new Error(`Workspace ${binding.workspace_id} referenced by chat ${chatId} does not exist.`);
        }
        return { kind: "workspace", project, workspace };
      }

      if (binding?.binding_kind === "project" && binding.project_id) {
        const project = await store.getProject(binding.project_id);
        if (project) {
          return { kind: "project", project };
        }
      }

      const cwd = getChatWorkDir(chatId, explicitCwd, chatName);
      const inferred = await inspectGitWorkspace(cwd);
      if (!inferred) {
        if (!isGroupChat) {
          return { kind: "unbound" };
        }
        const adopted = await resolveOrAdoptChatWorkspace({
          chatId,
          chatName,
          explicitCwd,
          store,
        });
        if (!adopted) {
          return { kind: "unbound" };
        }
        return { kind: "workspace", project: adopted.project, workspace: adopted.workspace };
      }

      const inferredRepoRoot = inferred.kind === "repo" ? inferred.rootPath : path.dirname(inferred.commonDir);
      const projectLookup = store.getProjectByRootPath;
      const createProject = store.createProject;
      let project = projectLookup ? await projectLookup(inferredRepoRoot) : null;

      if (!project && createProject) {
        project = await createProject({
          name: buildRepoName(inferredRepoRoot),
          rootPath: inferredRepoRoot,
          defaultBaseBranch: defaultBaseBranch(inferred.branch),
          controlChatId: null,
        });
      }

      if (!project) {
        return { kind: "unbound" };
      }

      if (inferred.kind === "repo") {
        return { kind: "project", project };
      }

      const workspace = store.getWorkspaceByWorktreePath
        ? await store.getWorkspaceByWorktreePath(inferred.rootPath)
        : null;
      if (!workspace) {
        return { kind: "unbound" };
      }

      return { kind: "workspace", project, workspace };
    },
  };
}

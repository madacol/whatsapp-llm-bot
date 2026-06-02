/**
 * @param {string} value
 * @returns {string}
 */
function normalizeTitlePart(value) {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * @param {string} projectName
 * @param {string} projectId
 * @returns {string}
 */
function resolveProjectTitle(projectName, projectId) {
  return normalizeTitlePart(projectName) || normalizeTitlePart(projectId) || "project";
}

/**
 * @param {string} workspaceName
 * @returns {boolean}
 */
function isMainWorkspaceName(workspaceName) {
  return normalizeTitlePart(workspaceName).toLowerCase() === "main";
}

/**
 * @param {string[]} jids
 * @returns {string[]}
 */
function normalizeParticipantJids(jids) {
  return [...new Set(jids
    .map((jid) => typeof jid === "string" ? jid.trim() : "")
    .filter((jid) => jid.includes("@")))];
}

/**
 * @param {string} projectName
 * @param {string} workspaceName
 * @param {{ projectId?: string, role?: WhatsAppWorkspacePresentationRole }} [options]
 * @returns {string}
 */
export function buildWorkspaceSurfaceName(projectName, workspaceName, options = {}) {
  const projectTitle = resolveProjectTitle(projectName, options.projectId ?? "");
  if (options.role === "main" || isMainWorkspaceName(workspaceName)) {
    return projectTitle;
  }
  return `${projectTitle} - ${normalizeTitlePart(workspaceName) || "workspace"}`;
}

/**
 * @param {{
 *   transport: ChatTransport,
 *   store: Pick<Awaited<ReturnType<typeof import("../store.js").initStore>>,
 *     "saveWhatsAppWorkspacePresentation">,
 * }} input
 * @returns {{
 *   syncMainWorkspaceCommunitySurface: (input: {
 *     projectId: string,
 *     projectName: string,
 *     workspaceId: string,
 *     existingWorkspacePresentation: WhatsAppWorkspacePresentationRow,
 *     communityChatId: string,
 *   }) => Promise<{ surfaceId: string, surfaceName: string }>,
 *   provisionWorkspaceSurface: (input: {
 *     projectId: string,
 *     projectName: string,
 *     workspaceId: string,
 *     workspaceName: string,
 *     sourceChatName?: string,
 *     sourceChatId?: string,
 *     requesterJids: string[],
 *   }) => Promise<{ surfaceId: string, surfaceName: string }>,
 * }}
 */
export function createWhatsAppWorkspaceTopology({ transport, store }) {
  /**
   * @param {string | undefined} sourceChatId
   * @returns {Promise<string | null>}
   */
  async function resolveSourceCommunityChatId(sourceChatId) {
    if (!sourceChatId || !transport.getGroupLinkedParent) {
      return null;
    }
    return transport.getGroupLinkedParent(sourceChatId);
  }

  /**
   * @param {string | undefined} sourceChatId
   * @param {string[]} requesterJids
   * @returns {Promise<string[]>}
   */
  async function resolveInitialParticipants(sourceChatId, requesterJids) {
    if (!sourceChatId || !transport.getGroupParticipants) {
      return normalizeParticipantJids(requesterJids);
    }
    const sourceParticipants = await transport.getGroupParticipants(sourceChatId);
    return normalizeParticipantJids([...sourceParticipants, ...requesterJids]);
  }

  /**
   * @param {{
   *   projectId: string,
   *   projectName: string,
   *   workspaceId: string,
   *   workspaceName: string,
   *   requesterJids: string[],
   *   communityChatId: string | null,
   * }} input
   * @returns {Promise<{ surfaceId: string, surfaceName: string }>}
   */
  async function provisionSurface({
    projectId,
    projectName,
    workspaceId,
    workspaceName,
    requesterJids,
    communityChatId,
  }) {
    const role = /** @type {WhatsAppWorkspacePresentationRole} */ (
      isMainWorkspaceName(workspaceName) ? "main" : "workspace"
    );
    const surfaceName = buildWorkspaceSurfaceName(projectName, workspaceName, { projectId, role });
    if (communityChatId) {
      if (!transport.createCommunityGroup) {
        throw new Error("Workspace creation inside an existing community requires community subgroup provisioning support.");
      }
      const group = await transport.createCommunityGroup(surfaceName, requesterJids, communityChatId);
      const persistedSurfaceName = typeof group.subject === "string" ? group.subject : surfaceName;
      await store.saveWhatsAppWorkspacePresentation({
        projectId,
        workspaceId,
        workspaceChatId: group.chatId,
        workspaceChatSubject: persistedSurfaceName,
        role,
        linkedCommunityChatId: communityChatId,
      });
      return {
        surfaceId: group.chatId,
        surfaceName: persistedSurfaceName,
      };
    }

    if (!transport.createGroup) {
      throw new Error("Workspace creation requires workspace surface provisioning support.");
    }
    const group = await transport.createGroup(surfaceName, requesterJids);
    if (transport.promoteParticipants && requesterJids.length > 0) {
      await transport.promoteParticipants(group.chatId, requesterJids);
    }
    const persistedSurfaceName = typeof group.subject === "string" ? group.subject : surfaceName;
    await store.saveWhatsAppWorkspacePresentation({
      projectId,
      workspaceId,
      workspaceChatId: group.chatId,
      workspaceChatSubject: persistedSurfaceName,
      role,
      linkedCommunityChatId: null,
    });
    return {
      surfaceId: group.chatId,
      surfaceName: persistedSurfaceName,
    };
  }

  return {
    async syncMainWorkspaceCommunitySurface({
      projectId,
      projectName,
      workspaceId,
      existingWorkspacePresentation,
      communityChatId,
    }) {
      const surfaceName = buildWorkspaceSurfaceName(projectName, "main", { projectId, role: "main" });
      if (transport.renameGroup && existingWorkspacePresentation.workspace_chat_subject !== surfaceName) {
        await transport.renameGroup(existingWorkspacePresentation.workspace_chat_id, surfaceName);
      }
      await store.saveWhatsAppWorkspacePresentation({
        projectId,
        workspaceId,
        workspaceChatId: existingWorkspacePresentation.workspace_chat_id,
        workspaceChatSubject: surfaceName,
        role: "main",
        linkedCommunityChatId: communityChatId,
      });
      return {
        surfaceId: existingWorkspacePresentation.workspace_chat_id,
        surfaceName,
      };
    },

    async provisionWorkspaceSurface(input) {
      const [communityChatId, participants] = await Promise.all([
        resolveSourceCommunityChatId(input.sourceChatId),
        resolveInitialParticipants(input.sourceChatId, input.requesterJids),
      ]);
      return provisionSurface({
        projectId: input.projectId,
        projectName: input.projectName,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        requesterJids: participants,
        communityChatId,
      });
    },
  };
}

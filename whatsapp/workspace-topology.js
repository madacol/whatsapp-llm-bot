/**
 * @param {string} workspaceName
 * @param {string | undefined} sourceChatName
 * @returns {string}
 */
export function buildWorkspaceSurfaceName(workspaceName, sourceChatName) {
  const trimmedChatName = sourceChatName?.trim();
  if (!trimmedChatName) {
    return workspaceName;
  }
  return `[${workspaceName}] ${trimmedChatName}`;
}

/**
 * @param {string} projectId
 * @param {string | undefined} sourceChatName
 * @returns {string}
 */
export function buildCommunitySurfaceName(projectId, sourceChatName) {
  const trimmedChatName = sourceChatName?.trim();
  return trimmedChatName || `project-${projectId}`;
}

/**
 * @param {string} workspaceName
 * @param {WhatsAppWorkspacePresentationRole} role
 * @returns {string}
 */
export function buildCommunityWorkspaceSurfaceName(workspaceName, role) {
  if (role === "main") {
    return "main";
  }
  return workspaceName;
}

/**
 * @param {WhatsAppProjectPresentationRow | null} repoPresentation
 * @param {string} workspaceId
 * @returns {WhatsAppWorkspacePresentationRole}
 */
export function resolveWorkspaceRole(repoPresentation, workspaceId) {
  if (repoPresentation?.topology_kind === "community" && repoPresentation.main_workspace_id === workspaceId) {
    return "main";
  }
  return "workspace";
}

/**
 * @param {string} workspaceId
 * @param {WhatsAppWorkspacePresentationRow[]} presentations
 * @returns {WhatsAppWorkspacePresentationRow | null}
 */
function findWorkspacePresentation(workspaceId, presentations) {
  return presentations.find((presentation) => presentation.workspace_id === workspaceId) ?? null;
}

/**
 * @param {{
 *   transport: ChatTransport & {
 *     linkExistingGroupToCommunity: (chatId: string, communityChatId: string) => Promise<void>,
 *   },
 *   store: Pick<Awaited<ReturnType<typeof import("../store.js").initStore>>,
 *     "listWhatsAppWorkspacePresentations"
 *     | "saveWhatsAppWorkspacePresentation"
 *     | "upsertWhatsAppProjectPresentation">,
 * }} input
 * @returns {{
 *   syncMainWorkspaceCommunitySurface: (input: {
 *     projectId: string,
 *     workspaceId: string,
 *     existingWorkspacePresentation: WhatsAppWorkspacePresentationRow,
 *     communityChatId: string,
 *   }) => Promise<{ surfaceId: string, surfaceName: string }>,
 *   provisionWorkspaceSurface: (input: {
 *     projectId: string,
 *     workspaceId: string,
 *     workspaceName: string,
 *     sourceChatName?: string,
 *     requesterJids: string[],
 *     repoPresentation: WhatsAppProjectPresentationRow | null,
 *   }) => Promise<{ surfaceId: string, surfaceName: string }>,
 * }}
 */
export function createWhatsAppWorkspaceTopology({ transport, store }) {
  /**
   * Normalize the persisted main workspace surface so the original flat group
   * becomes the `main` subgroup inside the community.
   * @param {{
   *   projectId: string,
   *   workspaceId: string,
   *   existingWorkspacePresentation: WhatsAppWorkspacePresentationRow,
   *   communityChatId: string,
   * }} input
   * @returns {Promise<{ surfaceId: string, surfaceName: string }>}
   */
  async function adoptExistingWorkspaceSurfaceIntoCommunity({
    projectId,
    workspaceId,
    existingWorkspacePresentation,
    communityChatId,
  }) {
    if (
      existingWorkspacePresentation.linked_community_chat_id
      && existingWorkspacePresentation.linked_community_chat_id !== communityChatId
    ) {
      throw new Error(
        `Workspace ${workspaceId} is already linked to community ${existingWorkspacePresentation.linked_community_chat_id}, expected ${communityChatId}.`,
      );
    }
    const surfaceName = buildCommunityWorkspaceSurfaceName(existingWorkspacePresentation.workspace_chat_subject, "main");
    if (
      existingWorkspacePresentation.workspace_chat_subject === surfaceName
      && existingWorkspacePresentation.role === "main"
      && existingWorkspacePresentation.linked_community_chat_id === communityChatId
    ) {
      return {
        surfaceId: existingWorkspacePresentation.workspace_chat_id,
        surfaceName,
      };
    }
    if (transport.renameGroup && existingWorkspacePresentation.workspace_chat_subject !== surfaceName) {
      await transport.renameGroup(existingWorkspacePresentation.workspace_chat_id, surfaceName);
    }
    if (existingWorkspacePresentation.linked_community_chat_id !== communityChatId) {
      await transport.linkExistingGroupToCommunity(
        existingWorkspacePresentation.workspace_chat_id,
        communityChatId,
      );
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
  }

  /**
   * @param {{
   *   projectId: string,
   *   workspaceId: string,
   *   workspaceName: string,
   *   sourceChatName?: string,
   *   requesterJids: string[],
   * }} input
   * @returns {Promise<{ surfaceId: string, surfaceName: string }>}
   */
  async function provisionFlatWorkspaceSurface({
    projectId,
    workspaceId,
    workspaceName,
    sourceChatName,
    requesterJids,
  }) {
    if (!transport.createGroup) {
      throw new Error("Workspace creation requires workspace surface provisioning support.");
    }
    const surfaceName = buildWorkspaceSurfaceName(workspaceName, sourceChatName);
    const group = await transport.createGroup(surfaceName, requesterJids);
    if (transport.promoteParticipants && requesterJids.length > 0) {
      await transport.promoteParticipants(group.chatId, requesterJids);
    }
    const persistedSurfaceName = typeof group.subject === "string" ? group.subject : surfaceName;
    await store.upsertWhatsAppProjectPresentation({
      projectId,
      topologyKind: "groups",
      mainWorkspaceId: workspaceId,
    });
    await store.saveWhatsAppWorkspacePresentation({
      projectId,
      workspaceId,
      workspaceChatId: group.chatId,
      workspaceChatSubject: persistedSurfaceName,
    });
    return {
      surfaceId: group.chatId,
      surfaceName: persistedSurfaceName,
    };
  }

  /**
   * @param {{
   *   projectId: string,
   *   workspaceId: string,
   *   workspaceName: string,
   *   requesterJids: string[],
   *   communityChatId: string,
   *   role: WhatsAppWorkspacePresentationRole,
   * }} input
   * @returns {Promise<{ surfaceId: string, surfaceName: string }>}
   */
  async function provisionCommunityWorkspaceSurface({
    projectId,
    workspaceId,
    workspaceName,
    requesterJids,
    communityChatId,
    role,
  }) {
    if (!transport.createCommunityGroup) {
      throw new Error("Workspace creation requires community subgroup provisioning support.");
    }
    const surfaceName = buildCommunityWorkspaceSurfaceName(workspaceName, role);
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

  /**
   * @param {{
   *   projectId: string,
   *   mainWorkspaceId: string,
   *   communityChatId: string,
   *   existingPresentations: WhatsAppWorkspacePresentationRow[],
   * }} input
   * @returns {Promise<void>}
   */
  async function ensureCommunityMainWorkspaceSurface({
    projectId,
    mainWorkspaceId,
    communityChatId,
    existingPresentations,
  }) {
    const mainWorkspacePresentation = findWorkspacePresentation(mainWorkspaceId, existingPresentations);
    if (!mainWorkspacePresentation) {
      throw new Error(`Could not find the persisted workspace presentation for main workspace ${mainWorkspaceId}.`);
    }
    await adoptExistingWorkspaceSurfaceIntoCommunity({
      projectId,
      workspaceId: mainWorkspaceId,
      existingWorkspacePresentation: mainWorkspacePresentation,
      communityChatId,
    });
  }

  return {
    async syncMainWorkspaceCommunitySurface({
      projectId,
      workspaceId,
      existingWorkspacePresentation,
      communityChatId,
    }) {
      return adoptExistingWorkspaceSurfaceIntoCommunity({
        projectId,
        workspaceId,
        existingWorkspacePresentation,
        communityChatId,
      });
    },

    async provisionWorkspaceSurface(input) {
      const existingPresentations = await store.listWhatsAppWorkspacePresentations(input.projectId);
      if (input.repoPresentation?.topology_kind === "community") {
        if (!input.repoPresentation.community_chat_id) {
          throw new Error(`Community presentation for project ${input.projectId} is missing its community chat id.`);
        }
        if (input.repoPresentation.main_workspace_id) {
          await ensureCommunityMainWorkspaceSurface({
            projectId: input.projectId,
            mainWorkspaceId: input.repoPresentation.main_workspace_id,
            communityChatId: input.repoPresentation.community_chat_id,
            existingPresentations,
          });
        }
        return provisionCommunityWorkspaceSurface({
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          workspaceName: input.workspaceName,
          requesterJids: input.requesterJids,
          communityChatId: input.repoPresentation.community_chat_id,
          role: resolveWorkspaceRole(input.repoPresentation, input.workspaceId),
        });
      }

      if (existingPresentations.length === 0) {
        return provisionFlatWorkspaceSurface(input);
      }

      if (!transport.createCommunity) {
        throw new Error("Workspace creation requires community provisioning support.");
      }
      const mainWorkspaceId = input.repoPresentation?.main_workspace_id ?? existingPresentations[0]?.workspace_id;
      if (!mainWorkspaceId) {
        throw new Error(`Could not determine the main workspace for project ${input.projectId}.`);
      }

      const community = await transport.createCommunity(
        buildCommunitySurfaceName(input.projectId, input.sourceChatName),
        "",
      );
      await ensureCommunityMainWorkspaceSurface({
        projectId: input.projectId,
        mainWorkspaceId,
        communityChatId: community.chatId,
        existingPresentations,
      });
      await store.upsertWhatsAppProjectPresentation({
        projectId: input.projectId,
        topologyKind: "community",
        communityChatId: community.chatId,
        mainWorkspaceId,
      });
      return provisionCommunityWorkspaceSurface({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        requesterJids: input.requesterJids,
        communityChatId: community.chatId,
        role: "workspace",
      });
    },
  };
}

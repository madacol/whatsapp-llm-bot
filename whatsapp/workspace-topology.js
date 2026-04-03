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
 * @param {string} projectId
 * @param {string | undefined} sourceChatName
 * @returns {string}
 */
export function buildCommunityDescription(projectId, sourceChatName) {
  return `Workspace hub for ${buildCommunitySurfaceName(projectId, sourceChatName)}.`;
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
 *     getGroupLinkedParent?: (chatId: string) => Promise<string | null>,
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
 *     sourceWorkspaceId?: string,
 *     requesterJids: string[],
 *     repoPresentation: WhatsAppProjectPresentationRow | null,
 *   }) => Promise<{ surfaceId: string, surfaceName: string }>,
 * }}
 */
export function createWhatsAppWorkspaceTopology({ transport, store }) {
  /**
   * @param {string} chatId
   * @returns {Promise<string | null>}
   */
  async function getLiveLinkedCommunityChatId(chatId) {
    if (!transport.getGroupLinkedParent) {
      throw new Error("Workspace adoption requires live WhatsApp group metadata lookup support.");
    }
    return transport.getGroupLinkedParent(chatId);
  }

  /**
   * @param {{
   *   workspaceId: string,
   *   workspaceChatId: string,
   *   communityChatId: string,
   * }} input
   * @returns {Promise<void>}
   */
  async function ensureLiveGroupLink({
    workspaceId,
    workspaceChatId,
    communityChatId,
  }) {
    const initialLinkedCommunityChatId = await getLiveLinkedCommunityChatId(workspaceChatId);
    if (initialLinkedCommunityChatId && initialLinkedCommunityChatId !== communityChatId) {
      throw new Error(
        `Workspace ${workspaceId} is already linked to community ${initialLinkedCommunityChatId}, expected ${communityChatId}.`,
      );
    }
    if (initialLinkedCommunityChatId === communityChatId) {
      return;
    }
    await transport.linkExistingGroupToCommunity(workspaceChatId, communityChatId);
    const linkedCommunityChatIdAfterLink = await getLiveLinkedCommunityChatId(workspaceChatId);
    if (linkedCommunityChatIdAfterLink !== communityChatId) {
      throw new Error(
        `Workspace ${workspaceId} was linked to community ${communityChatId}, but live WhatsApp metadata still reports ${linkedCommunityChatIdAfterLink ?? "no linked community"}.`,
      );
    }
  }

  /**
   * @param {{
   *   projectId: string,
   *   mainWorkspaceId: string,
   *   mainWorkspacePresentation: WhatsAppWorkspacePresentationRow,
   *   communityChatId: string,
   *   sourceChatName?: string,
   *   allowReplacement?: boolean,
   * }} input
   * @returns {Promise<string>}
   */
  async function resolveActiveCommunityChatIdForMainWorkspace({
    projectId,
    mainWorkspaceId,
    mainWorkspacePresentation,
    communityChatId,
    sourceChatName,
    allowReplacement,
  }) {
    const liveLinkedCommunityChatId = await getLiveLinkedCommunityChatId(mainWorkspacePresentation.workspace_chat_id);
    if (liveLinkedCommunityChatId === communityChatId) {
      return communityChatId;
    }
    if (liveLinkedCommunityChatId) {
      throw new Error(
        `Workspace ${mainWorkspaceId} is already linked to community ${liveLinkedCommunityChatId}, expected ${communityChatId}.`,
      );
    }
    if (!allowReplacement) {
      return communityChatId;
    }
    if (!transport.createCommunity) {
      throw new Error("Workspace adoption requires community provisioning support.");
    }
    const replacementCommunity = await transport.createCommunity(
      buildCommunitySurfaceName(projectId, sourceChatName),
      buildCommunityDescription(projectId, sourceChatName),
    );
    await store.upsertWhatsAppProjectPresentation({
      projectId,
      topologyKind: "community",
      communityChatId: replacementCommunity.chatId,
      mainWorkspaceId,
    });
    return replacementCommunity.chatId;
  }

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
    const surfaceName = buildCommunityWorkspaceSurfaceName(existingWorkspacePresentation.workspace_chat_subject, "main");
    await ensureLiveGroupLink({
      workspaceId,
      workspaceChatId: existingWorkspacePresentation.workspace_chat_id,
      communityChatId,
    });
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
   *   existingWorkspacePresentation: WhatsAppWorkspacePresentationRow,
   * }} input
   * @returns {Promise<void>}
   */
  async function demoteWorkspaceSurfaceFromMain({
    projectId,
    existingWorkspacePresentation,
  }) {
    await store.saveWhatsAppWorkspacePresentation({
      projectId,
      workspaceId: existingWorkspacePresentation.workspace_id,
      workspaceChatId: existingWorkspacePresentation.workspace_chat_id,
      workspaceChatSubject: existingWorkspacePresentation.workspace_chat_subject,
      role: "workspace",
      linkedCommunityChatId: existingWorkspacePresentation.linked_community_chat_id,
    });
  }

  /**
   * @param {{
   *   existingPresentations: WhatsAppWorkspacePresentationRow[],
   *   persistedMainWorkspaceId?: string | null,
   *   sourceWorkspaceId?: string,
   * }} input
   * @returns {Promise<{
   *   mainWorkspaceId: string | null,
   *   previousMainWorkspacePresentation: WhatsAppWorkspacePresentationRow | null,
   * }>}
   */
  async function resolveEffectiveMainWorkspaceSelection({
    existingPresentations,
    persistedMainWorkspaceId,
    sourceWorkspaceId,
  }) {
    const persistedMainWorkspacePresentation = persistedMainWorkspaceId
      ? findWorkspacePresentation(persistedMainWorkspaceId, existingPresentations)
      : null;
    if (sourceWorkspaceId) {
      const sourceWorkspacePresentation = findWorkspacePresentation(sourceWorkspaceId, existingPresentations);
      if (sourceWorkspacePresentation) {
        const liveLinkedCommunityChatId = await getLiveLinkedCommunityChatId(sourceWorkspacePresentation.workspace_chat_id);
        if (liveLinkedCommunityChatId === null) {
          return {
            mainWorkspaceId: sourceWorkspacePresentation.workspace_id,
            previousMainWorkspacePresentation:
              persistedMainWorkspacePresentation?.workspace_id !== sourceWorkspacePresentation.workspace_id
                ? persistedMainWorkspacePresentation
                : null,
          };
        }
      }
    }
    return {
      mainWorkspaceId: persistedMainWorkspacePresentation?.workspace_id ?? existingPresentations[0]?.workspace_id ?? null,
      previousMainWorkspacePresentation: null,
    };
  }

  /**
   * @param {{
   *   projectId: string,
   *   mainWorkspaceId: string,
   *   communityChatId: string,
   *   existingPresentations: WhatsAppWorkspacePresentationRow[],
   *   sourceChatName?: string,
   *   allowReplacement?: boolean,
   * }} input
   * @returns {Promise<string>}
   */
  async function ensureCommunityMainWorkspaceSurface({
    projectId,
    mainWorkspaceId,
    communityChatId,
    existingPresentations,
    sourceChatName,
    allowReplacement = false,
  }) {
    const mainWorkspacePresentation = findWorkspacePresentation(mainWorkspaceId, existingPresentations);
    if (!mainWorkspacePresentation) {
      throw new Error(`Could not find the persisted workspace presentation for main workspace ${mainWorkspaceId}.`);
    }
    const activeCommunityChatId = await resolveActiveCommunityChatIdForMainWorkspace({
      projectId,
      mainWorkspaceId,
      mainWorkspacePresentation,
      communityChatId,
      sourceChatName,
      allowReplacement,
    });
    await adoptExistingWorkspaceSurfaceIntoCommunity({
      projectId,
      workspaceId: mainWorkspaceId,
      existingWorkspacePresentation: mainWorkspacePresentation,
      communityChatId: activeCommunityChatId,
    });
    return activeCommunityChatId;
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
      const mainWorkspaceSelection = await resolveEffectiveMainWorkspaceSelection({
        existingPresentations,
        persistedMainWorkspaceId: input.repoPresentation?.main_workspace_id,
        sourceWorkspaceId: input.sourceWorkspaceId,
      });
      if (input.repoPresentation?.topology_kind === "community") {
        if (!input.repoPresentation.community_chat_id) {
          throw new Error(`Community presentation for project ${input.projectId} is missing its community chat id.`);
        }
        let activeCommunityChatId = input.repoPresentation.community_chat_id;
        if (mainWorkspaceSelection.mainWorkspaceId) {
          activeCommunityChatId = await ensureCommunityMainWorkspaceSurface({
            projectId: input.projectId,
            mainWorkspaceId: mainWorkspaceSelection.mainWorkspaceId,
            communityChatId: activeCommunityChatId,
            existingPresentations,
            sourceChatName: input.sourceChatName,
            allowReplacement: true,
          });
          if (mainWorkspaceSelection.previousMainWorkspacePresentation) {
            await demoteWorkspaceSurfaceFromMain({
              projectId: input.projectId,
              existingWorkspacePresentation: mainWorkspaceSelection.previousMainWorkspacePresentation,
            });
          }
        }
        return provisionCommunityWorkspaceSurface({
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          workspaceName: input.workspaceName,
          requesterJids: input.requesterJids,
          communityChatId: activeCommunityChatId,
          role: resolveWorkspaceRole(input.repoPresentation, input.workspaceId),
        });
      }

      if (existingPresentations.length === 0) {
        return provisionFlatWorkspaceSurface(input);
      }

      if (!transport.createCommunity) {
        throw new Error("Workspace creation requires community provisioning support.");
      }
      const mainWorkspaceId = mainWorkspaceSelection.mainWorkspaceId;
      if (!mainWorkspaceId) {
        throw new Error(`Could not determine the main workspace for project ${input.projectId}.`);
      }

      const community = await transport.createCommunity(
        buildCommunitySurfaceName(input.projectId, input.sourceChatName),
        buildCommunityDescription(input.projectId, input.sourceChatName),
      );
      const activeCommunityChatId = await ensureCommunityMainWorkspaceSurface({
        projectId: input.projectId,
        mainWorkspaceId,
        communityChatId: community.chatId,
        existingPresentations,
        sourceChatName: input.sourceChatName,
        allowReplacement: false,
      });
      await store.upsertWhatsAppProjectPresentation({
        projectId: input.projectId,
        topologyKind: "community",
        communityChatId: activeCommunityChatId,
        mainWorkspaceId,
      });
      return provisionCommunityWorkspaceSurface({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        requesterJids: input.requesterJids,
        communityChatId: activeCommunityChatId,
        role: "workspace",
      });
    },
  };
}

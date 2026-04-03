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
 * @param {string} chatId
 * @param {WhatsAppWorkspacePresentationRow[]} presentations
 * @returns {WhatsAppWorkspacePresentationRow | null}
 */
function findWorkspacePresentationByChatId(chatId, presentations) {
  return presentations.find((presentation) => presentation.workspace_chat_id === chatId) ?? null;
}

/**
 * @param {{
 *   transport: ChatTransport & {
 *     getGroupLinkedParent?: (chatId: string) => Promise<string | null>,
 *     linkExistingGroupToCommunity: (chatId: string, communityChatId: string) => Promise<void>,
 *   },
 *   store: Pick<Awaited<ReturnType<typeof import("../store.js").initStore>>,
 *     "getWhatsAppProjectPresentation"
 *     | "listWhatsAppWorkspacePresentations"
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
 *     sourceChatId?: string,
 *     requesterJids: string[],
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
   *   mainWorkspaceChatId: string,
   *   communityChatId: string,
   *   sourceChatName?: string,
   *   allowReplacement?: boolean,
   * }} input
   * @returns {Promise<string>}
   */
  async function resolveActiveCommunityChatIdForMainWorkspace({
    projectId,
    mainWorkspaceId,
    mainWorkspaceChatId,
    communityChatId,
    sourceChatName,
    allowReplacement,
  }) {
    const liveLinkedCommunityChatId = await getLiveLinkedCommunityChatId(mainWorkspaceChatId);
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
   *   workspaceChatId: string,
   *   workspaceChatSubject: string,
   *   persistedRole?: WhatsAppWorkspacePresentationRole,
   *   persistedLinkedCommunityChatId?: string | null,
   *   communityChatId: string,
   * }} input
   * @returns {Promise<{ surfaceId: string, surfaceName: string }>}
   */
  async function adoptWorkspaceSurfaceIntoCommunity({
    projectId,
    workspaceId,
    workspaceChatId,
    workspaceChatSubject,
    persistedRole,
    persistedLinkedCommunityChatId,
    communityChatId,
  }) {
    const surfaceName = buildCommunityWorkspaceSurfaceName(workspaceChatSubject, "main");
    await ensureLiveGroupLink({
      workspaceId,
      workspaceChatId,
      communityChatId,
    });
    if (
      workspaceChatSubject === surfaceName
      && persistedRole === "main"
      && persistedLinkedCommunityChatId === communityChatId
    ) {
      return {
        surfaceId: workspaceChatId,
        surfaceName,
      };
    }
    if (transport.renameGroup && workspaceChatSubject !== surfaceName) {
      await transport.renameGroup(workspaceChatId, surfaceName);
    }
    await store.saveWhatsAppWorkspacePresentation({
      projectId,
      workspaceId,
      workspaceChatId,
      workspaceChatSubject: surfaceName,
      role: "main",
      linkedCommunityChatId: communityChatId,
    });
    return {
      surfaceId: workspaceChatId,
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
   *   sourceChatName?: string,
   *   sourceChatId?: string,
   * }} input
   * @returns {Promise<{
   *   mainWorkspaceId: string | null,
   *   previousMainWorkspacePresentation: WhatsAppWorkspacePresentationRow | null,
   *   mainWorkspaceSurface: {
   *     workspaceChatId: string,
   *     workspaceChatSubject: string,
   *     persistedRole?: WhatsAppWorkspacePresentationRole,
   *     persistedLinkedCommunityChatId?: string | null,
   *   } | null,
   * }>}
   */
  async function resolveEffectiveMainWorkspaceSelection({
    existingPresentations,
    persistedMainWorkspaceId,
    sourceChatName,
    sourceChatId,
  }) {
    const persistedMainWorkspacePresentation = persistedMainWorkspaceId
      ? findWorkspacePresentation(persistedMainWorkspaceId, existingPresentations)
      : null;
    if (sourceChatId && (persistedMainWorkspacePresentation || existingPresentations.length > 0)) {
      const liveLinkedCommunityChatId = await getLiveLinkedCommunityChatId(sourceChatId);
      if (liveLinkedCommunityChatId === null) {
        const sourceWorkspacePresentation = findWorkspacePresentationByChatId(sourceChatId, existingPresentations);
        if (sourceWorkspacePresentation) {
          return {
            mainWorkspaceId: sourceWorkspacePresentation.workspace_id,
            previousMainWorkspacePresentation:
              persistedMainWorkspacePresentation?.workspace_id !== sourceWorkspacePresentation.workspace_id
                ? persistedMainWorkspacePresentation
                : null,
            mainWorkspaceSurface: {
              workspaceChatId: sourceWorkspacePresentation.workspace_chat_id,
              workspaceChatSubject: sourceWorkspacePresentation.workspace_chat_subject,
              persistedRole: sourceWorkspacePresentation.role,
              persistedLinkedCommunityChatId: sourceWorkspacePresentation.linked_community_chat_id,
            },
          };
        }
        const adoptedMainWorkspaceId = persistedMainWorkspacePresentation?.workspace_id
          ?? existingPresentations[0]?.workspace_id
          ?? null;
        if (adoptedMainWorkspaceId) {
          return {
            mainWorkspaceId: adoptedMainWorkspaceId,
            previousMainWorkspacePresentation: null,
            mainWorkspaceSurface: {
              workspaceChatId: sourceChatId,
              workspaceChatSubject: sourceChatName ?? persistedMainWorkspacePresentation?.workspace_chat_subject ?? "main",
              persistedRole: undefined,
              persistedLinkedCommunityChatId: null,
            },
          };
        }
      }
    }
    const fallbackMainWorkspacePresentation = persistedMainWorkspacePresentation ?? existingPresentations[0] ?? null;
    return {
      mainWorkspaceId: fallbackMainWorkspacePresentation?.workspace_id ?? null,
      previousMainWorkspacePresentation: null,
      mainWorkspaceSurface: fallbackMainWorkspacePresentation
        ? {
          workspaceChatId: fallbackMainWorkspacePresentation.workspace_chat_id,
          workspaceChatSubject: fallbackMainWorkspacePresentation.workspace_chat_subject,
          persistedRole: fallbackMainWorkspacePresentation.role,
          persistedLinkedCommunityChatId: fallbackMainWorkspacePresentation.linked_community_chat_id,
        }
        : null,
    };
  }

  /**
   * @param {{
   *   projectId: string,
   *   mainWorkspaceId: string,
   *   mainWorkspaceSurface: {
   *     workspaceChatId: string,
   *     workspaceChatSubject: string,
   *     persistedRole?: WhatsAppWorkspacePresentationRole,
   *     persistedLinkedCommunityChatId?: string | null,
   *   },
   *   communityChatId: string,
   *   sourceChatName?: string,
   *   allowReplacement?: boolean,
   * }} input
   * @returns {Promise<string>}
   */
  async function ensureCommunityMainWorkspaceSurface({
    projectId,
    mainWorkspaceId,
    mainWorkspaceSurface,
    communityChatId,
    sourceChatName,
    allowReplacement = false,
  }) {
    const activeCommunityChatId = await resolveActiveCommunityChatIdForMainWorkspace({
      projectId,
      mainWorkspaceId,
      mainWorkspaceChatId: mainWorkspaceSurface.workspaceChatId,
      communityChatId,
      sourceChatName,
      allowReplacement,
    });
    await adoptWorkspaceSurfaceIntoCommunity({
      projectId,
      workspaceId: mainWorkspaceId,
      workspaceChatId: mainWorkspaceSurface.workspaceChatId,
      workspaceChatSubject: mainWorkspaceSurface.workspaceChatSubject,
      persistedRole: mainWorkspaceSurface.persistedRole,
      persistedLinkedCommunityChatId: mainWorkspaceSurface.persistedLinkedCommunityChatId,
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
      return adoptWorkspaceSurfaceIntoCommunity({
        projectId,
        workspaceId,
        workspaceChatId: existingWorkspacePresentation.workspace_chat_id,
        workspaceChatSubject: existingWorkspacePresentation.workspace_chat_subject,
        persistedRole: existingWorkspacePresentation.role,
        persistedLinkedCommunityChatId: existingWorkspacePresentation.linked_community_chat_id,
        communityChatId,
      });
    },

    async provisionWorkspaceSurface(input) {
      const repoPresentation = await store.getWhatsAppProjectPresentation(input.projectId);
      const existingPresentations = await store.listWhatsAppWorkspacePresentations(input.projectId);
      const mainWorkspaceSelection = await resolveEffectiveMainWorkspaceSelection({
        existingPresentations,
        persistedMainWorkspaceId: repoPresentation?.main_workspace_id,
        sourceChatName: input.sourceChatName,
        sourceChatId: input.sourceChatId,
      });
      if (repoPresentation?.topology_kind === "community") {
        if (!repoPresentation.community_chat_id) {
          throw new Error(`Community presentation for project ${input.projectId} is missing its community chat id.`);
        }
        let activeCommunityChatId = repoPresentation.community_chat_id;
        if (mainWorkspaceSelection.mainWorkspaceId && mainWorkspaceSelection.mainWorkspaceSurface) {
          activeCommunityChatId = await ensureCommunityMainWorkspaceSurface({
            projectId: input.projectId,
            mainWorkspaceId: mainWorkspaceSelection.mainWorkspaceId,
            mainWorkspaceSurface: mainWorkspaceSelection.mainWorkspaceSurface,
            communityChatId: activeCommunityChatId,
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
          role: resolveWorkspaceRole(repoPresentation, input.workspaceId),
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
        mainWorkspaceSurface: mainWorkspaceSelection.mainWorkspaceSurface
          ?? (() => {
            throw new Error(`Could not determine the main workspace surface for project ${input.projectId}.`);
          })(),
        communityChatId: community.chatId,
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

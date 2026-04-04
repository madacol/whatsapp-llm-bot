import { readWhatsAppProjectPresentationCache } from "./project-presentation-cache.js";

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
 * @param {WhatsAppWorkspacePresentationRow[]} presentations
 * @returns {string | null}
 */
function findCachedCommunityChatIdHint(presentations) {
  return presentations.find((presentation) => presentation.linked_community_chat_id)?.linked_community_chat_id ?? null;
}

/**
 * @param {{
 *   transport: ChatTransport & {
 *     getGroupLinkedParent?: (chatId: string) => Promise<string | null>,
 *   },
 *   store: Pick<Awaited<ReturnType<typeof import("../store.js").initStore>>,
 *     "getWhatsAppProjectPresentationCache"
 *     | "listWhatsAppWorkspacePresentations">,
 * }} input
 * @returns {{
 *   getLiveLinkedCommunityChatId: (chatId: string) => Promise<string | null>,
 *   resolveProvisioningTopology: (input: {
 *     projectId: string,
 *     sourceChatId?: string,
 *     sourceChatName?: string,
 *   }) => Promise<{
 *     projectPresentation: WhatsAppProjectPresentationCacheView | null,
 *     existingPresentations: WhatsAppWorkspacePresentationRow[],
 *     sourceChatLiveCommunityChatId: string | null,
 *     mainWorkspaceLiveCommunityChatId: string | null,
 *     cachedCommunityChatIdHint: string | null,
 *     mainWorkspaceSelection: {
 *       mainWorkspaceId: string | null,
 *       previousMainWorkspacePresentation: WhatsAppWorkspacePresentationRow | null,
 *       mainWorkspaceSurface: {
 *         workspaceChatId: string,
 *         workspaceChatSubject: string,
 *         persistedRole?: WhatsAppWorkspacePresentationRole,
 *         persistedLinkedCommunityChatId?: string | null,
 *       } | null,
 *     },
 *   }>,
 * }}
 */
export function createWhatsAppLiveWorkspaceTopologyResolver({ transport, store }) {
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
   *   existingPresentations: WhatsAppWorkspacePresentationRow[],
   *   persistedMainWorkspaceId?: string | null,
   *   sourceChatName?: string,
   *   sourceChatId?: string,
   *   sourceChatLiveCommunityChatId: string | null,
   * }} input
   * @returns {{
   *   mainWorkspaceId: string | null,
   *   previousMainWorkspacePresentation: WhatsAppWorkspacePresentationRow | null,
   *   mainWorkspaceSurface: {
   *     workspaceChatId: string,
   *     workspaceChatSubject: string,
   *     persistedRole?: WhatsAppWorkspacePresentationRole,
   *     persistedLinkedCommunityChatId?: string | null,
   *   } | null,
   * }}
   */
  function resolveEffectiveMainWorkspaceSelection({
    existingPresentations,
    persistedMainWorkspaceId,
    sourceChatName,
    sourceChatId,
    sourceChatLiveCommunityChatId,
  }) {
    const persistedMainWorkspacePresentation = persistedMainWorkspaceId
      ? findWorkspacePresentation(persistedMainWorkspaceId, existingPresentations)
      : null;
    if (
      sourceChatId
      && sourceChatLiveCommunityChatId === null
      && (persistedMainWorkspacePresentation || existingPresentations.length > 0)
    ) {
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

  return {
    getLiveLinkedCommunityChatId,

    async resolveProvisioningTopology({
      projectId,
      sourceChatId,
      sourceChatName,
    }) {
      const [projectPresentationCacheHint, existingPresentations] = await Promise.all([
        store.getWhatsAppProjectPresentationCache(projectId),
        store.listWhatsAppWorkspacePresentations(projectId),
      ]);
      const projectPresentation = readWhatsAppProjectPresentationCache(projectPresentationCacheHint);
      const shouldInspectSourceChatLiveState = Boolean(
        sourceChatId && (projectPresentation || existingPresentations.length > 0),
      );
      const sourceChatLiveCommunityChatId = shouldInspectSourceChatLiveState && sourceChatId
        ? await getLiveLinkedCommunityChatId(sourceChatId)
        : null;
      const mainWorkspaceSelection = resolveEffectiveMainWorkspaceSelection({
        existingPresentations,
        persistedMainWorkspaceId: projectPresentation?.mainWorkspaceId,
        sourceChatName,
        sourceChatId,
        sourceChatLiveCommunityChatId,
      });
      const mainWorkspaceLiveCommunityChatId = mainWorkspaceSelection.mainWorkspaceSurface
        ? (
          sourceChatId && mainWorkspaceSelection.mainWorkspaceSurface.workspaceChatId === sourceChatId
            ? sourceChatLiveCommunityChatId
            : await getLiveLinkedCommunityChatId(mainWorkspaceSelection.mainWorkspaceSurface.workspaceChatId)
        )
        : null;
      const cachedCommunityChatIdHint = projectPresentation?.communityChatId
        ?? mainWorkspaceSelection.mainWorkspaceSurface?.persistedLinkedCommunityChatId
        ?? findCachedCommunityChatIdHint(existingPresentations);
      return {
        projectPresentation,
        existingPresentations,
        sourceChatLiveCommunityChatId,
        mainWorkspaceLiveCommunityChatId,
        cachedCommunityChatIdHint,
        mainWorkspaceSelection,
      };
    },
  };
}

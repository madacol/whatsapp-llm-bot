import { createWorkspaceBindingService } from "./workspace-binding-service.js";

/**
 * Backward-compatible wrapper around the dedicated workspace binding service.
 * @param {Parameters<typeof createWorkspaceBindingService>[0]} store
 * @param {string} chatId
 * @param {string | null | undefined} [explicitCwd]
 * @param {string | null | undefined} [chatName]
 * @returns {Promise<ResolvedChatBinding>}
 */
export async function resolveChatBinding(store, chatId, explicitCwd, chatName) {
  return createWorkspaceBindingService(store).resolveChatBinding(chatId, explicitCwd, chatName);
}

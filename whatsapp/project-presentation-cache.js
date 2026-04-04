/**
 * @typedef {{
 *   projectId: string,
 *   topologyKind: WhatsAppProjectTopologyKind,
 *   communityChatId: string | null,
 *   mainWorkspaceId: string | null,
 *   timestamp: string,
 * }} WhatsAppProjectPresentationCacheView
 */

/**
 * Read the persisted cache row through semantic field names so topology code
 * does not depend on storage-oriented column names.
 * @param {WhatsAppProjectPresentationCacheRow | null | undefined} row
 * @returns {WhatsAppProjectPresentationCacheView | null}
 */
export function readWhatsAppProjectPresentationCache(row) {
  if (!row) {
    return null;
  }
  return {
    projectId: row.project_id,
    topologyKind: row.cached_topology_kind,
    communityChatId: row.cached_community_chat_id,
    mainWorkspaceId: row.cached_main_workspace_id,
    timestamp: row.timestamp,
  };
}

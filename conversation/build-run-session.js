/**
 * Build the harness session payload from chat/runtime state.
 * @param {{
 *   chatId: string,
 *   senderIds: string[],
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   context: ExecuteActionContext,
 *   addMessage: Session["addMessage"],
 *   updateToolMessage: Session["updateToolMessage"],
 *   saveHarnessSession: import("../store.js").Store["saveHarnessSession"],
 * }} input
 * @returns {Session}
 */
export function buildRunSession({
  chatId,
  senderIds,
  chatInfo,
  context,
  addMessage,
  updateToolMessage,
  saveHarnessSession,
}) {
  return {
    chatId,
    senderIds,
    context,
    addMessage,
    updateToolMessage,
    harnessSession: chatInfo?.harness_session_id && chatInfo?.harness_session_kind
      ? { id: chatInfo.harness_session_id, kind: chatInfo.harness_session_kind }
      : null,
    saveHarnessSession,
  };
}

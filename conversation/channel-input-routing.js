/**
 * @typedef {{
 *   type: "archived-workspace-error"
 * } | {
 *   type: "bang-command"
 * } | {
 *   type: "disabled-slash-command"
 * } | {
 *   type: "slash-command"
 * } | {
 *   type: "pending-followup",
 *   shouldRespond: boolean,
 * } | {
 *   type: "persist-only"
 * } | {
 *   type: "agent-invocation"
 * }} ChannelInputRouteDecision
 */

/**
 * @param {ResolvedChatBinding} binding
 * @param {string | null | undefined} firstText
 * @returns {boolean}
 */
function isArchivedWorkspaceCodingRequest(binding, firstText) {
  return binding.kind === "workspace"
    && binding.workspace.status === "archived"
    && typeof firstText === "string"
    && !firstText.startsWith("!")
    && !firstText.startsWith("/");
}

/**
 * Decide the semantic route for one normalized ChannelInput.
 *
 * This module intentionally owns only policy vocabulary. Persistence, command
 * execution, and agent invocation execution stay in the runner.
 * @param {{
 *   chatInfo: Pick<import("../store.js").ChatRow, "is_enabled"> | undefined,
 *   resolvedBinding: ResolvedChatBinding,
 *   firstText: string | null | undefined,
 *   hasPendingRun: boolean,
 *   shouldRespond: boolean,
 * }} input
 * @returns {ChannelInputRouteDecision}
 */
export function decideChannelInputRoute({
  chatInfo,
  resolvedBinding,
  firstText,
  hasPendingRun,
  shouldRespond,
}) {
  if (isArchivedWorkspaceCodingRequest(resolvedBinding, firstText)) {
    return { type: "archived-workspace-error" };
  }

  if (firstText?.startsWith("!")) {
    return { type: "bang-command" };
  }

  const isSlashCommand = firstText?.startsWith("/") ?? false;
  if (isSlashCommand && !chatInfo?.is_enabled) {
    return { type: "disabled-slash-command" };
  }

  if (!isSlashCommand && hasPendingRun) {
    return { type: "pending-followup", shouldRespond };
  }

  if (isSlashCommand) {
    return { type: "slash-command" };
  }

  if (!shouldRespond) {
    return { type: "persist-only" };
  }

  return { type: "agent-invocation" };
}

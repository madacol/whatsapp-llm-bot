/**
 * Compatibility entry point for Codex event normalization.
 *
 * Transport-specific normalization now lives in dedicated modules:
 * - SDK event parsing: `codex-sdk-events.js`
 * - App Server event parsing: `codex-app-server-events.js`
 */

export { extractCodexText } from "./codex-event-utils.js";
export { decodeCodexAppServerNotification, normalizeCodexAppServerEvent } from "./codex-app-server-events.js";
export {
  extractCodexSessionId,
  normalizeCodexEvent,
} from "./codex-sdk-events.js";

/**
 * @typedef {{
 *   command: string,
 *   status: "started" | "completed" | "failed",
 *   output?: string,
 * }} CodexCommandEvent
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   arguments: Record<string, unknown>,
 *   status: "started" | "completed" | "failed",
 *   output?: string,
 * }} CodexToolEvent
 */

/**
 * @typedef {{
 *   path: string,
 *   summary?: string,
 *   diff?: string,
 *   kind?: "add" | "delete" | "update",
 *   itemId?: string,
 *   stage?: "proposed" | "denied" | "applied" | "failed",
 *   oldText?: string,
 *   newText?: string,
 * }} CodexFileChangeEvent
 */

/**
 * @typedef {{
 *   itemId: string,
 *   status: "started" | "completed" | "failed",
 *   changes: CodexFileChangeEvent[],
 * }} CodexFileChangeLifecycleEvent
 */

/**
 * @typedef {{
 *   itemId?: string,
 *   status: "started" | "updated" | "completed",
 *   summarySnapshot?: string[],
 *   contentSnapshot?: string[],
 *   summaryDelta?: { index: number, text: string },
 *   contentDelta?: { index: number, text: string },
 *   hasEncryptedContent?: boolean,
 * }} CodexReasoningEvent
 */

/**
 * @typedef {{
 *   text: string,
 *   status: "completed" | "in_progress" | "pending" | "unknown",
 * }} CodexPlanEntry
 */

/**
 * @typedef {{
 *   explanation: string | null,
 *   entries: CodexPlanEntry[],
 * }} CodexPlanState
 */

/**
 * @typedef {{
 *   sessionId: string | null,
 *   usage?: HarnessUsage,
 *   failureMessage?: string,
 *   threadEvent?: CodexThreadEvent,
 *   commandEvent?: CodexCommandEvent,
 *   toolEvent?: CodexToolEvent,
 *   subagentResponses?: CodexSubagentResponseEvent[],
 *   reasoningEvent?: CodexReasoningEvent,
 *   assistantText?: string,
 *   contentBlocks?: ToolContentBlock[],
 *   plan?: CodexPlanState,
 *   fileChange?: CodexFileChangeEvent,
 *   fileChanges?: CodexFileChangeEvent[],
 *   fileChangeLifecycle?: CodexFileChangeLifecycleEvent,
 * }} NormalizedCodexEvent
 */

/**
 * @typedef {{
 *   kind: "semantic",
 *   event: NormalizedCodexEvent,
 * } | {
 *   kind: "ignored",
 *   reason: "turn-lifecycle",
 *   event: NormalizedCodexEvent,
 * } | {
 *   kind: "unknown",
 *   summary: Record<string, unknown>,
 * } | {
 *   kind: "invalid",
 *   summary: Record<string, unknown>,
 * }} CodexAppServerNotificationDecode
 */

/**
 * @typedef {{
 *   id: string,
 *   kind: "subagent",
 *   parentThreadId?: string,
 *   agentNickname?: string,
 *   agentRole?: string,
 * }} CodexThreadEvent
 */

/**
 * @typedef {{
 *   threadId?: string,
 *   text: string,
 * }} CodexSubagentResponseEvent
 */

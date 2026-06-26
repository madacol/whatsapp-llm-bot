/**
 * @typedef {"claude" | "codex" | "pi" | string} HarnessRuntimeProvider
 */

/**
 * @typedef {{
 *   providerTurnId?: string,
 *   providerItemId?: string,
 *   providerRequestId?: string,
 * }} HarnessRuntimeProviderRefs
 */

/**
 * @typedef {{
 *   source?: "acp.jsonrpc" | "codex.app-server.notification" | "codex.app-server.request" | "claude.sdk.message" | "pi.sdk.message" | string,
 *   method?: string,
 *   messageType?: string,
 *   payload?: unknown,
 * } & Record<string, unknown>} HarnessRuntimeRawEvent
 */

/**
 * Diagnostic payload accepted at producer/adapter seams. This is not part of
 * canonical runtime events; dispatchers may log it and must drop it before
 * app-facing hooks or OutboundEvents see the event.
 * @typedef {{
 *   diagnosticRaw?: HarnessRuntimeRawEvent,
 * }} HarnessRuntimeDiagnosticInput
 */

/**
 * @typedef {{
 *   eventId?: string,
 *   createdAt?: string,
 *   providerInstanceId?: string,
 *   turnId?: string,
 *   requestId?: string,
 *   providerRefs?: HarnessRuntimeProviderRefs,
 * }} HarnessRuntimeEventEnvelope
 */

/**
 * @typedef {{
 *   promptTokens: number,
 *   completionTokens: number,
 *   cachedTokens: number,
 *   cost: number,
 *   totalTokens?: number,
 *   reasoningTokens?: number,
 *   contextWindow?: number,
 * }} HarnessRuntimeUsage
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   arguments: Record<string, unknown>,
 *   output?: string,
 *   outputBlocks?: ToolContentBlock[],
 *   permissions?: PermissionFlags,
 *   suppressProgress?: boolean,
 *   subagent?: LlmResponseMetadata,
 * }} HarnessRuntimeTool
 */

/**
 * @typedef {{
 *   chatId: string,
 *   harnessName: string,
 *   instanceId: string,
 *   status: "starting" | "ready" | "running" | "stopped" | "error",
 *   workdir?: string | null,
 *   model?: string | null,
 *   resumeCursor?: string | null,
 *   capabilities?: HarnessCapabilities,
 * }} HarnessRuntimeSession
 */

/**
 * @typedef {{
 *   id: string,
 *   chatId: string,
 *   status?: "started" | "completed" | "failed" | "cancelled" | "interrupted",
 * }} HarnessRuntimeTurn
 */

/**
 * @typedef {{
 *   id: string,
 *   kind: "command" | "file-read" | "file-change" | "tool-user-input" | "unknown",
 *   summary?: string,
 *   detail?: string,
 * }} HarnessRuntimeRequest
 */

/**
 * @typedef {{
 *   id: string,
 *   kind: "assistant" | "reasoning" | "tool" | "file" | "unknown",
 *   text?: string,
 * }} HarnessRuntimeItem
 */

/**
 * @typedef {{
 *   id: string,
 *   questions: Array<{ id: string, question: string, options: Array<{ label: string, description?: string }> }>,
 * }} HarnessRuntimeUserInputRequest
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "session.started" | "session.updated" | "session.stopped",
 *   provider: HarnessRuntimeProvider,
 *   session: HarnessRuntimeSession,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeSessionEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "turn.started" | "turn.completed",
 *   provider: HarnessRuntimeProvider,
 *   turn: HarnessRuntimeTurn,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeTurnEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "request.opened" | "request.resolved",
 *   provider: HarnessRuntimeProvider,
 *   request: HarnessRuntimeRequest,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeRequestEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "user-input.requested" | "user-input.resolved",
 *   provider: HarnessRuntimeProvider,
 *   request: HarnessRuntimeUserInputRequest,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeUserInputEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "item.started" | "item.updated" | "item.completed",
 *   provider: HarnessRuntimeProvider,
 *   item: HarnessRuntimeItem,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeItemEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "content.delta",
 *   provider: HarnessRuntimeProvider,
 *   itemId: string,
 *   text: string,
 *   displayText?: string,
 *   contentType: "text" | "markdown",
 *   notify?: boolean,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeContentDeltaEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "extension.notification" | "extension.request",
 *   provider: HarnessRuntimeProvider,
 *   method: string,
 *   payload: unknown,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeExtensionEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "file-change.completed",
 *   provider: HarnessRuntimeProvider,
 *   change: Parameters<Required<AgentIOHooks>["onFileChange"]>[0] & { cwd?: string | null },
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeFileChangeEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "reasoning.started" | "reasoning.updated" | "reasoning.completed",
 *   provider: HarnessRuntimeProvider,
 *   status: "started" | "updated" | "completed",
 *   text: string,
 *   summaryParts?: string[],
 *   contentParts?: string[],
 *   appendMode?: "delta" | "part",
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeReasoningEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "tool.started" | "tool.updated" | "tool.completed" | "tool.failed",
 *   provider: HarnessRuntimeProvider,
 *   tool: HarnessRuntimeTool,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeToolEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "command.started" | "command.completed" | "command.failed",
 *   provider: HarnessRuntimeProvider,
 *   command: { command: string, status: "started" | "completed" | "failed", output?: string },
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeCommandEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "assistant.completed",
 *   provider: HarnessRuntimeProvider,
 *   text: string,
 *   displayText?: string,
 *   contentType: "text" | "markdown",
 *   responseMode?: "replace" | "append" | "none",
 *   notify?: boolean,
 *   usage?: HarnessRuntimeUsage,
 *   usageMode?: "replace" | "add",
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeAssistantCompletedEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "subagent.completed",
 *   provider: HarnessRuntimeProvider,
 *   text: string,
 *   metadata?: LlmResponseMetadata,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeSubagentCompletedEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "plan.updated",
 *   provider: HarnessRuntimeProvider,
 *   plan: {
 *     explanation?: string | null,
 *     entries: Array<{ text: string, status: "completed" | "in_progress" | "pending" | "unknown" }>,
 *   },
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimePlanUpdatedEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "usage.updated",
 *   provider: HarnessRuntimeProvider,
 *   usage: HarnessRuntimeUsage,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeUsageEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "model.rerouted",
 *   provider: HarnessRuntimeProvider,
 *   fromModel?: string,
 *   toModel?: string,
 *   reason?: string,
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeModelReroutedEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "config.warning" | "runtime.warning" | "runtime.error",
 *   provider: HarnessRuntimeProvider,
 *   summary?: string,
 *   message?: string,
 *   details?: string,
 *   path?: string,
 *   class?: "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown",
 * } & HarnessRuntimeEventEnvelope} HarnessRuntimeDiagnosticEvent
 */

/**
 * @typedef {(
 *   HarnessRuntimeSessionEvent
 *   | HarnessRuntimeTurnEvent
 *   | HarnessRuntimeRequestEvent
 *   | HarnessRuntimeUserInputEvent
 *   | HarnessRuntimeItemEvent
 *   | HarnessRuntimeContentDeltaEvent
 *   | HarnessRuntimeExtensionEvent
 *   | HarnessRuntimeFileChangeEvent
 *   | HarnessRuntimeReasoningEvent
 *   | HarnessRuntimeToolEvent
 *   | HarnessRuntimeCommandEvent
 *   | HarnessRuntimeAssistantCompletedEvent
 *   | HarnessRuntimeSubagentCompletedEvent
 *   | HarnessRuntimePlanUpdatedEvent
 *   | HarnessRuntimeUsageEvent
 *   | HarnessRuntimeModelReroutedEvent
 *   | HarnessRuntimeDiagnosticEvent
 * )} HarnessRuntimeEvent
 */

/**
 * @typedef {HarnessRuntimeEvent & HarnessRuntimeDiagnosticInput} HarnessRuntimeEventInput
 */

let nextRuntimeEventId = 1;

/**
 * @returns {string}
 */
function createRuntimeEventId() {
  const id = nextRuntimeEventId;
  nextRuntimeEventId += 1;
  return `harness-event-${id}`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown> | undefined} raw
 * @returns {HarnessRuntimeRawEvent | undefined}
 */
function normalizeRawEvent(raw) {
  if (!raw) {
    return undefined;
  }
  if ("source" in raw || "method" in raw || "payload" in raw || "messageType" in raw) {
    return /** @type {HarnessRuntimeRawEvent} */ ({ ...raw });
  }
  return {
    source: "unknown",
    payload: raw,
  };
}

/**
 * @param {HarnessRuntimeEventInput | ({ type: string, provider: string } & Record<string, unknown>)} event
 * @returns {HarnessRuntimeEvent}
 */
function normalizeRuntimeEventPayload(event) {
  const canonicalEvent = /** @type {Record<string, unknown>} */ ({ ...event });
  delete canonicalEvent.raw;
  delete canonicalEvent.diagnosticRaw;
  return /** @type {HarnessRuntimeEvent} */ (canonicalEvent);
}

/**
 * Normalize provider events at the boundary so subscribers can rely on routing
 * and debugging metadata even when individual adapters emit lean events.
 * @param {HarnessRuntimeEventInput | ({ type: string, provider: string } & Record<string, unknown>)} event
 * @param {Partial<HarnessRuntimeEventEnvelope> & HarnessRuntimeDiagnosticInput} [defaults]
 * @returns {HarnessRuntimeEvent & Required<Pick<HarnessRuntimeEventEnvelope, "eventId" | "createdAt">>}
 */
export function normalizeHarnessRuntimeEvent(event, defaults = {}) {
  const normalizedEvent = normalizeRuntimeEventPayload(event);
  return /** @type {HarnessRuntimeEvent & Required<Pick<HarnessRuntimeEventEnvelope, "eventId" | "createdAt">>} */ ({
    ...normalizedEvent,
    eventId: typeof normalizedEvent.eventId === "string"
      ? normalizedEvent.eventId
      : typeof defaults.eventId === "string" ? defaults.eventId : createRuntimeEventId(),
    createdAt: typeof normalizedEvent.createdAt === "string"
      ? normalizedEvent.createdAt
      : typeof defaults.createdAt === "string" ? defaults.createdAt : new Date().toISOString(),
    ...(typeof normalizedEvent.providerInstanceId === "string"
      ? { providerInstanceId: normalizedEvent.providerInstanceId }
      : typeof defaults.providerInstanceId === "string" ? { providerInstanceId: defaults.providerInstanceId } : {}),
    ...(typeof normalizedEvent.turnId === "string"
      ? { turnId: normalizedEvent.turnId }
      : typeof defaults.turnId === "string" ? { turnId: defaults.turnId } : {}),
    ...(typeof normalizedEvent.requestId === "string"
      ? { requestId: normalizedEvent.requestId }
      : typeof defaults.requestId === "string" ? { requestId: defaults.requestId } : {}),
    ...(normalizedEvent.providerRefs
      ? { providerRefs: normalizedEvent.providerRefs }
      : defaults.providerRefs ? { providerRefs: defaults.providerRefs } : {}),
  });
}

/**
 * @param {HarnessRuntimeDiagnosticInput} event
 * @param {HarnessRuntimeDiagnosticInput} [defaults]
 * @returns {HarnessRuntimeRawEvent | undefined}
 */
export function getHarnessRuntimeDiagnosticRaw(event, defaults = {}) {
  return isRecord(event.diagnosticRaw)
    ? normalizeRawEvent(event.diagnosticRaw)
    : normalizeRawEvent(defaults.diagnosticRaw);
}

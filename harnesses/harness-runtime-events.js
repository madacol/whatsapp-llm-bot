/**
 * @typedef {"app" | "claude-agent-sdk" | "codex" | "pi" | string} HarnessRuntimeProvider
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
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeSessionEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "turn.started" | "turn.completed",
 *   provider: HarnessRuntimeProvider,
 *   turn: HarnessRuntimeTurn,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeTurnEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "request.opened" | "request.resolved",
 *   provider: HarnessRuntimeProvider,
 *   request: HarnessRuntimeRequest,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeRequestEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "user-input.requested" | "user-input.resolved",
 *   provider: HarnessRuntimeProvider,
 *   request: HarnessRuntimeUserInputRequest,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeUserInputEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "item.started" | "item.updated" | "item.completed",
 *   provider: HarnessRuntimeProvider,
 *   item: HarnessRuntimeItem,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeItemEvent
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
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeContentDeltaEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "extension.notification" | "extension.request",
 *   provider: HarnessRuntimeProvider,
 *   method: string,
 *   payload: unknown,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeExtensionEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "file-change.completed",
 *   provider: HarnessRuntimeProvider,
 *   change: Parameters<Required<AgentIOHooks>["onFileChange"]>[0],
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeFileChangeEvent
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
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeReasoningEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "tool.started" | "tool.updated" | "tool.completed" | "tool.failed",
 *   provider: HarnessRuntimeProvider,
 *   tool: HarnessRuntimeTool,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeToolEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "command.started" | "command.completed" | "command.failed",
 *   provider: HarnessRuntimeProvider,
 *   command: Parameters<Required<AgentIOHooks>["onCommand"]>[0],
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeCommandEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "file-read.started",
 *   provider: HarnessRuntimeProvider,
 *   fileRead: Parameters<Required<AgentIOHooks>["onFileRead"]>[0],
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeFileReadEvent
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
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeAssistantCompletedEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "subagent.completed",
 *   provider: HarnessRuntimeProvider,
 *   text: string,
 *   metadata?: LlmResponseMetadata,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeSubagentCompletedEvent
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
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimePlanUpdatedEvent
 */

/**
 * @typedef {{
 *   chatId?: string,
 *   type: "usage.updated",
 *   provider: HarnessRuntimeProvider,
 *   usage: HarnessRuntimeUsage,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeUsageEvent
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
 *   | HarnessRuntimeFileReadEvent
 *   | HarnessRuntimeAssistantCompletedEvent
 *   | HarnessRuntimeSubagentCompletedEvent
 *   | HarnessRuntimePlanUpdatedEvent
 *   | HarnessRuntimeUsageEvent
 * )} HarnessRuntimeEvent
 */

export {};

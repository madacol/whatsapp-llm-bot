/**
 * @typedef {"native" | "claude-agent-sdk" | "codex" | "pi" | string} HarnessRuntimeProvider
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
 *   questions: Array<{ id: string, question: string, options: Array<{ label: string, description?: string }> }>,
 * }} HarnessRuntimeUserInputRequest
 */

/**
 * @typedef {{
 *   type: "session.started" | "session.updated" | "session.stopped",
 *   provider: HarnessRuntimeProvider,
 *   session: HarnessRuntimeSession,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeSessionEvent
 */

/**
 * @typedef {{
 *   type: "turn.started" | "turn.completed",
 *   provider: HarnessRuntimeProvider,
 *   turn: HarnessRuntimeTurn,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeTurnEvent
 */

/**
 * @typedef {{
 *   type: "request.opened" | "request.resolved",
 *   provider: HarnessRuntimeProvider,
 *   request: HarnessRuntimeRequest,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeRequestEvent
 */

/**
 * @typedef {{
 *   type: "user-input.requested" | "user-input.resolved",
 *   provider: HarnessRuntimeProvider,
 *   request: HarnessRuntimeUserInputRequest,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeUserInputEvent
 */

/**
 * @typedef {{
 *   type: "file-change.completed",
 *   provider: HarnessRuntimeProvider,
 *   change: Parameters<Required<AgentIOHooks>["onFileChange"]>[0],
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeFileChangeEvent
 */

/**
 * @typedef {{
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
 *   type: "tool.started" | "tool.updated" | "tool.completed" | "tool.failed",
 *   provider: HarnessRuntimeProvider,
 *   tool: HarnessRuntimeTool,
 *   raw?: Record<string, unknown>,
 * }} HarnessRuntimeToolEvent
 */

/**
 * @typedef {{
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
 *   | HarnessRuntimeFileChangeEvent
 *   | HarnessRuntimeReasoningEvent
 *   | HarnessRuntimeToolEvent
 *   | HarnessRuntimeAssistantCompletedEvent
 *   | HarnessRuntimeUsageEvent
 * )} HarnessRuntimeEvent
 */

export {};

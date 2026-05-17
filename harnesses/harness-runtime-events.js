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
 * }} HarnessRuntimeTool
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
 *   HarnessRuntimeReasoningEvent
 *   | HarnessRuntimeToolEvent
 *   | HarnessRuntimeAssistantCompletedEvent
 *   | HarnessRuntimeUsageEvent
 * )} HarnessRuntimeEvent
 */

export {};

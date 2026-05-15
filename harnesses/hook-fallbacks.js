import { createLogger } from "../logger.js";
import { errorToString } from "../utils.js";

const log = createLogger("harness:hook-fallbacks");

/**
 * Log a suppressed hook error, distinguishing connection errors from others.
 * @param {string} hookName
 * @param {unknown} err
 */
function logSuppressedHookError(hookName, err) {
  const msg = errorToString(err);
  const isConnectionErr = msg.includes("Connection Closed") || msg.includes("Connection was lost");
  if (isConnectionErr) {
    log.warn(`Hook "${hookName}" failed (suppressed):`, msg);
  } else {
    log.error(`Hook "${hookName}" failed (suppressed):`, err);
  }
}

/**
 * Run a hook safely: suppress errors and return the fallback value on failure.
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function safeHook(name, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logSuppressedHookError(name, err);
    return fallback;
  }
}

/**
 * Wrap every hook so that a WhatsApp send failure (e.g. "Connection Closed")
 * doesn't kill the entire SDK query loop. Each hook has an explicit fallback
 * matching its return type contract.
 * @param {Required<AgentIOHooks>} rawHooks
 * @returns {Required<AgentIOHooks>}
 */
export function wrapHooksWithFallbacks(rawHooks) {
  return {
    onComposing: () => safeHook("onComposing", () => rawHooks.onComposing(), undefined),
    onPaused: () => safeHook("onPaused", () => rawHooks.onPaused(), undefined),
    onReasoning: (/** @type {{ status: "started" | "updated" | "completed", itemId?: string, summaryParts: string[], contentParts: string[], text?: string, hasEncryptedContent?: boolean }} */ event) =>
      safeHook("onReasoning", () => rawHooks.onReasoning(event), undefined),
    onLlmResponse: (/** @type {string} */ text) => safeHook("onLlmResponse", () => rawHooks.onLlmResponse(text), undefined),
    onAskUser: (/** @type {string} */ question, /** @type {string[]} */ options, /** @type {string | undefined} */ preamble, /** @type {string[] | undefined} */ descriptions) =>
      safeHook("onAskUser", () => rawHooks.onAskUser(question, options, preamble, descriptions), ""),
    onToolCall: (
      /** @type {LlmChatResponse['toolCalls'][0]} */ toolCall,
      /** @type {((params: Record<string, any>) => string) | undefined} */ formatToolCall,
      /** @type {{ oldContent?: string } | undefined} */ toolContext,
    ) =>
      safeHook("onToolCall", () => rawHooks.onToolCall(toolCall, formatToolCall, toolContext), undefined),
    onToolComplete: (/** @type {LlmChatResponse['toolCalls'][0]} */ toolCall) =>
      safeHook("onToolComplete", () => rawHooks.onToolComplete(toolCall), undefined),
    onToolResult: (/** @type {ToolContentBlock[]} */ blocks, /** @type {string} */ toolName, /** @type {PermissionFlags} */ permissions) =>
      safeHook("onToolResult", () => rawHooks.onToolResult(blocks, toolName, permissions), undefined),
    onToolError: (/** @type {string} */ error) => safeHook("onToolError", () => rawHooks.onToolError(error), undefined),
    onCommand: (/** @type {{ command: string, status: "started" | "completed" | "failed", output?: string }} */ event) =>
      safeHook("onCommand", () => rawHooks.onCommand(event), undefined),
    onFileRead: (/** @type {{ command: string, paths: string[] }} */ event) =>
      safeHook("onFileRead", () => rawHooks.onFileRead(event), undefined),
    onPlan: (/** @type {import("../plan-presentation.js").PlanPresentation} */ presentation) =>
      safeHook("onPlan", () => rawHooks.onPlan(presentation), undefined),
    onFileChange: (/** @type {{
      path: string,
      summary?: string,
      diff?: string,
      kind?: "add" | "delete" | "update",
      itemId?: string,
      stage?: "proposed" | "denied" | "applied" | "failed",
      oldText?: string,
      newText?: string,
    }} */ event) =>
      safeHook("onFileChange", () => rawHooks.onFileChange(event), undefined),
    onContinuePrompt: () => safeHook("onContinuePrompt", () => rawHooks.onContinuePrompt(), true),
    onDepthLimit: () => safeHook("onDepthLimit", () => rawHooks.onDepthLimit(), false),
    onUsage: (/** @type {string} */ cost, /** @type {UsageTokens} */ tokens) =>
      safeHook("onUsage", () => rawHooks.onUsage(cost, tokens), undefined),
  };
}

/**
 * Native harness — the original processLlmResponse loop extracted from index.js.
 */

import { sendChatCompletion } from "../llm.js";
import { createToolMessage, isHtmlContent } from "../utils.js";
import {
  actionsToToolDefinitions,
  registerMedia,
  isMediaBlock,
  parseStructuredQuestion,
} from "../message-formatting.js";
import { getRootDb } from "../db.js";
import { storeLlmContext } from "../context-log.js";
import { storeAndLinkHtml } from "../html-store.js";
import { recordUsage, resolveCost } from "../usage-tracker.js";
import { createLogger } from "../logger.js";

const log = createLogger("harness:native");

export const MAX_TOOL_CALL_DEPTH = 10;

/** @type {Required<AgentIOHooks>} */
export const NO_OP_HOOKS = {
  onLlmResponse: async () => {},
  onAskUser: async () => "",
  onToolCall: async () => {},
  onToolResult: async (_blocks, _name, _perms) => {},
  onToolResultCapture: () => {},
  onToolError: async () => {},
  onContinuePrompt: async () => true,
  onDepthLimit: async () => false,
  onUsage: async () => {},
};

/**
 * Parse tool call arguments from JSON string, with error fallback.
 * @param {string} argsString
 * @returns {Record<string, unknown>}
 */
export function parseToolArgs(argsString) {
  try {
    return JSON.parse(argsString || "{}");
  } catch {
    log.error("Failed to parse tool call arguments:", argsString);
    return {};
  }
}

/**
 * Execute a single tool call: run action, store result, display to user.
 * Returns the autoContinue value from the action's permissions.
 * @param {{
 *   session: Session,
 *   llmConfig: LlmConfig,
 *   toolCall: LlmChatResponse['toolCalls'][0],
 *   messages: Message[],
 *   mediaRegistry: MediaRegistry,
 *   hooks: Required<AgentIOHooks>,
 *   agentDepth?: number,
 * }} params
 * @returns {Promise<boolean | undefined>} The autoContinue value
 */
async function executeAndStoreTool({
  session, llmConfig, toolCall, messages, mediaRegistry, hooks, agentDepth,
}) {
  const { chatId, context, updateToolMessage } = session;
  const { executeActionFn, actionResolver, actionLlmClient } = llmConfig;
  const toolName = toolCall.name;
  const toolArgs = parseToolArgs(toolCall.arguments);
  log.debug("executing", toolName, toolArgs);

  /** Replace the stub in the messages array and persist to DB. */
  const replaceStub = async (/** @type {ToolMessage} */ toolMessage) => {
    await updateToolMessage(chatId, toolCall.id, toolMessage);
    const idx = messages.findIndex(
      m => m.role === "tool" && /** @type {ToolMessage} */ (m).tool_id === toolCall.id,
    );
    if (idx !== -1) messages[idx] = toolMessage;
  };

  try {
    // Resolve _media_refs: pull referenced media from the registry into context.content
    const { _media_refs, ...cleanArgs } = toolArgs;
    let actionContext = context;
    if (Array.isArray(_media_refs) && _media_refs.length > 0) {
      /** @type {IncomingContentBlock[]} */
      const resolvedMedia = [];
      for (const refId of _media_refs) {
        if (typeof refId !== "number") continue;
        const block = mediaRegistry.get(refId);
        if (block) resolvedMedia.push(block);
      }
      if (resolvedMedia.length > 0) {
        actionContext = { ...context, content: [...context.content, ...resolvedMedia] };
      }
    }

    const functionResponse = await executeActionFn(toolName, actionContext, cleanArgs, {
      toolCallId: toolCall.id, actionResolver, llmClient: actionLlmClient, updateToolMessage, agentDepth,
    });
    log.debug("response", functionResponse);

    const result = functionResponse.result;

    // HTML content → store page, send link, treat as text for LLM context
    if (isHtmlContent(result)) {
      const linkText = await storeAndLinkHtml(getRootDb(), result);

      const toolMessage = createToolMessage(toolCall.id, linkText);
      await replaceStub(toolMessage);
      await hooks.onToolResult([{ type: "text", text: linkText }], toolName, functionResponse.permissions);

      return !!functionResponse.permissions.autoContinue;
    }

    const isContentBlocks = Array.isArray(result)
      && result.length > 0
      && typeof result[0] === "object"
      && "type" in result[0];

    // Store tool result (silent tools get a stub to satisfy API pairing)
    /** @type {ToolMessage} */
    const toolMessage = {
      role: "tool",
      tool_id: toolCall.id,
      content: functionResponse.permissions.silent
        ? [{ type: "text", text: "[recalled prior messages]" }]
        : isContentBlocks
          ? /** @type {ToolContentBlock[]} */ (result)
          : [{ type: "text", text: JSON.stringify(result) }],
    };
    await replaceStub(toolMessage);

    // Tag media from tool results so subsequent tool calls can reference them
    if (isContentBlocks) {
      for (const block of /** @type {ToolContentBlock[]} */ (result)) {
        if (isMediaBlock(block)) {
          registerMedia(mediaRegistry, block);
        }
      }
    }

    /** @type {ToolContentBlock[]} */
    const displayBlocks = isContentBlocks
      ? /** @type {ToolContentBlock[]} */ (result)
      : [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }];

    await hooks.onToolResult(displayBlocks, toolName, functionResponse.permissions);

    return functionResponse.permissions.autoContinue;
  } catch (error) {
    log.error("Error executing tool:", error);
    const errorMessage = `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;

    const toolError = createToolMessage(toolCall.id, errorMessage);
    await replaceStub(toolError);

    await hooks.onToolError(errorMessage);

    // Errors always auto-continue for self-correction
    return true;
  }
}

/**
 * Process LLM responses, handling tool calls in a loop with depth guard.
 * @param {AgentHarnessParams} params
 * @returns {Promise<AgentResult>}
 */
async function processLlmResponse({ session, llmConfig, messages, mediaRegistry, hooks: userHooks, maxDepth, agentDepth }) {
  const { chatId, senderIds, addMessage } = session;
  const { llmClient, chatModel, actions } = llmConfig;
  const maxToolCallDepth = maxDepth ?? MAX_TOOL_CALL_DEPTH;
  /** @type {Required<AgentIOHooks>} */
  const hooks = { ...NO_OP_HOOKS, ...userHooks };
  let { systemPrompt } = llmConfig;
  if (mediaRegistry.size > 0) {
    systemPrompt += "\n\nMedia in the conversation is tagged with [media:N]. When calling tools that need media from earlier messages, pass the relevant IDs in the `_media_refs` parameter.";
  }
  const injectedActions = new Set();
  let depth = 0;

  /** @type {AgentResult} */
  const result = {
    response: [],
    messages,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
  };

  while (depth < maxToolCallDepth) {
    const response = await sendChatCompletion(llmClient, {
      model: chatModel,
      systemPrompt,
      messages,
      tools: actionsToToolDefinitions(actions, mediaRegistry.size > 0),
      mediaRegistry,
    });

    if (response.usage) {
      const { promptTokens: prompt, completionTokens: completion, cachedTokens: cached } = response.usage;
      const cost = await resolveCost(response.usage.cost, chatModel, prompt, completion);
      log.info(`[LLM usage] prompt=${prompt} cached=${cached} completion=${completion} cost=${cost} model=${chatModel}`);
      recordUsage(getRootDb(), { chatId, model: chatModel, promptTokens: prompt, completionTokens: completion, cachedTokens: cached, cost })
        .catch(err => log.error("[LLM usage] failed to persist:", err));
      result.usage.promptTokens += prompt;
      result.usage.completionTokens += completion;
      result.usage.cachedTokens += cached;
      if (cost !== null) result.usage.cost += cost;
    }

    /** @type {AssistantMessage} */
    const assistantMessage = { role: "assistant", content: [] };

    if (response.content) {
      log.debug("RESPONSE SENT:", response.content);
      const parsed = parseStructuredQuestion(response.content);
      if (parsed && parsed.options.length >= 2) {
        if (parsed.preamble) {
          await hooks.onLlmResponse(parsed.preamble);
        }
        const userChoice = await hooks.onAskUser(parsed.question, parsed.options, parsed.preamble);

        // Store the assistant message (with the question), add the user's
        // response, then skip tool calls and continue the LLM loop so the
        // model sees the answer.
        assistantMessage.content.push({ type: "text", text: response.content });
        result.response = [{ type: "markdown", text: response.content }];
        messages.push(assistantMessage);
        await addMessage(chatId, assistantMessage, senderIds);
        if (userChoice) {
          /** @type {UserMessage} */
          const userMsg = { role: "user", content: [{ type: "text", text: userChoice }] };
          messages.push(userMsg);
          // Message already persisted to DB by the interceptor in handleMessage
        }
        depth++;
        continue;
      } else {
        await hooks.onLlmResponse(response.content);
      }
      assistantMessage.content.push({ type: "text", text: response.content });
      result.response = [{ type: "markdown", text: response.content }];
    }

    if (response.toolCalls.length === 0) {
      if (result.usage.promptTokens > 0) {
        const costStr = result.usage.cost > 0 ? `$${result.usage.cost.toFixed(4)}` : "unknown";
        await hooks.onUsage(costStr, {
          prompt: result.usage.promptTokens,
          completion: result.usage.completionTokens,
          cached: result.usage.cachedTokens,
        });
      }
      messages.push(assistantMessage);
      const storedAssistant = await addMessage(chatId, assistantMessage, senderIds);
      if (depth === 0) {
        storeLlmContext(getRootDb(), storedAssistant.message_id, chatModel, systemPrompt, messages, actions);
      }
      return result;
    }

    // Record and display tool calls
    for (const toolCall of response.toolCalls) {
      assistantMessage.content.push({
        type: "tool",
        tool_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
      const action = actions.find(a => a.name === toolCall.name);
      await hooks.onToolCall(toolCall, action?.formatToolCall);
    }

    messages.push(assistantMessage);
    const storedAssistantWithTools = await addMessage(chatId, assistantMessage, senderIds);
    if (depth === 0) {
      storeLlmContext(getRootDb(), storedAssistantWithTools.message_id, chatModel, systemPrompt, messages, actions);
    }

    // Insert stubs for each tool call (timestamps anchored to assistant message)
    for (const toolCall of response.toolCalls) {
      const stub = createToolMessage(toolCall.id, `[executing ${toolCall.name}...]`);
      await addMessage(chatId, stub, senderIds);
      messages.push(stub);
    }

    // Execute each tool call
    let continueProcessing = true;
    for (const toolCall of response.toolCalls) {
      const shouldContinue = await executeAndStoreTool({
        session, llmConfig, toolCall, messages, mediaRegistry, hooks, agentDepth,
      });
      if (!shouldContinue) continueProcessing = false;
    }

    // Inject detailed instructions for newly-used actions into the system prompt
    for (const toolCall of response.toolCalls) {
      const name = toolCall.name;
      if (injectedActions.has(name)) continue;
      const action = actions.find(a => a.name === name);
      if (action?.instructions) {
        systemPrompt += `\n\n## ${action.name} instructions\n${action.instructions}`;
        injectedActions.add(name);
      }
    }

    if (!continueProcessing) {
      const confirmed = await hooks.onContinuePrompt();
      if (!confirmed) return result;
    }

    depth++;

    if (depth >= maxToolCallDepth) {
      const confirmed = await hooks.onDepthLimit();
      if (!confirmed) return result;
      depth = 0;
    }
  }

  return result;
}

/**
 * Create the native harness.
 * @returns {AgentHarness}
 */
export function createNativeHarness() {
  return { processLlmResponse };
}

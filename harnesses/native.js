/**
 * Native harness — the original run loop extracted from index.js.
 */

import { sendChatCompletion } from "../llm.js";
import { createToolMessage, isHtmlContent, errorToString } from "../utils.js";
import {
  actionsToToolDefinitions,
  resolveImageArgs,
  registerMedia,
  isMediaBlock,
  parseStructuredQuestion,
} from "../message-formatting.js";
import { getRootDb } from "../db.js";
import { storeLlmContext } from "../context-log.js";
import { existsSync, readFileSync } from "node:fs";
import { textUpdate, toolCallUpdate, toolInspectState } from "../outbound-events.js";
import { storeAndLinkHtml } from "../html-store.js";
import { recordUsage, resolveCost } from "../usage-tracker.js";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { createLogger } from "../logger.js";
import { handleHarnessSessionCommand } from "./session-commands.js";

const log = createLogger("harness:native");

export const MAX_TOOL_CALL_DEPTH = 10;

/** @type {HarnessCapabilities} */
const NATIVE_HARNESS_CAPABILITIES = {
  supportsResume: false,
  supportsCancel: false,
  supportsLiveInput: false,
  supportsApprovals: true,
  supportsWorkdir: true,
  supportsSandboxConfig: false,
  supportsModelSelection: false,
  supportsReasoningEffort: false,
  supportsSessionFork: false,
};

/** @type {Required<AgentIOHooks>} */
export const NO_OP_HOOKS = {
  onComposing: async () => {},
  onPaused: async () => {},
  onLlmResponse: async () => {},
  onAskUser: async () => "",
  onToolCall: async () => {},
  onToolResult: async (_blocks, _name, _perms) => {},
  onToolError: async () => {},
  onCommand: async () => {},
  onFileRead: async () => {},
  onPlan: async () => {},
  onFileChange: async () => {},
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
 * Try to edit the tool-call message in-place; swallow errors.
 * @param {MessageHandle | undefined} handle
 * @param {string} text
 * @param {string} toolName
 */
async function tryEdit(handle, text, toolName) {
  if (!handle) return;
  try { await handle.update(textUpdate(text)); }
  catch (err) { log.error(`Edit failed for ${toolName}:`, err); }
}

/**
 * Execute a single tool call: run action, store result, edit message in-place.
 * Returns the autoContinue value from the action's permissions.
 * @param {{
 *   session: Session,
 *   llmConfig: LlmConfig,
 *   toolCall: LlmChatResponse['toolCalls'][0],
 *   messages: Message[],
 *   mediaRegistry: MediaRegistry,
 *   hooks: Required<AgentIOHooks>,
 *   agentDepth?: number,
 *   handle?: MessageHandle,
 *   actionFormatToolCall?: (params: Record<string, any>) => string,
 *   workdir?: string | null,
 *   sandboxMode?: HarnessRunConfig["sandboxMode"] | null,
 * }} params
 * @returns {Promise<boolean | undefined>} The autoContinue value
 */
async function executeAndStoreTool({
  session, llmConfig, toolCall, messages, mediaRegistry, hooks, agentDepth,
  handle, actionFormatToolCall, workdir, sandboxMode,
}) {
  const { chatId, context, updateToolMessage } = session;
  const { toolRuntime } = llmConfig;
  const toolName = toolCall.name;
  const toolArgs = parseToolArgs(toolCall.arguments);
  log.debug("executing", toolName, toolArgs);

  // Compute display context for Edit line numbers
  /** @type {{ startLine?: number } | undefined} */
  let displayContext;
  if (toolName === "Edit" && typeof toolArgs.file_path === "string" && typeof toolArgs.old_string === "string") {
    try {
      if (existsSync(toolArgs.file_path)) {
        const fileContent = readFileSync(toolArgs.file_path, "utf-8");
        const idx = fileContent.indexOf(toolArgs.old_string);
        if (idx !== -1) {
          displayContext = { startLine: fileContent.slice(0, idx).split("\n").length };
        }
      }
    } catch { /* best-effort — display still works without line numbers */ }
  }

  const presentation = buildToolPresentation(
    toolName,
    toolArgs,
    actionFormatToolCall,
    workdir ?? null,
    displayContext,
  );

  /** Replace the stub in the messages array and persist to DB. */
  const replaceStub = async (/** @type {ToolMessage} */ toolMessage) => {
    await updateToolMessage(chatId, toolCall.id, toolMessage);
    const idx = messages.findIndex(
      m => m.role === "tool" && /** @type {ToolMessage} */ (m).tool_id === toolCall.id,
    );
    if (idx !== -1) messages[idx] = toolMessage;
  };

  /** Register 👁 react-to-inspect on the tool-call message handle. */
  const registerInspect = (/** @type {ToolMessage} */ toolMessage) => {
    if (handle) {
      const rawText = toolMessage.content
        .filter((block) => block.type === "text")
        .map((block) => /** @type {TextContentBlock} */ (block).text)
        .join("\n");
      handle.setInspect(toolInspectState(presentation, rawText || undefined));
    }
  };

  try {
    // Resolve image params: look up action schema, replace media refs with actual content blocks
    const tool = await toolRuntime.getTool(toolName);
    const resolvedArgs = tool
      ? resolveImageArgs(tool.parameters, toolArgs, mediaRegistry)
      : toolArgs;

    const functionResponse = await toolRuntime.executeTool(toolName, context, resolvedArgs, {
      toolCallId: toolCall.id,
      agentDepth,
      workdir: workdir ?? null,
      sandboxMode: sandboxMode ?? null,
    });
    log.debug("response", functionResponse);

    const result = functionResponse.result;

    // HTML content → store page, edit message with link
    if (isHtmlContent(result)) {
      const linkText = await storeAndLinkHtml(getRootDb(), result);

      const toolMessage = createToolMessage(toolCall.id, linkText);
      await replaceStub(toolMessage);
      await tryEdit(handle, linkText, toolName);
      registerInspect(toolMessage);

      return !!functionResponse.permissions.autoContinue;
    }

    const isContentBlocks = Array.isArray(result)
      && result.length > 0
      && typeof result[0] === "object"
      && "type" in result[0];

    /** @type {ToolMessage} */
    const toolMessage = {
      role: "tool",
      tool_id: toolCall.id,
      content: isContentBlocks
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

    // Edit tool-call message in-place with summary label
    if (handle) {
      await handle.update(toolCallUpdate(presentation));
    }

    // Register 👁 react-to-inspect for tool results
    registerInspect(toolMessage);

    // Display non-text content (images, videos); text results visible via react-to-inspect
    if (isContentBlocks) {
      const nonTextBlocks = /** @type {ToolContentBlock[]} */ (result).filter(b => b.type !== "text");
      if (nonTextBlocks.length > 0) {
        await hooks.onToolResult(nonTextBlocks, toolName, functionResponse.permissions);
      }
    }

    return functionResponse.permissions.autoContinue;
  } catch (error) {
    log.error("Error executing tool:", error);
    const errorMessage = `Error executing ${toolName}: ${errorToString(error)}`;

    const toolMessage = createToolMessage(toolCall.id, errorMessage);
    await replaceStub(toolMessage);
    await tryEdit(handle, `${toolName} — error`, toolName);
    registerInspect(toolMessage);
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
async function processLlmResponse({ session, llmConfig, messages, mediaRegistry, hooks: userHooks, maxDepth, agentDepth, runConfig }) {
  const { chatId, senderIds, addMessage } = session;
  const { llmClient, chatModel, toolRuntime } = llmConfig;
  const maxToolCallDepth = maxDepth ?? MAX_TOOL_CALL_DEPTH;
  const workdir = runConfig?.workdir ?? null;
  const tools = toolRuntime.listTools();
  /** @type {Required<AgentIOHooks>} */
  const hooks = { ...NO_OP_HOOKS, ...userHooks };
  let effectiveSystemPrompt = llmConfig.externalInstructions;
  if (mediaRegistry.size > 0) {
    effectiveSystemPrompt += '\n\nMedia in the conversation is tagged with [media:N]. When calling tools with image parameters, pass the media reference (e.g. "media:1") as the parameter value.';
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
    await hooks.onComposing();
    const response = await sendChatCompletion(llmClient, {
      model: chatModel,
      systemPrompt: effectiveSystemPrompt,
      messages,
      tools: actionsToToolDefinitions(tools, mediaRegistry.size > 0),
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
        storeLlmContext(getRootDb(), storedAssistant.message_id, chatModel, effectiveSystemPrompt, messages, tools);
      }
      return result;
    }

    // Record and display tool calls, capturing handles for in-place updates
    /** @type {Map<string, { handle?: MessageHandle, formatToolCall?: (params: Record<string, any>) => string }>} */
    const toolCallState = new Map();
    for (const toolCall of response.toolCalls) {
      assistantMessage.content.push({
        type: "tool",
        tool_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
      const tool = tools.find((entry) => entry.name === toolCall.name);
      const handle = await hooks.onToolCall(toolCall, tool?.formatToolCall);
      toolCallState.set(toolCall.id, { handle: handle ?? undefined, formatToolCall: tool?.formatToolCall });
    }

    messages.push(assistantMessage);
    const storedAssistantWithTools = await addMessage(chatId, assistantMessage, senderIds);
    if (depth === 0) {
      storeLlmContext(getRootDb(), storedAssistantWithTools.message_id, chatModel, effectiveSystemPrompt, messages, tools);
    }

    // Insert stubs for each tool call (timestamps anchored to assistant message)
    for (const toolCall of response.toolCalls) {
      const stub = createToolMessage(toolCall.id, `[executing ${toolCall.name}...]`);
      const state = toolCallState.get(toolCall.id);
      await addMessage(chatId, stub, senderIds, state?.handle?.keyId);
      messages.push(stub);
    }

    // Execute each tool call
    let continueProcessing = true;
    for (const toolCall of response.toolCalls) {
      await hooks.onComposing();
      const state = toolCallState.get(toolCall.id);
      const shouldContinue = await executeAndStoreTool({
        session, llmConfig, toolCall, messages, mediaRegistry, hooks, agentDepth,
        handle: state?.handle,
        actionFormatToolCall: state?.formatToolCall,
        workdir,
        sandboxMode: runConfig?.sandboxMode ?? "workspace-write",
      });
      if (!shouldContinue) continueProcessing = false;
    }

    // Inject detailed instructions for newly-used actions into the system prompt
    for (const toolCall of response.toolCalls) {
      const name = toolCall.name;
      if (injectedActions.has(name)) continue;
      const tool = tools.find((entry) => entry.name === name);
      if (tool?.instructions) {
        effectiveSystemPrompt += `\n\n## ${tool.name} instructions\n${tool.instructions}`;
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
 * Run a native harness turn through the unified harness contract.
 * @param {AgentHarnessParams} params
 * @returns {Promise<AgentResult>}
 */
async function run(params) {
  return processLlmResponse(params);
}

/**
 * Native does not currently own any slash commands.
 * @param {HarnessCommandContext} input
 * @returns {Promise<boolean>}
 */
async function handleCommand(input) {
  return handleHarnessSessionCommand({
    command: input.command,
    chatId: input.chatId,
    context: input.context,
    sessionControl: input.sessionControl,
  });
}

/**
 * @returns {SlashCommandDescriptor[]}
 */
function listSlashCommands() {
  return [
    { name: "clear", description: "Clear the current harness session" },
    { name: "resume", description: "Restore a previously cleared harness session" },
  ];
}

/**
 * Create the native harness.
 * @returns {AgentHarness}
 */
export function createNativeHarness() {
  return {
    getName: () => "native",
    getCapabilities: () => NATIVE_HARNESS_CAPABILITIES,
    run,
    handleCommand,
    listSlashCommands,
  };
}

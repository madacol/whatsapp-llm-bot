/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import { getActions, executeAction, getChatActions, getChatAction, getAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient, sendChatCompletion } from "./llm.js";
import { formatTime, isHtmlContent, createToolMessage } from "./utils.js";
import { connectToWhatsApp, sendBlocks } from "./whatsapp-adapter.js";
import { startReminderDaemon } from "./reminder-daemon.js";
import { startModelsCacheDaemon } from "./models-cache.js";
import { initStore } from "./store.js";
import {
  actionsToToolDefinitions,
  shouldRespond,
  formatUserMessage,
  parseCommandArgs,
  prepareMessages,
  registerMedia,
  isMediaBlock,
} from "./message-formatting.js";
import { convertUnsupportedMedia } from "./media-to-text.js";
import { resolveModel, ROLE_DEFINITIONS } from "./model-roles.js";
import { getAgent } from "./agents.js";
import { getRootDb } from "./db.js";
import {
  extractTextFromMessage,
  findMemories,
  formatMemoriesContext,
} from "./memory.js";
import { storeLlmContext } from "./context-log.js";
import { storeAndLinkHtml } from "./html-store.js";
import { startHtmlServer, stopHtmlServer } from "./html-server.js";
import { recordUsage, resolveCost } from "./usage-tracker.js";
import {
  loadPendingConfirmations,
  deletePendingConfirmation,
} from "./pending-confirmations.js";
import { createLogger } from "./logger.js";

const log = createLogger("index");

/**
 * Type guard: checks that an action has a command string.
 * @param {Action} a
 * @returns {a is Action & {command: string}}
 */
function hasCommand(a) {
  return typeof a.command === "string";
}

const MAX_TOOL_CALL_DEPTH = 10;

/** @type {Required<AgentIOHooks>} */
const NO_OP_HOOKS = {
  onLlmResponse: async () => {},
  onToolCall: async () => {},
  onToolResult: async (_blocks, _name, _perms) => {},
  onToolError: async () => {},
  onContinuePrompt: async () => true,
  onDepthLimit: async () => false,
  onUsage: async () => {},
};

/**
 * Display a tool call to the user (compact or verbose based on debug mode).
 * @param {LlmChatResponse['toolCalls'][0]} toolCall
 * @param {Pick<ExecuteActionContext, "send">} context
 * @param {boolean} isDebug
 * @param {((params: Record<string, any>) => string)} [formatToolCall] - Optional formatter from the action
 */
async function displayToolCall(toolCall, context, isDebug, formatToolCall) {
  let msg = isDebug ? `*${toolCall.name}*` : toolCall.name;
  const args = parseToolArgs(toolCall.arguments);

  if (formatToolCall) {
    msg += `: ${formatToolCall(args)}`;
  } else {
    const entries = Object.entries(args);
    if (entries.length > 0) {
      const inline = entries.map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return entries.length === 1 ? val : `${k}: ${val}`;
      }).join(", ");
      const maxLen = isDebug ? 120 : 80;
      if (inline.length <= maxLen) {
        msg += `: ${inline}`;
      } else if (isDebug) {
        msg += `\n${inline.slice(0, 200)}${inline.length > 200 ? "…" : ""}`;
      }
    }
  }

  await context.send("tool-call", msg);
}

/**
 * Display a tool result to the user (compact, verbose, or silent).
 * @param {ToolContentBlock[]} blocks - The result content blocks
 * @param {string} toolName - Name of the tool that produced the result
 * @param {Action['permissions']} permissions - Action permission flags
 * @param {Pick<ExecuteActionContext, "send" | "reply">} context
 * @param {boolean} isDebug
 */
async function displayToolResult(blocks, toolName, permissions, context, isDebug) {
  if (permissions.silent) return;

  if (isDebug) {
    const textSummary = blocks.filter(b => b.type === "text").map(b => /** @type {TextContentBlock} */ (b).text).join("\n");
    await context.send("tool-result", `${toolName}: ${textSummary || "Done."}`);
    const nonTextBlocks = blocks.filter(b => b.type !== "text");
    if (nonTextBlocks.length > 0) await context.send("tool-result", nonTextBlocks);
  } else if (permissions.autoContinue) {
    // autoContinue: suppress text, but still show media/code blocks
    const visualBlocks = blocks.filter(b => b.type !== "text");
    if (visualBlocks.length > 0) await context.send("tool-result", visualBlocks);
  } else {
    // Final answer: render all blocks
    await context.reply("tool-result", blocks);
  }
}

/**
 * Parse tool call arguments from JSON string, with error fallback.
 * @param {string} argsString
 * @returns {Record<string, unknown>}
 */
function parseToolArgs(argsString) {
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
 * - `true`: continue automatically
 * - `false`/`undefined`: ask user before continuing
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
 * @param {{
 *   session: Session,
 *   llmConfig: LlmConfig,
 *   messages: Message[],
 *   mediaRegistry: MediaRegistry,
 *   hooks?: AgentIOHooks,
 *   maxDepth?: number,
 *   agentDepth?: number,
 * }} params
 * @returns {Promise<AgentResult>}
 */
export async function processLlmResponse({ session, llmConfig, messages, mediaRegistry, hooks: userHooks, maxDepth, agentDepth }) {
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
      await hooks.onLlmResponse(response.content);
      assistantMessage.content.push({ type: "text", text: response.content });
      result.response = [{ type: "text", text: response.content }];
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
 * @typedef {import('./store.js').Store} Store
 *
 * @typedef {{
 *   store: Store,
 *   llmClient: LlmClient,
 *   getActionsFn: typeof getActions,
 *   executeActionFn: typeof executeAction,
 * }} MessageHandlerDeps
 */

/**
 * Create a message handler with injected dependencies.
 * @param {MessageHandlerDeps} deps
 * @returns {{ handleMessage: (messageContext: IncomingContext) => Promise<void> }}
 */
export function createMessageHandler({ store, llmClient, getActionsFn, executeActionFn }) {
  const { addMessage, updateToolMessage, createChat, getChat, getMessages } = store;

  /**
   * Handle incoming WhatsApp messages
   * @param {IncomingContext} messageContext
   * @returns {Promise<void>}
   */
  async function handleMessage(messageContext) {
    const { chatId, senderIds, content, isGroup, senderName, selfIds, quotedSenderId } = messageContext;

    log.debug("INCOMING MESSAGE:", JSON.stringify(messageContext, null, 2));

    // Ensure chat exists in DB for both command and message paths
    await createChat(chatId);

    // Compute debug state before building context so it's immutable
    const chatInfo = await getChat(chatId);
    const isDebug = !!chatInfo?.debug_until && new Date(chatInfo.debug_until) > new Date();

    /** @type {ExecuteActionContext} */
    const context = {
      chatId,
      senderIds,
      content,
      getIsAdmin: messageContext.getIsAdmin,
      send: messageContext.send,
      reply: messageContext.reply,
      reactToMessage: messageContext.reactToMessage,
      sendPoll: messageContext.sendPoll,
      confirm: messageContext.confirm,
    };

    // Load actions (global + chat-scoped), filtering out opt-in actions not enabled for this chat.
    // Deduplicate by name — chat-scoped actions override global ones.
    const globalActions = await getActionsFn();
    const chatActions = await getChatActions(chatId);
    const chatActionNames = new Set(chatActions.map(a => a.name));
    const enabledActions = chatInfo?.enabled_actions ?? [];
    /** @type {Action[]} */
    const actions = [
      ...globalActions.filter(a => !chatActionNames.has(a.name)),
      ...chatActions,
    ].filter(
      (a) => !a.optIn || enabledActions.includes(a.name),
    );

    /** @param {string} name */
    const actionResolver = async (name) => {
      const chatAction = await getChatAction(chatId, name);
      if (chatAction) return chatAction;
      return getAction(name);
    };

    const firstBlock = content.find(block=>block.type === "text")

    if (firstBlock?.text?.startsWith("!")) {
      const inputText = firstBlock.text.slice(1).trim();
      const commandText = inputText.toLowerCase();

      // Sort commands longest-first so "set model" matches before hypothetical "set"
      const commandActions = actions.filter(hasCommand);
      const action = commandActions
        .sort((a, b) => b.command.length - a.command.length)
        .find(a => commandText === a.command || commandText.startsWith(a.command + " "));

      if (!action) {
        await context.reply("error", `Unknown command: ${commandText.split(" ")[0]}`);
        return;
      }

      // Store the command message so the LLM has context about recent commands
      /** @type {UserMessage} */
      const cmdMessage = { role: "user", content };
      await addMessage(chatId, cmdMessage, senderIds);

      const argsText = inputText.slice(action.command.length).trim();
      const args = argsText ? argsText.split(" ") : [];

      // Map command arguments to action parameters
      const params = parseCommandArgs(args, action.parameters);

      log.debug("executing", action.name, params);

      try {
        const { result } = await executeActionFn(action.name, context, params, { actionResolver, llmClient });

        if (isHtmlContent(result)) {
          const linkText = await storeAndLinkHtml(getRootDb(), result);
          await context.reply("tool-result", linkText);
        } else if (typeof result === "string") {
          await context.reply("tool-result", result);
        }
      } catch (error) {
        log.error("Error executing command:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await context.reply("error", `Error: ${errorMessage}`);
      }

      return;
    }

    // Use data from message context
    const time = formatTime(messageContext.timestamp);

    // Check shouldRespond BEFORE formatting (formatting strips @mentions)
    const willRespond = shouldRespond(chatInfo, isGroup, content, selfIds, quotedSenderId);

    // Format user message text (timestamp, sender name, mention stripping)
    /** @type {string} */
    let systemPromptSuffix = "";
    if (firstBlock) {
      const formatted = formatUserMessage(firstBlock, isGroup, senderName, time, selfIds);
      firstBlock.text = formatted.formattedText;
      systemPromptSuffix = formatted.systemPromptSuffix;
    }

    // Always store the message so it's available in history for future responses
    /** @type {UserMessage} */
    const message = {role: "user", content}
    await addMessage(chatId, message, senderIds);

    const enableMemory = !!chatInfo?.memory;

    if (!willRespond) {
      return;
    }

    log.debug("LLM will respond");

    // Resolve active persona (if any)
    const persona = chatInfo?.active_persona ? await getAgent(chatInfo.active_persona) : null;

    // Get system prompt and model from persona, chat, or defaults
    let systemPrompt = (persona?.systemPrompt ?? chatInfo?.system_prompt ?? config.system_prompt) + systemPromptSuffix;
    const chatModel = persona?.model && persona.model in ROLE_DEFINITIONS
      ? resolveModel(persona.model, chatInfo ?? undefined)
      : persona?.model
        ? persona.model
        : resolveModel("chat", chatInfo ?? undefined);

    // Get latest messages from DB
    const chatMessages = await getMessages(chatId)

    // Convert unsupported media types to text for non-multimodal models
    const mediaToTextModels = chatInfo?.media_to_text_models ?? {};
    const rootDb = getRootDb();
    const { messages: translatedMessages, skippedTypes } = await convertUnsupportedMedia(
      chatMessages, chatModel, mediaToTextModels, llmClient, rootDb,
    );

    if (skippedTypes.size > 0) {
      const types = [...skippedTypes].join(", ");
      await context.send("warning", `${types} not supported by this model. Use \`!config media_to_text_model\` to enable.`);
    }

    // Search long-term memory for relevant past conversations
    if (enableMemory) {
      const currentText = extractTextFromMessage(message);
      if (currentText.length >= 10) {
        try {
          const threshold = chatInfo?.memory_threshold ?? config.memory_threshold;
          const similar = await findMemories(getRootDb(), llmClient, chatId, currentText, { minSimilarity: threshold });
          log.debug(`[memory] query="${currentText.slice(0, 80)}" found=${similar.length} threshold=${threshold}`);
          if (similar.length > 0) {
            systemPrompt += "\n\n## Relevant memories\n" + formatMemoriesContext(similar);
            log.debug("[memory] recalled:", similar.map(m => `#${m.id}(${Number(m.similarity).toFixed(3)})`).join(", "));
            if (isDebug) {
              const lines = similar.map(m =>
                `• [#${m.id}] (score: ${Number(m.similarity).toFixed(3)}) ${m.content.slice(0, 100)}${m.content.length > 100 ? "…" : ""}`
              );
              await context.send("memory", `Recalled ${similar.length} memor${similar.length === 1 ? "y" : "ies"}\n${lines.join("\n")}`);
            }
          }
        } catch (err) {
          log.error("Memory search failed:", err);
        }
      }
    }

    // Prepare messages (internal Message[] format)
    const { messages: preparedMessages, mediaRegistry } = prepareMessages(translatedMessages);

    /** @type {Session} */
    const session = {
      chatId, senderIds, context, addMessage, updateToolMessage,
    };

    // Filter actions by persona whitelist if active
    const activeActions = persona?.allowedActions
      ? actions.filter(a => persona.allowedActions?.includes(a.name))
      : actions;

    /** @type {LlmConfig} */
    const llmConfig = {
      llmClient, chatModel, systemPrompt, actions: activeActions,
      executeActionFn, actionResolver, actionLlmClient: llmClient,
    };

    /** @type {AgentIOHooks} */
    const hooks = {
      onLlmResponse: (text) => context.reply("llm", text),
      onToolCall: (toolCall, fmt) => displayToolCall(toolCall, context, isDebug, fmt),
      onToolResult: (blocks, name, perms) => displayToolResult(blocks, name, perms, context, isDebug),
      onToolError: (msg) => context.send("error", msg),
      onContinuePrompt: () => context.confirm(`React 👍 to continue or 👎 to stop.`),
      onDepthLimit: () => context.confirm(
        `⚠️ *Depth limit*\n\nReached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). React 👍 to continue or 👎 to stop.`,
      ),
      onUsage: (cost, tokens) => isDebug
        ? context.send("usage", `Cost: ${cost} | prompt=${tokens.prompt} cached=${tokens.cached} completion=${tokens.completion}`)
        : Promise.resolve(),
    };

    await messageContext.sendPresenceUpdate("composing");
    try {
      await processLlmResponse({ session, llmConfig, messages: preparedMessages, mediaRegistry, hooks });
    } catch (error) {
      log.error(error);
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
      await context.reply("error", errorMessage);
    } finally {
      await messageContext.sendPresenceUpdate("paused");
    }

    // Note: memory storage is now handled via the saveMemory tool action,
    // not automatically after each exchange.
  }

  return { handleMessage };
}

/**
 * @typedef {{
 *   store: Pick<Store, "addMessage" | "updateToolMessage">;
 *   executeActionFn: typeof executeAction;
 *   pendingByMsgKeyId: Map<string, import("./pending-confirmations.js").PendingConfirmationRow>;
 *   rootDb: import("@electric-sql/pglite").PGlite;
 * }} ReactionHandlerDeps
 */

/**
 * Create a reaction handler for resuming pending confirmations after restart.
 * @param {ReactionHandlerDeps} deps
 * @returns {(event: import("./whatsapp-adapter.js").ReactionEvent, sock: import("@whiskeysockets/baileys").WASocket) => Promise<void>}
 */
export function createReactionHandler({ store, executeActionFn, pendingByMsgKeyId, rootDb }) {
  /**
   * @param {import("./whatsapp-adapter.js").ReactionEvent} event
   * @param {import("@whiskeysockets/baileys").WASocket} sock
   */
  async function onReaction(event, sock) {
    const { key, reaction } = event;
    const pending = pendingByMsgKeyId.get(key.id);
    if (!pending) return;

    const isApproved = reaction.text?.startsWith("\uD83D\uDC4D");
    const isRejected = reaction.text?.startsWith("\uD83D\uDC4E");
    if (!isApproved && !isRejected) return;

    const msgKey = { id: pending.msg_key_id, remoteJid: pending.msg_key_remote_jid };

    // Remove from in-memory map and DB
    pendingByMsgKeyId.delete(key.id);
    await deletePendingConfirmation(rootDb, key.id);

    if (isRejected) {
      await sock.sendMessage(pending.msg_key_remote_jid, {
        react: { text: "❌", key: msgKey },
      });

      // Store rejection as tool result so the LLM learns the action was rejected
      if (pending.tool_call_id) {
        const toolMessage = createToolMessage(pending.tool_call_id, "[action rejected by user]");
        const updated = await store.updateToolMessage(pending.chat_id, pending.tool_call_id, toolMessage);
        if (!updated) await store.addMessage(pending.chat_id, toolMessage, pending.sender_ids);
      }

      log.info(`Pending confirmation for ${pending.action_name} rejected after restart`);
      return;
    }

    // Approved — react ✅ and re-execute the action
    await sock.sendMessage(pending.msg_key_remote_jid, {
      react: { text: "✅", key: msgKey },
    });

    log.info(`Resuming action "${pending.action_name}" after restart approval`);

    /** @type {ExecuteActionContext} */
    const resumeContext = {
      chatId: pending.chat_id,
      senderIds: pending.sender_ids,
      content: [],
      getIsAdmin: async () => true,
      send: async (source, content) => sendBlocks(sock, pending.chat_id, source, content),
      reply: async (source, content) => sendBlocks(sock, pending.chat_id, source, content),
      reactToMessage: async () => {},
      sendPoll: async (name, options, selectableCount) => {
        await sock.sendMessage(pending.chat_id, {
          poll: { name, values: options, selectableCount: selectableCount || 0 },
        });
      },
      confirm: async () => true, // auto-confirm: user already approved
    };

    try {
      const { result } = await executeActionFn(
        pending.action_name, resumeContext, pending.action_params,
        { toolCallId: pending.tool_call_id },
      );
      const resultText = typeof result === "string" ? result : JSON.stringify(result, null, 2);

      // Store tool result so the LLM learns the outcome
      if (pending.tool_call_id) {
        const toolMessage = createToolMessage(pending.tool_call_id, resultText);
        const updated = await store.updateToolMessage(pending.chat_id, pending.tool_call_id, toolMessage);
        if (!updated) await store.addMessage(pending.chat_id, toolMessage, pending.sender_ids);
      }

      await resumeContext.send("tool-result", resultText);
    } catch (error) {
      log.error(`Error resuming action "${pending.action_name}":`, error);
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Store error as tool result so the LLM learns the failure
      if (pending.tool_call_id) {
        const toolMessage = createToolMessage(pending.tool_call_id, `Error executing ${pending.action_name}: ${errorMsg}`);
        const updated = await store.updateToolMessage(pending.chat_id, pending.tool_call_id, toolMessage);
        if (!updated) await store.addMessage(pending.chat_id, toolMessage, pending.sender_ids);
      }

      await resumeContext.send("error", `Error resuming ${pending.action_name}: ${errorMsg}`);
    }
  }

  return onReaction;
}

// ── Default initialization (production) ──

if (!process.env.TESTING) {
  const store = await initStore();
  const llmClient = createLlmClient();

  const { handleMessage } = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
  });

  await startHtmlServer(config.html_server_port, getRootDb());

  const rootDb = getRootDb();

  // Load pending confirmations from a previous session
  const pendingConfirmations = await loadPendingConfirmations(rootDb);
  if (pendingConfirmations.length > 0) {
    log.info(`Loaded ${pendingConfirmations.length} pending confirmation(s) from previous session`);
  }

  /** @type {Map<string, import("./pending-confirmations.js").PendingConfirmationRow>} */
  const pendingByMsgKeyId = new Map(
    pendingConfirmations.map(row => [row.msg_key_id, row]),
  );

  const onReaction = createReactionHandler({
    store,
    executeActionFn: executeAction,
    pendingByMsgKeyId,
    rootDb,
  });

  const { closeWhatsapp, sendToChat } = await connectToWhatsApp({
    onMessage: handleMessage,
    onReaction,
  }).catch(async (error) => {
      log.error("Initialization error:", error);
      await store.closeDb();
      process.exit(1);
    });

  const stopReminders = startReminderDaemon(sendToChat);
  const stopModelsCache = startModelsCacheDaemon();

  async function cleanup() {
    try {
      stopReminders();
      stopModelsCache();
      await stopHtmlServer();
      await closeWhatsapp();
      await store.closeDb();
    } catch (error) {
      log.error("Error during cleanup:", error);
    }
  }

  process.on("SIGINT", async function () {
    log.info("SIGINT received, cleaning up...");
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async function () {
    log.info("SIGTERM received, cleaning up...");
    await cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", async (error) => {
    log.error("Uncaught Exception:", error);
    await cleanup();
    process.exit(1);
  });
}

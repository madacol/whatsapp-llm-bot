/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import fs from "node:fs";

import { getActions, executeAction, getChatActions, getChatAction, getAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { formatTime, isHtmlContent, createToolMessage, formatRelativeTime, getChatWorkDir } from "./utils.js";
import { connectToWhatsApp, sendBlocks } from "./whatsapp-adapter.js";
import { startReminderDaemon } from "./reminder-daemon.js";
import { startModelsCacheDaemon } from "./models-cache.js";
import { initStore } from "./store.js";
import {
  shouldRespond,
  formatUserMessage,
  parseCommandArgs,
  prepareMessages,
} from "./message-formatting.js";
import { convertUnsupportedMedia } from "./media-to-text.js";
import { resolveChatModel } from "./model-roles.js";
import { getAgent } from "./agents.js";
import { getRootDb } from "./db.js";
import {
  extractTextFromMessage,
  findMemories,
  formatMemoriesContext,
} from "./memory.js";
import { storeAndLinkHtml } from "./html-store.js";
import { startHtmlServer, stopHtmlServer } from "./html-server.js";
import {
  loadPendingConfirmations,
  deletePendingConfirmation,
} from "./pending-confirmations.js";
import { resolveHarness, resolveHarnessName, registerHarness, waitForAllHarnesses, MAX_TOOL_CALL_DEPTH } from "./harnesses/index.js";
import { formatToolCallDisplay, formatToolResultDisplay } from "./tool-display.js";
import { createMessageActionContext, createSilentActionContext } from "./execute-action-context.js";
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

/**
 * Type guard: checks that a content block is a text block.
 * @param {IncomingContentBlock} block
 * @returns {block is TextContentBlock}
 */
function isTextBlock(block) {
  return block.type === "text";
}

/**
 * Display a tool call to the user using the pure formatter.
 * @param {LlmChatResponse['toolCalls'][0]} toolCall
 * @param {Pick<ExecuteActionContext, "send">} context
 * @param {boolean} isDebug
 * @param {((params: Record<string, any>) => string)} [actionFormatter]
 * @returns {Promise<MessageEditor | undefined>}
 */
async function displayToolCall(toolCall, context, isDebug, actionFormatter) {
  const content = formatToolCallDisplay(toolCall, isDebug, actionFormatter);
  if (content != null) {
    return context.send("tool-call", content);
  }
}

/**
 * Display a tool result to the user using the pure formatter.
 * @param {ToolContentBlock[]} blocks
 * @param {string} toolName
 * @param {Action['permissions']} permissions
 * @param {Pick<ExecuteActionContext, "send" | "reply">} context
 * @param {boolean} isDebug
 */
async function displayToolResult(blocks, toolName, permissions, context, isDebug) {
  const items = formatToolResultDisplay(blocks, toolName, permissions, isDebug);
  if (!items) return;
  for (const { source, content } of items) {
    if (source === "reply") {
      await context.reply("tool-result", content);
    } else {
      await context.send("tool-result", content);
    }
  }
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
 * @returns {{ handleMessage: (messageContext: IncomingContext) => Promise<void>, handlePollVote: (event: import("./whatsapp-adapter.js").PollVoteEvent) => Promise<void> }}
 */
export function createMessageHandler({ store, llmClient, getActionsFn, executeActionFn }) {
  const { addMessage, updateToolMessage, createChat, getChat, getMessages, updateSdkSessionId, archiveSdkSession, getSdkSessionHistory, restoreSdkSession } = store;

  /** Timeout for onAskUser responses (5 minutes). */
  const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * Per-chat pending response resolvers for onAskUser.
   * When set, the next incoming message for that chat resolves the promise
   * instead of being processed normally.
   * @type {Map<string, (text: string) => void>}
   */
  const pendingUserResponses = new Map();

  /**
   * Chats currently in LLM processing (between "LLM will respond" and harness completion).
   * Used to prevent concurrent queries: if a second message arrives during setup,
   * it gets buffered and injected once the harness is active, instead of spawning
   * a parallel query.
   * @type {Map<string, string[]>}
   */
  const pendingLlmChats = new Map();

  /**
   * Wait for a user response on a given chat, with a timeout.
   * Registers a resolver in `pendingUserResponses` that will be triggered
   * by the next incoming message or poll vote for this chat.
   * @param {string} chatId
   * @param {(text: string) => string} [transform] - Optional transform applied to the raw response before resolving.
   * @returns {Promise<string>} The user's response text, or "" on timeout.
   */
  function waitForUserResponse(chatId, transform) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingUserResponses.delete(chatId);
        resolve("");
      }, ASK_USER_TIMEOUT_MS);
      pendingUserResponses.set(chatId, (text) => {
        clearTimeout(timer);
        resolve(transform ? transform(text) : text);
      });
    });
  }



  /**
   * Handle a `!command` message: parse, dispatch, and render result.
   * @param {object} opts
   * @param {string} opts.chatId
   * @param {string[]} opts.senderIds
   * @param {IncomingContentBlock[]} opts.content
   * @param {TextContentBlock} opts.firstBlock
   * @param {import("./store.js").ChatRow | undefined} opts.chatInfo
   * @param {ExecuteActionContext} opts.context
   * @param {Action[]} opts.actions
   * @param {(name: string) => Promise<AppAction | null>} opts.actionResolver
   */
  async function handleCommandMessage({ chatId, senderIds, content, firstBlock, chatInfo, context, actions, actionResolver }) {
    const inputText = firstBlock.text.slice(1).trim();
    const commandText = inputText.toLowerCase();

    // Handle !cancel — abort the active harness query for this chat
    if (commandText === "cancel") {
      const persona = chatInfo?.active_persona
        ? (await getAgent(chatInfo.active_persona))
        : null;
      const harnessName = resolveHarnessName(persona, chatInfo);
      const harness = resolveHarness(harnessName);
      if (harness.cancel?.(chatId)) {
        await context.reply("tool-result", "Cancelled.");
      } else {
        await context.reply("tool-result", "Nothing to cancel.");
      }
      return;
    }

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
      } else if (Array.isArray(result)) {
        await context.reply("tool-result", /** @type {ToolContentBlock[]} */ (result));
      } else {
        await context.reply("tool-result", JSON.stringify(result, null, 2));
      }
    } catch (error) {
      log.error("Error executing command:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await context.reply("error", `Error: ${errorMessage}`);
    }
  }

  /**
   * Handle built-in slash commands that operate on the harness level.
   * Returns true if the command was handled, false if it should fall through to the SDK.
   * @param {string} command - The slash command text (without leading /)
   * @param {string} chatId
   * @param {import("./store.js").ChatRow | undefined} chatInfo
   * @param {ExecuteActionContext} context
   * @returns {Promise<boolean>}
   */
  async function handleSlashCommand(command, chatId, chatInfo, context) {
    switch (command) {
      case "clear": {
        // Reset the SDK session — next message starts a fresh conversation
        const persona = chatInfo?.active_persona ? await getAgent(chatInfo.active_persona) : null;
        const harnessName = resolveHarnessName(persona, chatInfo);
        const harness = resolveHarness(harnessName);
        // Cancel any active query
        harness.cancel?.(chatId);
        // Archive the current session before clearing so it can be resumed later
        await archiveSdkSession(chatId);
        await context.reply("tool-result", "Session cleared. Next message starts fresh.\nUse /resume to restore this session later.");
        return true;
      }
      case "resume": {
        // Archive the current active session first so it's not lost
        await archiveSdkSession(chatId);
        const history = await getSdkSessionHistory(chatId);
        if (history.length === 0) {
          await context.reply("tool-result", "No previous sessions to resume.");
          return true;
        }

        // Build poll options: most recent first, with relative time labels
        // WhatsApp polls support up to 12 options
        const recentFirst = [...history].reverse().slice(0, 11);
        const cancelLabel = "Cancel";
        const pollOptions = recentFirst.map((entry, i) => {
          return `Session ${i + 1} (${formatRelativeTime(Date.now() - new Date(entry.cleared_at).getTime())})`;
        });
        pollOptions.push(cancelLabel);

        // Send poll and wait for user choice
        await context.sendPoll("Which session to resume?", pollOptions, 1);
        const choice = await waitForUserResponse(chatId);

        if (!choice || choice === cancelLabel) {
          await context.reply("tool-result", "Resume cancelled.");
          return true;
        }

        // Parse the chosen index from "Session N (Xm ago)"
        const match = String(choice).match(/^Session (\d+)/);
        if (!match) {
          await context.reply("tool-result", "Could not parse selection.");
          return true;
        }
        const selectedIndex = parseInt(match[1], 10) - 1; // 0-based from most recent

        const restored = await restoreSdkSession(chatId, selectedIndex);
        if (!restored) {
          await context.reply("tool-result", "Failed to restore session.");
          return true;
        }
        const agoStr = formatRelativeTime(Date.now() - new Date(restored.cleared_at).getTime());
        await context.reply("tool-result", `Session restored (cleared ${agoStr}). Your next message will continue that conversation.`);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Handle a regular (non-command) message: format, store, and run through the LLM harness.
   * @param {object} opts
   * @param {IncomingContext} opts.messageContext
   * @param {import("./store.js").ChatRow | undefined} opts.chatInfo
   * @param {boolean} opts.isDebug
   * @param {ExecuteActionContext} opts.context
   * @param {Action[]} opts.actions
   * @param {(name: string) => Promise<AppAction | null>} opts.actionResolver
   * @param {TextContentBlock | undefined} opts.firstBlock
   * @param {boolean} [opts.isSlashCommand]
   */
  async function handleLlmMessage({ messageContext, chatInfo, isDebug, context, actions, actionResolver, firstBlock, isSlashCommand }) {
    const { chatId, senderIds, content, isGroup, senderName, selfIds, quotedSenderId } = messageContext;

    // Use data from message context
    const time = formatTime(messageContext.timestamp);

    // Slash commands always get a response; regular messages check shouldRespond
    const willRespond = isSlashCommand || shouldRespond(chatInfo, isGroup, content, selfIds, quotedSenderId);

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

    // If a harness is waiting for a user response (onAskUser), resolve it
    // with this message instead of starting a new query or injecting.
    const pendingResolve = pendingUserResponses.get(chatId);
    if (pendingResolve) {
      pendingUserResponses.delete(chatId);
      pendingResolve(firstBlock?.text ?? "");
      return;
    }

    log.debug("LLM will respond");

    const userText = firstBlock?.text ?? "";

    // --- Concurrency guard (fully synchronous — no awaits between check and set) ---
    // 1. If setup is in progress for this chat, buffer the message
    if (userText && pendingLlmChats.has(chatId)) {
      pendingLlmChats.get(chatId)?.push(userText);
      log.debug("Buffered message for pending LLM setup on chat", chatId);
      return;
    }
    // 2. If the harness already has an active query, inject into it
    const harnessName = resolveHarnessName(null, chatInfo); // sync — persona resolved later
    const harness = resolveHarness(harnessName);
    if (userText && harness.injectMessage?.(chatId, userText)) {
      log.debug("Injected message into active harness query for chat", chatId);
      return;
    }
    // 3. Mark as pending synchronously — before any awaits.
    //    All subsequent messages for this chat hit check #1 above.
    pendingLlmChats.set(chatId, []);

    // Send composing signal (first await — safe, guard is already set)
    try {
      await messageContext.sendPresenceUpdate("composing");
    } catch (err) {
      log.debug("Could not send composing signal:", err instanceof Error ? err.message : err);
    }

    try {

    // Resolve active persona (if any)
    const persona = chatInfo?.active_persona ? await getAgent(chatInfo.active_persona) : null;

    // Get system prompt and model from persona, chat, or defaults
    let systemPrompt = (persona?.systemPrompt ?? chatInfo?.system_prompt ?? config.system_prompt) + systemPromptSuffix;
    const chatModel = resolveChatModel(persona, chatInfo ?? undefined);

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
      sdkSessionId: chatInfo?.sdk_session_id,
      updateSdkSessionId,
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
      onLlmResponse: async (text) => { await context.reply("llm", [{ type: "markdown", text }]); },
      onAskUser: async (question, options, _preamble, descriptions) => {
        // Embed descriptions into poll labels when available
        /** @type {Map<string, string>} enriched label → original label */
        const labelMap = new Map();
        const pollOptions = options.map((label, i) => {
          const desc = descriptions?.[i];
          const enriched = desc ? `${label}\n\n${desc}` : label;
          labelMap.set(enriched, label);
          return enriched;
        });

        await context.sendPoll(question || "Choose an option:", pollOptions, 1);
        // Map enriched label back to original label
        return waitForUserResponse(chatId, (text) => labelMap.get(text) ?? text);
      },
      onToolCall: (toolCall, fmt) => displayToolCall(toolCall, context, isDebug, fmt),
      onToolResult: (blocks, name, perms) => displayToolResult(blocks, name, perms, context, isDebug),
      onToolError: async (msg) => { await context.send("error", msg); },
      onContinuePrompt: () => context.confirm(`React 👍 to continue or 👎 to stop.`),
      onDepthLimit: () => context.confirm(
        `⚠️ *Depth limit*\n\nReached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). React 👍 to continue or 👎 to stop.`,
      ),
      onUsage: async (cost, tokens) => {
        if (isDebug) await context.send("usage", `Cost: ${cost} | prompt=${tokens.prompt} cached=${tokens.cached} completion=${tokens.completion}`);
      },
    };

    // Append any messages that arrived during setup to the conversation
    const buffered = pendingLlmChats.get(chatId) ?? [];
    pendingLlmChats.delete(chatId);
    for (const text of buffered) {
      if (text) {
        /** @type {UserMessage} */
        const bufferedMsg = { role: "user", content: [{ type: "text", text }] };
        preparedMessages.push(bufferedMsg);
        log.debug("Appended buffered message to conversation for chat", chatId);
      }
    }

    await harness.processLlmResponse({ session, llmConfig, messages: preparedMessages, mediaRegistry, hooks, cwd: getChatWorkDir(chatId, chatInfo?.harness_cwd) });

    } catch (error) {
      log.error("handleLlmMessage failed:", error);
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
      try { await context.reply("error", errorMessage); } catch { /* best effort */ }
    } finally {
      pendingLlmChats.delete(chatId); // clean up in case of error before flush
      try {
        await messageContext.sendPresenceUpdate("paused");
      } catch (err) {
        log.debug("Could not send paused signal:", err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Handle incoming WhatsApp messages — dispatches to command or LLM handler.
   * @param {IncomingContext} messageContext
   * @returns {Promise<void>}
   */
  async function handleMessage(messageContext) {
    const { chatId, senderIds, content } = messageContext;

    log.debug("INCOMING MESSAGE:", JSON.stringify(messageContext, null, 2));

    // Ensure chat exists in DB for both command and message paths
    await createChat(chatId);

    // Compute debug state before building context so it's immutable
    const chatInfo = await getChat(chatId);
    const isDebug = !!chatInfo?.debug_until && new Date(chatInfo.debug_until) > new Date();

    const context = createMessageActionContext(messageContext);

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

    const firstBlock = content.find(isTextBlock)

    if (firstBlock?.text?.startsWith("!")) {
      return handleCommandMessage({ chatId, senderIds, content, firstBlock, chatInfo, context, actions, actionResolver });
    }

    // Slash commands: harness-level commands handled at the bot level.
    // /clear resets the SDK session; other /commands are passed to the SDK as prompts.
    const isSlashCommand = firstBlock?.text?.startsWith("/");
    if (isSlashCommand && firstBlock) {
      if (!chatInfo?.is_enabled) {
        await context.reply("error", "Bot is not enabled in this chat. Use !config enabled true");
        return;
      }
      const slashCmd = firstBlock.text.slice(1).trim().toLowerCase();
      const handled = await handleSlashCommand(slashCmd, chatId, chatInfo, context);
      if (handled) return;
      // Not a built-in slash command — fall through to LLM as a skill invocation
    }

    return handleLlmMessage({ messageContext, chatInfo, isDebug, context, actions, actionResolver, firstBlock, isSlashCommand: !!isSlashCommand });
  }

  /**
   * Handle a poll vote by resolving any pending onAskUser promise for that chat.
   * @param {import("./whatsapp-adapter.js").PollVoteEvent} event
   */
  async function handlePollVote(event) {
    const resolver = pendingUserResponses.get(event.chatId);
    if (resolver && event.selectedOptions.length > 0) {
      pendingUserResponses.delete(event.chatId);
      resolver(event.selectedOptions[0]);
    }
  }

  return { handleMessage, handlePollVote };
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
      ...createSilentActionContext(pending.chat_id, pending.sender_ids),
      send: async (source, content) => sendBlocks(sock, pending.chat_id, source, content),
      reply: async (source, content) => sendBlocks(sock, pending.chat_id, source, content),
      sendPoll: async (name, options, selectableCount) => {
        await sock.sendMessage(pending.chat_id, {
          poll: { name, values: options, selectableCount: selectableCount || 0 },
        });
      },
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

// Register optional harnesses
try {
  const { createClaudeAgentSdkHarness } = await import("./harnesses/claude-agent-sdk.js");
  registerHarness("claude-agent-sdk", createClaudeAgentSdkHarness);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Cannot find") || msg.includes("MODULE_NOT_FOUND")) {
    log.debug("Claude Agent SDK not installed, skipping harness registration");
  } else {
    log.warn("Failed to load Claude Agent SDK harness:", msg);
  }
}

if (!process.env.TESTING) {
  // Prevent duplicate instances: if old PID is still running, kill it first
  const pidFile = ".bot.pid";
  if (fs.existsSync(pidFile)) {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
    try {
      process.kill(oldPid, 0); // check if alive
      console.log(`Killing previous instance (PID ${oldPid})...`);
      process.kill(oldPid, "SIGTERM");
      // Wait for graceful shutdown (active queries get 2min to finish)
      const start = Date.now();
      while (Date.now() - start < 125_000) {
        try { process.kill(oldPid, 0); } catch { break; }
      }
    } catch { /* not running, ok */ }
  }
  fs.writeFileSync(pidFile, process.pid.toString());
  for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { fs.unlinkSync(pidFile); } catch {} });
  }

  const store = await initStore();
  const llmClient = createLlmClient();

  const { handleMessage, handlePollVote } = createMessageHandler({
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
    onPollVote: handlePollVote,
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
      const waitedOn = await waitForAllHarnesses();
      if (waitedOn.length > 0) {
        log.info(`Shutdown waited on ${waitedOn.length} chat(s): ${waitedOn.join(", ")}`);
      }
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

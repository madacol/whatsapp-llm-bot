/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import fs from "node:fs";

import { getActions, executeAction, getChatActions, getChatAction, getAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { formatTime, isHtmlContent, formatRelativeTime, getChatWorkDir, errorToString } from "./utils.js";
import { connectToWhatsApp, editWhatsAppMessage } from "./whatsapp-adapter.js";
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
import { resolveHarness, resolveHarnessName, registerHarness, waitForAllHarnesses, MAX_TOOL_CALL_DEPTH } from "./harnesses/index.js";
import { handleModelCommand, handleEffortCommand, getModels as getSdkModels, getEffortLevels as getSdkEffortLevels } from "./harnesses/claude-agent-sdk.js";
import { formatToolCallDisplay } from "./tool-display.js";
import { createMessageActionContext } from "./execute-action-context.js";
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
  const { addMessage, updateToolMessage, createChat, getChat, getMessages, updateSdkSessionId, archiveSdkSession, getSdkSessionHistory, restoreSdkSession } = store;

  /**
   * Chats currently in LLM processing (between "LLM will respond" and harness completion).
   * Used to prevent concurrent queries: if a second message arrives during setup,
   * it gets buffered and injected once the harness is active, instead of spawning
   * a parallel query.
   * @type {Map<string, string[]>}
   */
  const pendingLlmChats = new Map();



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
      const errorMessage = errorToString(error);
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

        // Build options: most recent first, with relative time labels
        // WhatsApp polls support up to 12 options
        const recentFirst = [...history].reverse().slice(0, 11);
        /** @type {SelectOption[]} */
        const selectOptions = [
          ...recentFirst.map((entry, i) => ({
            id: String(i),
            label: `Session ${i + 1} (${formatRelativeTime(Date.now() - new Date(entry.cleared_at).getTime())})`,
          })),
          { id: "cancel", label: "Cancel" },
        ];

        const choice = await context.select("Which session to resume?", selectOptions);

        if (!choice || choice === "cancel") {
          await context.reply("tool-result", "Resume cancelled.");
          return true;
        }

        const selectedIndex = parseInt(choice, 10);
        const restored = await restoreSdkSession(chatId, selectedIndex);
        if (!restored) {
          await context.reply("tool-result", "Failed to restore session.");
          return true;
        }
        const agoStr = formatRelativeTime(Date.now() - new Date(restored.cleared_at).getTime());
        await context.reply("tool-result", `Session restored (cleared ${agoStr}). Your next message will continue that conversation.`);
        return true;
      }
      default: {
        // /model [arg] — list or set SDK model and effort
        const modelMatch = command.match(/^model(?:\s+(.*))?$/);
        if (modelMatch) {
          const arg = modelMatch[1]?.trim() || null;
          if (arg) {
            // Direct set: /model effort <level>, /model opus, /model off, etc.
            const effortMatch = arg.match(/^effort\s+(.+)$/i);
            if (effortMatch) {
              const result = await handleEffortCommand(chatId, effortMatch[1].trim());
              await context.reply("tool-result", result);
              return true;
            }
            const result = await handleModelCommand(chatId, arg);
            await context.reply("tool-result", result);
            return true;
          }
          // No arg — model poll, then effort poll if the model supports it
          const models = getSdkModels();
          const db = getRootDb();
          const { rows } = await db.query("SELECT sdk_model, sdk_effort FROM chats WHERE chat_id = $1", [chatId]);
          const currentModel = /** @type {string | null} */ (rows[0]?.sdk_model ?? null);
          const currentEffort = /** @type {string | null} */ (rows[0]?.sdk_effort ?? null);

          // Model selection
          /** @type {SelectOption[]} */
          const modelSelectOptions = [
            ...models.map((m) => {
              const label = `${m.displayName} — ${m.description}`;
              return { id: m.value, label: currentModel === m.value ? `${label} ✓` : label };
            }),
            { id: "off", label: "Default (Sonnet)" },
          ];

          const modelChoice = await context.select("Choose SDK model", modelSelectOptions);

          /** @type {string | null} */
          let resolvedModelValue = currentModel;
          if (modelChoice) {
            await handleModelCommand(chatId, modelChoice);
            resolvedModelValue = modelChoice === "off" ? null : modelChoice;
          }

          // Effort selection — only if the chosen model supports effort levels
          const efforts = getSdkEffortLevels(resolvedModelValue);
          if (efforts.length > 0) {
            /** @type {SelectOption[]} */
            const effortSelectOptions = [
              ...efforts.map((e) => ({
                id: e.value,
                label: currentEffort === e.value ? `${e.label} ✓` : e.label,
              })),
              { id: "off", label: "Default (high)" },
            ];

            const effortChoice = await context.select("Choose effort level", effortSelectOptions);

            if (!effortChoice || effortChoice === "off") {
              await handleEffortCommand(chatId, "off");
            } else {
              await handleEffortCommand(chatId, effortChoice);
            }
          } else {
            // Clear effort for models that don't support it
            await handleEffortCommand(chatId, "off");
          }

          // Show final state
          const { rows: updated } = await db.query("SELECT sdk_model, sdk_effort FROM chats WHERE chat_id = $1", [chatId]);
          const finalModel = updated[0]?.sdk_model ?? "default (Sonnet)";
          const finalEffort = updated[0]?.sdk_effort ?? "default (high)";
          await context.reply("tool-result", `*Model:* ${finalModel}\n*Effort:* ${finalEffort}`);
          return true;
        }
        return false;
      }
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
      log.debug("Could not send composing signal:", errorToString(err));
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

        const choice = await context.select(question || "Choose an option:", pollOptions);
        // Map enriched label back to original label
        return labelMap.get(choice) ?? choice;
      },
      onToolCall: async (toolCall, fmt) => {
        return displayToolCall(toolCall, context, isDebug, fmt);
      },
      onToolResult: async (blocks) => { await context.send("tool-result", blocks); },
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

    await harness.processLlmResponse({ session, llmConfig, messages: preparedMessages, mediaRegistry, hooks, cwd: getChatWorkDir(chatId, chatInfo?.harness_cwd), sdkModel: chatInfo?.sdk_model ?? undefined, sdkEffort: /** @type {AgentHarnessParams['sdkEffort']} */ (chatInfo?.sdk_effort ?? undefined) });

    } catch (error) {
      log.error("handleLlmMessage failed:", error);
      const errorMessage = errorToString(error);
      try { await context.reply("error", errorMessage); } catch { /* best effort */ }
    } finally {
      pendingLlmChats.delete(chatId); // clean up in case of error before flush
      try {
        await messageContext.sendPresenceUpdate("paused");
      } catch (err) {
        log.debug("Could not send paused signal:", errorToString(err));
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

  return { handleMessage };
}

/**
 * @typedef {{
 *   store: Pick<Store, "getToolResultByWaKeyId">;
 * }} ReactionHandlerDeps
 */

/**
 * Create a reaction handler for tool-call inspect (👁 reaction shows result).
 * @param {ReactionHandlerDeps} deps
 * @returns {(event: import("./whatsapp-adapter.js").ReactionEvent, sock: import("@whiskeysockets/baileys").WASocket) => Promise<void>}
 */
export function createReactionHandler({ store }) {
  /**
   * @param {import("./whatsapp-adapter.js").ReactionEvent} event
   * @param {import("@whiskeysockets/baileys").WASocket} sock
   */
  async function onReaction(event, sock) {
    const { key } = event;

    const t0 = Date.now();
    const toolResult = await store.getToolResultByWaKeyId(key.id);
    const t1 = Date.now();
    if (!toolResult) return;

    const { toolMsg, chatId } = toolResult;
    // Use chatId (standard JID) for relayMessage — LID JIDs from reactions don't work with relayMessage
    const editJid = toolMsg.wa_msg_is_image ? chatId : key.remoteJid;
    const msgKey = { id: key.id, remoteJid: editJid, fromMe: true };
    const toolName = toolMsg.tool_name || "Tool";
    const resultText = toolMsg.content
      .filter(/** @param {ToolContentBlock} b */ (b) => b.type === "text")
      .map(/** @param {TextContentBlock} b */ (b) => b.text)
      .join("\n");

    const MAX_EDIT_LEN = 3000;
    const resultDisplay = resultText.length <= MAX_EDIT_LEN
      ? resultText
      : resultText.slice(0, MAX_EDIT_LEN)
        + `\n\n_… truncated (${resultText.length.toLocaleString()} chars total)_`;

    const formatted = `🔧 *${toolName}*\n\n${resultDisplay}`;
    try {
      await editWhatsAppMessage(sock, editJid, msgKey, formatted, !!toolMsg.wa_msg_is_image);
    } catch (editErr) {
      log.error("onReaction: edit failed:", editErr);
    }
    log.info(`onReaction: inspect ${toolMsg.tool_name} — db=${t1 - t0}ms edit=${Date.now() - t1}ms total=${Date.now() - t0}ms`);
  }

  return onReaction;
}

// ── Default initialization (production) ──

// Register optional harnesses
try {
  const { createClaudeAgentSdkHarness } = await import("./harnesses/claude-agent-sdk.js");
  registerHarness("claude-agent-sdk", createClaudeAgentSdkHarness);
} catch (err) {
  const msg = errorToString(err);
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

  const { handleMessage } = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
  });

  await startHtmlServer(config.html_server_port, getRootDb());

  const onReaction = createReactionHandler({ store });

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

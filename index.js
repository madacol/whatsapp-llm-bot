/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import fs from "node:fs";

import { getActions, executeAction, getChatActions, getChatAction, getAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { formatTime, isHtmlContent, formatRelativeTime, getChatWorkDir, errorToString } from "./utils.js";
import { connectToWhatsApp } from "./whatsapp-adapter.js";
import { reattachHdDeferreds } from "./whatsapp-hd-media.js";
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
 * Build the AgentIOHooks wiring from a message context.
 * Pure factory — no shared mutable state.
 * @param {Pick<ExecuteActionContext, "send" | "reply" | "select" | "confirm">} context
 * @param {() => Promise<void>} sendComposing
 * @param {string | null} cwd
 * @returns {AgentIOHooks}
 */
function buildAgentIOHooks(context, sendComposing, cwd) {
  return {
    onComposing: sendComposing,
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

      const choice = await context.select(question || "Choose an option:", pollOptions, {
        deleteOnSelect: true,
      });
      // Map enriched label back to original label
      return labelMap.get(choice) ?? choice;
    },
    onToolCall: async (toolCall, fmt, toolContext) => {
      return displayToolCall(toolCall, context, fmt, cwd, toolContext);
    },
    onToolResult: async (blocks) => { await context.send("tool-result", blocks); },
    onToolError: async (msg) => { await context.send("error", msg); },
    onContinuePrompt: () => context.confirm(`React 👍 to continue or 👎 to stop.`),
    onDepthLimit: () => context.confirm(
      `⚠️ *Depth limit*\n\nReached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). React 👍 to continue or 👎 to stop.`,
    ),
    onUsage: async (cost, tokens) => {
      await context.send("usage", `Cost: ${cost} | prompt=${tokens.prompt} cached=${tokens.cached} completion=${tokens.completion}`);
    },
  };
}

/**
 * Search long-term memory for relevant context and append to system prompt.
 * Returns the (possibly extended) system prompt.
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {import("./store.js").ChatRow | undefined} opts.chatInfo
 * @param {UserMessage} opts.message
 * @param {LlmClient} opts.llmClient
 * @param {string} opts.systemPrompt
 * @param {Pick<ExecuteActionContext, "send">} opts.context
 * @returns {Promise<string>}
 */
async function searchAndAppendMemories({ chatId, chatInfo, message, llmClient, systemPrompt, context }) {
  const currentText = extractTextFromMessage(message);
  if (currentText.length < 10) return systemPrompt;

  try {
    const threshold = chatInfo?.memory_threshold ?? config.memory_threshold;
    const similar = await findMemories(getRootDb(), llmClient, chatId, currentText, { minSimilarity: threshold });
    log.debug(`[memory] query="${currentText.slice(0, 80)}" found=${similar.length} threshold=${threshold}`);
    if (similar.length > 0) {
      const extended = systemPrompt + "\n\n## Relevant memories\n" + formatMemoriesContext(similar);
      log.debug("[memory] recalled:", similar.map(m => `#${m.id}(${Number(m.similarity).toFixed(3)})`).join(", "));
      const lines = similar.map(m =>
        `• [#${m.id}] (score: ${Number(m.similarity).toFixed(3)}) ${m.content.slice(0, 100)}${m.content.length > 100 ? "…" : ""}`
      );
      await context.send("memory", `Recalled ${similar.length} memor${similar.length === 1 ? "y" : "ies"}\n${lines.join("\n")}`);
      return extended;
    }
  } catch (err) {
    log.error("Memory search failed:", err);
  }
  return systemPrompt;
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
 * @param {((params: Record<string, any>) => string)} [actionFormatter]
 * @param {string | null} [cwd]
 * @param {{ oldContent?: string }} [toolContext]
 * @returns {Promise<MessageHandle | undefined>}
 */
async function displayToolCall(toolCall, context, actionFormatter, cwd, toolContext) {
  const content = formatToolCallDisplay(toolCall, actionFormatter, cwd, toolContext);
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
        await context.reply("tool-result", "Session cleared\n\nNext message starts fresh.\nUse */resume* to restore this session later.");
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

        const choice = await context.select("Which session to resume?", selectOptions, {
          deleteOnSelect: true,
          cancelIds: ["cancel"],
        });

        if (!choice || choice === "cancel") {
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
            ...models.map((m) => ({
              id: m.value,
              label: `${m.displayName} — ${m.description}`,
            })),
            { id: "off", label: "Default (Sonnet)" },
          ];

          const modelChoice = await context.select("Choose SDK model", modelSelectOptions, {
            currentId: currentModel ?? undefined,
          });

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
                label: e.label,
              })),
              { id: "off", label: "Default (high)" },
            ];

            const effortChoice = await context.select("Choose effort level", effortSelectOptions, {
              currentId: currentEffort ?? undefined,
            });

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
   * @param {ExecuteActionContext} opts.context
   * @param {Action[]} opts.actions
   * @param {(name: string) => Promise<AppAction | null>} opts.actionResolver
   * @param {TextContentBlock | undefined} opts.firstBlock
   * @param {boolean} [opts.isSlashCommand]
   */
  async function handleLlmMessage({ messageContext, chatInfo, context, actions, actionResolver, firstBlock, isSlashCommand }) {
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

    /** Send "composing" presence, swallowing errors. */
    const sendComposing = async () => {
      try { await messageContext.sendPresenceUpdate("composing"); }
      catch (err) { log.debug("Could not send composing signal:", errorToString(err)); }
    };

    // Send composing signal (first await — safe, guard is already set)
    await sendComposing();

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
      systemPrompt = await searchAndAppendMemories({ chatId, chatInfo, message, llmClient, systemPrompt, context });
    }

    // Prepare messages (internal Message[] format)
    const { messages: preparedMessages, mediaRegistry } = prepareMessages(translatedMessages);
    reattachHdDeferreds(chatId, mediaRegistry);

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

    const hooks = buildAgentIOHooks(context, sendComposing, chatInfo?.harness_cwd ?? null);

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

    const chatInfo = await getChat(chatId);

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

    return handleLlmMessage({ messageContext, chatInfo, context, actions, actionResolver, firstBlock, isSlashCommand: !!isSlashCommand });
  }

  return { handleMessage };
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
      log.info(`Killing previous instance (PID ${oldPid})...`);
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

  const { closeWhatsapp, sendToChat } = await connectToWhatsApp(handleMessage).catch(async (error) => {
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
    // The Claude Agent SDK subprocess throws "Operation aborted" as an
    // uncaught exception when a query is cancelled via AbortController.
    // This is a known SDK internal error path (y9.write → handleControlRequest)
    // that escapes the async iterator's promise chain.  Suppress it instead
    // of crashing the whole bot.
    if (error?.message === "Operation aborted" || error?.name === "AbortError") {
      log.warn("Suppressed SDK abort exception:", error.message);
      return;
    }
    log.error("Uncaught Exception:", error);
    await cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    // Same suppression for abort errors surfacing as unhandled rejections
    if (reason instanceof Error && (reason.message === "Operation aborted" || reason.name === "AbortError")) {
      log.warn("Suppressed SDK abort rejection:", reason.message);
      return;
    }
    log.error("Unhandled Rejection:", reason);
    // Don't exit — unhandled rejections are non-fatal by default in Node ≥15
    // but log them so they're visible.
  });
}

/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import fs from "node:fs";

import { getActions, executeAction, getChatActions, getChatAction, getAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { formatTime, isHtmlContent, createToolMessage } from "./utils.js";
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
import { resolveHarness, resolveHarnessName, registerHarness, MAX_TOOL_CALL_DEPTH, parseToolArgs } from "./harnesses/index.js";
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

/** Map file extensions to language identifiers for syntax highlighting. */
const EXT_TO_LANG = /** @type {Record<string, string>} */ ({
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", kts: "kotlin", swift: "swift", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", lua: "lua", r: "r", jl: "julia", scala: "scala",
  dart: "dart", zig: "zig", nim: "nim", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", ml: "ocaml", fs: "fsharp",
  clj: "clojure", groovy: "groovy", pl: "perl", pm: "perl",
  sh: "bash", bash: "bash", zsh: "zsh", fish: "fish",
  ps1: "powershell", bat: "bat", cmd: "cmd",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass",
  less: "less", xml: "xml", svg: "svg", vue: "vue", svelte: "svelte",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  sql: "sql", graphql: "graphql", proto: "protobuf",
  dockerfile: "dockerfile", makefile: "makefile",
  tf: "terraform", hcl: "hcl", tex: "latex",
  md: "markdown", mdx: "mdx",
});

/**
 * Infer a syntax-highlighting language from a file path's extension.
 * @param {string} filePath
 * @returns {string}
 */
function langFromPath(filePath) {
  const base = filePath.split("/").pop() || "";
  // Handle extensionless known files
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()?.toLowerCase() ?? "" : "";
  return EXT_TO_LANG[ext] || "";
}

/**
 * Display a tool call to the user — renders Edit/Write code as images.
 * @param {LlmChatResponse['toolCalls'][0]} toolCall
 * @param {Pick<ExecuteActionContext, "send">} context
 * @param {boolean} isDebug
 * @param {((params: Record<string, any>) => string)} [formatToolCall]
 * @returns {Promise<MessageEditor | undefined>}
 */
async function displayToolCall(toolCall, context, isDebug, formatToolCall) {
  const args = parseToolArgs(toolCall.arguments);

  // Non-debug: show only the description when available
  if (!isDebug) {
    const description = typeof args.description === "string" ? args.description : null;
    if (description) {
      return context.send("tool-call", description);
    }
  }

  // For Edit/Write tool calls, render the code content as a syntax-highlighted image
  const name = toolCall.name;
  if ((name === "Edit" || name === "Write") && typeof args.file_path === "string") {
    const lang = langFromPath(args.file_path);
    /** @type {ToolContentBlock[]} */
    const blocks = [{ type: "text", text: `🔧 *${name}*\n${args.file_path}` }];
    if (name === "Edit" && typeof args.old_string === "string" && typeof args.new_string === "string" && lang) {
      // Render a diff image showing old → new
      blocks.push({ type: "diff", oldStr: args.old_string, newStr: args.new_string, language: lang });
    } else if (name === "Write" && typeof args.content === "string" && args.content.trim() && lang) {
      blocks.push({ type: "code", code: args.content, language: lang });
    }
    return context.send("tool-call", blocks);
  }

  let msg = isDebug ? `*${toolCall.name}*` : toolCall.name;

  if (formatToolCall) {
    msg += `: ${formatToolCall(args)}`;
  } else {
    const entries = Object.entries(args);
    if (entries.length > 0) {
      const inline = entries.map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return entries.length === 1 ? val : `${k}: ${val}`;
      }).join(", ");
      if (isDebug) {
        msg += `\n${inline}`;
      } else if (inline.length <= 80) {
        msg += `: ${inline}`;
      }
    }
  }

  return context.send("tool-call", msg);
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

  const textBlocks = blocks.filter(b => b.type === "text");
  const nonTextBlocks = blocks.filter(b => b.type !== "text");

  if (isDebug) {
    const textSummary = textBlocks.map(b => /** @type {TextContentBlock} */ (b).text).join("\n");
    await context.send("tool-result", `${toolName}: ${textSummary || "Done."}`);
    if (nonTextBlocks.length > 0) await context.send("tool-result", nonTextBlocks);
  } else if (permissions.autoContinue) {
    // autoContinue: suppress text, but still show media/code blocks
    if (nonTextBlocks.length > 0) await context.send("tool-result", nonTextBlocks);
  } else {
    // Final answer: render all blocks
    await context.reply("tool-result", blocks);
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
  const { addMessage, updateToolMessage, createChat, getChat, getMessages, updateSdkSessionId } = store;

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
   * Handle a regular (non-command) message: format, store, and run through the LLM harness.
   * @param {object} opts
   * @param {IncomingContext} opts.messageContext
   * @param {import("./store.js").ChatRow | undefined} opts.chatInfo
   * @param {boolean} opts.isDebug
   * @param {ExecuteActionContext} opts.context
   * @param {Action[]} opts.actions
   * @param {(name: string) => Promise<AppAction | null>} opts.actionResolver
   * @param {TextContentBlock | undefined} opts.firstBlock
   */
  async function handleLlmMessage({ messageContext, chatInfo, isDebug, context, actions, actionResolver, firstBlock }) {
    const { chatId, senderIds, content, isGroup, senderName, selfIds, quotedSenderId } = messageContext;

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

    // If a harness is waiting for a user response (onAskUser), resolve it
    // with this message instead of starting a new query or injecting.
    const pendingResolve = pendingUserResponses.get(chatId);
    if (pendingResolve) {
      pendingUserResponses.delete(chatId);
      pendingResolve(firstBlock?.text ?? "");
      return;
    }

    log.debug("LLM will respond");

    // Resolve active persona (if any)
    const persona = chatInfo?.active_persona ? await getAgent(chatInfo.active_persona) : null;

    // If the harness has an active query for this chat, inject the message instead of starting a new one
    const harnessName = resolveHarnessName(persona, chatInfo);
    const harness = resolveHarness(harnessName);

    const userText = firstBlock?.text ?? "";
    if (userText && harness.injectMessage?.(chatId, userText)) {
      log.debug("Injected message into active query for chat", chatId);
      return;
    }

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
      onAskUser: async (question, options, _preamble) => {
        await context.sendPoll(question || "Choose an option:", options, 1);
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingUserResponses.delete(chatId);
            resolve("");
          }, ASK_USER_TIMEOUT_MS);
          pendingUserResponses.set(chatId, (text) => {
            clearTimeout(timer);
            resolve(text);
          });
        });
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

    // harness already resolved above (before injection check)
    await messageContext.sendPresenceUpdate("composing");
    try {
      await harness.processLlmResponse({ session, llmConfig, messages: preparedMessages, mediaRegistry, hooks, cwd: chatInfo?.harness_cwd ?? undefined });
    } catch (error) {
      log.error(error);
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
      await context.reply("error", errorMessage);
    } finally {
      await messageContext.sendPresenceUpdate("paused");
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

    const firstBlock = content.find(block=>block.type === "text")

    if (firstBlock?.text?.startsWith("!")) {
      return handleCommandMessage({ chatId, senderIds, content, firstBlock, chatInfo, context, actions, actionResolver });
    }

    return handleLlmMessage({ messageContext, chatInfo, isDebug, context, actions, actionResolver, firstBlock });
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
} catch { /* SDK not installed, skip */ }

if (!process.env.TESTING) {
  // Prevent duplicate instances: if old PID is still running, kill it first
  const pidFile = ".bot.pid";
  if (fs.existsSync(pidFile)) {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
    try {
      process.kill(oldPid, 0); // check if alive
      console.log(`Killing previous instance (PID ${oldPid})...`);
      process.kill(oldPid, "SIGTERM");
      const start = Date.now();
      while (Date.now() - start < 3000) {
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

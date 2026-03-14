/**
 * Claude Agent SDK harness — uses @anthropic-ai/claude-agent-sdk for agentic processing.
 *
 * All SDK built-in tools are enabled (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch).
 * Custom bot actions are exposed as Skills (SKILL.md files) rather than MCP tools.
 * Chat-specific actions are embedded in the system prompt.
 *
 * Supports mid-conversation message injection via streamInput() and cancellation via AbortController.
 * Whitelisted tools are auto-approved; AskUserQuestion has a custom handler;
 * all other tools are prompted to the user for approval via canUseTool.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { NO_OP_HOOKS } from "./native.js";
import { formatToolCallDisplay, getToolCallSummary } from "../tool-display.js";
import { getChatActions } from "../actions.js";
import { createLogger } from "../logger.js";
import { extractLastUserText } from "../message-formatting.js";
import { createToolMessage, errorToString, registerInspectHandler } from "../utils.js";
import { getRootDb } from "../db.js";

const log = createLogger("harness:claude-agent-sdk");

// ── Tool approval whitelist ─────────────────────────────────────────────

/** Tools that are auto-approved without prompting the user. */
const AUTO_APPROVED_TOOLS = new Set([
  // Code tools
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit",
  // Agent/task tools
  "Agent", "TaskOutput", "TaskStop",
  // Web tools
  "WebFetch", "WebSearch",
  // Planning
  "EnterPlanMode",
  // Config/workspace
  "TodoWrite", "EnterWorktree", "ToolSearch", "Skill",
]);

// ── Cached SDK model list ──────────────────────────────────────────────

/** @type {import("@anthropic-ai/claude-agent-sdk").ModelInfo[] | null} */
let cachedModels = null;


/** @type {Array<{ value: string, displayName: string, description: string }>} */
const FALLBACK_MODELS = [
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Fast, balanced" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Most capable" },
  { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Fastest, lightweight" },
];

/**
 * Get available models from SDK cache with fallback.
 * @returns {Array<{ value: string, displayName: string, description: string }>}
 */
export function getModels() {
  if (cachedModels && cachedModels.length > 0) {
    return cachedModels.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }));
  }
  return FALLBACK_MODELS;
}

/**
 * Set or clear the SDK model for a chat. Returns a confirmation string.
 * @param {string} chatId
 * @param {string} arg - model name/alias, or "off"/"default"/"none" to clear
 * @returns {Promise<string>}
 */
export async function handleModelCommand(chatId, arg) {
  const db = getRootDb();

  if (arg === "off" || arg === "default" || arg === "none") {
    await db.sql`UPDATE chats SET sdk_model = NULL WHERE chat_id = ${chatId}`;
    return "SDK model reset to default.";
  }

  const models = getModels();
  const input = arg.toLowerCase();
  const match = models.find(
    (m) => m.value === input || m.value.includes(input) || m.displayName.toLowerCase() === input,
  );
  const modelValue = match ? match.value : input;

  await db.sql`UPDATE chats SET sdk_model = ${modelValue} WHERE chat_id = ${chatId}`;
  return match
    ? `SDK model set to \`${match.value}\` (${match.displayName})`
    : `SDK model set to \`${modelValue}\``;
}

/** @type {Record<string, string>} */
const EFFORT_LABELS = {
  low: "Low — fast, minimal thinking",
  medium: "Medium — balanced",
  high: "High — deep reasoning (default)",
  max: "Max — maximum effort",
};

/** @type {string[]} */
const FALLBACK_EFFORT_LEVELS = ["low", "medium", "high"];

/**
 * Get available effort levels for a specific model.
 * Uses SDK metadata when available, falls back to low/medium/high.
 * @param {string | null} modelValue - the sdk_model value, or null for default
 * @returns {Array<{ value: string, label: string }>}
 */
export function getEffortLevels(modelValue) {
  /** @type {string[]} */
  let levels = FALLBACK_EFFORT_LEVELS;
  if (cachedModels && modelValue) {
    const model = cachedModels.find((m) => m.value === modelValue);
    if (model?.supportedEffortLevels?.length) {
      levels = model.supportedEffortLevels;
    } else if (model && !model.supportsEffort) {
      return [];
    }
  } else if (cachedModels && !modelValue) {
    // Default model — find it in the cache
    const defaultModel = cachedModels.find((m) => m.value.includes("sonnet"));
    if (defaultModel?.supportedEffortLevels?.length) {
      levels = defaultModel.supportedEffortLevels;
    } else if (defaultModel && !defaultModel.supportsEffort) {
      return [];
    }
  }
  return levels.map((v) => ({ value: v, label: EFFORT_LABELS[v] ?? v }));
}

/**
 * Set or clear the SDK effort for a chat. Returns a confirmation string.
 * @param {string} chatId
 * @param {string} arg - effort level, or "off"/"default"/"none" to clear
 * @returns {Promise<string>}
 */
export async function handleEffortCommand(chatId, arg) {
  const db = getRootDb();

  if (arg === "off" || arg === "default" || arg === "none") {
    await db.sql`UPDATE chats SET sdk_effort = NULL WHERE chat_id = ${chatId}`;
    return "SDK effort reset to default (high).";
  }

  const input = arg.toLowerCase();
  const validLevels = ["low", "medium", "high", "max"];
  if (validLevels.includes(input)) {
    await db.sql`UPDATE chats SET sdk_effort = ${input} WHERE chat_id = ${chatId}`;
    return `SDK effort set to \`${input}\``;
  }
  return `Unknown effort level \`${arg}\`. Use: ${validLevels.join(", ")}`;
}

/**
 * Build the full system prompt for the SDK, including:
 * - Base system prompt from llmConfig
 * - Chat ID and runtime context
 * - DB paths
 * - Chat-specific action descriptions
 *
 * @param {LlmConfig} llmConfig
 * @param {string} chatId
 * @param {string[]} senderIds
 * @returns {Promise<string>}
 */
async function buildSystemPrompt(llmConfig, chatId, senderIds) {
  let prompt = llmConfig.systemPrompt;

  const promptTemplate = readFileSync(new URL("./claude-agent-sdk-prompt.md", import.meta.url), "utf-8");
  prompt += "\n\n" + promptTemplate
    .replace(/\{\{chatId\}\}/g, chatId)
    .replace(/\{\{senderIds\}\}/g, senderIds.join(", "));

  // CLAUDE.md is loaded automatically by the SDK via settingSources: ["project"]

  // Inject chat-specific action descriptions
  try {
    const chatActions = await getChatActions(chatId);
    if (chatActions.length > 0) {
      prompt += "\n\n## Chat-specific actions\n";
      prompt += "These are custom actions created by users for this chat. Execute them by writing and running the appropriate code.\n";
      for (const action of chatActions) {
        prompt += `\n### ${action.name}\n${action.description}\n`;
        prompt += `Parameters: ${JSON.stringify(action.parameters)}\n`;
      }
    }
  } catch (err) {
    log.error("Failed to load chat actions for system prompt:", err);
  }

  return prompt;
}

/**
 * State for an active SDK query, used for injection and cancellation.
 * `query` is null during setup; messages arriving in that window are buffered
 * in `pendingMessages` and flushed once the query starts.
 * @typedef {{
 *   query: import("@anthropic-ai/claude-agent-sdk").Query | null;
 *   abortController: AbortController;
 *   sessionId: string;
 *   pendingMessages: string[];
 * }} ActiveQuery
 */

/**
 * Entry in the activeTools map, tracking a tool call's display state.
 * @typedef {{
 *   handle?: MessageHandle,
 *   toolName: string,
 *   summary?: string,
 *   filePath?: string,
 * }} ActiveToolEntry
 */

/**
 * Shared mutable state passed to SDK event handlers.
 * @typedef {{
 *   result: AgentResult,
 *   messages: AgentHarnessParams["messages"],
 *   activeTools: Map<string, ActiveToolEntry>,
 *   hooks: Required<AgentIOHooks>,
 *   session: AgentHarnessParams["session"],
 *   cwd: string | null | undefined,
 * }} SdkEventContext
 */

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
  try { return await fn(); }
  catch (err) { logSuppressedHookError(name, err); return fallback; }
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
    onLlmResponse: (/** @type {string} */ text) => safeHook("onLlmResponse", () => rawHooks.onLlmResponse(text), undefined),
    onAskUser: (/** @type {string} */ question, /** @type {string[]} */ options, /** @type {string | undefined} */ preamble, /** @type {string[] | undefined} */ descriptions) =>
      safeHook("onAskUser", () => rawHooks.onAskUser(question, options, preamble, descriptions), ""),
    onToolCall: (/** @type {LlmChatResponse['toolCalls'][0]} */ toolCall, /** @type {((params: Record<string, any>) => string) | undefined} */ formatToolCall) =>
      safeHook("onToolCall", () => rawHooks.onToolCall(toolCall, formatToolCall), undefined),
    onToolResult: (/** @type {ToolContentBlock[]} */ blocks, /** @type {string} */ toolName, /** @type {PermissionFlags} */ permissions) =>
      safeHook("onToolResult", () => rawHooks.onToolResult(blocks, toolName, permissions), undefined),
    onToolError: (/** @type {string} */ error) => safeHook("onToolError", () => rawHooks.onToolError(error), undefined),
    onContinuePrompt: () => safeHook("onContinuePrompt", () => rawHooks.onContinuePrompt(), true),
    onDepthLimit: () => safeHook("onDepthLimit", () => rawHooks.onDepthLimit(), false),
    onUsage: (/** @type {string} */ cost, /** @type {{ prompt: number; completion: number; cached: number }} */ tokens) =>
      safeHook("onUsage", () => rawHooks.onUsage(cost, tokens), undefined),
  };
}

/**
 * Create the Claude Agent SDK harness.
 * Maintains per-chat active query state for message injection and cancellation.
 * @returns {AgentHarness}
 */
export function createClaudeAgentSdkHarness() {
  /** @type {Map<string, ActiveQuery>} */
  const activeQueries = new Map();

  /** Max time (ms) to wait for active queries before force-cancelling them */
  const SHUTDOWN_TIMEOUT_MS = 120_000;

  return { processLlmResponse, injectMessage, cancel, waitForIdle };

  /**
   * Wait for all active queries to finish (drain the activeQueries map).
   * Resolves immediately if no queries are running.
   *
   * Notifies each active query via message injection that a shutdown is
   * pending and it should wrap up. If queries don't finish within the
   * timeout, they are force-cancelled.
   * @returns {Promise<string[]>} chat IDs that were waited on
   */
  function waitForIdle() {
    if (activeQueries.size === 0) return Promise.resolve([]);

    const chatIds = [...activeQueries.keys()];
    log.info(`Waiting for ${chatIds.length} active query(ies) to finish: ${chatIds.join(", ")}`);

    // Notify each active query that a restart is pending
    const shutdownNotice =
      "⚠️ SERVER RESTART: The server is shutting down and waiting for your query to finish. " +
      "You are one of the active queries blocking the restart. " +
      "Finish your current task immediately and end your response — do NOT start new tool calls.";
    for (const chatId of chatIds) {
      injectMessage(chatId, shutdownNotice);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        const remaining = [...activeQueries.keys()];
        log.warn(`Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) — force-cancelling ${remaining.length} query(ies): ${remaining.join(", ")}`);
        for (const chatId of remaining) {
          cancel(chatId);
        }
        resolve(chatIds);
      }, SHUTDOWN_TIMEOUT_MS);

      const interval = setInterval(() => {
        if (activeQueries.size === 0) {
          clearInterval(interval);
          clearTimeout(timeout);
          log.info("All queries finished, ready to shut down.");
          resolve(chatIds);
        }
      }, 200);
    });
  }

  /**
   * Inject a follow-up user message into a running query for the given chat.
   * @param {string} chatId
   * @param {string} text
   * @returns {boolean} true if injected, false if no active query
   */
  function injectMessage(chatId, text) {
    const active = activeQueries.get(chatId);
    if (!active) return false;

    // If the query hasn't started yet (still in setup), buffer the message
    if (!active.query) {
      active.pendingMessages.push(text);
      log.debug(`Buffered message for pending query on chat ${chatId}: "${text.slice(0, 80)}"`);
      return true;
    }

    /** @type {import("@anthropic-ai/claude-agent-sdk").SDKUserMessage} */
    const sdkMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: active.sessionId,
    };

    // streamInput expects an AsyncIterable — wrap in an async generator
    active.query.streamInput((async function* () {
      yield sdkMessage;
    })()).catch(err => {
      log.error("Failed to inject message into active query:", err);
    });

    log.debug(`Injected message into active query for chat ${chatId}: "${text.slice(0, 80)}"`);
    return true;
  }

  /**
   * Cancel the active query for the given chat.
   * @param {string} chatId
   * @returns {boolean} true if cancelled, false if no active query
   */
  function cancel(chatId) {
    const active = activeQueries.get(chatId);
    if (!active) return false;

    log.debug(`Cancelling active query for chat ${chatId}`);
    active.abortController.abort();
    return true;
  }

  /**
   * @param {AgentHarnessParams} params
   * @returns {Promise<AgentResult>}
   */
  async function processLlmResponse({ session, llmConfig, messages, hooks: userHooks, maxDepth, cwd, sdkModel, sdkEffort }) {
    const rawHooks = { ...NO_OP_HOOKS, ...userHooks };
    const hooks = wrapHooksWithFallbacks(rawHooks);

    const lastUserText = extractLastUserText(messages);

    if (!lastUserText) {
      log.error("No user text found in messages");
      return {
        response: [{ type: "text", text: "No input message found." }],
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    }

    /** @type {AgentResult} */
    const result = {
      response: [],
      messages,
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
    };

    const abortController = new AbortController();

    // Register early so messages arriving during setup get buffered
    // instead of spawning a parallel query (fixes race condition).
    activeQueries.set(session.chatId, {
      query: null, abortController, sessionId: "", pendingMessages: [],
    });

    const existingSessionId = session.sdkSessionId ?? null;

    const fullSystemPrompt = await buildSystemPrompt(llmConfig, session.chatId, session.senderIds);

    /** @type {string | null} */
    let resolvedSessionId = null;

    /** @type {string | null} Set when we auto-abort due to a fatal SDK error */
    let fatalAbortReason = null;

    // Ring buffer: only keep the last N stderr lines (up to MAX_STDERR_BYTES total)
    // for error diagnostics. The SDK subprocess runs with --verbose, producing
    // massive debug output that was previously accumulated unboundedly (OOM at ~1.9GB).
    const MAX_STDERR_LINES = 200;
    const MAX_STDERR_BYTES = 50_000;
    /** @type {string[]} */
    const stderrLines = [];
    let stderrBytes = 0;

    /** @type {Map<string, ActiveToolEntry>} */
    const activeTools = new Map();

    try {
      /** @type {import("@anthropic-ai/claude-agent-sdk").Options} */
      const queryOptions = {
        systemPrompt: fullSystemPrompt,
        maxTurns: maxDepth ?? 50,
        cwd: cwd ?? process.cwd(),
        settingSources: ["project"],
        // Use acceptEdits so the SDK's permission state machine stays active —
        // this lets plan mode (EnterPlanMode / ExitPlanMode) work properly.
        // canUseTool auto-approves all other tools, so behavior is effectively
        // the same as bypassPermissions for non-plan operations.
        permissionMode: "acceptEdits",
        allowDangerouslySkipPermissions: true,
        persistSession: true,
        abortController,
        ...(sdkModel && { model: sdkModel }),
        ...(sdkEffort && { effort: sdkEffort }),
        stderr: (/** @type {string} */ data) => {
          stderrBytes += data.length;
          while (stderrLines.length >= MAX_STDERR_LINES || stderrBytes > MAX_STDERR_BYTES) {
            const removed = stderrLines.shift();
            if (!removed) break;
            stderrBytes -= removed.length;
          }
          stderrLines.push(data);
          log.debug("[sdk stderr]", data.trimEnd());

          // Detect fatal stream errors in hook callbacks. When the SDK's
          // internal stream dies, every subsequent tool use fails with
          // "Stream closed" creating an infinite retry loop. Abort early.
          if (data.includes("Stream closed") && data.includes("Error in hook callback")) {
            fatalAbortReason = "SDK internal stream closed — session needs restart";
            log.error(fatalAbortReason + "; aborting query");
            abortController.abort();
          }
        },
        /**
         * Handle tool permission requests.
         * Whitelisted tools are auto-approved. AskUserQuestion has a custom
         * handler (structured Q&A). Everything else is prompted to the user
         * with a generic Allow/Deny poll showing tool name and input summary.
         * @type {import("@anthropic-ai/claude-agent-sdk").CanUseTool}
         */
        canUseTool: async (toolName, input, _options) => {
          if (toolName === "AskUserQuestion") {
            return handleAskUserQuestion(input, hooks.onAskUser);
          }
          if (AUTO_APPROVED_TOOLS.has(toolName)) {
            return { behavior: "allow", updatedInput: input };
          }
          return handleToolApproval(toolName, input, hooks.onAskUser);
        },
        hooks: {
          PreToolUse: [{
            hooks: [
              /** @type {import("@anthropic-ai/claude-agent-sdk").HookCallback} */
              async (hookInput, toolUseId) => {
                const input = /** @type {import("@anthropic-ai/claude-agent-sdk").PreToolUseHookInput} */ (hookInput);
                const toolInput = /** @type {Record<string, unknown>} */ (input.tool_input);

                // Capture file content for display context (Write diffs, Edit line numbers)
                /** @type {{ oldContent?: string; startLine?: number } | undefined} */
                let displayContext;
                const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
                if (filePath && existsSync(filePath)) {
                  const fileContent = readFileSync(filePath, "utf-8");
                  if (input.tool_name === "Write") {
                    displayContext = { oldContent: fileContent };
                  } else if (input.tool_name === "Edit" && typeof toolInput.old_string === "string") {
                    const idx = fileContent.indexOf(toolInput.old_string);
                    if (idx !== -1) {
                      const startLine = fileContent.slice(0, idx).split("\n").length;
                      displayContext = { startLine };
                    }
                  }
                }

                // Display tool call and store handle for inspect handler
                if (toolUseId) {
                  const toolCall = { id: toolUseId, name: input.tool_name, arguments: JSON.stringify(toolInput) };
                  const content = formatToolCallDisplay(toolCall, undefined, cwd, displayContext);
                  const summary = getToolCallSummary(input.tool_name, toolInput, undefined, cwd, displayContext);
                  /** @type {MessageHandle | undefined} */
                  let handle;
                  if (content != null) {
                    try {
                      handle = await session.context.send("tool-call", content);
                    } catch (err) {
                      log.warn("PreToolUse display failed:", errorToString(err));
                    }
                  }
                  activeTools.set(toolUseId, {
                    handle: handle ?? undefined,
                    toolName: input.tool_name,
                    summary,
                    ...(filePath && { filePath }),
                  });
                }

                return {};
              },
            ],
          }],
        },
      };

      // Resume the previous session if one exists for this chat
      if (existingSessionId) {
        queryOptions.resume = existingSessionId;
        log.info(`Resuming SDK session ${existingSessionId} for chat ${session.chatId}`);
      }

      const q = query({
        prompt: lastUserText,
        options: queryOptions,
      });

      // Promote the placeholder with the real query object and flush buffered messages
      const sessionId = existingSessionId ?? randomUUID();
      const pending = activeQueries.get(session.chatId);
      const buffered = pending?.pendingMessages ?? [];
      activeQueries.set(session.chatId, { query: q, abortController, sessionId, pendingMessages: [] });

      // Flush any messages that arrived during setup
      for (const text of buffered) {
        log.debug(`Flushing buffered message for chat ${session.chatId}: "${text.slice(0, 80)}"`);
        injectMessage(session.chatId, text);
      }

      // Cache available models on first query (non-blocking)
      if (!cachedModels) {
        q.supportedModels()
          .then((models) => { cachedModels = models; })
          .catch((err) => log.warn("Failed to fetch SDK models:", err));
      }

      /** @type {SdkEventContext} */
      const ctx = { result, messages, activeTools, hooks, session, cwd: cwd ?? null };

      let eventCount = 0;

      for await (const event of q) {
        eventCount++;

        // Log event with tool context for tracing what the SDK is doing.
        log.debug(`SDK event: ${getSdkEventLabel(event)}`);

        // Always capture the latest session_id from events.
        if ("session_id" in event && typeof event.session_id === "string") {
          if (resolvedSessionId !== event.session_id) {
            resolvedSessionId = event.session_id;
            const active = activeQueries.get(session.chatId);
            if (active) active.sessionId = resolvedSessionId;
          }
        }

        switch (event.type) {
          case "assistant": await handleAssistantEvent(event, ctx); break;
          case "result": await handleResultEvent(event, ctx); break;
          case "tool_progress": break;
          case "user": await handleUserEvent(event, ctx); break;
          case "tool_use_summary": await handleToolUseSummaryEvent(event, ctx); break;
          default: break;
        }

        // Re-send composing before the next slow await (LLM call or tool execution)
        if (event.type !== "result") {
          await hooks.onComposing();
        }
      }
      log.debug(`SDK query done: events=${eventCount} activeTools=${activeTools.size}`);
    } catch (err) {
      // Don't log user-initiated abort as an error — it's expected from !cancel
      if (abortController.signal.aborted && !fatalAbortReason) {
        log.debug("SDK query was cancelled for chat", session.chatId);
      } else if (fatalAbortReason) {
        log.error("SDK query aborted due to fatal error:", fatalAbortReason);
        await hooks.onToolError(fatalAbortReason);
        result.response = [{ type: "text", text: fatalAbortReason }];
      } else {
        const errorMsg = errorToString(err);

        // If resume failed (session not found / corrupt), clear the stale session ID
        // so the next message starts fresh instead of hitting the same error.
        if (existingSessionId && !resolvedSessionId) {
          log.warn(`Resume failed for session ${existingSessionId}, clearing stale session ID`);
          if (session.updateSdkSessionId) {
            try {
              await session.updateSdkSessionId(session.chatId, null);
            } catch (clearErr) {
              log.error("Failed to clear stale SDK session ID:", clearErr);
            }
          }
        }

        log.error("Claude Agent SDK query failed:", err);
        if (stderrLines.length > 0) {
          log.error(`[sdk stderr tail (last ${stderrLines.length} chunks)]`, stderrLines.join(""));
        }
        let displayMsg = errorMsg;
        if (errorMsg.includes("executable not found") && cwd) {
          displayMsg += `\n\nHint: The harness_cwd is set to "${cwd}" — make sure this path exists. Use \`!config harness_cwd <path>\` to fix it.`;
        }
        await hooks.onToolError(displayMsg);
        result.response = [{ type: "text", text: `SDK error: ${displayMsg}` }];
      }
    } finally {
      activeQueries.delete(session.chatId);

      // Persist the SDK session ID so the next message can resume the conversation.
      // Save when: we got a session ID AND it differs from what was stored.
      if (resolvedSessionId && resolvedSessionId !== existingSessionId && session.updateSdkSessionId) {
        try {
          await session.updateSdkSessionId(session.chatId, resolvedSessionId);
          log.info(`Saved SDK session ${resolvedSessionId} for chat ${session.chatId}`);
        } catch (err) {
          log.error("Failed to persist SDK session ID:", err);
        }
      }
    }

    // Report usage
    if (result.usage.promptTokens > 0) {
      const costStr = result.usage.cost > 0 ? `$${result.usage.cost.toFixed(4)}` : "unknown";
      await hooks.onUsage(costStr, {
        prompt: result.usage.promptTokens,
        completion: result.usage.completionTokens,
        cached: result.usage.cachedTokens,
      });
    }

    // Store the final response if it wasn't already stored during an "assistant" event.
    const textBlocks = result.response.filter(b => b.type === "text");
    if (textBlocks.length > 0) {
      const lastStored = messages[messages.length - 1];
      const alreadyStored = lastStored?.role === "assistant"
        && /** @type {AssistantMessage} */ (lastStored).content.some(
          b => b.type === "text" && textBlocks.some(tb => /** @type {TextContentBlock} */ (tb).text === /** @type {TextContentBlock} */ (b).text),
        );
      if (!alreadyStored) {
        /** @type {AssistantMessage} */
        const assistantMessage = { role: "assistant", content: /** @type {TextContentBlock[]} */ (textBlocks) };
        messages.push(assistantMessage);
        await session.addMessage(session.chatId, assistantMessage, session.senderIds);
      }
    }

    return result;
  }
}

/**
 * @typedef {{ toolUseId: string | null, resultText: string | null }} ExtractedToolResult
 */

/**
 * Extract tool use ID and result text from an SDKUserMessage.
 *
 * Tool use ID resolution order:
 * 1. `message.content` tool_result blocks — carry the individual tool call ID
 *    (accurate for both main-agent and sub-agent results)
 * 2. `parent_tool_use_id` — fallback; for sub-agent events this points to the
 *    Agent tool call (not the individual tool), so it must not take priority.
 *
 * Result text is extracted from (in order):
 * 1. `tool_use_result` — convenience field (may be absent for built-in tools)
 * 2. `message.content` — standard Anthropic API format with tool_result blocks
 *
 * @param {import("@anthropic-ai/claude-agent-sdk").SDKUserMessage} userEvent
 * @returns {ExtractedToolResult}
 */
export function extractToolResultFromEvent(userEvent) {
  /** @type {string | null} */
  let toolUseId = null;
  /** @type {string | null} */
  let resultText = null;

  // Source 1: tool_use_result field (preferred when available)
  if ("tool_use_result" in userEvent && userEvent.tool_use_result != null) {
    resultText = extractToolResultText(userEvent.tool_use_result);
  }

  // Source 2: message.content — array of content blocks (tool_result blocks)
  // Preferred source for toolUseId (accurate for both main and sub-agent events).
  const message = userEvent.message;
  if (message && typeof message === "object" && "content" in message) {
    const content = /** @type {unknown} */ (message.content);

    // String content (simple tool result)
    if (resultText == null && typeof content === "string" && content.length > 0) {
      resultText = content;
    }

    // Array of content blocks
    if (Array.isArray(content)) {
      /** @type {string[]} */
      const texts = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = /** @type {Record<string, unknown>} */ (block);
        // tool_result block: { type: "tool_result", tool_use_id: "...", content: "..." | [...] }
        if (b.type === "tool_result") {
          // Prefer tool_use_id from content block (accurate for both main and sub-agent)
          if (!toolUseId && typeof b.tool_use_id === "string") {
            toolUseId = b.tool_use_id;
          }
          if (resultText == null) {
            const inner = b.content;
            if (typeof inner === "string") {
              texts.push(inner);
            } else if (Array.isArray(inner)) {
              for (const sub of inner) {
                if (sub && typeof sub === "object" && typeof /** @type {Record<string, unknown>} */ (sub).text === "string") {
                  texts.push(/** @type {{ text: string }} */ (sub).text);
                }
              }
            }
          }
        }
        // Plain text block (only if we don't already have result from tool_use_result)
        if (resultText == null && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
      if (resultText == null && texts.length > 0) resultText = texts.join("\n");
    }
  }

  // Fallback: use parent_tool_use_id only when no tool_use_id was found in content blocks.
  // For sub-agent events, parent_tool_use_id points to the Agent tool call, not the
  // individual tool — so it must not override the content block ID.
  if (!toolUseId) {
    toolUseId = userEvent.parent_tool_use_id ?? null;
  }

  return { toolUseId, resultText };
}

/**
 * Extract a displayable text string from a tool_use_result value.
 * The SDK's `tool_use_result` field is typed as `unknown` and may be:
 * - a string
 * - an object / array (JSON-serializable)
 * - content blocks with `type` and `text` fields
 * @param {unknown} result
 * @returns {string}
 */
export function extractToolResultText(result) {
  if (typeof result === "string") return result;

  // Handle array of content blocks (e.g. [{ type: "text", text: "..." }])
  if (Array.isArray(result)) {
    const texts = result
      .filter((b) => hasTextField(b))
      .map((b) => /** @type {{ text: string }} */ (b).text);
    if (texts.length > 0) return texts.join("\n");
  }

  // Handle single content block
  if (hasTextField(result)) {
    return result.text;
  }

  // Fallback: JSON
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// ── SDK event handlers ──────────────────────────────────────────────────

/**
 * Check whether an SDK event originates from a sub-agent.
 * Sub-agent events have a non-null `parent_tool_use_id` pointing
 * to the Agent tool call that spawned them.
 * @param {{ parent_tool_use_id?: string | null }} event
 * @returns {boolean}
 */
function isSubagentEvent(event) {
  return event.parent_tool_use_id != null;
}

/**
 * Build a debug label for an SDK event (used for log.debug tracing).
 * @param {{ type: string, message?: { content?: Array<Record<string, unknown>> } }} event
 * @returns {string}
 */
function getSdkEventLabel(event) {
  if (event.type === "assistant" && event.message?.content) {
    const toolBlock = event.message.content.find(b => b.type === "tool_use");
    if (toolBlock) {
      const input = /** @type {Record<string, unknown>} */ (toolBlock.input ?? {});
      const inputSummary = String(
        input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.prompt ?? input.description ?? ""
      ).slice(0, 80);
      return `tool_use:${toolBlock.name}(${inputSummary})`;
    }
  }
  return event.type;
}

/**
 * Handle an SDK "assistant" event: dispatch text/tool blocks to hooks and persist.
 *
 * Sub-agent events (parent_tool_use_id != null) are displayed with an "*Agent:*"
 * prefix but not persisted to the conversation history — the SDK manages
 * sub-agent history internally.
 * @param {{ message: { content?: Array<Record<string, unknown>>, usage?: Record<string, number> }, parent_tool_use_id?: string | null }} event
 * @param {SdkEventContext} ctx
 */
async function handleAssistantEvent(event, ctx) {
  const isSubagent = isSubagentEvent(event);
  const betaMessage = event.message;
  if (betaMessage.content) {
    /** @type {(TextContentBlock | ToolCallContentBlock)[]} */
    const storedBlocks = [];

    for (const block of betaMessage.content) {
      if (block.type === "text") {
        const text = /** @type {string} */ (block.text);
        log.debug(`  block: text len=${text.length} subagent=${isSubagent}`);
        const displayText = isSubagent ? `*Agent:* ${text}` : text;
        await ctx.hooks.onLlmResponse(displayText);
        if (!isSubagent) {
          ctx.result.response.push({ type: "text", text });
        }
        storedBlocks.push({ type: "text", text });
      } else if (block.type === "tool_use") {
        const name = /** @type {string} */ (block.name);
        const id = /** @type {string} */ (block.id);
        log.debug(`  block: tool_use ${name} subagent=${isSubagent}`);
        // Display + activeTools entry already handled by PreToolUse hook
        storedBlocks.push({
          type: "tool",
          tool_id: id,
          name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    // Only persist main-agent messages to conversation history
    if (!isSubagent && storedBlocks.length > 0) {
      /** @type {AssistantMessage} */
      const assistantMsg = { role: "assistant", content: storedBlocks };
      ctx.messages.push(assistantMsg);
      await ctx.session.addMessage(ctx.session.chatId, assistantMsg, ctx.session.senderIds);
    }
  }
  if (betaMessage.usage) {
    ctx.result.usage.promptTokens += betaMessage.usage.input_tokens ?? 0;
    ctx.result.usage.completionTokens += betaMessage.usage.output_tokens ?? 0;
    ctx.result.usage.cachedTokens += /** @type {SdkUsageWithCache} */ (betaMessage.usage).cache_read_input_tokens ?? 0;
  }
}

/**
 * Handle an SDK "result" event: capture final response, usage, and errors.
 * @param {import("@anthropic-ai/claude-agent-sdk").SDKResultMessage} event
 * @param {SdkEventContext} ctx
 */
async function handleResultEvent(event, ctx) {
  log.debug(`SDK result: subtype=${event.subtype}, is_error=${event.is_error}, has_result=${"result" in event}, responseBlocks=${ctx.result.response.length}`);

  if (!event.is_error && "result" in event && typeof event.result === "string") {
    const resultText = event.result;
    const lastSent = ctx.result.response[ctx.result.response.length - 1];
    const alreadySent = lastSent?.type === "text"
      && lastSent.text.trim() === resultText.trim();
    log.debug(`SDK result text: len=${resultText.length}, alreadySent=${alreadySent}`);
    ctx.result.response = [{ type: "text", text: resultText }];
    if (!alreadySent && resultText.trim()) {
      await ctx.hooks.onLlmResponse(resultText);
    }
  }
  if (event.usage) {
    ctx.result.usage.promptTokens = event.usage.input_tokens ?? ctx.result.usage.promptTokens;
    ctx.result.usage.completionTokens = event.usage.output_tokens ?? ctx.result.usage.completionTokens;
    ctx.result.usage.cachedTokens = /** @type {SdkUsageWithCache} */ (event.usage).cache_read_input_tokens ?? ctx.result.usage.cachedTokens;
  }
  if (typeof event.total_cost_usd === "number") {
    ctx.result.usage.cost = event.total_cost_usd;
  }

  if (event.is_error) {
    const errors = /** @type {import("@anthropic-ai/claude-agent-sdk").SDKResultError} */ (event).errors;
    log.error("SDK query ended with error:", errors);
    if (errors?.length > 0) {
      await ctx.hooks.onToolError(errors.join("; "));
    }
  }
}


/**
 * Handle an SDK "user" event (tool result): persist and register inspect.
 *
 * Main and sub-agent tool results are treated the same — persisted to DB
 * and wired up for 👁 inspect. The only difference: sub-agent results are
 * not pushed to ctx.messages (the in-memory LLM context) since the SDK
 * manages sub-agent history internally.
 * @param {import("@anthropic-ai/claude-agent-sdk").SDKUserMessage} event
 * @param {SdkEventContext} ctx
 */
async function handleUserEvent(event, ctx) {
  const isSubagent = isSubagentEvent(event);
  const { toolUseId: resolvedToolUseId, resultText } = extractToolResultFromEvent(event);

  if (!resolvedToolUseId) return;

  const active = ctx.activeTools.get(resolvedToolUseId);

  if (resultText != null) {
    const toolMsg = createToolMessage(resolvedToolUseId, resultText);

    if (!isSubagent) {
      ctx.messages.push(toolMsg);
    }
    await ctx.session.addMessage(ctx.session.chatId, toolMsg, ctx.session.senderIds, active?.handle?.keyId);

    // Register 👁 react-to-inspect on the tool-call message handle
    if (active?.handle) {
      const summary = active.summary ?? `*${active.toolName}*`;
      registerInspectHandler(active.handle, summary, toolMsg, active.toolName);
    } else if (active) {
      log.warn(`No message handle for tool ${active.toolName} (${resolvedToolUseId}) — 👁 inspect unavailable`);
    }

  } else if (active) {
    log.warn(`No result text extracted for tool ${active.toolName} (${resolvedToolUseId}) — 👁 inspect unavailable`);
  }

  ctx.activeTools.delete(resolvedToolUseId);
}


/**
 * Handle an SDK "tool_use_summary" event: display summary as a tool call.
 * @param {{ summary?: string }} event
 * @param {SdkEventContext} ctx
 */
async function handleToolUseSummaryEvent(event, ctx) {
  if (event.summary) {
    await ctx.hooks.onToolCall({
      id: `summary-${randomUUID()}`,
      name: "Agent",
      arguments: JSON.stringify({ description: event.summary }),
    });
  }
}

// ── canUseTool handlers ─────────────────────────────────────────────────

/**
 * Handle an AskUserQuestion tool call by presenting questions as WhatsApp
 * polls and returning the user's selections in the SDK's expected format.
 * @param {Record<string, unknown>} input
 * @param {Required<AgentIOHooks>["onAskUser"]} onAskUser
 * @returns {Promise<import("@anthropic-ai/claude-agent-sdk").PermissionResult>}
 */
async function handleAskUserQuestion(input, onAskUser) {
  const questions = /** @type {Array<{question: string, header?: string, options: Array<{label: string, description?: string}>, multiSelect?: boolean}>} */ (
    input.questions ?? []
  );

  if (questions.length === 0) {
    return { behavior: "allow", updatedInput: input };
  }

  /** @type {Record<string, string>} */
  const answers = {};

  for (const q of questions) {
    const optionLabels = q.options.map(o => o.label);
    const optionDescriptions = q.options.map(o => o.description ?? "");
    const userChoice = await onAskUser(q.question, optionLabels, q.header, optionDescriptions);

    // Use the user's choice, or fall back to the first option on timeout
    answers[q.question] = userChoice || optionLabels[0];
  }

  return {
    behavior: "allow",
    updatedInput: { questions: input.questions, answers },
  };
}

/**
 * Generic handler for non-whitelisted tools. Prompts the user with the
 * tool name, asking them to Allow or Deny via a poll.
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @param {Required<AgentIOHooks>["onAskUser"]} onAskUser
 * @returns {Promise<import("@anthropic-ai/claude-agent-sdk").PermissionResult>}
 */
async function handleToolApproval(toolName, input, onAskUser) {
  const userChoice = await onAskUser(`Allow *${toolName}*?`, ["✅ Allow", "❌ Deny"]);

  if (userChoice === "❌ Deny") {
    return { behavior: "deny", message: `User denied the ${toolName} tool call.` };
  }

  return { behavior: "allow", updatedInput: input };
}

// ── Type guards ─────────────────────────────────────────────────────────

/**
 * Check if a value is an object with a string `text` field.
 * Used to safely extract text from SDK content blocks and tool results.
 * @param {unknown} value
 * @returns {value is { text: string }}
 */
export function hasTextField(value) {
  return value != null
    && typeof value === "object"
    && "text" in value
    && typeof /** @type {{ text: unknown }} */ (value).text === "string";
}

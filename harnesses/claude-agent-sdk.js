/**
 * Claude Agent SDK harness — uses @anthropic-ai/claude-agent-sdk for agentic processing.
 *
 * All SDK built-in tools are enabled (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch).
 * Custom bot actions are exposed as Skills (SKILL.md files) rather than MCP tools.
 * Chat-specific actions are embedded in the system prompt.
 *
 * Supports mid-conversation message injection via streamInput() and cancellation via AbortController.
 * Clarifying questions (AskUserQuestion) are handled via the canUseTool callback.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { NO_OP_HOOKS } from "./native.js";
import { getChatActions } from "../actions.js";
import { createLogger } from "../logger.js";
import { extractLastUserText } from "../message-formatting.js";
import { createToolMessage } from "../utils.js";
import { formatSdkToolCall } from "../tool-display.js";

const log = createLogger("harness:claude-agent-sdk");

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

  prompt += `\n\n## Runtime Context
- Chat ID: ${chatId}
- Sender IDs: ${senderIds.join(", ")}
- PGlite root database: ./pgdata/root
- PGlite chat database: ./pgdata/${chatId}
- Action databases: ./pgdata/${chatId}/<action_name>/

## User interaction
If you want to propose something and wait for the user's decision before acting, either use the AskUserQuestion tool (which pauses execution) or finish your response and let the user reply. Do NOT ask a question in plain text and then immediately act on it in the same turn — plain text does not pause execution.`;

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
  async function processLlmResponse({ session, llmConfig, messages, hooks: userHooks, maxDepth, cwd }) {
    const rawHooks = { ...NO_OP_HOOKS, ...userHooks };

    // Wrap every hook so that a WhatsApp send failure (e.g. "Connection Closed")
    // doesn't kill the entire SDK query loop. The SDK query is expensive and should
    // continue processing even if a hook can't deliver its output right now.
    /** @type {Required<AgentIOHooks>} */
    const hooks = /** @type {Required<AgentIOHooks>} */ (/** @type {unknown} */ (Object.fromEntries(
      Object.entries(rawHooks).map(([key, fn]) => [
        key,
        /** @param {any[]} args */
        async (...args) => {
          try {
            return await /** @type {Function} */ (fn)(...args);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isConnectionErr = msg.includes("Connection Closed") || msg.includes("Connection was lost");
            if (isConnectionErr) {
              log.warn(`Hook "${key}" failed (suppressed):`, msg);
            } else {
              log.error(`Hook "${key}" failed (suppressed):`, err);
            }
          }
        },
      ]),
    )));

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

    // Ring buffer: only keep the last N stderr lines for error diagnostics.
    // The SDK subprocess runs with --verbose, which produces massive debug output
    // that was previously accumulated unboundedly — causing OOM at ~1.9GB.
    const MAX_STDERR_LINES = 200;
    /** @type {string[]} */
    const stderrLines = [];
    try {
      /** @type {Record<string, unknown>} */
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
        // Don't pass llmConfig.chatModel — it's an OpenRouter model ID.
        // The SDK uses Claude Code's own model (configurable via its own settings).
        stderr: (/** @type {string} */ data) => {
          if (stderrLines.length >= MAX_STDERR_LINES) stderrLines.shift();
          stderrLines.push(data);
          log.debug("[sdk stderr]", data.trimEnd());
        },
        /**
         * Handle tool permission requests and AskUserQuestion.
         * All tools are auto-approved via canUseTool (equivalent to bypassPermissions).
         * AskUserQuestion is intercepted to present questions as WhatsApp polls.
         * @type {import("@anthropic-ai/claude-agent-sdk").CanUseTool}
         */
        canUseTool: async (toolName, input, _options) => {
          if (toolName === "AskUserQuestion") {
            return handleAskUserQuestion(input);
          }
          if (toolName === "ExitPlanMode") {
            return handleExitPlanMode(input);
          }
          // Auto-approve all tools — this gives us bypassPermissions behavior
          // while keeping the permission state machine active for plan mode.
          return { behavior: "allow", updatedInput: input };
        },
      };

      /**
       * Handle an AskUserQuestion tool call by presenting questions as WhatsApp
       * polls and returning the user's selections in the SDK's expected format.
       * @param {Record<string, unknown>} input
       * @returns {Promise<import("@anthropic-ai/claude-agent-sdk").PermissionResult>}
       */
      async function handleAskUserQuestion(input) {
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
          const userChoice = await hooks.onAskUser(q.question, optionLabels, q.header, optionDescriptions);

          // Use the user's choice, or fall back to the first option on timeout
          answers[q.question] = userChoice || optionLabels[0];
        }

        return {
          behavior: "allow",
          updatedInput: { questions: input.questions, answers },
        };
      }

      /**
       * Handle an ExitPlanMode tool call by presenting the plan to the user
       * for approval via a WhatsApp poll before allowing plan mode to exit.
       * @param {Record<string, unknown>} input
       * @returns {Promise<import("@anthropic-ai/claude-agent-sdk").PermissionResult>}
       */
      async function handleExitPlanMode(input) {
        const userChoice = await hooks.onAskUser(
          "Plan ready — approve to start implementation?",
          ["✅ Approve", "❌ Reject"],
        );

        if (userChoice === "❌ Reject") {
          return { behavior: "deny", message: "User rejected the plan. Revise your approach based on their feedback." };
        }

        return { behavior: "allow", updatedInput: input };
      }

      // Resume the previous session if one exists for this chat
      if (existingSessionId) {
        queryOptions.resume = existingSessionId;
        log.info(`Resuming SDK session ${existingSessionId} for chat ${session.chatId}`);
      }

      const q = query({
        prompt: lastUserText,
        options: /** @type {*} */ (queryOptions),
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

      /** @type {Map<string, { editor?: MessageEditor, toolName: string, description: string | null, waKeyId: string | null, isImage: boolean }>} */
      const activeTools = new Map();

      let eventCount = 0;

      for await (const event of q) {
        eventCount++;

        // Log event with tool context for tracing what the SDK is doing.
        /** @type {string} */
        let eventLabel = event.type;
        if (event.type === "assistant" && event.message?.content) {
          const toolBlock = event.message.content.find(
            /** @param {*} b */ (b) => b.type === "tool_use"
          );
          if (toolBlock) {
            const input = /** @type {Record<string, unknown>} */ (toolBlock.input ?? {});
            const inputSummary = String(
              input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.prompt ?? input.description ?? ""
            ).slice(0, 80);
            eventLabel = `tool_use:${toolBlock.name}(${inputSummary})`;
          }
        }
        log.debug(`SDK event: ${eventLabel}`);

        // Always capture the latest session_id from events.
        if ("session_id" in event && typeof event.session_id === "string") {
          if (resolvedSessionId !== event.session_id) {
            resolvedSessionId = event.session_id;
            const active = activeQueries.get(session.chatId);
            if (active) active.sessionId = resolvedSessionId;
          }
        }

        switch (event.type) {
          case "assistant": {
            // Extract text content from the BetaMessage
            const betaMessage = event.message;
            if (betaMessage.content) {
              /** @type {(TextContentBlock | ToolCallContentBlock)[]} */
              const storedBlocks = [];

              for (const block of betaMessage.content) {
                if (block.type === "text") {
                  log.debug(`  block: text len=${block.text.length}`);
                  await hooks.onLlmResponse(block.text);
                  result.response.push({ type: "text", text: block.text });
                  storedBlocks.push({ type: "text", text: block.text });
                } else if (block.type === "tool_use") {
                  log.debug(`  block: tool_use ${block.name}`);
                  const input = /** @type {Record<string, unknown>} */ (block.input ?? {});
                  const description = typeof input.description === "string" ? input.description : null;
                  // Build a human-readable label for the tool call (used on completion)
                  const displayLabel = description
                    || formatSdkToolCall(block.name, input)
                    || block.name;
                  const editor = await hooks.onToolCall({
                    id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  });
                  activeTools.set(block.id, {
                    editor: editor ?? undefined,
                    toolName: block.name,
                    description: displayLabel,
                    waKeyId: editor?.keyId ?? null,
                    isImage: editor?.isImage ?? false,
                  });
                  storedBlocks.push({
                    type: "tool",
                    tool_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  });
                }
              }

              // Persist assistant message (with tool_use blocks) to DB
              if (storedBlocks.length > 0) {
                /** @type {AssistantMessage} */
                const assistantMsg = { role: "assistant", content: storedBlocks };
                messages.push(assistantMsg);
                await session.addMessage(session.chatId, assistantMsg, session.senderIds);

              }
            }
            // Accumulate usage from each assistant message
            if (betaMessage.usage) {
              result.usage.promptTokens += betaMessage.usage.input_tokens ?? 0;
              result.usage.completionTokens += betaMessage.usage.output_tokens ?? 0;
              result.usage.cachedTokens += /** @type {*} */ (betaMessage.usage).cache_read_input_tokens ?? 0;
            }
            break;
          }

          case "result": {
            const resultEvent = /** @type {import("@anthropic-ai/claude-agent-sdk").SDKResultMessage} */ (event);
            log.debug(`SDK result: subtype=${resultEvent.subtype}, is_error=${resultEvent.is_error}, has_result=${"result" in resultEvent}, responseBlocks=${result.response.length}`);

            // Final result — the SDK's result string is the authoritative final answer.
            if (!resultEvent.is_error && "result" in resultEvent && typeof resultEvent.result === "string") {
              const resultText = resultEvent.result;
              // Check if this final text was already sent via an assistant event.
              const lastSent = result.response[result.response.length - 1];
              const alreadySent = lastSent?.type === "text"
                && lastSent.text.trim() === resultText.trim();
              log.debug(`SDK result text: len=${resultText.length}, alreadySent=${alreadySent}`);
              result.response = [{ type: "text", text: resultText }];
              if (!alreadySent && resultText.trim()) {
                await hooks.onLlmResponse(resultText);
              }
            }
            if (resultEvent.usage) {
              // Overwrite with final totals if available
              result.usage.promptTokens = resultEvent.usage.input_tokens ?? result.usage.promptTokens;
              result.usage.completionTokens = resultEvent.usage.output_tokens ?? result.usage.completionTokens;
              result.usage.cachedTokens = /** @type {*} */ (resultEvent.usage).cache_read_input_tokens ?? result.usage.cachedTokens;
            }
            if (typeof resultEvent.total_cost_usd === "number") {
              result.usage.cost = resultEvent.total_cost_usd;
            }

            if (resultEvent.is_error) {
              const errors = /** @type {import("@anthropic-ai/claude-agent-sdk").SDKResultError} */ (resultEvent).errors;
              log.error("SDK query ended with error:", errors);
              if (errors?.length > 0) {
                await hooks.onToolError(errors.join("; "));
              }
            }
            break;
          }

          case "tool_progress": {
            // Long-running tool feedback — edit the tool call message in-place.
            const progress = /** @type {import("@anthropic-ai/claude-agent-sdk").SDKToolProgressMessage} */ (event);
            const active = activeTools.get(progress.tool_use_id);
            if (active?.editor) {
              const elapsed = Math.round(progress.elapsed_time_seconds);
              await active.editor(`${active.toolName} (${elapsed}s…)`);
            }
            break;
          }

          case "user": {
            // Tool result — the SDK sends these as "user" events.
            // The result may be in `tool_use_result` (convenience field) OR in `message.content`
            // as tool_result content blocks (standard Anthropic API format).
            // NOTE: parent_tool_use_id is often null for built-in tools — fall back to
            // extracting the tool_use_id from message.content tool_result blocks.
            const userEvent = /** @type {import("@anthropic-ai/claude-agent-sdk").SDKUserMessage} */ (event);
            const { toolUseId: resolvedToolUseId, resultText } = extractToolResultFromEvent(userEvent);

            if (resolvedToolUseId) {
              const active = activeTools.get(resolvedToolUseId);

              if (resultText != null) {
                // Persist tool result to DB (with wa_key_id for react-to-inspect)
                /** @type {ToolMessage} */
                const toolMsg = {
                  ...createToolMessage(resolvedToolUseId, resultText),
                  ...(active?.waKeyId && { wa_key_id: active.waKeyId }),
                  ...(active?.toolName && { tool_name: active.toolName }),
                  ...(active?.isImage && { wa_msg_is_image: true }),
                };
                messages.push(toolMsg);
                await session.addMessage(session.chatId, toolMsg, session.senderIds);
              }

              // Restore original description (or tool name) on completion
              if (active?.editor) {
                try {
                  await active.editor(active.description || active.toolName);
                } catch (editorErr) {
                  log.error(`Editor failed for ${active.toolName}:`, editorErr);
                }
              }
              activeTools.delete(resolvedToolUseId);
            }
            break;
          }

          case "tool_use_summary": {
            // Compact summary of what SDK tools did (e.g. "Read 3 files").
            // Display via onToolCall so subagent activity is visible to the user
            // (consistent with how main-agent tool calls are displayed).
            const summary = /** @type {{ summary: string }} */ (event).summary;
            if (summary) {
              await hooks.onToolCall({
                id: `summary-${randomUUID()}`,
                name: "Agent",
                arguments: JSON.stringify({ description: summary }),
              });
            }
            break;
          }

          // Ignore system, stream_event, and other message types
          default:
            break;
        }
      }
      log.debug(`SDK query done: events=${eventCount} activeTools=${activeTools.size}`);
    } catch (err) {
      // Don't log abort as an error — it's expected from !cancel
      if (abortController.signal.aborted) {
        log.debug("SDK query was cancelled for chat", session.chatId);
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);

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
 * The SDK's `parent_tool_use_id` is often null for built-in tools, so we also
 * look inside `message.content` for `tool_result` blocks which carry the ID.
 *
 * Result text is extracted from (in order):
 * 1. `tool_use_result` — convenience field (may be absent for built-in tools)
 * 2. `message.content` — standard Anthropic API format with tool_result blocks
 *
 * @param {import("@anthropic-ai/claude-agent-sdk").SDKUserMessage} userEvent
 * @returns {ExtractedToolResult}
 */
function extractToolResultFromEvent(userEvent) {
  /** @type {string | null} */
  let toolUseId = userEvent.parent_tool_use_id ?? null;
  /** @type {string | null} */
  let resultText = null;

  // Source 1: tool_use_result field (preferred when available)
  if ("tool_use_result" in userEvent && userEvent.tool_use_result != null) {
    resultText = extractToolResultText(userEvent.tool_use_result);
  }

  // Source 2: message.content — array of content blocks (tool_result blocks)
  // Also used to resolve toolUseId when parent_tool_use_id is null.
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
          // Resolve toolUseId from content block when parent_tool_use_id is null
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
function extractToolResultText(result) {
  if (typeof result === "string") return result;

  // Handle array of content blocks (e.g. [{ type: "text", text: "..." }])
  if (Array.isArray(result)) {
    const texts = result
      .filter(/** @param {*} b */ (b) => b && typeof b === "object" && typeof b.text === "string")
      .map(/** @param {{ text: string }} b */ (b) => b.text);
    if (texts.length > 0) return texts.join("\n");
  }

  // Handle single content block
  if (result && typeof result === "object" && "text" in result && typeof /** @type {*} */ (result).text === "string") {
    return /** @type {{ text: string }} */ (result).text;
  }

  // Fallback: JSON
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

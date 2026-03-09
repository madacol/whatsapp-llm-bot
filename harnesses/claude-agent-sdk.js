/**
 * Claude Agent SDK harness — uses @anthropic-ai/claude-agent-sdk for agentic processing.
 *
 * All SDK built-in tools are enabled (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch).
 * Custom bot actions are exposed as Skills (SKILL.md files) rather than MCP tools.
 * Conversation history and chat-specific actions are embedded in the system prompt.
 *
 * Supports mid-conversation message injection via streamInput() and cancellation via AbortController.
 * Clarifying questions (AskUserQuestion) are handled via the canUseTool callback.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { NO_OP_HOOKS } from "./native.js";
import { getChatActions } from "../actions.js";
import { createLogger } from "../logger.js";
import { formatConversationHistory, extractLastUserText } from "../message-formatting.js";

const log = createLogger("harness:claude-agent-sdk");

/**
 * Build the full system prompt for the SDK, including:
 * - Base system prompt from llmConfig
 * - Chat ID and runtime context
 * - DB paths
 * - Conversation history (skipped when resuming — the SDK session already has it)
 * - Chat-specific action descriptions
 *
 * @param {LlmConfig} llmConfig
 * @param {Message[]} messages
 * @param {string} chatId
 * @param {string[]} senderIds
 * @param {{ resuming: boolean }} opts
 * @returns {Promise<string>}
 */
async function buildSystemPrompt(llmConfig, messages, chatId, senderIds, { resuming }) {
  let prompt = llmConfig.systemPrompt;

  prompt += `\n\n## Runtime Context
- Chat ID: ${chatId}
- Sender IDs: ${senderIds.join(", ")}
- PGlite root database: ./pgdata/root
- PGlite chat database: ./pgdata/${chatId}
- Action databases: ./pgdata/${chatId}/<action_name>/`;

  // When resuming, the SDK session already has the conversation history.
  // Only embed history for new sessions.
  if (!resuming) {
    const history = formatConversationHistory(messages);
    if (history) {
      prompt += `\n\n## Conversation History\n${history}`;
    }
  }

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

  return { processLlmResponse, injectMessage, cancel };

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
    const hooks = /** @type {Required<AgentIOHooks>} */ (Object.fromEntries(
      Object.entries(rawHooks).map(([key, fn]) => [
        key,
        /** @param {any[]} args */
        async (...args) => {
          try {
            return await /** @type {Function} */ (fn)(...args);
          } catch (err) {
            log.warn(`Hook "${key}" failed (suppressed):`, err instanceof Error ? err.message : err);
          }
        },
      ]),
    ));

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
    const resuming = !!existingSessionId;

    const fullSystemPrompt = await buildSystemPrompt(llmConfig, messages, session.chatId, session.senderIds, { resuming });

    /** @type {string | null} */
    let resolvedSessionId = null;

    /** @type {string[]} */
    const stderrLines = [];
    try {
      /** @type {Record<string, unknown>} */
      const queryOptions = {
        systemPrompt: fullSystemPrompt,
        maxTurns: maxDepth ?? 50,
        cwd: cwd || process.cwd(),
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: true,
        abortController,
        // Don't pass llmConfig.chatModel — it's an OpenRouter model ID.
        // The SDK uses Claude Code's own model (configurable via its own settings).
        stderr: (/** @type {string} */ data) => {
          stderrLines.push(data);
          log.debug("[sdk stderr]", data.trimEnd());
        },
        /**
         * Handle tool permission requests and AskUserQuestion.
         * Regular tools are auto-approved (bypassPermissions handles most).
         * AskUserQuestion is intercepted to present questions as WhatsApp polls.
         * @type {import("@anthropic-ai/claude-agent-sdk").CanUseTool}
         */
        canUseTool: async (toolName, input, _options) => {
          if (toolName === "AskUserQuestion") {
            return handleAskUserQuestion(input);
          }
          // Auto-approve all other tools (fallback for any not covered by bypassPermissions)
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
          const userChoice = await hooks.onAskUser(q.question, optionLabels, q.header);

          // Use the user's choice, or fall back to the first option on timeout
          answers[q.question] = userChoice || optionLabels[0];
        }

        return {
          behavior: "allow",
          updatedInput: { questions: input.questions, answers },
        };
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

      /** @type {Map<string, { editor?: MessageEditor, toolName: string }>} */
      const activeTools = new Map();

      for await (const event of q) {
        // Always capture the latest session_id from events.
        // When resuming, the SDK may return the same or a new session_id.
        if ("session_id" in event && typeof event.session_id === "string") {
          if (resolvedSessionId !== event.session_id) {
            resolvedSessionId = event.session_id;
            // Update the active query's sessionId for injection
            const active = activeQueries.get(session.chatId);
            if (active) active.sessionId = resolvedSessionId;
          }
        }

        log.debug(`SDK event: ${event.type}`, event.type === "assistant" ? `blocks=${event.message?.content?.length}` : "");
        switch (event.type) {
          case "assistant": {
            // Extract text content from the BetaMessage
            const betaMessage = event.message;
            if (betaMessage.content) {
              for (const block of betaMessage.content) {
                log.debug(`  assistant block: ${block.type}`, block.type === "text" ? `len=${block.text.length}` : "");
                if (block.type === "text") {
                  await hooks.onLlmResponse(block.text);
                  result.response.push({ type: "text", text: block.text });
                } else if (block.type === "tool_use") {
                  const editor = await hooks.onToolCall({
                    id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  });
                  activeTools.set(block.id, { editor: editor ?? undefined, toolName: block.name });
                }
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

          case "tool_use_summary": {
            // Compact summary of what SDK tools did (e.g. "Read 3 files").
            // Show in debug mode via onToolResult; suppressed in non-debug
            // (consistent with native harness autoContinue behavior).
            const summary = /** @type {{ summary: string }} */ (event).summary;
            if (summary) {
              /** @type {ToolContentBlock[]} */
              const summaryBlocks = [{ type: "text", text: summary }];
              await hooks.onToolResult(summaryBlocks, "tools", { autoContinue: true });
            }
            break;
          }

          // Ignore system, stream_event, and other message types
          default:
            break;
        }
      }
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
          log.error("[sdk stderr output]", stderrLines.join(""));
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

    // Store the final response in the session's message store
    const textBlocks = result.response.filter(b => b.type === "text");
    if (textBlocks.length > 0) {
      /** @type {AssistantMessage} */
      const assistantMessage = { role: "assistant", content: /** @type {TextContentBlock[]} */ (textBlocks) };
      messages.push(assistantMessage);
      await session.addMessage(session.chatId, assistantMessage, session.senderIds);
    }

    return result;
  }
}

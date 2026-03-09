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

  // Instruction to read CLAUDE.md when programming the bot
  prompt += `\n\n## Internal Development
When the user asks you to program, modify, fix, or work on the bot's internal system (this codebase), you MUST first read the file \`CLAUDE.md\` in the project root for coding guidelines and conventions before making any changes.`;

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
 * @typedef {{
 *   query: import("@anthropic-ai/claude-agent-sdk").Query;
 *   abortController: AbortController;
 *   sessionId: string;
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
        maxTurns: maxDepth ?? 10,
        cwd: cwd || process.cwd(),
        settingSources: [],
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

      // Use existing session ID for injection until we get one from the SDK
      const sessionId = existingSessionId ?? randomUUID();
      activeQueries.set(session.chatId, { query: q, abortController, sessionId });

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

        switch (event.type) {
          case "assistant": {
            // Extract text content from the BetaMessage
            const betaMessage = event.message;
            if (betaMessage.content) {
              for (const block of betaMessage.content) {
                if (block.type === "text") {
                  await hooks.onLlmResponse(block.text);
                  result.response = [{ type: "markdown", text: block.text }];
                } else if (block.type === "tool_use") {
                  await hooks.onToolCall({
                    id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  });
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
            // Final result — extract usage and response
            if ("result" in event && typeof event.result === "string") {
              result.response = [{ type: "text", text: event.result }];
            }
            if (event.usage) {
              // Overwrite with final totals if available
              result.usage.promptTokens = event.usage.input_tokens ?? result.usage.promptTokens;
              result.usage.completionTokens = event.usage.output_tokens ?? result.usage.completionTokens;
              result.usage.cachedTokens = /** @type {*} */ (event.usage).cache_read_input_tokens ?? result.usage.cachedTokens;
            }
            if (typeof event.total_cost_usd === "number") {
              result.usage.cost = event.total_cost_usd;
            }

            if (event.is_error) {
              const errors = /** @type {import("@anthropic-ai/claude-agent-sdk").SDKResultError} */ (event).errors;
              log.error("SDK query ended with error:", errors);
              if (errors?.length > 0) {
                await hooks.onToolError(errors.join("; "));
              }
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

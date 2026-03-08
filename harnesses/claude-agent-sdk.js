/**
 * Claude Agent SDK harness — uses @anthropic-ai/claude-agent-sdk for agentic processing.
 *
 * All SDK built-in tools are enabled (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch).
 * Custom bot actions are exposed as Skills (SKILL.md files) rather than MCP tools.
 * Conversation history and chat-specific actions are embedded in the system prompt.
 *
 * Supports mid-conversation message injection via streamInput() and cancellation via AbortController.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { NO_OP_HOOKS } from "./native.js";
import { getChatActions } from "../actions.js";
import { createLogger } from "../logger.js";

const log = createLogger("harness:claude-agent-sdk");

/**
 * Format conversation history from Message[] into a readable string for the system prompt.
 * @param {Message[]} messages
 * @returns {string}
 */
function formatConversationHistory(messages) {
  /** @type {string[]} */
  const lines = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const texts = msg.content
        .filter(/** @param {*} b */ b => b.type === "text")
        .map(/** @param {*} b */ b => b.text);
      if (texts.length > 0) lines.push(`User: ${texts.join(" ")}`);
    } else if (msg.role === "assistant") {
      const texts = msg.content
        .filter(/** @param {*} b */ b => b.type === "text")
        .map(/** @param {*} b */ b => b.text);
      if (texts.length > 0) lines.push(`Assistant: ${texts.join(" ")}`);
    }
    // Tool messages are implementation details — skip them
  }
  return lines.join("\n");
}

/**
 * Extract the last user text from the messages array.
 * @param {Message[]} messages
 * @returns {string}
 */
function extractLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const texts = msg.content
        .filter(/** @param {*} b */ b => b.type === "text")
        .map(/** @param {*} b */ b => b.text);
      if (texts.length > 0) return texts.join(" ");
    }
  }
  return "";
}

/**
 * Build the full system prompt for the SDK, including:
 * - Base system prompt from llmConfig
 * - Chat ID and runtime context
 * - DB paths
 * - Conversation history
 * - Chat-specific action descriptions
 *
 * @param {LlmConfig} llmConfig
 * @param {Message[]} messages
 * @param {string} chatId
 * @param {string[]} senderIds
 * @returns {Promise<string>}
 */
async function buildSystemPrompt(llmConfig, messages, chatId, senderIds) {
  let prompt = llmConfig.systemPrompt;

  prompt += `\n\n## Runtime Context
- Chat ID: ${chatId}
- Sender IDs: ${senderIds.join(", ")}
- PGlite root database: ./pgdata/root
- PGlite chat database: ./pgdata/${chatId}
- Action databases: ./pgdata/${chatId}/<action_name>/`;

  // Embed conversation history
  const history = formatConversationHistory(messages);
  if (history) {
    prompt += `\n\n## Conversation History\n${history}`;
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
    /** @type {Required<AgentIOHooks>} */
    const hooks = { ...NO_OP_HOOKS, ...userHooks };

    const fullSystemPrompt = await buildSystemPrompt(llmConfig, messages, session.chatId, session.senderIds);
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
    const sessionId = randomUUID();

    /** @type {string[]} */
    const stderrLines = [];
    try {
      const q = query({
        prompt: lastUserText,
        options: {
          systemPrompt: fullSystemPrompt,
          maxTurns: maxDepth ?? 10,
          cwd: cwd || process.cwd(),
          settingSources: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          persistSession: false,
          abortController,
          // Don't pass llmConfig.chatModel — it's an OpenRouter model ID.
          // The SDK uses Claude Code's own model (configurable via its own settings).
          stderr: (data) => {
            stderrLines.push(data);
            log.debug("[sdk stderr]", data.trimEnd());
          },
        },
      });

      activeQueries.set(session.chatId, { query: q, abortController, sessionId });

      for await (const event of q) {
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
        log.error("Claude Agent SDK query failed:", err);
        if (stderrLines.length > 0) {
          log.error("[sdk stderr output]", stderrLines.join(""));
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        await hooks.onToolError(errorMsg);
        result.response = [{ type: "text", text: `SDK error: ${errorMsg}` }];
      }
    } finally {
      activeQueries.delete(session.chatId);
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

import { createLogger } from "../logger.js";
import { toolInspectState } from "../outbound-events.js";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { openPiRpcConnection } from "./pi-rpc-client.js";
import { toPiThinkingLevel } from "./pi-config.js";

const log = createLogger("harness:pi-runner");

/** @type {Pick<Required<AgentIOHooks>, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onLlmResponse" | "onToolError" | "onUsage">} */
const DEFAULT_PI_RUN_HOOKS = {
  onComposing: async () => {},
  onPaused: async () => {},
  onReasoning: async () => {},
  onToolCall: async () => {},
  onLlmResponse: async () => {},
  onToolError: async () => {},
  onUsage: async () => {},
};

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   presentation: import("../tool-presentation-model.js").ToolPresentation,
 *   handle?: MessageHandle,
 * }} ActivePiTool
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   provider: string,
 *   reasoning?: boolean,
 * }} PiModel
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is Array<Record<string, unknown>>}
 */
function isRecordArray(value) {
  return Array.isArray(value) && value.every((entry) => isObjectRecord(entry));
}

/**
 * @param {string} prompt
 * @param {string | null | undefined} externalInstructions
 * @returns {string}
 */
export function buildPiTurnInput(prompt, externalInstructions) {
  const trimmedPrompt = prompt.trim();
  const trimmedExternalInstructions = externalInstructions?.trim() ?? "";
  if (!trimmedExternalInstructions) {
    return trimmedPrompt;
  }
  return [
    "Follow these instructions for this run:",
    trimmedExternalInstructions,
    "",
    "User request:",
    trimmedPrompt,
  ].join("\n");
}

/**
 * @param {Record<string, unknown>} response
 * @returns {Record<string, unknown>}
 */
function getResponseData(response) {
  if (!isObjectRecord(response.data)) {
    return {};
  }
  return response.data;
}

/**
 * @param {Record<string, unknown>} response
 * @param {string} commandName
 * @returns {void}
 */
function assertSuccessfulResponse(response, commandName) {
  if (response.success === true) {
    return;
  }
  const errorMessage = typeof response.error === "string"
    ? response.error
    : typeof response.message === "string"
      ? response.message
      : `${commandName} failed`;
  throw new Error(errorMessage);
}

/**
 * @param {Record<string, unknown>} response
 * @returns {PiModel[]}
 */
function extractPiModels(response) {
  const data = getResponseData(response);
  if (!isRecordArray(data.models)) {
    return [];
  }
  return data.models
    .map((model) => {
      if (typeof model.id !== "string" || typeof model.provider !== "string" || typeof model.name !== "string") {
        return null;
      }
      return {
        id: model.id,
        name: model.name,
        provider: model.provider,
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      };
    })
    .filter(/** @returns {model is PiModel} */ (model) => model !== null);
}

/**
 * @param {string} value
 * @param {PiModel[]} models
 * @returns {{ provider: string, modelId: string } | null}
 */
export function resolvePiModelSelection(value, models) {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const exactFullMatch = models.find((model) => `${model.provider}/${model.id}` === trimmedValue);
  if (exactFullMatch) {
    return {
      provider: exactFullMatch.provider,
      modelId: exactFullMatch.id,
    };
  }

  const shortMatches = models.filter((model) => model.id === trimmedValue);
  if (shortMatches.length === 1) {
    return {
      provider: shortMatches[0].provider,
      modelId: shortMatches[0].id,
    };
  }

  return null;
}

/**
 * @param {Record<string, unknown>} message
 * @returns {string | null}
 */
function extractAssistantText(message) {
  if (!isObjectRecord(message) || !Array.isArray(message.content)) {
    return null;
  }
  const parts = message.content
    .filter((entry) => isObjectRecord(entry) && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => /** @type {string} */ (entry.text));
  const text = parts.join("").trim();
  return text || null;
}

/**
 * @param {Record<string, unknown>} message
 * @returns {{ promptTokens: number, completionTokens: number, cachedTokens: number, cost: number }}
 */
function extractAssistantUsage(message) {
  if (!isObjectRecord(message.usage)) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
    };
  }
  const usage = message.usage;
  const cost = isObjectRecord(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : 0;
  return {
    promptTokens: typeof usage.input === "number" ? usage.input : 0,
    completionTokens: typeof usage.output === "number" ? usage.output : 0,
    cachedTokens: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
    cost,
  };
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string | null}
 */
function extractSessionPath(event) {
  const data = getResponseData(event);
  return typeof data.sessionFile === "string" ? data.sessionFile : null;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string | null}
 */
function extractThinkingText(event) {
  if (!isObjectRecord(event.message) || !Array.isArray(event.message.content)) {
    return null;
  }
  const content = event.message.content;
  const parts = content
    .filter((entry) => isObjectRecord(entry) && entry.type === "thinking" && typeof entry.thinking === "string")
    .map((entry) => /** @type {string} */ (entry.thinking));
  const text = parts.join("\n").trim();
  return text || null;
}

/**
 * @param {Record<string, unknown>} result
 * @returns {string | undefined}
 */
function extractToolResultText(result) {
  if (!isObjectRecord(result) || !Array.isArray(result.content)) {
    return undefined;
  }
  const text = result.content
    .filter((entry) => isObjectRecord(entry) && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => /** @type {string} */ (entry.text))
    .join("\n")
    .trim();
  return text || undefined;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {{ id: string, name: string, args: Record<string, unknown> } | null}
 */
function extractToolStart(event) {
  if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
    return null;
  }
  const args = isObjectRecord(event.args) ? event.args : {};
  return {
    id: event.toolCallId,
    name: event.toolName,
    args,
  };
}

/**
 * @param {string} id
 * @returns {string}
 */
function buildRequestId(id) {
  return `req-${id}`;
}

/**
 * @param {{
 *   chatId: string,
 *   prompt: string,
 *   externalInstructions?: string,
 *   messages: Message[],
 *   sessionPath?: string | null,
 *   runConfig?: HarnessRunConfig,
 *   env?: NodeJS.ProcessEnv,
 *   hooks?: Pick<AgentIOHooks, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onLlmResponse" | "onToolError" | "onUsage">,
 *   isAborted?: () => boolean,
 * }} input
 * @param {{
 *   openConnection?: typeof openPiRpcConnection,
 * }} [deps]
 * @returns {Promise<{
 *   abortController: AbortController,
 *   done: Promise<{ result: AgentResult, sessionPath: string | null }>,
 *   steer: (text: string) => Promise<boolean>,
 *   interrupt: () => Promise<boolean>,
 * }>}
 */
export async function startPiRpcRun(input, deps = {}) {
  const openConnection = deps.openConnection ?? openPiRpcConnection;
  const hooks = { ...DEFAULT_PI_RUN_HOOKS, ...input.hooks };
  const abortController = new AbortController();
  const prompt = buildPiTurnInput(input.prompt, input.externalInstructions);
  const activeTools = new Map();
  /** @type {AgentResult} */
  const result = {
    response: [],
    messages: input.messages,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
  };
  /** @type {string | null} */
  let sessionPath = input.sessionPath ?? null;
  let agentCompleted = false;
  let requestSequence = 1;

  const connection = await openConnection({
    ...(input.runConfig?.workdir ? { cwd: input.runConfig.workdir } : {}),
    ...(input.env ? { env: input.env } : {}),
    signal: abortController.signal,
  });

  /**
   * @param {Omit<Record<string, unknown>, "id">} message
   * @returns {Promise<Record<string, unknown>>}
   */
  async function sendRequest(message) {
    const response = await connection.sendRequest({
      id: buildRequestId(String(requestSequence)),
      ...message,
    });
    requestSequence += 1;
    return response;
  }

  if (sessionPath) {
    const switchResponse = await sendRequest({
      type: "switch_session",
      sessionPath,
    });
    assertSuccessfulResponse(switchResponse, "switch_session");
  }

  if (input.runConfig?.model) {
    const modelsResponse = await sendRequest({ type: "get_available_models" });
    assertSuccessfulResponse(modelsResponse, "get_available_models");
    const selection = resolvePiModelSelection(input.runConfig.model, extractPiModels(modelsResponse));
    if (!selection) {
      throw new Error(`Unknown Pi model "${input.runConfig.model}"`);
    }
    const setModelResponse = await sendRequest({
      type: "set_model",
      provider: selection.provider,
      modelId: selection.modelId,
    });
    assertSuccessfulResponse(setModelResponse, "set_model");
  }

  const thinkingLevel = toPiThinkingLevel(input.runConfig?.reasoningEffort);
  if (thinkingLevel) {
    const thinkingResponse = await sendRequest({
      type: "set_thinking_level",
      level: thinkingLevel,
    });
    assertSuccessfulResponse(thinkingResponse, "set_thinking_level");
  }

  const promptResponse = await sendRequest({
    type: "prompt",
    message: prompt,
  });
  assertSuccessfulResponse(promptResponse, "prompt");
  await hooks.onComposing();

  const done = (async () => {
    try {
      for await (const event of connection.notifications) {
        if (event.type === "message_update" && isObjectRecord(event.assistantMessageEvent)) {
          const assistantMessageEvent = event.assistantMessageEvent;
          if (
            (assistantMessageEvent.type === "thinking_start"
              || assistantMessageEvent.type === "thinking_delta"
              || assistantMessageEvent.type === "thinking_end")
          ) {
            const thinkingText = extractThinkingText(event);
            if (thinkingText) {
              await hooks.onReasoning({
                status: assistantMessageEvent.type === "thinking_end"
                  ? "completed"
                  : assistantMessageEvent.type === "thinking_start"
                    ? "started"
                    : "updated",
                summaryParts: [],
                contentParts: [thinkingText],
                text: thinkingText,
              });
            }
          }
        }

        if (event.type === "tool_execution_start") {
          const toolStart = extractToolStart(event);
          if (toolStart) {
            const toolCall = {
              id: toolStart.id,
              name: toolStart.name,
              arguments: JSON.stringify(toolStart.args),
            };
            const handle = await hooks.onToolCall(toolCall) ?? undefined;
            activeTools.set(toolStart.id, {
              id: toolStart.id,
              name: toolStart.name,
              presentation: buildToolPresentation(toolStart.name, toolStart.args, undefined, input.runConfig?.workdir ?? null, undefined),
              ...(handle ? { handle } : {}),
            });
            await hooks.onPaused();
            await hooks.onComposing();
          }
          continue;
        }

        if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
          const activeTool = activeTools.get(event.toolCallId);
          if (activeTool?.handle && isObjectRecord(event.partialResult)) {
            activeTool.handle.setInspect(
              toolInspectState(activeTool.presentation, extractToolResultText(event.partialResult)),
            );
          }
          continue;
        }

        if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
          const activeTool = activeTools.get(event.toolCallId);
          if (activeTool?.handle && isObjectRecord(event.result)) {
            activeTool.handle.setInspect(
              toolInspectState(activeTool.presentation, extractToolResultText(event.result)),
            );
          }
          activeTools.delete(event.toolCallId);
          continue;
        }

        if (event.type === "agent_end") {
          agentCompleted = true;
          const messages = isRecordArray(event.messages) ? event.messages : [];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i];
            if (message.role !== "assistant") {
              continue;
            }
            const text = extractAssistantText(message);
            if (text) {
              result.response = [{ type: "markdown", text }];
              await hooks.onLlmResponse(text);
            }
            result.usage = extractAssistantUsage(message);
            if (
              result.usage.promptTokens > 0
              || result.usage.completionTokens > 0
              || result.usage.cachedTokens > 0
            ) {
              await hooks.onUsage(result.usage.cost.toFixed(6), {
                prompt: result.usage.promptTokens,
                completion: result.usage.completionTokens,
                cached: result.usage.cachedTokens,
              });
            }
            break;
          }
          break;
        }
      }

      const stateResponse = await sendRequest({ type: "get_state" });
      assertSuccessfulResponse(stateResponse, "get_state");
      sessionPath = extractSessionPath(stateResponse);
      return { result, sessionPath };
    } catch (error) {
      if (input.isAborted?.() || abortController.signal.aborted) {
        return { result, sessionPath };
      }
      log.error("Pi run failed:", error);
      throw error;
    } finally {
      await connection.close();
    }
  })();

  return {
    abortController,
    done,
    steer: async (text) => {
      if (!text || agentCompleted) {
        return false;
      }
      const steerResponse = await sendRequest({
        type: "steer",
        message: text,
      });
      assertSuccessfulResponse(steerResponse, "steer");
      return true;
    },
    interrupt: async () => {
      if (agentCompleted) {
        return false;
      }
      const abortResponse = await sendRequest({ type: "abort" });
      assertSuccessfulResponse(abortResponse, "abort");
      return true;
    },
  };
}

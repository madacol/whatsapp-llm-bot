import { createLogger } from "../logger.js";
import { openPiRpcConnection } from "./pi-rpc-client.js";
import { toPiThinkingLevel } from "./pi-config.js";
import { createHarnessRuntimeEventDispatcher } from "./harness-runtime-event-dispatcher.js";
import { normalizePiRuntimeEvents, getResponseData } from "./pi-runtime-events.js";

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
 * @param {Record<string, unknown>} event
 * @returns {string | null}
 */
function extractSessionPath(event) {
  const data = getResponseData(event);
  return typeof data.sessionFile === "string" ? data.sessionFile : null;
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
  const dispatcher = createHarnessRuntimeEventDispatcher({
    provider: "pi",
    messages: input.messages,
    hooks,
    workdir: input.runConfig?.workdir ?? null,
  });
  /** @type {string | null} */
  let sessionPath = input.sessionPath ?? null;
  let agentCompleted = false;
  let requestSequence = 1;
  /** @type {Map<string, { toolName: string, args: Record<string, unknown> }>} */
  const activeToolCalls = new Map();

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
      for await (const rawEvent of connection.notifications) {
        let event = rawEvent;
        if (
          event.type === "tool_execution_start"
          && typeof event.toolCallId === "string"
          && typeof event.toolName === "string"
        ) {
          activeToolCalls.set(event.toolCallId, {
            toolName: event.toolName,
            args: isObjectRecord(event.args) ? event.args : {},
          });
        } else if (
          (event.type === "tool_execution_update" || event.type === "tool_execution_end")
          && typeof event.toolCallId === "string"
        ) {
          const toolCallId = event.toolCallId;
          const activeTool = activeToolCalls.get(toolCallId);
          if (activeTool) {
            event = {
              ...event,
              toolName: typeof event.toolName === "string" ? event.toolName : activeTool.toolName,
              args: isObjectRecord(event.args) ? event.args : activeTool.args,
            };
          }
          if (event.type === "tool_execution_end") {
            activeToolCalls.delete(toolCallId);
          }
        }
        const runtimeEvents = normalizePiRuntimeEvents(event);
        for (const runtimeEvent of runtimeEvents) {
          await dispatcher.handleEvent(runtimeEvent);
        }

        if (event.type === "agent_end") {
          agentCompleted = true;
          break;
        }
      }

      const stateResponse = await sendRequest({ type: "get_state" });
      assertSuccessfulResponse(stateResponse, "get_state");
      sessionPath = extractSessionPath(stateResponse);
      return { result: dispatcher.result, sessionPath };
    } catch (error) {
      if (input.isAborted?.() || abortController.signal.aborted) {
        return { result: dispatcher.result, sessionPath };
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

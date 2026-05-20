import { toolInspectState } from "../outbound-events.js";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { createLogger } from "../logger.js";
import { getHarnessRawEventLoggerFromEnv } from "./raw-event-log.js";

/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeEvent} HarnessRuntimeEvent
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeProvider} HarnessRuntimeProvider
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeTool} HarnessRuntimeTool
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeUsage} HarnessRuntimeUsage
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeToolEvent} HarnessRuntimeToolEvent
 * @typedef {import("./raw-event-log.js").HarnessRawEventLogger} HarnessRawEventLogger
 */

const log = createLogger("harness:runtime-events");

/**
 * @type {Pick<Required<AgentIOHooks>, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onToolComplete" | "onToolResult" | "onLlmResponse" | "onFileChange" | "onUsage" | "onToolError" | "onCommand" | "onFileRead">}
 */
const DEFAULT_RUNTIME_EVENT_HOOKS = {
  onComposing: async () => {},
  onPaused: async () => {},
  onReasoning: async () => {},
  onToolCall: async () => {},
  onToolComplete: async () => {},
  onToolResult: async () => {},
  onLlmResponse: async () => {},
  onFileChange: async () => {},
  onUsage: async () => {},
  onToolError: async () => {},
  onCommand: async () => {},
  onFileRead: async () => {},
};

/**
 * @param {HarnessRuntimeUsage} usage
 * @returns {UsageTokens}
 */
function toUsageTokens(usage) {
  return {
    prompt: usage.promptTokens,
    completion: usage.completionTokens,
    cached: usage.cachedTokens,
    ...(usage.totalTokens !== undefined ? { total: usage.totalTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoning: usage.reasoningTokens } : {}),
    ...(usage.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
  };
}

/**
 * @param {HarnessRuntimeUsage} usage
 * @returns {string}
 */
function formatUsageCost(usage) {
  return usage.cost.toFixed(6);
}

/**
 * @param {HarnessRuntimeTool} tool
 * @param {string | null | undefined} workdir
 * @returns {import("../tool-presentation-model.js").ToolPresentation}
 */
function buildRuntimeToolPresentation(tool, workdir) {
  return buildToolPresentation(tool.name, tool.arguments, undefined, workdir ?? null, undefined);
}

/**
 * Create the app-facing dispatcher for canonical harness runtime events.
 * Provider-specific runners should normalize raw SDK/RPC messages before this
 * point; this layer owns presentation hooks and accumulated `AgentResult`.
 * @param {{
 *   provider: HarnessRuntimeProvider,
 *   messages: Message[],
 *   hooks?: Pick<AgentIOHooks, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onToolComplete" | "onToolResult" | "onLlmResponse" | "onFileChange" | "onUsage" | "onToolError" | "onCommand" | "onFileRead">,
 *   workdir?: string | null,
 *   emitUsage?: boolean,
 *   rawEventLogger?: HarnessRawEventLogger | null,
 * }} input
 * @returns {{
 *   result: AgentResult,
 *   handleEvent: (event: HarnessRuntimeEvent) => Promise<void>,
 * }}
 */
export function createHarnessRuntimeEventDispatcher(input) {
  const hooks = { ...DEFAULT_RUNTIME_EVENT_HOOKS, ...input.hooks };
  const rawEventLogger = input.rawEventLogger ?? getHarnessRawEventLoggerFromEnv();
  /** @type {Map<string, { handle?: MessageHandle, presentation: import("../tool-presentation-model.js").ToolPresentation }>} */
  const activeTools = new Map();

  /** @type {AgentResult} */
  const result = {
    response: [],
    messages: input.messages,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
  };

  /**
   * @param {HarnessRuntimeUsage} usage
   * @param {"replace" | "add"} mode
   * @returns {Promise<void>}
   */
  async function updateUsage(usage, mode) {
    result.usage = mode === "add"
      ? {
          promptTokens: result.usage.promptTokens + usage.promptTokens,
          completionTokens: result.usage.completionTokens + usage.completionTokens,
          cachedTokens: result.usage.cachedTokens + usage.cachedTokens,
          cost: result.usage.cost + usage.cost,
          ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
          ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
          ...(usage.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
        }
      : usage;
    if (input.emitUsage !== false && (usage.promptTokens > 0 || usage.completionTokens > 0 || usage.cachedTokens > 0)) {
      await hooks.onUsage(formatUsageCost(result.usage), toUsageTokens(result.usage));
    }
  }

  /**
   * @param {HarnessRuntimeToolEvent} event
   * @returns {Promise<void>}
   */
  async function handleToolStarted(event) {
    const presentation = buildRuntimeToolPresentation(event.tool, input.workdir);
    const toolCall = {
      id: event.tool.id,
      name: event.tool.name,
      arguments: JSON.stringify(event.tool.arguments),
    };
    const handle = await hooks.onToolCall(toolCall) ?? undefined;
    activeTools.set(event.tool.id, {
      ...(handle ? { handle } : {}),
      presentation,
    });
  }

  /**
   * @param {HarnessRuntimeToolEvent} event
   * @returns {Promise<void>}
   */
  async function handleToolProgress(event) {
    const active = activeTools.get(event.tool.id);
    if (active?.handle) {
      active.handle.setInspect(toolInspectState(active.presentation, event.tool.output));
    }
    if (event.type === "tool.completed") {
      await hooks.onToolComplete({
        id: event.tool.id,
        name: event.tool.name,
        arguments: JSON.stringify(event.tool.arguments),
      });
      if (event.tool.outputBlocks) {
        await hooks.onToolResult(event.tool.outputBlocks, event.tool.name, event.tool.permissions ?? {});
      }
      activeTools.delete(event.tool.id);
    }
    if (event.type === "tool.failed") {
      if (event.tool.output) {
        await hooks.onToolError(event.tool.output);
      }
      activeTools.delete(event.tool.id);
    }
  }

  /**
   * @param {HarnessRuntimeEvent} event
   * @returns {Promise<void>}
   */
  async function captureRawEvent(event) {
    if (!rawEventLogger || !event.raw) {
      return;
    }
    try {
      await rawEventLogger.write({
        provider: event.provider,
        type: event.type,
        raw: event.raw,
      });
    } catch (error) {
      log.warn("Failed to capture raw harness runtime event:", error);
    }
  }

  /**
   * @param {HarnessRuntimeEvent} event
   * @returns {Promise<void>}
   */
  async function handleEvent(event) {
    await captureRawEvent(event);
    switch (event.type) {
      case "reasoning.started":
      case "reasoning.updated":
      case "reasoning.completed":
        await hooks.onReasoning({
          status: event.status,
          summaryParts: event.summaryParts ?? [],
          contentParts: event.contentParts ?? [event.text],
          text: event.text,
        });
        return;
      case "tool.started":
        await handleToolStarted(event);
        return;
      case "tool.updated":
      case "tool.completed":
      case "tool.failed":
        await handleToolProgress(event);
        return;
      case "command.started":
      case "command.completed":
      case "command.failed":
        await hooks.onCommand(event.command);
        return;
      case "file-read.started":
        await hooks.onFileRead(event.fileRead);
        return;
      case "assistant.completed":
        if (event.responseMode === "append") {
          result.response.push({ type: event.contentType, text: event.text });
        } else if (event.responseMode !== "none") {
          result.response = [{ type: event.contentType, text: event.text }];
        }
        if (event.notify !== false) {
          await hooks.onLlmResponse(event.displayText ?? event.text);
        }
        if (event.usage) {
          await updateUsage(event.usage, event.usageMode ?? "replace");
        }
        return;
      case "usage.updated":
        await updateUsage(event.usage, "replace");
        return;
      case "session.started":
      case "session.updated":
      case "session.stopped":
      case "turn.started":
      case "turn.completed":
      case "request.opened":
      case "request.resolved":
      case "user-input.requested":
      case "user-input.resolved":
        return;
      case "file-change.completed":
        await hooks.onFileChange(event.change);
        return;
      default: {
        /** @type {never} */
        const exhaustive = event;
        throw new Error(`Unsupported harness runtime event: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return {
    result,
    handleEvent,
  };
}

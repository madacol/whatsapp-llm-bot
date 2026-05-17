import { toolInspectState } from "../outbound-events.js";
import { buildToolPresentation } from "../tool-presentation-model.js";

/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeEvent} HarnessRuntimeEvent
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeProvider} HarnessRuntimeProvider
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeTool} HarnessRuntimeTool
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeUsage} HarnessRuntimeUsage
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeToolEvent} HarnessRuntimeToolEvent
 */

/**
 * @type {Pick<Required<AgentIOHooks>, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onLlmResponse" | "onUsage">}
 */
const DEFAULT_RUNTIME_EVENT_HOOKS = {
  onComposing: async () => {},
  onPaused: async () => {},
  onReasoning: async () => {},
  onToolCall: async () => {},
  onLlmResponse: async () => {},
  onUsage: async () => {},
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
 *   hooks?: Pick<AgentIOHooks, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onLlmResponse" | "onUsage">,
 *   workdir?: string | null,
 * }} input
 * @returns {{
 *   result: AgentResult,
 *   handleEvent: (event: HarnessRuntimeEvent) => Promise<void>,
 * }}
 */
export function createHarnessRuntimeEventDispatcher(input) {
  const hooks = { ...DEFAULT_RUNTIME_EVENT_HOOKS, ...input.hooks };
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
   * @returns {Promise<void>}
   */
  async function updateUsage(usage) {
    result.usage = usage;
    if (usage.promptTokens > 0 || usage.completionTokens > 0 || usage.cachedTokens > 0) {
      await hooks.onUsage(formatUsageCost(usage), toUsageTokens(usage));
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
    await hooks.onPaused();
    await hooks.onComposing();
  }

  /**
   * @param {HarnessRuntimeToolEvent} event
   * @returns {void}
   */
  function handleToolProgress(event) {
    const active = activeTools.get(event.tool.id);
    if (active?.handle) {
      active.handle.setInspect(toolInspectState(active.presentation, event.tool.output));
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      activeTools.delete(event.tool.id);
    }
  }

  /**
   * @param {HarnessRuntimeEvent} event
   * @returns {Promise<void>}
   */
  async function handleEvent(event) {
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
        handleToolProgress(event);
        return;
      case "assistant.completed":
        result.response = [{ type: event.contentType, text: event.text }];
        await hooks.onLlmResponse(event.text);
        if (event.usage) {
          await updateUsage(event.usage);
        }
        return;
      case "usage.updated":
        await updateUsage(event.usage);
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

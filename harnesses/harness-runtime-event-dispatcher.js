import { toolFlowInspectState, toolFlowUpdate, toolInspectState } from "../outbound-events.js";
import { buildToolPresentation, getToolFlowDescriptor } from "../tool-presentation-model.js";
import { createLogger } from "../logger.js";
import { getHarnessRawEventLoggerFromEnv } from "./raw-event-log.js";
import { createPlanPresentationFromState } from "../plan-presentation.js";
import { normalizeHarnessRuntimeEvent } from "./harness-runtime-events.js";

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
 * @type {Pick<Required<AgentIOHooks>, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onToolComplete" | "onToolResult" | "onLlmResponse" | "onFileChange" | "onUsage" | "onToolError" | "onCommand" | "onFileRead" | "onPlan" | "onRuntimeEvent">}
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
  onPlan: async () => {},
  onRuntimeEvent: async () => {},
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
 * @param {HarnessRuntimeEvent} event
 * @returns {boolean}
 */
function shouldPassThroughPresentationBoundary(event) {
  return event.provider === "acp"
    && (event.type === "command.started"
      || event.type === "command.completed"
      || event.type === "command.failed"
      || event.type === "file-read.started"
      || event.type === "tool.started"
      || event.type === "tool.updated"
      || event.type === "tool.completed"
      || event.type === "tool.failed"
      || event.type === "file-change.completed");
}

/**
 * @param {HarnessRuntimeEvent} event
 * @param {string | null | undefined} workdir
 * @returns {HarnessRuntimeEvent}
 */
function attachRuntimeBoundaryFacts(event, workdir) {
  if (event.type !== "file-change.completed" || !workdir || event.change.cwd !== undefined) {
    return event;
  }
  return {
    ...event,
    change: {
      ...event.change,
      cwd: workdir,
    },
  };
}

/**
 * Create the app-facing dispatcher for canonical harness runtime events.
 * Provider-specific runners should normalize raw SDK/RPC messages before this
 * point; this layer owns presentation hooks and accumulated `AgentResult`.
 * @param {{
 *   provider: HarnessRuntimeProvider,
 *   messages: Message[],
 *   hooks?: Pick<AgentIOHooks, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onToolComplete" | "onToolResult" | "onLlmResponse" | "onFileChange" | "onUsage" | "onToolError" | "onCommand" | "onFileRead" | "onPlan" | "onRuntimeEvent">,
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
  /** @type {Map<string, { handle?: MessageHandle, state: import("../tool-flow-presentation.js").ToolFlowState }>} */
  const activeFlows = new Map();
  /** @type {Map<string, LlmResponseMetadata>} */
  const subagentThreads = new Map();
  /** @type {Set<string>} */
  const deliveredSubagentResponses = new Set();

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
    const contextWindow = usage.contextWindow ?? result.usage.contextWindow;
    result.usage = mode === "add"
      ? {
          promptTokens: result.usage.promptTokens + usage.promptTokens,
          completionTokens: result.usage.completionTokens + usage.completionTokens,
          cachedTokens: result.usage.cachedTokens + usage.cachedTokens,
          cost: result.usage.cost + usage.cost,
          ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
          ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
        }
      : {
          ...usage,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
        };
    if (input.emitUsage !== false && (usage.promptTokens > 0 || usage.completionTokens > 0 || usage.cachedTokens > 0)) {
      await hooks.onUsage(formatUsageCost(result.usage), toUsageTokens(result.usage));
    }
  }

  /**
   * @param {HarnessRuntimeTool} tool
   * @returns {void}
   */
  function rememberSpawnedSubagent(tool) {
    if (tool.name !== "spawn_agent" || typeof tool.output !== "string") {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(tool.output);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const record = /** @type {Record<string, unknown>} */ (parsed);
    const threadId = typeof record.agent_id === "string"
      ? record.agent_id
      : typeof record.threadId === "string" ? record.threadId : null;
    if (!threadId) {
      return;
    }
    subagentThreads.set(threadId, {
      source: "subagent",
      threadId,
      ...(typeof record.nickname === "string" ? { agentNickname: record.nickname } : {}),
    });
  }

  /**
   * @param {HarnessRuntimeTool} tool
   * @returns {Array<{ threadId: string, text: string }>}
   */
  function extractWaitAgentResponses(tool) {
    if (tool.name !== "wait_agent" || typeof tool.output !== "string") {
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(tool.output);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const status = /** @type {Record<string, unknown>} */ (parsed).status;
    if (!status || typeof status !== "object" || Array.isArray(status)) {
      return [];
    }
    /** @type {Array<{ threadId: string, text: string }>} */
    const responses = [];
    for (const [threadId, state] of Object.entries(/** @type {Record<string, unknown>} */ (status))) {
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        continue;
      }
      const text = /** @type {Record<string, unknown>} */ (state).completed;
      if (typeof text === "string" && text.length > 0) {
        responses.push({ threadId, text });
      }
    }
    return responses;
  }

  /**
   * @param {{ threadId?: string, text: string }} response
   * @returns {Promise<void>}
   */
  async function emitSubagentResponse(response) {
    /** @type {LlmResponseMetadata} */
    const metadata = response.threadId
      ? subagentThreads.get(response.threadId) ?? { source: "subagent", threadId: response.threadId }
      : { source: "subagent" };
    const dedupeKey = `${metadata.threadId ?? ""}\u0000${response.text}`;
    if (deliveredSubagentResponses.has(dedupeKey)) {
      return;
    }
    deliveredSubagentResponses.add(dedupeKey);
    await hooks.onLlmResponse(response.text, metadata);
  }

  /**
   * @param {HarnessRuntimeToolEvent} event
   * @returns {Promise<void>}
   */
  async function handleToolStarted(event) {
    const presentation = buildRuntimeToolPresentation(event.tool, input.workdir);
    const flow = getToolFlowDescriptor(presentation);
    const toolCall = {
      id: event.tool.id,
      name: event.tool.name,
      arguments: JSON.stringify(event.tool.arguments),
    };
    if (flow) {
      let activeFlow = activeFlows.get(flow.groupKey);
      if (!activeFlow) {
        const handle = await hooks.onToolCall(toolCall) ?? undefined;
        activeFlow = {
          ...(handle ? { handle } : {}),
          state: { title: flow.groupTitle, steps: [] },
        };
        activeFlows.set(flow.groupKey, activeFlow);
      }
      activeFlow.state.steps.push({ id: event.tool.id, presentation });
      if (activeFlow.handle) {
        await activeFlow.handle.update(toolFlowUpdate(activeFlow.state));
        activeFlow.handle.setInspect(toolFlowInspectState(activeFlow.state));
      }
      activeTools.set(event.tool.id, {
        ...(activeFlow.handle ? { handle: activeFlow.handle } : {}),
        presentation,
      });
      return;
    }
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
    const presentation = buildRuntimeToolPresentation(event.tool, input.workdir);
    const flow = getToolFlowDescriptor(presentation);
    if (flow) {
      const activeFlow = activeFlows.get(flow.groupKey);
      const step = activeFlow?.state.steps.find((candidate) => candidate.id === event.tool.id);
      if (step) {
        step.presentation = presentation;
        step.output = event.tool.output;
      }
      if (activeFlow?.handle) {
        activeFlow.handle.setInspect(toolFlowInspectState(activeFlow.state));
      }
    }
    if (!flow && active?.handle) {
      active.handle.setInspect(toolInspectState(presentation, event.tool.output));
    }
    if (event.type === "tool.completed") {
      rememberSpawnedSubagent(event.tool);
      await hooks.onToolComplete({
        id: event.tool.id,
        name: event.tool.name,
        arguments: JSON.stringify(event.tool.arguments),
      });
      if (event.tool.outputBlocks) {
        await hooks.onToolResult(event.tool.outputBlocks, event.tool.name, event.tool.permissions ?? {});
      }
      activeTools.delete(event.tool.id);
      for (const response of extractWaitAgentResponses(event.tool)) {
        await emitSubagentResponse(response);
      }
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
        ...(event.eventId ? { eventId: event.eventId } : {}),
        ...(event.createdAt ? { createdAt: event.createdAt } : {}),
        ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
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
    const normalizedEvent = normalizeHarnessRuntimeEvent(event);
    await captureRawEvent(normalizedEvent);
    if (shouldPassThroughPresentationBoundary(normalizedEvent)) {
      await hooks.onRuntimeEvent(attachRuntimeBoundaryFacts(normalizedEvent, input.workdir));
      if (normalizedEvent.type === "tool.completed") {
        rememberSpawnedSubagent(normalizedEvent.tool);
        if (normalizedEvent.tool.outputBlocks) {
          await hooks.onToolResult(normalizedEvent.tool.outputBlocks, normalizedEvent.tool.name, normalizedEvent.tool.permissions ?? {});
        }
        for (const response of extractWaitAgentResponses(normalizedEvent.tool)) {
          await emitSubagentResponse(response);
        }
      }
      return;
    }
    switch (normalizedEvent.type) {
      case "reasoning.started":
      case "reasoning.updated":
      case "reasoning.completed":
        await hooks.onReasoning({
          status: normalizedEvent.status,
          summaryParts: normalizedEvent.summaryParts ?? [],
          contentParts: normalizedEvent.contentParts ?? [normalizedEvent.text],
          text: normalizedEvent.text,
        });
        return;
      case "tool.started":
        await handleToolStarted(normalizedEvent);
        return;
      case "tool.updated":
      case "tool.completed":
      case "tool.failed":
        await handleToolProgress(normalizedEvent);
        return;
      case "command.started":
      case "command.completed":
      case "command.failed":
        await hooks.onCommand(normalizedEvent.command);
        return;
      case "file-read.started":
        await hooks.onFileRead(normalizedEvent.fileRead);
        return;
      case "assistant.completed":
        if (normalizedEvent.responseMode === "append") {
          result.response.push({ type: normalizedEvent.contentType, text: normalizedEvent.text });
        } else if (normalizedEvent.responseMode !== "none") {
          result.response = [{ type: normalizedEvent.contentType, text: normalizedEvent.text }];
        }
        if (normalizedEvent.notify !== false) {
          await hooks.onLlmResponse(normalizedEvent.displayText ?? normalizedEvent.text);
        }
        if (normalizedEvent.usage) {
          await updateUsage(normalizedEvent.usage, normalizedEvent.usageMode ?? "replace");
        }
        return;
      case "content.delta":
        if (normalizedEvent.notify !== false) {
          await hooks.onLlmResponse(normalizedEvent.displayText ?? normalizedEvent.text, {
            source: "llm",
            streamId: normalizedEvent.itemId,
            streamStatus: "partial",
          });
        }
        return;
      case "subagent.completed":
        await hooks.onLlmResponse(normalizedEvent.text, {
          source: "subagent",
          ...(normalizedEvent.metadata ?? {}),
        });
        return;
      case "plan.updated":
        await hooks.onPlan(createPlanPresentationFromState(normalizedEvent.plan));
        return;
      case "usage.updated":
        await updateUsage(normalizedEvent.usage, "replace");
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
      case "item.started":
      case "item.updated":
        await hooks.onRuntimeEvent(normalizedEvent);
        return;
      case "item.completed":
        if (normalizedEvent.item.kind === "assistant") {
          const text = normalizedEvent.item.text ?? "";
          result.response = [{ type: "markdown", text }];
          if (text) {
            await hooks.onLlmResponse(text, {
              source: "llm",
              streamId: normalizedEvent.item.id,
              streamStatus: "final",
            });
          }
        } else {
          await hooks.onRuntimeEvent(normalizedEvent);
        }
        return;
      case "extension.notification":
      case "extension.request":
        await hooks.onRuntimeEvent(normalizedEvent);
        return;
      case "file-change.completed":
        await hooks.onFileChange(normalizedEvent.change);
        return;
      case "model.rerouted":
      case "config.warning":
      case "runtime.warning":
      case "runtime.error":
        await hooks.onRuntimeEvent(normalizedEvent);
        return;
      default: {
        /** @type {never} */
        const exhaustive = normalizedEvent;
        throw new Error(`Unsupported harness runtime event: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return {
    result,
    handleEvent,
  };
}

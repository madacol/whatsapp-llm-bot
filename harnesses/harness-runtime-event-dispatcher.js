import { getDefaultFixtureCapture } from "../diagnostics/capture.js";
import { createPlanPresentationFromState } from "../plan-presentation.js";
import { createAgentRunActivityReconciliation } from "./agent-run-activity-reconciliation.js";
import { getHarnessRuntimeDiagnosticRaw, normalizeHarnessRuntimeEvent } from "./harness-runtime-events.js";

/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeEvent} HarnessRuntimeEvent
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeEventInput} HarnessRuntimeEventInput
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeProvider} HarnessRuntimeProvider
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeTool} HarnessRuntimeTool
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeUsage} HarnessRuntimeUsage
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeCommandEvent
 *   | import("./harness-runtime-events.js").HarnessRuntimeToolEvent
 *   | import("./harness-runtime-events.js").HarnessRuntimeFileChangeEvent} HarnessRuntimeProgressEvent
 */

/**
 * @type {Pick<Required<AgentIOHooks>, "onReasoning" | "onToolResult" | "onLlmResponse" | "onUsage" | "onPlan" | "onRuntimeEvent">}
 */
const DEFAULT_RUNTIME_EVENT_HOOKS = {
  onReasoning: async () => {},
  onToolResult: async () => {},
  onLlmResponse: async () => {},
  onUsage: async () => {},
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
 * @param {HarnessRuntimeEvent} event
 * @returns {event is HarnessRuntimeProgressEvent}
 */
function shouldEmitAsRuntimeProgress(event) {
  return event.type === "command.started"
    || event.type === "command.completed"
    || event.type === "command.failed"
    || event.type === "tool.started"
    || event.type === "tool.updated"
    || event.type === "tool.completed"
    || event.type === "tool.failed"
    || event.type === "file-change.completed";
}

/**
 * ACP terminal output deltas can arrive many times per second and may contain
 * very large chunks. ACP normalization marks those tool events so chat only
 * emits the started and completed lifecycle.
 * @param {HarnessRuntimeEvent} event
 * @returns {boolean}
 */
function shouldSuppressChatRuntimeProgress(event) {
  return event.type === "tool.updated" && event.tool.suppressProgress === true;
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
 *   hooks?: Pick<AgentIOHooks, "onReasoning" | "onToolResult" | "onLlmResponse" | "onUsage" | "onPlan" | "onRuntimeEvent">,
 *   emitRuntimeEvent?: (event: HarnessRuntimeEvent) => Promise<void>,
 *   workdir?: string | null,
 *   emitUsage?: boolean,
 *   fixtureCapture?: import("../diagnostics/capture.js").FixtureCapture | null,
 * }} input
 * @returns {{
 *   result: AgentResult,
 *   handleEvent: (event: HarnessRuntimeEventInput) => Promise<void>,
 * }}
 */
export function createHarnessRuntimeEventDispatcher(input) {
  const hooks = { ...DEFAULT_RUNTIME_EVENT_HOOKS, ...input.hooks };
  const activity = createAgentRunActivityReconciliation({ hooks });
  const emitRuntimeEvent = input.emitRuntimeEvent ?? hooks.onRuntimeEvent;
  const fixtureCapture = input.fixtureCapture === undefined ? getDefaultFixtureCapture() : input.fixtureCapture;

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
   * @param {HarnessRuntimeEvent} event
   * @param {import("./harness-runtime-events.js").HarnessRuntimeRawEvent | undefined} diagnosticRaw
   * @returns {void}
   */
  function captureRawEvent(event, diagnosticRaw) {
    if (!fixtureCapture || !diagnosticRaw) {
      return;
    }
    fixtureCapture.capture({
      seam: "harness.raw-event",
      direction: "provider_to_runtime",
      event: event.type,
      ...(event.createdAt ? { capturedAt: event.createdAt } : {}),
      payload: {
        provider: event.provider,
        type: event.type,
        ...(event.eventId ? { eventId: event.eventId } : {}),
        ...(event.createdAt ? { createdAt: event.createdAt } : {}),
        ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
        raw: diagnosticRaw,
      },
    });
  }

  /**
   * @param {HarnessRuntimeEventInput} event
   * @returns {Promise<void>}
   */
  async function handleEvent(event) {
    const diagnosticRaw = getHarnessRuntimeDiagnosticRaw(event);
    const normalizedEvent = normalizeHarnessRuntimeEvent(event);
    captureRawEvent(normalizedEvent, diagnosticRaw);
    if (shouldSuppressChatRuntimeProgress(normalizedEvent)) {
      return;
    }
    if (shouldEmitAsRuntimeProgress(normalizedEvent)) {
      await emitRuntimeEvent(attachRuntimeBoundaryFacts(activity.enrichSubagentToolEvent(normalizedEvent), input.workdir));
      if (normalizedEvent.type === "tool.completed") {
        activity.rememberSpawnedSubagent(normalizedEvent.tool);
        if (normalizedEvent.tool.outputBlocks) {
          await hooks.onToolResult(normalizedEvent.tool.outputBlocks, normalizedEvent.tool.name, normalizedEvent.tool.permissions ?? {});
        }
        await activity.emitWaitAgentResponses(normalizedEvent.tool);
      }
      return;
    }
    switch (normalizedEvent.type) {
      case "reasoning.started":
      case "reasoning.updated":
      case "reasoning.completed":
        await activity.emitReasoning(normalizedEvent);
        return;
      case "assistant.completed":
        await activity.completeOpenReasoning();
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
        await activity.emitSubagentCompleted(normalizedEvent);
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
        await emitRuntimeEvent(normalizedEvent);
        return;
      case "turn.completed":
        await activity.completeOpenReasoning();
        await emitRuntimeEvent(normalizedEvent);
        return;
      case "request.opened":
      case "request.resolved":
      case "user-input.requested":
      case "user-input.resolved":
      case "item.started":
      case "item.updated":
        await emitRuntimeEvent(normalizedEvent);
        return;
      case "item.completed":
        if (normalizedEvent.item.kind === "assistant") {
          await activity.completeOpenReasoning();
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
          await emitRuntimeEvent(normalizedEvent);
        }
        return;
      case "extension.notification":
      case "extension.request":
        await emitRuntimeEvent(normalizedEvent);
        return;
      case "model.rerouted":
      case "config.warning":
      case "runtime.warning":
      case "runtime.error":
        await emitRuntimeEvent(normalizedEvent);
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

import { failedToolCallUpdate } from "../message-failure-presentation.js";
import { buildToolPresentation, getToolFlowDescriptor } from "../tool-presentation-model.js";
import { toolCallUpdate, toolFlowInspectState, toolFlowUpdate, toolInspectState } from "../outbound-events.js";
import { createPlanPresentationFromState } from "../plan-presentation.js";
import { createLogger } from "../logger.js";
import { estimateCodexUsageCost } from "./codex-usage-cost.js";
import { createCodexReasoningState } from "./codex-reasoning-state.js";
import { createCodexRunState } from "./codex-run-state.js";
import { createCodexSyntheticToolAdapter } from "./codex-synthetic-tools.js";

const log = createLogger("harness:codex-events");

/**
 * Shared semantic dispatcher for normalized Codex events, independent of the
 * underlying transport (SDK exec or App Server).
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onComposing" | "onPaused" | "onReasoning" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
 *   runConfig?: HarnessRunConfig,
 *   messages: Message[],
 *   fileChangeTracker?: ReturnType<typeof import("./codex-file-change-tracker.js").createCodexFileChangeTracker>,
 * }} input
 * @returns {{
 *   result: AgentResult,
 *   handleNormalized: (event: import("./codex-events.js").NormalizedCodexEvent) => Promise<void>,
 *   finalize: () => { result: AgentResult, failureMessage: string | null },
 * }}
 */
export function createCodexEventDispatcher(input) {
  const runState = createCodexRunState({ workdir: input.runConfig?.workdir });
  const syntheticToolAdapter = createCodexSyntheticToolAdapter({
    onToolCall: input.hooks.onToolCall,
    cwd: input.runConfig?.workdir ?? null,
  });
  const reasoningState = createCodexReasoningState();
  /** @type {Map<string, { handle?: MessageHandle, presentation: import("../tool-presentation-model.js").ToolPresentation, flowKey?: string }>} */
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

  /** @type {string | null} */
  let lastAssistantText = null;
  /** @type {string | null} */
  let failureMessage = null;

  /**
   * @param {Record<string, unknown>} args
   * @returns {string[]}
   */
  function getReceiverThreadIds(args) {
    const value = args.receiver_thread_ids;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry) => typeof entry === "string");
  }

  /**
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * @param {string | undefined} text
   * @returns {Record<string, unknown> | null}
   */
  function parseJsonObject(text) {
    if (typeof text !== "string" || text.trim().length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {import("./codex-events.js").CodexThreadEvent} threadEvent
   * @returns {void}
   */
  function rememberSubagentThread(threadEvent) {
    subagentThreads.set(threadEvent.id, {
      source: "subagent",
      threadId: threadEvent.id,
      ...(threadEvent.parentThreadId !== undefined && { parentThreadId: threadEvent.parentThreadId }),
      ...(threadEvent.agentNickname !== undefined && { agentNickname: threadEvent.agentNickname }),
      ...(threadEvent.agentRole !== undefined && { agentRole: threadEvent.agentRole }),
    });
    log.info("registered sub-agent thread", {
      threadId: threadEvent.id,
      parentThreadId: threadEvent.parentThreadId ?? null,
      agentNickname: threadEvent.agentNickname ?? null,
      agentRole: threadEvent.agentRole ?? null,
    });
  }

  /**
   * @param {import("./codex-events.js").CodexToolEvent} toolEvent
   * @returns {void}
   */
  function rememberSpawnedReceiverThreads(toolEvent) {
    if (toolEvent.name !== "spawn_agent" || toolEvent.status !== "completed") {
      return;
    }
    for (const threadId of getReceiverThreadIds(toolEvent.arguments)) {
      if (!subagentThreads.has(threadId)) {
        subagentThreads.set(threadId, {
          source: "subagent",
          threadId,
        });
      }
    }
  }

  /**
   * Standard Codex tool output reports spawned agents as
   * `{ agent_id, nickname }` instead of collab `receiver_thread_ids`.
   * @param {import("./codex-events.js").CodexToolEvent} toolEvent
   * @returns {void}
   */
  function rememberStandardSpawnedAgent(toolEvent) {
    if (toolEvent.name !== "spawn_agent" || toolEvent.status !== "completed") {
      return;
    }
    const output = parseJsonObject(toolEvent.output);
    const threadId = typeof output?.agent_id === "string" ? output.agent_id : null;
    if (!threadId) {
      return;
    }
    const agentNickname = typeof output?.nickname === "string" ? output.nickname : undefined;
    const existing = subagentThreads.get(threadId);
    subagentThreads.set(threadId, {
      ...existing,
      source: "subagent",
      threadId,
      ...(agentNickname !== undefined && { agentNickname }),
    });
  }

  /**
   * Standard Codex `wait_agent` output reports final messages as
   * `{ status: { [threadId]: { completed: text } } }`.
   * @param {import("./codex-events.js").CodexToolEvent} toolEvent
   * @returns {import("./codex-events.js").CodexSubagentResponseEvent[]}
   */
  function extractStandardWaitAgentResponses(toolEvent) {
    if (toolEvent.name !== "wait_agent" || toolEvent.status !== "completed") {
      return [];
    }
    const output = parseJsonObject(toolEvent.output);
    const status = isRecord(output?.status) ? output.status : null;
    if (!status) {
      return [];
    }

    /** @type {import("./codex-events.js").CodexSubagentResponseEvent[]} */
    const responses = [];
    for (const [threadId, state] of Object.entries(status)) {
      if (!isRecord(state) || typeof state.completed !== "string" || state.completed.length === 0) {
        continue;
      }
      responses.push({ threadId, text: state.completed });
    }
    return responses;
  }

  /**
   * @param {import("./codex-events.js").CodexSubagentResponseEvent} response
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
    log.info("emitting sub-agent response", {
      threadId: metadata.threadId ?? null,
      parentThreadId: metadata.parentThreadId ?? null,
      agentNickname: metadata.agentNickname ?? null,
      textLength: response.text.length,
    });
    await input.hooks.onLlmResponse(response.text, metadata);
  }

  /**
   * @param {import("./codex-events.js").NormalizedCodexEvent} normalized
   * @returns {Promise<void>}
   */
  async function handleNormalized(normalized) {
    if (normalized.usage) {
      const estimatedCost = normalized.usage.cost > 0
        ? normalized.usage.cost
        : estimateCodexUsageCost(input.runConfig?.model, normalized.usage);
      result.usage = {
        ...normalized.usage,
        cost: estimatedCost ?? normalized.usage.cost,
      };
    }

    if (normalized.failureMessage) {
      failureMessage = normalized.failureMessage;
    }

    if (normalized.threadEvent?.kind === "subagent") {
      rememberSubagentThread(normalized.threadEvent);
    }

    if (normalized.commandEvent) {
      const dispatch = await runState.handleCommandEvent(normalized.commandEvent);
      if (normalized.commandEvent.status === "completed") {
        syntheticToolAdapter.handleCommandCompletion(normalized.commandEvent);
      }
      if (dispatch.fileRead) {
        await input.hooks.onFileRead(dispatch.fileRead);
      }
      if (dispatch.command) {
        await input.hooks.onCommand(dispatch.command);
      }
      if (normalized.commandEvent.status === "started" && (dispatch.fileRead || dispatch.command)) {
        await input.hooks.onPaused();
        await input.hooks.onComposing();
      }
    }

    if (normalized.toolEvent) {
      const toolEvent = normalized.toolEvent;
      rememberSpawnedReceiverThreads(toolEvent);
      rememberStandardSpawnedAgent(toolEvent);
      const currentPresentation = buildToolPresentation(
        toolEvent.name,
        toolEvent.arguments,
        undefined,
        input.runConfig?.workdir ?? null,
        undefined,
      );
      const flow = getToolFlowDescriptor(currentPresentation);
      if (flow) {
        let activeFlow = activeFlows.get(flow.groupKey);
        if (!activeFlow) {
          const toolCall = {
            id: toolEvent.id,
            name: toolEvent.name,
            arguments: JSON.stringify(toolEvent.arguments),
          };
          const handle = await input.hooks.onToolCall(toolCall) ?? undefined;
          activeFlow = {
            handle,
            state: { title: flow.groupTitle, steps: [] },
          };
          activeFlows.set(flow.groupKey, activeFlow);
        }

        let step = activeFlow.state.steps.find((candidate) => candidate.id === toolEvent.id);
        if (!step) {
          step = { id: toolEvent.id, presentation: currentPresentation };
          activeFlow.state.steps.push(step);
        } else {
          step.presentation = currentPresentation;
        }

        activeTools.set(toolEvent.id, {
          handle: activeFlow.handle,
          presentation: currentPresentation,
          flowKey: flow.groupKey,
        });

        if (activeFlow.handle && toolEvent.status === "started") {
          try {
            await activeFlow.handle.update(toolFlowUpdate(activeFlow.state));
            activeFlow.handle.setInspect(toolFlowInspectState(activeFlow.state));
          } catch {
            // best-effort
          }
        }
        if (toolEvent.status === "started") {
          await input.hooks.onPaused();
          await input.hooks.onComposing();
        }

        if (toolEvent.status !== "started") {
          step.output = toolEvent.output;
          if (activeFlow.handle) {
            try {
              activeFlow.handle.setInspect(toolFlowInspectState(activeFlow.state));
            } catch {
              // best-effort
            }
          }
          activeTools.delete(toolEvent.id);
        }
      } else if (toolEvent.status === "started") {
        const toolCall = {
          id: toolEvent.id,
          name: toolEvent.name,
          arguments: JSON.stringify(toolEvent.arguments),
        };
        const handle = await input.hooks.onToolCall(toolCall);
        if (handle) {
          try {
            handle.setInspect(toolInspectState(currentPresentation));
          } catch {
            // best-effort
          }
          activeTools.set(toolEvent.id, {
            handle,
            presentation: currentPresentation,
          });
        }
        await input.hooks.onPaused();
        await input.hooks.onComposing();
      } else {
        let activeTool = activeTools.get(toolEvent.id);
        if (!activeTool) {
          const toolCall = {
            id: toolEvent.id,
            name: toolEvent.name,
            arguments: JSON.stringify(toolEvent.arguments),
          };
          const handle = await input.hooks.onToolCall(toolCall);
          if (handle) {
            activeTool = { handle, presentation: currentPresentation };
          }
        }
        if (activeTool?.handle && activeTool.presentation.summary !== currentPresentation.summary) {
          try {
            await activeTool.handle.update(toolCallUpdate(currentPresentation));
          } catch {
            // best-effort
          }
          activeTool.presentation = currentPresentation;
        }
        if (activeTool?.handle && toolEvent.output) {
          activeTool.handle.setInspect(toolInspectState(activeTool.presentation, toolEvent.output));
        }
        if (activeTool?.handle && toolEvent.status === "failed") {
          try {
            await activeTool.handle.update(failedToolCallUpdate(activeTool.presentation));
          } catch {
            // best-effort
          }
        }
        if (activeTool) {
          activeTools.delete(toolEvent.id);
        }
      }

      for (const response of extractStandardWaitAgentResponses(toolEvent)) {
        await emitSubagentResponse(response);
      }
    }

    if (normalized.reasoningEvent) {
      await input.hooks.onReasoning(reasoningState.apply(normalized.reasoningEvent));
    }

    for (const response of normalized.subagentResponses ?? []) {
      await emitSubagentResponse(response);
    }

    if (normalized.assistantText) {
      const suppressAssistantText = await syntheticToolAdapter.handleAssistantText(normalized.assistantText);
      if (!suppressAssistantText) {
        const metadata = normalized.sessionId ? subagentThreads.get(normalized.sessionId) : undefined;
        if (metadata?.source === "subagent") {
          await emitSubagentResponse({
            ...(metadata.threadId !== undefined && { threadId: metadata.threadId }),
            text: normalized.assistantText,
          });
        } else {
          lastAssistantText = normalized.assistantText;
          await input.hooks.onLlmResponse(normalized.assistantText, metadata);
        }
      }
    }

    if (normalized.plan) {
      await input.hooks.onPlan(createPlanPresentationFromState(normalized.plan));
    }

    if (normalized.fileChangeLifecycle) {
      const lifecycle = normalized.fileChangeLifecycle;
      if (lifecycle.status === "started") {
        input.fileChangeTracker?.rememberStarted(lifecycle.itemId, lifecycle.changes);
        return;
      }

      const tracked = input.fileChangeTracker?.takeCompletion(lifecycle.itemId, lifecycle.changes) ?? {
        itemId: lifecycle.itemId,
        changes: lifecycle.changes,
        decision: null,
      };
      if (tracked.decision === "cancel") {
        return;
      }
      for (const fileChange of tracked.changes) {
        const enrichedFileChange = await runState.enrichFileChangeEvent(fileChange);
        await input.hooks.onFileChange({
          ...enrichedFileChange,
          itemId: lifecycle.itemId,
          stage: lifecycle.status === "failed" ? "failed" : "applied",
        });
      }
      return;
    }

    const fileChanges = normalized.fileChanges ?? (normalized.fileChange ? [normalized.fileChange] : []);
    for (const fileChange of fileChanges) {
      const enrichedFileChange = await runState.enrichFileChangeEvent(fileChange);
      await input.hooks.onFileChange(enrichedFileChange);
    }
  }

  return {
    result,
    handleNormalized,
    finalize() {
      if (lastAssistantText) {
        result.response = [{ type: "markdown", text: lastAssistantText }];
      }
      return { result, failureMessage };
    },
  };
}

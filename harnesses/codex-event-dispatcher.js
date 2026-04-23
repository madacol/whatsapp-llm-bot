import { buildToolPresentation, getToolFlowDescriptor } from "../tool-presentation-model.js";
import { textUpdate, toolCallUpdate, toolFlowInspectState, toolFlowUpdate, toolInspectState } from "../outbound-events.js";
import { createPlanPresentationFromState } from "../plan-presentation.js";
import { createCodexReasoningState } from "./codex-reasoning-state.js";
import { createCodexRunState } from "./codex-run-state.js";
import { createCodexSyntheticToolAdapter } from "./codex-synthetic-tools.js";

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
   * @param {string} summary
   * @returns {string}
   */
  function formatFailedSummary(summary) {
    return summary.startsWith("❌ ") ? summary : `❌ ${summary}`;
  }

  /**
   * @param {import("./codex-events.js").NormalizedCodexEvent} normalized
   * @returns {Promise<void>}
   */
  async function handleNormalized(normalized) {
    if (normalized.usage) {
      result.usage = normalized.usage;
    }

    if (normalized.failureMessage) {
      failureMessage = normalized.failureMessage;
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
            await activeTool.handle.update(textUpdate(formatFailedSummary(activeTool.presentation.summary)));
          } catch {
            // best-effort
          }
        }
        if (activeTool) {
          activeTools.delete(toolEvent.id);
        }
      }
    }

    if (normalized.reasoningEvent) {
      await input.hooks.onReasoning(reasoningState.apply(normalized.reasoningEvent));
    }

    if (normalized.assistantText) {
      const suppressAssistantText = await syntheticToolAdapter.handleAssistantText(normalized.assistantText);
      if (!suppressAssistantText) {
        lastAssistantText = normalized.assistantText;
        await input.hooks.onLlmResponse(normalized.assistantText);
      }
    }

    if (normalized.plan) {
      await input.hooks.onPlan(createPlanPresentationFromState(normalized.plan));
    }

    if (normalized.fileChangeLifecycle) {
      const lifecycle = normalized.fileChangeLifecycle;
      if (lifecycle.status === "started") {
        input.fileChangeTracker?.rememberStarted(lifecycle.itemId, lifecycle.changes);
        for (const fileChange of lifecycle.changes) {
          await input.hooks.onFileChange({
            ...fileChange,
            itemId: lifecycle.itemId,
            stage: "proposed",
          });
        }
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

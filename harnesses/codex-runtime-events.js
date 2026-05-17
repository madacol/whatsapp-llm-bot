import { estimateCodexUsageCost } from "./codex-usage-cost.js";

/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeAssistantCompletedEvent} HarnessRuntimeAssistantCompletedEvent
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeUsageEvent} HarnessRuntimeUsageEvent
 */

/**
 * @param {string} text
 * @returns {HarnessRuntimeAssistantCompletedEvent}
 */
export function normalizeCodexAssistantRuntimeEvent(text) {
  return {
    type: "assistant.completed",
    provider: "codex",
    text,
    contentType: "markdown",
    responseMode: "replace",
  };
}

/**
 * @param {{
 *   usage: HarnessUsage,
 *   runConfig?: HarnessRunConfig,
 * }} input
 * @returns {HarnessRuntimeUsageEvent}
 */
export function normalizeCodexUsageRuntimeEvent(input) {
  const estimatedCost = input.usage.cost > 0
    ? input.usage.cost
    : estimateCodexUsageCost(input.runConfig?.model, input.usage);
  return {
    type: "usage.updated",
    provider: "codex",
    usage: {
      ...input.usage,
      cost: estimatedCost ?? input.usage.cost,
    },
  };
}

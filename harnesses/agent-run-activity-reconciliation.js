/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeEvent} HarnessRuntimeEvent
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeTool} HarnessRuntimeTool
 * @typedef {Extract<HarnessRuntimeEvent, { type: "reasoning.started" | "reasoning.updated" | "reasoning.completed" }>} HarnessRuntimeReasoningEvent
 * @typedef {Extract<HarnessRuntimeEvent, { type: "subagent.completed" }>} HarnessRuntimeSubagentCompletedEvent
 */

/**
 * ACP thought chunks are mostly deltas, but the provider can also emit a later
 * snapshot of the current thought block. Keep the assembled text latest and
 * non-repeating without changing ordinary token deltas.
 * @param {string} current
 * @param {string} incoming
 * @returns {string}
 */
function appendCoalescedDeltaText(current, incoming) {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  if (current === incoming) {
    return current;
  }
  const minimumSnapshotLength = 24;
  if (incoming.length >= minimumSnapshotLength && current.endsWith(incoming)) {
    return current;
  }
  if (current.length >= minimumSnapshotLength && incoming.startsWith(current)) {
    return incoming;
  }
  const maxOverlap = Math.min(current.length, incoming.length);
  for (let overlapLength = maxOverlap; overlapLength >= minimumSnapshotLength; overlapLength -= 1) {
    if (current.endsWith(incoming.slice(0, overlapLength))) {
      return current + incoming.slice(overlapLength);
    }
  }
  return current + incoming;
}

/**
 * @param {string[]} parts
 * @returns {string[]}
 */
function cleanCompletedReasoningParts(parts) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} args
 * @returns {string[]}
 */
function readReceiverThreadIds(args) {
  const value = Array.isArray(args.receiverThreadIds) ? args.receiverThreadIds : args.receiver_thread_ids;
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

/**
 * @param {unknown} prompt
 * @returns {string | null}
 */
function deriveSubagentNicknameFromPrompt(prompt) {
  if (typeof prompt !== "string") {
    return null;
  }
  const firstLine = prompt.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }
  const sentenceMatch = /^(.+?)[.!?](?:\s|$)/.exec(firstLine);
  const nickname = (sentenceMatch?.[1] ?? firstLine).replace(/\s+/g, " ").trim();
  if (!nickname) {
    return null;
  }
  return nickname.length > 80 ? `${nickname.slice(0, 77).trimEnd()}...` : nickname;
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
  if (!isRecord(parsed) || !isRecord(parsed.status)) {
    return [];
  }
  /** @type {Array<{ threadId: string, text: string }>} */
  const responses = [];
  for (const [threadId, state] of Object.entries(parsed.status)) {
    if (!isRecord(state)) {
      continue;
    }
    const text = state.completed;
    if (typeof text === "string" && text.length > 0) {
      responses.push({ threadId, text });
    }
  }
  return responses;
}

/**
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onReasoning" | "onLlmResponse">,
 * }} input
 */
export function createAgentRunActivityReconciliation(input) {
  /** @type {Map<string, LlmResponseMetadata>} */
  const subagentThreads = new Map();
  /** @type {Set<string>} */
  const deliveredSubagentResponses = new Set();
  /** @type {{ contentParts: string[], summaryParts: string[], contentDeltaText: string, summaryDeltaText: string } | null} */
  let openReasoning = null;

  /**
   * @param {HarnessRuntimeTool} tool
   * @returns {void}
   */
  function rememberSpawnedSubagent(tool) {
    if (tool.name !== "spawn_agent") {
      return;
    }
    const receiverThreadIds = readReceiverThreadIds(tool.arguments);
    if (receiverThreadIds.length > 0) {
      const agentNickname = deriveSubagentNicknameFromPrompt(tool.arguments.prompt);
      for (const threadId of receiverThreadIds) {
        subagentThreads.set(threadId, {
          source: "subagent",
          threadId,
          ...(agentNickname ? { agentNickname } : {}),
        });
      }
      return;
    }
    if (typeof tool.output !== "string") {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(tool.output);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    const threadId = typeof parsed.agent_id === "string"
      ? parsed.agent_id
      : typeof parsed.threadId === "string" ? parsed.threadId : null;
    if (!threadId) {
      return;
    }
    subagentThreads.set(threadId, {
      source: "subagent",
      threadId,
      ...(typeof parsed.nickname === "string" ? { agentNickname: parsed.nickname } : {}),
    });
  }

  /**
   * @param {HarnessRuntimeEvent} event
   * @returns {HarnessRuntimeEvent}
   */
  function enrichSubagentToolEvent(event) {
    if (
      event.type !== "tool.started"
      && event.type !== "tool.updated"
      && event.type !== "tool.completed"
      && event.type !== "tool.failed"
    ) {
      return event;
    }
    const threadId = event.tool.subagent?.threadId;
    const remembered = threadId ? subagentThreads.get(threadId) : null;
    if (!remembered) {
      return event;
    }
    return {
      ...event,
      tool: {
        ...event.tool,
        subagent: {
          ...remembered,
          ...(event.tool.subagent ?? {}),
          ...(event.tool.subagent?.agentNickname
            ? { agentNickname: event.tool.subagent.agentNickname }
            : remembered.agentNickname ? { agentNickname: remembered.agentNickname } : {}),
        },
      },
    };
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
    await input.hooks.onLlmResponse(response.text, metadata);
  }

  /**
   * @param {HarnessRuntimeTool} tool
   * @returns {Promise<void>}
   */
  async function emitWaitAgentResponses(tool) {
    for (const response of extractWaitAgentResponses(tool)) {
      await emitSubagentResponse(response);
    }
  }

  /**
   * @param {HarnessRuntimeReasoningEvent} event
   * @returns {void}
   */
  function rememberReasoning(event) {
    if (!openReasoning) {
      openReasoning = { contentParts: [], summaryParts: [], contentDeltaText: "", summaryDeltaText: "" };
    }
    const contentParts = event.contentParts ?? [event.text];
    const summaryParts = event.summaryParts ?? [];
    if (event.appendMode === "delta") {
      openReasoning.contentDeltaText = appendCoalescedDeltaText(openReasoning.contentDeltaText, contentParts.join(""));
      openReasoning.summaryDeltaText = appendCoalescedDeltaText(openReasoning.summaryDeltaText, summaryParts.join(""));
    } else {
      openReasoning.contentParts.push(...contentParts);
      openReasoning.summaryParts.push(...summaryParts);
    }
    if (event.type === "reasoning.completed") {
      openReasoning = null;
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function completeOpenReasoning() {
    if (!openReasoning) {
      return;
    }
    const contentParts = cleanCompletedReasoningParts([
      openReasoning.contentDeltaText.trim(),
      ...openReasoning.contentParts.map((part) => part.trim()),
    ]);
    const summaryParts = cleanCompletedReasoningParts([
      openReasoning.summaryDeltaText.trim(),
      ...openReasoning.summaryParts.map((part) => part.trim()),
    ]);
    const text = [...contentParts, ...summaryParts].join("\n\n").trim();
    openReasoning = null;
    await input.hooks.onReasoning({
      status: "completed",
      summaryParts,
      contentParts,
      text,
    });
  }

  /**
   * @param {HarnessRuntimeReasoningEvent} event
   * @returns {Promise<void>}
   */
  async function emitReasoning(event) {
    rememberReasoning(event);
    if (event.status === "completed") {
      const contentParts = cleanCompletedReasoningParts(event.contentParts ?? [event.text]);
      const summaryParts = cleanCompletedReasoningParts(event.summaryParts ?? []);
      const text = event.text.trim();
      await input.hooks.onReasoning({
        status: event.status,
        summaryParts,
        contentParts,
        text,
      });
      return;
    }
    await input.hooks.onReasoning({
      status: event.status,
      summaryParts: event.summaryParts ?? [],
      contentParts: event.contentParts ?? [event.text],
      text: event.text,
    });
  }

  /**
   * @param {HarnessRuntimeSubagentCompletedEvent} event
   * @returns {Promise<void>}
   */
  async function emitSubagentCompleted(event) {
    await completeOpenReasoning();
    await input.hooks.onLlmResponse(event.text, {
      source: "subagent",
      ...(event.metadata ?? {}),
    });
  }

  return {
    rememberSpawnedSubagent,
    enrichSubagentToolEvent,
    emitWaitAgentResponses,
    emitReasoning,
    completeOpenReasoning,
    emitSubagentCompleted,
  };
}

import { getSharedSkillActions } from "./shared-skills.js";

const SHARED_SKILL_FENCE = "madabot-skill";

/**
 * @typedef {{
 *   skill: string,
 *   arguments: Record<string, unknown>,
 *   raw: string,
 * }} SharedSkillInvocation
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is ToolContentBlock[]}
 */
function isToolContentBlockArray(value) {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.type === "string");
}

/**
 * @param {ActionResultValue} result
 * @returns {ToolContentBlock[]}
 */
function normalizeActionResult(result) {
  if (isToolContentBlockArray(result)) {
    return result;
  }
  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }
  return [{ type: "text", text: JSON.stringify(result) }];
}

/**
 * @param {string} text
 * @returns {SharedSkillInvocation | null}
 */
export function parseSharedSkillInvocation(text) {
  const trimmed = text.trim();
  const escapedFence = SHARED_SKILL_FENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = trimmed.match(new RegExp(`^\`\`\`${escapedFence}\\s*\\n([\\s\\S]*?)\\n\`\`\`$`));
  if (!match) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.skill !== "string" || !parsed.skill.trim()) {
    return null;
  }
  const args = isRecord(parsed.arguments) ? parsed.arguments : {};
  return {
    skill: parsed.skill.trim(),
    arguments: args,
    raw: trimmed,
  };
}

/**
 * @returns {{
 *   handleText: (text: string) => boolean,
 *   drainInvocations: () => SharedSkillInvocation[],
 * }}
 */
export function createSharedSkillInvocationAdapter() {
  /** @type {SharedSkillInvocation[]} */
  let pending = [];
  /** @type {Set<string>} */
  const seenRaw = new Set();

  return {
    handleText(text) {
      const parsed = parseSharedSkillInvocation(text);
      if (!parsed) {
        return false;
      }
      if (!seenRaw.has(parsed.raw)) {
        pending.push(parsed);
        seenRaw.add(parsed.raw);
      }
      return true;
    },
    drainInvocations() {
      const drained = pending;
      pending = [];
      seenRaw.clear();
      return drained;
    },
  };
}

/**
 * @param {SharedSkillInvocation[]} invocations
 * @param {{
 *   toolRuntime: ToolRuntime,
 *   session: Session,
 *   hooks: Pick<AgentIOHooks, "onToolCall" | "onToolResult" | "onToolError">,
 *   messages: Message[],
 *   runConfig?: HarnessRunConfig,
 * }} input
 * @returns {Promise<ToolContentBlock[]>}
 */
export async function executeSharedSkillInvocations(invocations, input) {
  const sharedTools = getSharedSkillActions(input.toolRuntime.listTools());
  /** @type {ToolContentBlock[]} */
  let latestBlocks = [];

  for (let index = 0; index < invocations.length; index += 1) {
    const invocation = invocations[index];
    const tool = sharedTools.find((candidate) => candidate.sharedSkill.name === invocation.skill);
    if (!tool) {
      const errorText = `Unknown shared skill: ${invocation.skill}`;
      const errorBlocks = /** @type {ToolContentBlock[]} */ ([{ type: "text", text: errorText }]);
      await input.hooks.onToolError?.(errorText);
      latestBlocks = errorBlocks;
      continue;
    }

    const toolCall = {
      id: `shared-skill:${tool.name}:${index + 1}`,
      name: tool.name,
      arguments: JSON.stringify(invocation.arguments),
    };
    const handle = await input.hooks.onToolCall?.(toolCall, tool.formatToolCall);
    const actionResult = await input.toolRuntime.executeTool(
      tool.name,
      input.session.context,
      invocation.arguments,
      {
        workdir: input.runConfig?.workdir ?? null,
        sandboxMode: input.runConfig?.sandboxMode ?? null,
      },
    );

    const blocks = normalizeActionResult(actionResult.result);
    latestBlocks = blocks;

    /** @type {ToolMessage} */
    const toolMessage = {
      role: "tool",
      tool_id: toolCall.id,
      content: blocks,
    };
    input.messages.push(toolMessage);
    await input.session.addMessage(
      input.session.chatId,
      toolMessage,
      input.session.senderIds,
      handle?.keyId,
    );
    await input.hooks.onToolResult?.(blocks, tool.name, actionResult.permissions);
  }

  return latestBlocks;
}

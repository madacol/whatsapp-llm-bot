import { parseToolArgs } from "../agent-io-defaults.js";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { compactToolActivityEvent } from "../outbound-events.js";

/**
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {((params: Record<string, unknown>) => string) | undefined} actionFormatter
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string } | undefined} toolContext
 * @returns {import("../tool-presentation-model.js").ToolPresentation}
 */
function buildCompactToolPresentation(toolCall, actionFormatter, cwd, toolContext) {
  return buildToolPresentation(
    toolCall.name,
    parseToolArgs(toolCall.arguments),
    actionFormatter,
    cwd ?? null,
    toolContext,
  );
}

/**
 * @param {{
 *   send: Pick<ExecuteActionContext, "send">["send"],
 *   cwd: string | null,
 * }} input
 * @returns {{
 *   addCommand: (command: string) => Promise<void>,
 *   completeCommand: (command: string) => Promise<void>,
 *   failCommand: (command: string, output?: string) => Promise<boolean>,
 *   addFileRead: (command: string, paths: string[]) => Promise<void>,
 *   addToolCall: (
 *     toolCall: LlmChatResponse["toolCalls"][0],
 *     actionFormatter?: (params: Record<string, unknown>) => string,
 *     toolContext?: { oldContent?: string },
 *   ) => Promise<void>,
 *   completeToolCall: (toolCall: LlmChatResponse["toolCalls"][0]) => Promise<boolean>,
 *   failMostRecentToolCall: () => Promise<boolean>,
 *   close: () => Promise<void>,
 * }}
 */
export function createCompactToolActivityFeed({ send, cwd }) {
  /** @type {string[]} */
  let pendingToolIds = [];
  let hasOpenActivity = false;

  /**
   * @param {CompactToolActivityEvent["activity"]} activity
   * @returns {Promise<void>}
   */
  async function emit(activity) {
    if (activity.type !== "close") {
      hasOpenActivity = true;
    }
    await send(compactToolActivityEvent(activity, { cwd }));
  }

  return {
    addCommand: async (command) => {
      await emit({ type: "command", status: "started", command });
    },
    completeCommand: async (command) => {
      await emit({ type: "command", status: "completed", command });
    },
    failCommand: async (command, output) => {
      await emit({
        type: "command",
        status: "failed",
        command,
        ...(output !== undefined && { output }),
      });
      return true;
    },
    addFileRead: async (command, paths) => {
      await emit({ type: "file_read", status: "started", command, paths });
    },
    addToolCall: async (toolCall, actionFormatter, toolContext) => {
      if (pendingToolIds.includes(toolCall.id)) {
        return;
      }
      pendingToolIds.push(toolCall.id);
      await emit({
        type: "tool",
        status: "started",
        toolCall,
        presentation: buildCompactToolPresentation(toolCall, actionFormatter, cwd, toolContext),
      });
    },
    completeToolCall: async (toolCall) => {
      if (!pendingToolIds.includes(toolCall.id)) {
        return false;
      }
      pendingToolIds = pendingToolIds.filter((candidate) => candidate !== toolCall.id);
      await emit({
        type: "tool",
        status: "completed",
        toolCall,
      });
      return true;
    },
    failMostRecentToolCall: async () => {
      const toolId = pendingToolIds.pop();
      if (!toolId) {
        return false;
      }
      await emit({
        type: "tool",
        status: "failed",
        toolCall: { id: toolId, name: "", arguments: "{}" },
      });
      return true;
    },
    close: async () => {
      if (!hasOpenActivity) {
        return;
      }
      pendingToolIds = [];
      hasOpenActivity = false;
      await emit({ type: "close" });
    },
  };
}

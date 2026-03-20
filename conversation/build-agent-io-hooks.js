import { MAX_TOOL_CALL_DEPTH } from "../harnesses/index.js";
import { formatToolCallDisplay } from "../tool-display.js";

/**
 * Display a tool call to the user using the formatter shared across harnesses.
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {Pick<ExecuteActionContext, "send">} context
 * @param {((params: Record<string, any>) => string) | undefined} actionFormatter
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string } | undefined} toolContext
 * @returns {Promise<MessageHandle | undefined>}
 */
async function displayToolCall(toolCall, context, actionFormatter, cwd, toolContext) {
  const content = formatToolCallDisplay(toolCall, actionFormatter, cwd ?? null, toolContext);
  if (content == null) {
    return undefined;
  }
  return context.send("tool-call", content);
}

/**
 * Build the AgentIOHooks wiring from a message context.
 * @param {Pick<ExecuteActionContext, "send" | "reply" | "select" | "confirm">} context
 * @param {() => Promise<void>} sendComposing
 * @param {string | null} cwd
 * @returns {AgentIOHooks}
 */
export function buildAgentIoHooks(context, sendComposing, cwd) {
  return {
    onComposing: sendComposing,
    onLlmResponse: async (text) => { await context.reply("llm", [{ type: "markdown", text }]); },
    onAskUser: async (question, options, _preamble, descriptions) => {
      /** @type {Map<string, string>} */
      const labelMap = new Map();
      const pollOptions = options.map((label, index) => {
        const description = descriptions?.[index];
        const enrichedLabel = description ? `${label}\n\n${description}` : label;
        labelMap.set(enrichedLabel, label);
        return enrichedLabel;
      });

      const choice = await context.select(question || "Choose an option:", pollOptions, {
        deleteOnSelect: true,
      });
      return labelMap.get(choice) ?? choice;
    },
    onToolCall: async (toolCall, formatToolCall, toolContext) => {
      return displayToolCall(toolCall, context, formatToolCall, cwd, toolContext);
    },
    onToolResult: async (blocks) => { await context.send("tool-result", blocks); },
    onToolError: async (message) => { await context.send("error", message); },
    onCommand: async ({ command, status, output }) => {
      if (status === "started") {
        return context.send("tool-call", [{ type: "markdown", text: `*Command*\n\n\`\`\`bash\n${command}\n\`\`\`` }]);
      }
      if (status === "failed") {
        const detail = output ? `\n\n${output}` : "";
        await context.send("error", `Command failed: \`${command}\`${detail}`);
        return;
      }
      if (output) {
        await context.send("tool-result", [{ type: "markdown", text: `*Command output*\n\n\`\`\`bash\n${command}\n\`\`\`\n\n\`\`\`\n${output}\n\`\`\`` }]);
      }
    },
    onPlan: async (text) => { await context.reply("llm", [{ type: "markdown", text: `*Plan*\n\n${text}` }]); },
    onFileChange: async ({ path, summary }) => {
      const detail = summary ? `${summary}\n\`${path}\`` : `Changed file: \`${path}\``;
      await context.send("tool-result", detail);
    },
    onContinuePrompt: () => context.confirm("React 👍 to continue or 👎 to stop."),
    onDepthLimit: () => context.confirm(
      `⚠️ *Depth limit*\n\nReached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). React 👍 to continue or 👎 to stop.`,
    ),
    onUsage: async (cost, tokens) => {
      await context.send("usage", `Cost: ${cost} | prompt=${tokens.prompt} cached=${tokens.cached} completion=${tokens.completion}`);
    },
  };
}

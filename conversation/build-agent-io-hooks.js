import { MAX_TOOL_CALL_DEPTH } from "../harnesses/index.js";
import { formatToolCallDisplay, getToolCallSummary, langFromPath } from "../tool-display.js";
import { createToolMessage, registerInspectHandler } from "../utils.js";

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
  /** @type {Map<string, Array<{ handle: MessageHandle, summary: string, toolName: string }>>} */
  const activeInspects = new Map();

  /**
   * @param {string} key
   * @param {{ handle: MessageHandle, summary: string, toolName: string }} entry
   */
  function rememberInspect(key, entry) {
    const existing = activeInspects.get(key) ?? [];
    existing.push(entry);
    activeInspects.set(key, existing);
  }

  /**
   * @param {string} key
   * @returns {{ handle: MessageHandle, summary: string, toolName: string } | undefined}
   */
  function consumeInspect(key) {
    const existing = activeInspects.get(key);
    if (!existing || existing.length === 0) {
      return undefined;
    }
    const entry = existing.shift();
    if (!entry) {
      return undefined;
    }
    if (existing.length === 0) {
      activeInspects.delete(key);
    }
    return entry;
  }

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
        const toolCall = {
          id: `codex-command:${command}`,
          name: "Bash",
          arguments: JSON.stringify({ command }),
        };
        const handle = await displayToolCall(toolCall, context, undefined, cwd, undefined);
        if (handle) {
          rememberInspect(command, {
            handle,
            summary: getToolCallSummary("Bash", { command }, undefined, cwd ?? null),
            toolName: "Bash",
          });
        }
        return handle;
      }
      const inspectEntry = consumeInspect(command);
      if (inspectEntry && output) {
        registerInspectHandler(
          inspectEntry.handle,
          inspectEntry.summary,
          createToolMessage(`codex-command:${command}`, output),
          inspectEntry.toolName,
        );
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
    onFileRead: async ({ command, paths }) => {
      if (paths.length === 1 && typeof paths[0] === "string") {
        const filePath = paths[0];
        const toolCall = {
          id: `codex-read:${filePath}`,
          name: "Read",
          arguments: JSON.stringify({ file_path: filePath }),
        };
        const handle = await displayToolCall(toolCall, context, undefined, cwd, undefined);
        if (handle) {
          rememberInspect(command, {
            handle,
            summary: getToolCallSummary("Read", { file_path: filePath }, undefined, cwd ?? null),
            toolName: "Read",
          });
        }
        return;
      }
      const body = paths.map((filePath) => `\`${filePath}\``).join("\n");
      await context.send("tool-call", [{ type: "markdown", text: `*Read file*\n\n${body}` }]);
    },
    onPlan: async (text) => { await context.reply("llm", [{ type: "markdown", text: `*Plan*\n\n${text}` }]); },
    onFileChange: async ({ path, summary, diff, kind, oldText, newText }) => {
      if (diff) {
        const title = kind === "add"
          ? "*File added*"
          : kind === "delete"
            ? "*File deleted*"
            : "*File changed*";
        if (typeof oldText === "string" || typeof newText === "string") {
          const captionLines = [`${title}  \`${path}\``];
          if (summary) {
            captionLines.push(summary);
          }
          await context.send("tool-result", [{
            type: "diff",
            oldStr: oldText ?? "",
            newStr: newText ?? "",
            language: langFromPath(path) || "text",
            caption: captionLines.join("\n"),
          }]);
          return;
        }
        const lines = [title, ""];
        if (summary) {
          lines.push(summary);
        }
        lines.push(`\`${path}\``, "", "```diff", diff, "```");
        await context.send("tool-result", [{ type: "markdown", text: lines.join("\n") }]);
        return;
      }
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

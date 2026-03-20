import { getToolCallSummary, langFromPath } from "../tool-display.js";
import { createToolMessage, registerInspectHandler } from "../utils.js";

/**
 * @typedef {{
 *   handle: MessageHandle,
 *   summary: string,
 *   toolName: string,
 * }} PendingInspectEntry
 */

/**
 * Build the Codex-specific display hooks that correlate command/file events
 * with inspect handlers and diff rendering.
 * @param {{
 *   context: Pick<ExecuteActionContext, "send">,
 *   cwd: string | null,
 *   displayToolCall: (toolCall: LlmChatResponse["toolCalls"][0]) => Promise<MessageHandle | undefined>,
 * }} input
 * @returns {Pick<Required<AgentIOHooks>, "onCommand" | "onFileRead" | "onFileChange">}
 */
export function createCodexDisplayHooks({ context, cwd, displayToolCall }) {
  /** @type {Map<string, PendingInspectEntry[]>} */
  const activeInspects = new Map();

  return {
    onCommand,
    onFileRead,
    onFileChange,
  };

  /**
   * @param {string} key
   * @param {PendingInspectEntry} entry
   * @returns {void}
   */
  function rememberInspect(key, entry) {
    const existing = activeInspects.get(key) ?? [];
    existing.push(entry);
    activeInspects.set(key, existing);
  }

  /**
   * @param {string} key
   * @returns {PendingInspectEntry | undefined}
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

  /**
   * @param {{ command: string, status: "started" | "completed" | "failed", output?: string }} event
   * @returns {Promise<MessageHandle | void>}
   */
  async function onCommand({ command, status, output }) {
    if (status === "started") {
      const toolCall = {
        id: `codex-command:${command}`,
        name: "Bash",
        arguments: JSON.stringify({ command }),
      };
      const handle = await displayToolCall(toolCall);
      if (handle) {
        rememberInspect(command, {
          handle,
          summary: getToolCallSummary("Bash", { command }, undefined, cwd),
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
      await context.send("tool-result", [{
        type: "markdown",
        text: `*Command output*\n\n\`\`\`bash\n${command}\n\`\`\`\n\n\`\`\`\n${output}\n\`\`\``,
      }]);
    }
  }

  /**
   * @param {{ command: string, paths: string[] }} event
   * @returns {Promise<void>}
   */
  async function onFileRead({ command, paths }) {
    if (paths.length === 1 && typeof paths[0] === "string") {
      const filePath = paths[0];
      const toolCall = {
        id: `codex-read:${filePath}`,
        name: "Read",
        arguments: JSON.stringify({ file_path: filePath }),
      };
      const handle = await displayToolCall(toolCall);
      if (handle) {
        rememberInspect(command, {
          handle,
          summary: getToolCallSummary("Read", { file_path: filePath }, undefined, cwd),
          toolName: "Read",
        });
      }
      return;
    }

    const body = paths.map((filePath) => `\`${filePath}\``).join("\n");
    await context.send("tool-call", [{ type: "markdown", text: `*Read file*\n\n${body}` }]);
  }

  /**
   * @param {{
   *   path: string,
   *   summary?: string,
   *   diff?: string,
   *   kind?: "add" | "delete" | "update",
   *   oldText?: string,
   *   newText?: string,
   * }} event
   * @returns {Promise<void>}
   */
  async function onFileChange({ path, summary, diff, kind, oldText, newText }) {
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
  }
}

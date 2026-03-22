import { buildCommandPresentation, buildMultiReadActivity, buildReadToolPresentation, formatActivitySummary, shortenPath } from "../tool-presentation-model.js";
import { langFromPath, formatToolPresentationInspect, formatToolPresentationSummary } from "#presentation/whatsapp";
import { createToolMessage, registerInspectHandler } from "../utils.js";

/**
 * @typedef {{
 *   handle: MessageHandle,
 *   displayPresentation: import("../tool-presentation-model.js").ToolPresentation,
 *   inspectPresentation: import("../tool-presentation-model.js").ToolPresentation,
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
          displayPresentation: buildCommandPresentation(command, cwd),
          inspectPresentation: buildCommandPresentation(command, cwd),
        });
      }
      return handle;
    }

    const inspectEntry = consumeInspect(command);
    if (inspectEntry) {
      const summary = formatToolPresentationSummary(inspectEntry.displayPresentation);
      const inspectText = formatToolPresentationInspect(inspectEntry.inspectPresentation, output ?? "") ?? undefined;
      registerInspectHandler(
        inspectEntry.handle,
        summary,
        createToolMessage(`codex-command:${command}`, output ?? ""),
        inspectEntry.inspectPresentation.toolName,
        inspectText,
      );
    }

    if (status === "failed") {
      const detail = output ? `\n\n${output}` : "";
      await context.send("error", `Command failed: \`${command}\`${detail}`);
      return;
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
          displayPresentation: buildReadToolPresentation(filePath, cwd),
          inspectPresentation: buildCommandPresentation(command, cwd),
        });
      }
      return;
    }

    await context.send("tool-call", formatActivitySummary(buildMultiReadActivity(paths, cwd)));
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
    const displayPath = shortenPath(path, cwd);
    const cleanedSummary = cleanFileChangeSummary(summary, path, displayPath, kind);
    if (diff) {
      const title = kind === "add"
        ? "*File added*"
        : kind === "delete"
          ? "*File deleted*"
          : "*File changed*";

      if (typeof oldText === "string" || typeof newText === "string") {
        const captionLines = [`${title}  \`${displayPath}\``];
        if (cleanedSummary) {
          captionLines.push(cleanedSummary);
        }
        await context.send("tool-call", [{
          type: "diff",
          oldStr: oldText ?? "",
          newStr: newText ?? "",
          language: langFromPath(path) || "text",
          caption: captionLines.join("\n"),
        }]);
        return;
      }

      const lines = [title, ""];
      if (cleanedSummary) {
        lines.push(cleanedSummary);
      }
      lines.push(`\`${displayPath}\``, "", "```diff", diff, "```");
      await context.send("tool-call", [{ type: "markdown", text: lines.join("\n") }]);
      return;
    }

    const detail = cleanedSummary ? `${cleanedSummary}\n\`${displayPath}\`` : `Changed file: \`${displayPath}\``;
    await context.send("tool-call", detail);
  }
}

/**
 * @param {string | undefined} summary
 * @param {string} rawPath
 * @param {string} displayPath
 * @param {"add" | "delete" | "update" | undefined} kind
 * @returns {string | undefined}
 */
function cleanFileChangeSummary(summary, rawPath, displayPath, kind) {
  if (!summary) {
    return undefined;
  }

  const shortenedSummary = summary.split(rawPath).join(displayPath);
  const redundantForms = new Set([
    rawPath,
    displayPath,
    ...(kind ? [`${rawPath} (${kind})`, `${displayPath} (${kind})`] : []),
  ]);

  return redundantForms.has(shortenedSummary) ? undefined : shortenedSummary;
}

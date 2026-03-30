import { buildCommandPresentation, buildMultiReadActivity, buildReadToolPresentation } from "../tool-presentation-model.js";
import {
  contentEvent,
  fileChangeEvent,
  toolActivityEvent,
  toolInspectState,
} from "../outbound-events.js";

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
 *   visibility: import("../chat-output-visibility.js").OutputVisibility,
 *   displayToolCall: (toolCall: LlmChatResponse["toolCalls"][0]) => Promise<MessageHandle | undefined>,
 * }} input
 * @returns {Pick<Required<AgentIOHooks>, "onCommand" | "onFileRead" | "onFileChange">}
 */
export function createCodexDisplayHooks({ context, cwd, visibility, displayToolCall }) {
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
      if (!visibility.tools) {
        return;
      }
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
      inspectEntry.handle.setInspect(toolInspectState(inspectEntry.inspectPresentation, output ?? ""));
    }

    if (status === "failed") {
      const detail = output ? `\n\n${output}` : "";
      await context.send(contentEvent("error", `Command failed: \`${command}\`${detail}`));
      return;
    }
  }

  /**
   * @param {{ command: string, paths: string[] }} event
   * @returns {Promise<void>}
   */
  async function onFileRead({ command, paths }) {
    if (!visibility.tools) {
      return;
    }

    if (paths.length === 1 && typeof paths[0] === "string") {
      const filePath = paths[0];
      const toolCall = {
        id: `codex-read:${filePath}`,
        name: "Read",
        arguments: JSON.stringify({ file_path: filePath }),
      };
      const handle = await displayToolCall(toolCall);
      if (handle) {
        const readPresentation = buildReadToolPresentation(filePath, cwd);
        rememberInspect(command, {
          handle,
          displayPresentation: readPresentation,
          inspectPresentation: readPresentation,
        });
      }
      return;
    }

    await context.send(toolActivityEvent(buildMultiReadActivity(paths, cwd)));
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
    if (!visibility.changes) {
      return;
    }

    await context.send(fileChangeEvent({
      path,
      ...(summary !== undefined && { summary }),
      ...(diff !== undefined && { diff }),
      ...(kind !== undefined && { changeKind: kind }),
      ...(oldText !== undefined && { oldText }),
      ...(newText !== undefined && { newText }),
      cwd,
    }));
  }
}

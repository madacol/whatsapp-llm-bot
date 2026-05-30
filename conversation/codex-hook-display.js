import { runtimeEvent } from "../outbound-events.js";

/**
 * @typedef {{
 *   handle: MessageHandle,
 * }} PendingInspectEntry
 */

/**
 * Build the Codex-specific display hooks that correlate command/file events
 * with inspect handlers and diff rendering.
 * @param {{
 *   context: Pick<ExecuteActionContext, "send">,
 *   cwd: string | null,
 *   visibility: import("../chat-output-visibility.js").OutputVisibility,
 * }} input
 * @returns {Pick<Required<AgentIOHooks>, "onCommand" | "onFileRead" | "onFileChange">}
 */
export function createCodexDisplayHooks({ context, cwd, visibility }) {
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
    if (!visibility.toolDetails) {
      return;
    }

    const handle = await context.send(runtimeEvent({
      type: `command.${status}`,
      provider: "codex",
      command: {
        command,
        status,
        ...(output !== undefined && { output }),
      },
    }));
    if (status !== "started") {
      const inspectEntry = consumeInspect(command);
      if (inspectEntry) {
        inspectEntry.handle.setInspect({
          kind: "text",
          text: output ?? "",
          persistOnInspect: true,
        });
      }
    }
    return handle;
  }

  /**
   * @param {{ command: string, paths: string[] }} event
   * @returns {Promise<void>}
   */
  async function onFileRead({ command, paths }) {
    if (!visibility.toolDetails) {
      return;
    }

    const handle = await context.send(runtimeEvent({
      type: "file-read.started",
      provider: "codex",
      fileRead: {
        command,
        paths,
      },
    }));
    if (handle) {
      rememberInspect(command, { handle });
    }
  }

  /**
   * @param {{
   *   path: string,
   *   summary?: string,
   *   diff?: string,
   *   kind?: "add" | "delete" | "update",
   *   source?: "tool" | "snapshot",
   *   itemId?: string,
   *   stage?: "proposed" | "denied" | "applied" | "failed",
   *   oldText?: string,
   *   newText?: string,
   * }} event
   * @returns {Promise<void>}
   */
  async function onFileChange({ path, summary, diff, kind, source, itemId, stage, oldText, newText }) {
    if (!visibility.changes) {
      return;
    }

    await context.send(runtimeEvent({
      type: "file-change.completed",
      provider: "codex",
      change: {
        path,
        ...(summary !== undefined && { summary }),
        ...(diff !== undefined && { diff }),
        ...(kind !== undefined && { kind }),
        ...(source !== undefined && { source }),
        ...(itemId !== undefined && { itemId }),
        ...(stage !== undefined && { stage }),
        ...(oldText !== undefined && { oldText }),
        ...(newText !== undefined && { newText }),
        cwd,
      },
    }));
  }
}

import { runtimeEvent } from "../outbound-events.js";

/**
 * Build the Codex-specific display hook for file change rendering.
 * @param {{
 *   context: Pick<ExecuteActionContext, "send">,
 *   cwd: string | null,
 *   visibility: import("../chat-output-visibility.js").OutputVisibility,
 * }} input
 * @returns {Pick<Required<AgentIOHooks>, "onFileChange">}
 */
export function createCodexDisplayHooks({ context, cwd, visibility }) {
  return {
    onFileChange,
  };

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

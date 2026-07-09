import { createAgentRunOutputPort } from "../agent-run-output-port.js";

/**
 * Build the Codex-specific display hook for file change rendering.
 * @param {{
 *   context: Pick<ExecuteActionContext, "send" | "reply">,
 *   cwd: string | null,
 *   getVisibility: () => import("../chat-output-visibility.js").OutputVisibility | Promise<import("../chat-output-visibility.js").OutputVisibility>,
 * }} input
 * @returns {Pick<Required<AgentIOHooks>, "onFileChange">}
 */
export function createCodexDisplayHooks({ context, cwd, getVisibility }) {
  const agentOutput = createAgentRunOutputPort(context, { cwd });
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
    const visibility = await getVisibility();
    if (source === "snapshot" ? visibility.snapshots === "off" : visibility.fileChanges === "hidden") {
      return;
    }

    await agentOutput.sendRuntimeEvent({
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
    });
  }
}

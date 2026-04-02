import { createSeedTurnIo } from "./conversation/seed-turn-io.js";

/**
 * @typedef {{
 *   senderIds: string[],
 *   senderJids?: string[],
 *   senderName: string,
 * }} WorkspaceSeedSourceTurn
 */

/**
 * @param {string} seedPrompt
 * @returns {string}
 */
function formatSeedPromptText(seedPrompt) {
  const trimmed = seedPrompt.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.includes("\n")
    ? `Prompt:\n${trimmed}`
    : `Prompt: ${trimmed}`;
}

/**
 * App-side entrypoint for workspace lifecycle use cases. It owns orchestration
 * of workspace create/archive flows, while delegating presentation details to
 * the workspace presentation port and lower-level state changes to
 * `workspaceControl`.
 * @param {{
 *   workspaceControl: Pick<ReturnType<typeof import("./workspace-control.js").createWorkspaceControl>,
 *     "list" | "create" | "status" | "diff" | "commit" | "archiveByName" | "archiveCurrent">,
 *   workspacePresentation?: WorkspacePresentationPort,
 *   dispatchTurn: (turn: ChatTurn) => Promise<void>,
 * }} input
 */
export function createWorkspaceLifecycleService({ workspaceControl, workspacePresentation, dispatchTurn }) {
  return {
    list: workspaceControl.list,
    status: workspaceControl.status,
    diff: workspaceControl.diff,
    commit: workspaceControl.commit,

    /**
     * @param {{
     *   repo: RepoRow,
     *   context: ExecuteActionContext,
     *   workspaceName: string,
     *   baseBranch: string,
     *   seedPrompt?: string,
     *   sourceTurn: WorkspaceSeedSourceTurn,
     * }} input
     * @returns {Promise<{ message: string, workspace: WorkspaceRow | null }>}
     */
    async createWorkspace({ repo, context, workspaceName, baseBranch, seedPrompt, sourceTurn }) {
      const result = await workspaceControl.create(repo, context, workspaceName, baseBranch);
      if (!seedPrompt || !result.workspace) {
        return result;
      }

      const promptText = formatSeedPromptText(seedPrompt);
      if (!promptText) {
        return result;
      }

      await workspacePresentation?.presentSeedPrompt({
        surfaceId: result.workspace.workspace_chat_id,
        promptText,
      });

      await dispatchTurn({
        chatId: result.workspace.workspace_chat_id,
        senderIds: sourceTurn.senderIds,
        senderJids: sourceTurn.senderJids,
        senderName: sourceTurn.senderName,
        chatName: result.workspace.workspace_chat_subject,
        content: [{ type: "text", text: seedPrompt }],
        timestamp: new Date(),
        facts: {
          isGroup: true,
          addressedToBot: true,
          repliedToBot: false,
        },
        io: createSeedTurnIo({
          sendEvent: (event) => workspacePresentation?.sendWorkspaceEvent({
            surfaceId: result.workspace ? result.workspace.workspace_chat_id : "",
            event,
          }) ?? Promise.resolve(undefined),
        }),
      });

      return result;
    },

    /**
     * @param {RepoRow} repo
     * @param {string} workspaceName
     * @returns {Promise<string>}
     */
    archiveByName(repo, workspaceName) {
      return workspaceControl.archiveByName(repo, workspaceName);
    },

    /**
     * @param {WorkspaceRow} workspace
     * @returns {Promise<string>}
     */
    archiveCurrent(workspace) {
      return workspaceControl.archiveCurrent(workspace);
    },
  };
}

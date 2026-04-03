import { formatCancelCommand } from "./chat-commands.js";
import { contentEvent } from "./outbound-events.js";

/**
 * @typedef {{
 *   list: (project: ProjectRow) => Promise<string>;
 *   createWorkspace: (input: {
 *     project: ProjectRow,
 *     context: ExecuteActionContext,
 *     workspaceName: string,
 *     baseBranch: string,
 *     seedPrompt?: string,
 *     sourceTurn: {
 *       senderIds: string[],
 *       senderJids?: string[],
 *       senderName: string,
 *     },
 *   }) => Promise<{ message: string, workspace: WorkspaceRow | null }>;
 *   status: (workspace: WorkspaceRow) => Promise<string>;
 *   diff: (workspace: WorkspaceRow) => Promise<string>;
 *   archiveByName: (project: ProjectRow, workspaceName: string) => Promise<string>;
 *   archiveCurrent: (workspace: WorkspaceRow) => Promise<string>;
 * }} WorkspaceControl
 */

/**
 * @param {string} inputText
 * @returns {{ name: string, argsText: string, lowered: string }}
 */
function parseCommandText(inputText) {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return { name: "", argsText: "", lowered: "" };
  }
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { name: trimmed.toLowerCase(), argsText: "", lowered: trimmed.toLowerCase() };
  }
  return {
    name: trimmed.slice(0, firstSpace).toLowerCase(),
    argsText: trimmed.slice(firstSpace + 1).trim(),
    lowered: trimmed.toLowerCase(),
  };
}

/**
 * @param {string} argsText
 * @returns {{ workspaceName: string, seedPrompt?: string } | null}
 */
function parseNewArgs(argsText) {
  const trimmed = argsText.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(":");
  const rawWorkspaceName = separatorIndex === -1
    ? trimmed
    : trimmed.slice(0, separatorIndex).trim();
  if (!rawWorkspaceName) {
    return null;
  }
  const rawSeedPrompt = separatorIndex === -1
    ? ""
    : trimmed.slice(separatorIndex + 1).trim();
  return {
    workspaceName: rawWorkspaceName,
    ...(rawSeedPrompt ? { seedPrompt: rawSeedPrompt } : {}),
  };
}

/**
 * @param {string} loweredCommandText
 * @returns {boolean}
 */
function isWorkspaceOnlyCommand(loweredCommandText) {
  return loweredCommandText === "status"
    || loweredCommandText === "diff";
}

/**
 * @param {ExecuteActionContext} context
 * @param {string} message
 * @returns {Promise<void>}
 */
async function replyToolResult(context, message) {
  await context.reply(contentEvent("tool-result", message));
}

/**
 * @param {ExecuteActionContext} context
 * @param {string} message
 * @returns {Promise<void>}
 */
async function replyError(context, message) {
  await context.reply(contentEvent("error", message));
}

/**
 * @param {{
 *   context: ExecuteActionContext,
 *   binding: ResolvedChatBinding,
 *   inputText: string,
 *   workspaceControl: WorkspaceControl,
 *   seedSourceTurn: {
 *     senderIds: string[],
 *     senderJids?: string[],
 *     senderName: string,
 *   },
 * }} input
 * @returns {Promise<boolean>}
 */
export async function tryHandleWorkspaceCommand({ context, binding, inputText, workspaceControl, seedSourceTurn }) {
  const { name, argsText, lowered } = parseCommandText(inputText);

  if (!name) {
    return false;
  }

  try {
    if (binding.kind === "project") {
      if (isWorkspaceOnlyCommand(lowered)) {
        await replyError(context, "Workspace commands must be run inside a workspace chat.");
        return true;
      }

      if (name === "list" && !argsText) {
        await replyToolResult(context, await workspaceControl.list(binding.project));
        return true;
      }

      if (name === "new") {
        const parsed = parseNewArgs(argsText);
        if (!parsed) {
          await replyError(context, "Usage: `!new <name>` or `!new <name>: <seed prompt>`.");
          return true;
        }
        const result = await workspaceControl.createWorkspace({
          project: binding.project,
          context,
          workspaceName: parsed.workspaceName,
          baseBranch: binding.project.default_base_branch,
          seedPrompt: parsed.seedPrompt,
          sourceTurn: seedSourceTurn,
        });
        await replyToolResult(context, result.message);
        return true;
      }

      if (name === "archive") {
        if (!argsText) {
          await replyError(context, "Use `!archive <name>` to archive a specific workspace.");
          return true;
        }
        const confirmed = await context.confirm(
          `Archive workspace \`${argsText}\`?\nThis will freeze its workspace chat and stop new work there.`,
        );
        if (!confirmed) {
          await replyToolResult(context, "Archive cancelled.");
          return true;
        }
        await replyToolResult(context, await workspaceControl.archiveByName(binding.project, argsText));
        return true;
      }

      return false;
    }

    if (binding.kind === "workspace") {
      if (binding.workspace.status === "busy" && name !== "status") {
        await replyError(context, `Workspace is busy.\nUse \`${formatCancelCommand()}\` or wait for the current task to finish.`);
        return true;
      }
      if (binding.workspace.status === "archived" && name !== "status") {
        await replyError(context, "This workspace is archived and no longer accepts work.");
        return true;
      }
      if (name === "status" && !argsText) {
        await replyToolResult(context, await workspaceControl.status(binding.workspace));
        return true;
      }
      if (name === "list" && !argsText) {
        await replyToolResult(context, await workspaceControl.list(binding.project));
        return true;
      }
      if (name === "new") {
        const parsed = parseNewArgs(argsText);
        if (!parsed) {
          await replyError(context, "Usage: `!new <name>` or `!new <name>: <seed prompt>`.");
          return true;
        }
        const result = await workspaceControl.createWorkspace({
          project: binding.project,
          context,
          workspaceName: parsed.workspaceName,
          baseBranch: binding.workspace.branch,
          seedPrompt: parsed.seedPrompt,
          sourceTurn: seedSourceTurn,
        });
        await replyToolResult(context, result.message);
        return true;
      }
      if (name === "diff" && !argsText) {
        await replyToolResult(context, await workspaceControl.diff(binding.workspace));
        return true;
      }
      if (name === "archive" && !argsText) {
        const confirmed = await context.confirm(
          "Archive this workspace?\nThis will freeze the workspace chat and stop new work here.",
        );
        if (!confirmed) {
          await replyToolResult(context, "Archive cancelled.");
          return true;
        }
        await replyToolResult(context, await workspaceControl.archiveCurrent(binding.workspace));
        return true;
      }
      if (name === "archive" && !!argsText) {
        const confirmed = await context.confirm(
          `Archive workspace \`${argsText}\`?\nThis will freeze its workspace chat and stop new work there.`,
        );
        if (!confirmed) {
          await replyToolResult(context, "Archive cancelled.");
          return true;
        }
        await replyToolResult(context, await workspaceControl.archiveByName(binding.project, argsText));
        return true;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await replyError(context, message);
    return true;
  }

  return false;
}

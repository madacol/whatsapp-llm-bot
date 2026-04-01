import { contentEvent } from "./outbound-events.js";

/**
 * @typedef {{
 *   list: (repo: RepoRow) => Promise<string>;
 *   create: (repo: RepoRow, context: ExecuteActionContext, workspaceName: string, explicitBaseBranch?: string) => Promise<string>;
 *   status: (workspace: WorkspaceRow) => Promise<string>;
 *   diff: (workspace: WorkspaceRow) => Promise<string>;
 *   test: (workspace: WorkspaceRow) => Promise<string>;
 *   commit: (workspace: WorkspaceRow, message: string) => Promise<string>;
 *   archiveByName: (repo: RepoRow, workspaceName: string) => Promise<string>;
 *   archiveCurrent: (workspace: WorkspaceRow) => Promise<string>;
 *   merge: (workspace: WorkspaceRow) => Promise<string>;
 *   showConflict: (workspace: WorkspaceRow) => Promise<string>;
 *   resolveConflicts: (workspace: WorkspaceRow) => Promise<string>;
 *   abortMerge: (workspace: WorkspaceRow) => Promise<string>;
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
 * @returns {{ workspaceName: string, explicitBaseBranch?: string } | null}
 */
function parseNewArgs(argsText) {
  const trimmed = argsText.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^([A-Za-z0-9_-]+)(?:\s+from\s+(.+))?$/i);
  if (!match?.[1]) {
    return null;
  }
  return {
    workspaceName: match[1],
    ...(typeof match[2] === "string" && match[2].trim() ? { explicitBaseBranch: match[2].trim() } : {}),
  };
}

/**
 * @param {string} loweredCommandText
 * @returns {boolean}
 */
function isWorkspaceOnlyCommand(loweredCommandText) {
  return loweredCommandText === "status"
    || loweredCommandText === "diff"
    || loweredCommandText === "test"
    || loweredCommandText === "commit"
    || loweredCommandText === "merge"
    || loweredCommandText === "show conflict"
    || loweredCommandText === "resolve conflicts"
    || loweredCommandText === "abort merge";
}

/**
 * @param {string} loweredCommandText
 * @returns {boolean}
 */
function isRepoOnlyCommand(loweredCommandText) {
  return loweredCommandText === "list" || loweredCommandText === "new";
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
 * }} input
 * @returns {Promise<boolean>}
 */
export async function tryHandleWorkspaceCommand({ context, binding, inputText, workspaceControl }) {
  const { name, argsText, lowered } = parseCommandText(inputText);

  if (!name) {
    return false;
  }

  try {
    if (binding.kind === "repo") {
      if (isWorkspaceOnlyCommand(lowered)) {
        await replyError(context, "Workspace commands must be run inside a workspace chat.");
        return true;
      }

      if (name === "list" && !argsText) {
        await replyToolResult(context, await workspaceControl.list(binding.repo));
        return true;
      }

      if (name === "new") {
        const parsed = parseNewArgs(argsText);
        if (!parsed) {
          await replyError(context, "Usage: `!new <name>` or `!new <name> from <base>`.");
          return true;
        }
        await replyToolResult(
          context,
          await workspaceControl.create(binding.repo, context, parsed.workspaceName, parsed.explicitBaseBranch),
        );
        return true;
      }

      if (name === "archive") {
        if (!argsText) {
          await replyError(context, "Use `!archive <name>` in the repo chat.");
          return true;
        }
        const confirmed = await context.confirm(
          `Archive workspace \`${argsText}\`?\nThis will freeze its workspace chat and stop new work there.`,
        );
        if (!confirmed) {
          await replyToolResult(context, "Archive cancelled.");
          return true;
        }
        await replyToolResult(context, await workspaceControl.archiveByName(binding.repo, argsText));
        return true;
      }

      return false;
    }

    if (binding.kind === "workspace") {
      if (isRepoOnlyCommand(lowered) || (name === "archive" && !!argsText)) {
        await replyError(context, "Repo lifecycle commands must be run inside the repo chat.");
        return true;
      }

      if (binding.workspace.status === "busy" && name !== "status") {
        await replyError(context, "Workspace is busy.\nUse `!c` or wait for the current task to finish.");
        return true;
      }
      if (binding.workspace.status === "archived" && name !== "status") {
        await replyError(context, "This workspace is archived and no longer accepts work.");
        return true;
      }
      if (binding.workspace.status === "conflicted" && !["status", "show conflict", "resolve conflicts", "abort merge", "archive"].includes(lowered)) {
        await replyError(context, "This workspace has merge conflicts.\nUse `!show conflict`, `!resolve conflicts`, or `!abort merge`.");
        return true;
      }

      if (name === "status" && !argsText) {
        await replyToolResult(context, await workspaceControl.status(binding.workspace));
        return true;
      }
      if (name === "diff" && !argsText) {
        await replyToolResult(context, await workspaceControl.diff(binding.workspace));
        return true;
      }
      if (name === "test" && !argsText) {
        await replyToolResult(context, await workspaceControl.test(binding.workspace));
        return true;
      }
      if (name === "commit") {
        await replyToolResult(context, await workspaceControl.commit(binding.workspace, argsText));
        return true;
      }
      if (name === "merge" && !argsText) {
        await replyToolResult(context, await workspaceControl.merge(binding.workspace));
        return true;
      }
      if (lowered === "show conflict") {
        await replyToolResult(context, await workspaceControl.showConflict(binding.workspace));
        return true;
      }
      if (lowered === "resolve conflicts") {
        await replyToolResult(context, await workspaceControl.resolveConflicts(binding.workspace));
        return true;
      }
      if (lowered === "abort merge") {
        await replyToolResult(context, await workspaceControl.abortMerge(binding.workspace));
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
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await replyError(context, message);
    return true;
  }

  return false;
}

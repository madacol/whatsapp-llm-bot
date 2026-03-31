import { contentEvent } from "./outbound-events.js";
import {
  archiveWorkspaceById,
  formatWorkspaceStatus,
  getWorkspaceForArchiveByName,
  getWorkspaceForCurrentArchive,
  listRepoWorkspaces,
} from "./workspace-service.js";

/**
 * @typedef {import("./store.js").Store} Store
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
 * @param {{
 *   store: Store,
 *   context: ExecuteActionContext,
 *   binding: ResolvedChatBinding,
 *   inputText: string,
 * }} input
 * @returns {Promise<boolean>}
 */
export async function tryHandleWorkspaceCommand({ store, context, binding, inputText }) {
  const { name, argsText, lowered } = parseCommandText(inputText);

  if (!name) {
    return false;
  }

  if (binding.kind === "repo") {
    if (isWorkspaceOnlyCommand(lowered)) {
      await context.reply(contentEvent("error", "Workspace commands must be run inside a workspace chat."));
      return true;
    }

    if (name === "list" && !argsText) {
      const result = await listRepoWorkspaces(store, context.chatId);
      await context.reply(contentEvent("tool-result", result));
      return true;
    }

    if (name === "new") {
      await context.reply(contentEvent(
        "warning",
        "Workspace creation is not wired yet. The workspace data model is in place, but workspace-chat creation still needs WhatsApp group primitives.",
      ));
      return true;
    }

    if (name === "archive") {
      if (!argsText) {
        await context.reply(contentEvent("error", "Use `!archive <name>` in the repo chat."));
        return true;
      }
      const workspace = await getWorkspaceForArchiveByName(store, context.chatId, argsText);
      if (!workspace) {
        await context.reply(contentEvent("error", `Workspace \`${argsText}\` does not exist.`));
        return true;
      }
      if (workspace.status === "archived") {
        await context.reply(contentEvent("tool-result", `Workspace \`${workspace.name}\` is already archived.`));
        return true;
      }
      const confirmed = await context.confirm(
        `Archive workspace \`${workspace.name}\`?\nThis will freeze chat \`${workspace.branch}\` and stop new work there.`,
      );
      if (!confirmed) {
        await context.reply(contentEvent("tool-result", "Archive cancelled."));
        return true;
      }
      await archiveWorkspaceById(store, workspace.workspace_id);
      await context.reply(contentEvent("tool-result", `Archived workspace \`${workspace.name}\`.`));
      return true;
    }

    return false;
  }

  if (binding.kind === "workspace") {
    if (isRepoOnlyCommand(lowered) || (name === "archive" && !!argsText)) {
      await context.reply(contentEvent("error", "Repo lifecycle commands must be run inside the repo chat."));
      return true;
    }

    if (name === "status" && !argsText) {
      const result = await formatWorkspaceStatus(store, context.chatId);
      await context.reply(contentEvent("tool-result", result));
      return true;
    }

    if (name === "archive" && !argsText) {
      const workspace = await getWorkspaceForCurrentArchive(store, context.chatId);
      if (workspace.status === "archived") {
        await context.reply(contentEvent("tool-result", `Workspace \`${workspace.name}\` is already archived.`));
        return true;
      }
      const confirmed = await context.confirm(
        `Archive this workspace?\nThis will freeze \`${workspace.branch}\` and stop new work here.`,
      );
      if (!confirmed) {
        await context.reply(contentEvent("tool-result", "Archive cancelled."));
        return true;
      }
      await archiveWorkspaceById(store, workspace.workspace_id);
      await context.reply(contentEvent("tool-result", `Archived workspace \`${workspace.name}\`.`));
      return true;
    }

    if (binding.workspace.status === "archived" && name !== "status") {
      await context.reply(contentEvent("error", "This workspace is archived and no longer accepts work."));
      return true;
    }
  }

  return false;
}

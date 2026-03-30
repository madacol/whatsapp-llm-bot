import { formatRelativeTime } from "../utils.js";
import { contentEvent } from "../outbound-events.js";

/**
 * @typedef {{
 *   archive: (chatId: string) => Promise<HarnessSessionHistoryEntry | null>;
 *   getHistory: (chatId: string) => Promise<HarnessSessionHistoryEntry[]>;
 *   restore: (chatId: string, indexOrId: number | string) => Promise<HarnessSessionHistoryEntry | null>;
 * }} HarnessSessionControl
 */

/**
 * @param {HarnessSessionHistoryEntry} entry
 * @param {number} index
 * @param {Date} now
 * @returns {string}
 */
function formatSessionLabel(entry, index, now) {
  const ago = formatRelativeTime(now.getTime() - new Date(entry.cleared_at).getTime());
  const baseLabel = entry.title ?? `Session ${index + 1}`;
  return `${baseLabel} (${ago})`;
}

/**
 * Handle generic harness session commands such as /clear and /resume.
 * Returns true when the command was consumed.
 * @param {{
 *   command: string;
 *   chatId: string;
 *   context: ExecuteActionContext;
 *   cancelActiveQuery?: () => Promise<boolean> | boolean;
 *   sessionControl?: HarnessSessionControl;
 *   now?: () => Date;
 * }} input
 * @returns {Promise<boolean>}
 */
export async function handleHarnessSessionCommand({ command, chatId, context, cancelActiveQuery, sessionControl, now = () => new Date() }) {
  if (!sessionControl) {
    return false;
  }

  switch (command) {
    case "clear": {
      await cancelActiveQuery?.();
      const archived = await sessionControl.archive(chatId);
      const titleLine = archived?.title ? `Session cleared: ${archived.title}\n\n` : "Session cleared\n\n";
      await context.reply(contentEvent("tool-result", `${titleLine}Next message starts fresh.\nUse */resume* to restore this session later.`));
      return true;
    }
    case "resume": {
      await sessionControl.archive(chatId);
      const history = await sessionControl.getHistory(chatId);
      if (history.length === 0) {
        await context.reply(contentEvent("tool-result", "No previous sessions to resume."));
        return true;
      }
      const currentTime = now();

      /** @type {SelectOption[]} */
      const selectOptions = [
        ...[...history].reverse().slice(0, 11).map((entry, index) => ({
          id: String(index),
          label: formatSessionLabel(entry, index, currentTime),
        })),
        { id: "cancel", label: "Cancel" },
      ];

      const choice = await context.select("Which session to resume?", selectOptions, {
        deleteOnSelect: true,
        cancelIds: ["cancel"],
      });

      if (!choice || choice === "cancel") {
        return true;
      }

      const selectedIndex = parseInt(choice, 10);
      const restored = await sessionControl.restore(chatId, selectedIndex);
      if (!restored) {
        await context.reply(contentEvent("tool-result", "Failed to restore session."));
        return true;
      }

      const agoStr = formatRelativeTime(currentTime.getTime() - new Date(restored.cleared_at).getTime());
      const restoredLabel = restored.title ? `Session restored: ${restored.title}` : "Session restored";
      await context.reply(contentEvent("tool-result", `${restoredLabel} (cleared ${agoStr}). Your next message will continue that conversation.`));
      return true;
    }
    default:
      return false;
  }
}

import { formatRelativeTime } from "../utils.js";
import { contentEvent } from "../outbound-events.js";

/**
 * @typedef {{
 *   archive: (chatId: string) => Promise<void>;
 *   getHistory: (chatId: string) => Promise<HarnessSessionHistoryEntry[]>;
 *   restore: (chatId: string, indexOrId: number | string) => Promise<HarnessSessionHistoryEntry | null>;
 * }} HarnessSessionControl
 */

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
      await sessionControl.archive(chatId);
      await context.reply(contentEvent("tool-result", "Session cleared\n\nNext message starts fresh.\nUse */resume* to restore this session later."));
      return true;
    }
    case "resume": {
      await sessionControl.archive(chatId);
      const history = await sessionControl.getHistory(chatId);
      if (history.length === 0) {
        await context.reply(contentEvent("tool-result", "No previous sessions to resume."));
        return true;
      }

      /** @type {SelectOption[]} */
      const selectOptions = [
        ...[...history].reverse().slice(0, 11).map((entry, index) => ({
          id: String(index),
          label: `Session ${index + 1} (${formatRelativeTime(now().getTime() - new Date(entry.cleared_at).getTime())})`,
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

      const agoStr = formatRelativeTime(now().getTime() - new Date(restored.cleared_at).getTime());
      await context.reply(contentEvent("tool-result", `Session restored (cleared ${agoStr}). Your next message will continue that conversation.`));
      return true;
    }
    default:
      return false;
  }
}

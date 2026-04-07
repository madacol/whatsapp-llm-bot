import { formatRelativeTime } from "../utils.js";
import { contentEvent } from "../outbound-events.js";

const MAX_RESUME_OPTIONS = 11;
const RESUME_CANCEL_OPTION_ID = "cancel";

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
 * @param {HarnessSessionHistoryEntry[]} history
 * @param {Date} now
 * @returns {SelectOption[]}
 */
function buildResumeSelectOptions(history, now) {
  return [
    ...[...history].reverse().slice(0, MAX_RESUME_OPTIONS).map((entry, index) => ({
      id: entry.id,
      label: formatSessionLabel(entry, index, now),
    })),
    { id: RESUME_CANCEL_OPTION_ID, label: "Cancel" },
  ];
}

/**
 * Resolve the selected session ID for /resume. Cancellation and timeout both return null.
 * @param {ExecuteActionContext} context
 * @param {HarnessSessionHistoryEntry[]} history
 * @param {Date} now
 * @returns {Promise<string | null>}
 */
async function selectResumeSessionId(context, history, now) {
  const choice = await context.select("Which session to resume?", buildResumeSelectOptions(history, now), {
    deleteOnSelect: true,
    cancelIds: [RESUME_CANCEL_OPTION_ID],
  });

  if (!choice || choice === RESUME_CANCEL_OPTION_ID) {
    return null;
  }

  return choice;
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
      const history = await sessionControl.getHistory(chatId);
      if (history.length === 0) {
        await context.reply(contentEvent("tool-result", "No previous sessions to resume."));
        return true;
      }
      const currentTime = now();
      const sessionId = await selectResumeSessionId(context, history, currentTime);
      if (!sessionId) {
        return true;
      }

      await sessionControl.archive(chatId);
      const restored = await sessionControl.restore(chatId, sessionId);
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

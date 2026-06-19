import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_RESTART_ACK_PATH = ".state/restart-ack.json";

/**
 * @typedef {{
 *   chatId: string,
 *   label?: string,
 *   activeTurnId?: string,
 *   resumeCursor?: string,
 *   status?: string,
 * }} RestartInterruptedTurn
 *
 * @typedef {{
 *   restartId?: string,
 *   chatId: string,
 *   requestedAt: string,
 *   transportHandleId?: string,
 *   oldPid: number,
 *   keyId?: string,
 *   isImage?: boolean,
 *   queueId?: number,
 *   interruptedTurns?: RestartInterruptedTurn[],
 * }} RestartAckRecord
 *
 * `keyId` and `isImage` are legacy fields kept so pending acknowledgements
 * written by older builds can still be delivered after restart.
 *
 * @typedef {{
 *   save: (record: RestartAckRecord) => Promise<void>,
 *   read: () => Promise<RestartAckRecord | null>,
 *   clear: () => Promise<void>,
 * }} RestartAckStore
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {RestartInterruptedTurn[] | undefined}
 */
function parseInterruptedTurns(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const turns = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.chatId !== "string" || entry.chatId.length === 0) {
      return [];
    }
    return [{
      chatId: entry.chatId,
      ...(typeof entry.label === "string" && entry.label.length > 0 ? { label: entry.label } : {}),
      ...(typeof entry.activeTurnId === "string" && entry.activeTurnId.length > 0 ? { activeTurnId: entry.activeTurnId } : {}),
      ...(typeof entry.resumeCursor === "string" && entry.resumeCursor.length > 0 ? { resumeCursor: entry.resumeCursor } : {}),
      ...(typeof entry.status === "string" && entry.status.length > 0 ? { status: entry.status } : {}),
    }];
  });
  return turns.length > 0 ? turns : undefined;
}

/**
 * @param {unknown} value
 * @returns {RestartAckRecord | null}
 */
function parseRestartAckRecord(value) {
  if (!isRecord(value)) {
    return null;
  }
  const { restartId, chatId, requestedAt, oldPid, transportHandleId, keyId, isImage, queueId, interruptedTurns } = value;
  if (restartId !== undefined && typeof restartId !== "string") {
    return null;
  }
  if (typeof chatId !== "string" || chatId.length === 0) {
    return null;
  }
  if (typeof requestedAt !== "string" || requestedAt.length === 0) {
    return null;
  }
  if (typeof oldPid !== "number" || !Number.isInteger(oldPid) || oldPid <= 0) {
    return null;
  }
  if (transportHandleId !== undefined && typeof transportHandleId !== "string") {
    return null;
  }
  if (keyId !== undefined && typeof keyId !== "string") {
    return null;
  }
  if (isImage !== undefined && typeof isImage !== "boolean") {
    return null;
  }
  if (queueId !== undefined && (typeof queueId !== "number" || !Number.isInteger(queueId) || queueId <= 0)) {
    return null;
  }
  const parsedInterruptedTurns = parseInterruptedTurns(interruptedTurns);
  return {
    ...(restartId ? { restartId } : {}),
    chatId,
    requestedAt,
    oldPid,
    ...(transportHandleId ? { transportHandleId } : {}),
    ...(keyId ? { keyId } : {}),
    ...(typeof isImage === "boolean" ? { isImage } : {}),
    ...(typeof queueId === "number" ? { queueId } : {}),
    ...(parsedInterruptedTurns ? { interruptedTurns: parsedInterruptedTurns } : {}),
  };
}

/**
 * @param {string} [filePath]
 * @returns {RestartAckStore}
 */
export function createRestartAckStore(filePath = DEFAULT_RESTART_ACK_PATH) {
  const resolvedPath = path.resolve(filePath);

  return {
    async save(record) {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    },

    async read() {
      try {
        const text = await fs.readFile(resolvedPath, "utf8");
        return parseRestartAckRecord(JSON.parse(text));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async clear() {
      try {
        await fs.unlink(resolvedPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return;
        }
        throw error;
      }
    },
  };
}

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_RESTART_ACK_PATH = ".state/restart-ack.json";

/**
 * @typedef {{
 *   chatId: string,
 *   requestedAt: string,
 *   oldPid: number,
 *   keyId?: string,
 *   isImage?: boolean,
 *   queueId?: number,
 * }} RestartAckRecord
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
 * @returns {RestartAckRecord | null}
 */
function parseRestartAckRecord(value) {
  if (!isRecord(value)) {
    return null;
  }
  const { chatId, requestedAt, oldPid, keyId, isImage, queueId } = value;
  if (typeof chatId !== "string" || chatId.length === 0) {
    return null;
  }
  if (typeof requestedAt !== "string" || requestedAt.length === 0) {
    return null;
  }
  if (typeof oldPid !== "number" || !Number.isInteger(oldPid) || oldPid <= 0) {
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
  return {
    chatId,
    requestedAt,
    oldPid,
    ...(keyId ? { keyId } : {}),
    ...(typeof isImage === "boolean" ? { isImage } : {}),
    ...(typeof queueId === "number" ? { queueId } : {}),
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

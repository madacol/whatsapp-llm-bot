import fs from "node:fs/promises";
import path from "node:path";

const RETENTION_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const HOURLY_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}Z$/;

/**
 * @typedef {{
 *   write: (entry: unknown) => Promise<void> | void,
 * }} HourlyNdjsonLogWriter
 */

/**
 * @param {string} filePath
 * @param {Date} date
 * @returns {string}
 */
export function formatHourlyNdjsonLogPath(filePath, date) {
  const parsed = path.parse(filePath);
  const hourStamp = formatUtcHourStamp(date);
  return path.join(parsed.dir, `${parsed.name}.${hourStamp}${parsed.ext}`);
}

/**
 * @param {string} filePath
 * @returns {HourlyNdjsonLogWriter}
 */
export function createHourlyNdjsonLogWriter(filePath) {
  const baseFilePath = path.resolve(filePath);
  /** @type {Promise<void>} */
  let pendingWrite = Promise.resolve();
  let activeHourStamp = "";

  /**
   * @param {unknown} entry
   * @returns {Promise<void>}
   */
  async function writeEntry(entry) {
    const entryDate = getLogEntryDate(entry);
    const hourStamp = formatUtcHourStamp(entryDate);
    const targetPath = formatHourlyNdjsonLogPath(baseFilePath, entryDate);
    if (hourStamp !== activeHourStamp) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await pruneOldHourlyLogs(baseFilePath, entryDate);
      activeHourStamp = hourStamp;
    }
    await fs.appendFile(targetPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  return {
    write(entry) {
      const write = pendingWrite.then(() => writeEntry(entry), () => writeEntry(entry));
      pendingWrite = write.catch(() => {});
      return write;
    },
  };
}

/**
 * @param {unknown} entry
 * @returns {Date}
 */
function getLogEntryDate(entry) {
  const record = entry && typeof entry === "object" ? entry : null;
  const rawTimestamp = record && "timestamp" in record && typeof record.timestamp === "string"
    ? record.timestamp
    : record && "createdAt" in record && typeof record.createdAt === "string"
      ? record.createdAt
      : "";
  const date = new Date(rawTimestamp);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * @param {Date} date
 * @returns {string}
 */
function formatUtcHourStamp(date) {
  return `${date.toISOString().slice(0, 13)}Z`;
}

/**
 * @param {Date} date
 * @returns {number}
 */
function utcHourStartMs(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
}

/**
 * @param {string} stamp
 * @returns {number | null}
 */
function parseUtcHourStampMs(stamp) {
  if (!HOURLY_STAMP_PATTERN.test(stamp)) {
    return null;
  }
  const ms = Date.parse(`${stamp.slice(0, 13)}:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * @param {string} baseFilePath
 * @param {string} filename
 * @returns {number | null}
 */
function hourlyLogFileTimestampMs(baseFilePath, filename) {
  const parsed = path.parse(baseFilePath);
  const prefix = `${parsed.name}.`;
  if (!filename.startsWith(prefix) || !filename.endsWith(parsed.ext)) {
    return null;
  }
  const stamp = filename.slice(prefix.length, filename.length - parsed.ext.length);
  return parseUtcHourStampMs(stamp);
}

/**
 * @param {string} baseFilePath
 * @param {Date} now
 * @returns {Promise<void>}
 */
async function pruneOldHourlyLogs(baseFilePath, now) {
  const parsed = path.parse(baseFilePath);
  const cutoffMs = utcHourStartMs(now) - RETENTION_HOURS * HOUR_MS;
  let entries;
  try {
    entries = await fs.readdir(parsed.dir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    const stampMs = hourlyLogFileTimestampMs(baseFilePath, entry);
    if (stampMs === null || stampMs >= cutoffMs) {
      return;
    }
    try {
      await fs.unlink(path.join(parsed.dir, entry));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }));
}

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getDefaultRuntimeDiagnosticsState } from "../diagnostics-config.js";
import { createLogger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CAPTURE_DIR = path.join(REPO_ROOT, "logs", "capture");
const DEFAULT_ROTATE_MINUTES = 60;
const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_QUEUE_LIMIT = 1_000;
const SCHEMA_VERSION = 1;
const WRITE_WARNING_INTERVAL_MS = 60_000;

/**
 * @typedef {{
 *   seam: string,
 *   direction?: string,
 *   event: string,
 *   payload: unknown,
 *   capturedAt?: string,
 * }} FixtureCaptureInput
 *
 * @typedef {{
 *   capture: (input: FixtureCaptureInput) => void,
 *   waitForIdle: () => Promise<void>,
 * }} FixtureCapture
 */

/**
 * Known field groups are code-owned seam knowledge. Config owns the behavior
 * for these groups.
 * @type {Record<string, Record<string, string[]>>}
 */
const KNOWN_FIELD_GROUPS = {
  "whatsapp.inbound": {
    jpegThumbnail: [
      "payload.messages[].message.imageMessage.jpegThumbnail",
      "payload.messages[].message.videoMessage.jpegThumbnail",
      "payload.messages[].message.documentMessage.jpegThumbnail",
      "payload.messages[].message.stickerMessage.jpegThumbnail",
    ],
    mediaKeys: [
      "payload.messages[].message.imageMessage.mediaKey",
      "payload.messages[].message.videoMessage.mediaKey",
      "payload.messages[].message.audioMessage.mediaKey",
      "payload.messages[].message.documentMessage.mediaKey",
      "payload.messages[].message.stickerMessage.mediaKey",
    ],
    fileHashes: [
      "payload.messages[].message.imageMessage.fileSha256",
      "payload.messages[].message.imageMessage.fileEncSha256",
      "payload.messages[].message.videoMessage.fileSha256",
      "payload.messages[].message.videoMessage.fileEncSha256",
      "payload.messages[].message.audioMessage.fileSha256",
      "payload.messages[].message.audioMessage.fileEncSha256",
      "payload.messages[].message.documentMessage.fileSha256",
      "payload.messages[].message.documentMessage.fileEncSha256",
    ],
  },
  "whatsapp.outbound": {
    media: [
      "payload.message.image",
      "payload.message.video",
      "payload.message.audio",
      "payload.message.document",
    ],
  },
  "acp.protocol": {
    content: [
      "payload.params.update.content",
      "payload.params.update.delta",
      "payload.params.update.toolCall.content",
      "payload.params.update.toolCall.input",
      "payload.params.update.toolCall.output",
      "payload.params.result.content",
      "payload.params.result.output",
      "payload.result.content",
      "payload.result.output",
    ],
  },
  "harness.raw-event": {
    raw: [
      "payload.raw",
    ],
  },
};

/**
 * @param {{
 *   diagnosticsState?: import("../diagnostics-config.js").RuntimeDiagnosticsState,
 *   baseDir?: string,
 *   now?: () => Date,
 *   log?: Pick<ReturnType<typeof createLogger>, "warn">,
 *   writeDelay?: () => Promise<void>,
 * }} [options]
 * @returns {FixtureCapture}
 */
export function createFixtureCapture(options = {}) {
  const diagnosticsState = options.diagnosticsState ?? getDefaultRuntimeDiagnosticsState();
  const baseDir = options.baseDir ?? DEFAULT_CAPTURE_DIR;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? createLogger("capture");
  /** @type {Map<string, SeamState>} */
  const seamStates = new Map();
  let lastWriteWarningMs = 0;

  /**
   * @param {string} seam
   * @returns {SeamState}
   */
  function getSeamState(seam) {
    let state = seamStates.get(seam);
    if (!state) {
      state = {
        seq: 0,
        queue: [],
        active: false,
        idleWaiters: [],
        metaWrittenPaths: new Set(),
        droppedRecords: 0,
      };
      seamStates.set(seam, state);
    }
    return state;
  }

  /**
   * @param {FixtureCaptureInput} input
   * @returns {void}
   */
  function capture(input) {
    const capturedAtDate = input.capturedAt ? new Date(input.capturedAt) : now();
    const seamConfig = getActiveSeamConfig(diagnosticsState.getConfig(), input.seam, capturedAtDate);
    if (!seamConfig) {
      return;
    }

    const seamState = getSeamState(input.seam);
    const queueLimit = seamConfig.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    const queuedAndActive = seamState.queue.length + (seamState.active ? 1 : 0);
    if (queuedAndActive >= queueLimit) {
      seamState.droppedRecords += 1;
      scheduleDrain(input.seam, seamConfig, seamState);
      return;
    }

    const captureRecord = buildEventRecord({
      input,
      seamConfig,
      capturedAt: capturedAtDate,
      seq: ++seamState.seq,
    });
    seamState.queue.push(captureRecord);
    scheduleDrain(input.seam, seamConfig, seamState);
  }

  /**
   * @param {string} seam
   * @param {import("../diagnostics-config.js").CaptureSeamConfig} seamConfig
   * @param {SeamState} seamState
   * @returns {void}
   */
  function scheduleDrain(seam, seamConfig, seamState) {
    if (seamState.active) {
      return;
    }
    seamState.active = true;
    queueMicrotask(() => {
      void drain(seam, seamConfig, seamState);
    });
  }

  /**
   * @param {string} seam
   * @param {import("../diagnostics-config.js").CaptureSeamConfig} seamConfig
   * @param {SeamState} seamState
   * @returns {Promise<void>}
   */
  async function drain(seam, seamConfig, seamState) {
    try {
      while (seamState.queue.length > 0) {
        const record = seamState.queue.shift();
        if (!record) {
          continue;
        }
        await writeRecordWithMeta(seam, seamConfig, seamState, record);
      }
      if (seamState.droppedRecords > 0) {
        const droppedRecords = seamState.droppedRecords;
        seamState.droppedRecords = 0;
        const statusRecord = {
          recordType: "fixtureCapture.status",
          schemaVersion: SCHEMA_VERSION,
          seam,
          capturedAt: now().toISOString(),
          droppedRecords,
          dropReason: "queue_limit_exceeded",
        };
        await writeRecordWithMeta(seam, seamConfig, seamState, statusRecord);
      }
    } catch (error) {
      const nowMs = Date.now();
      if (nowMs - lastWriteWarningMs >= WRITE_WARNING_INTERVAL_MS) {
        lastWriteWarningMs = nowMs;
        log.warn("Fixture capture write failed.", error);
      }
    } finally {
      seamState.active = false;
      if (seamState.queue.length > 0 || seamState.droppedRecords > 0) {
        scheduleDrain(seam, seamConfig, seamState);
      } else {
        resolveIdle(seamState);
      }
    }
  }

  /**
   * @param {string} seam
   * @param {import("../diagnostics-config.js").CaptureSeamConfig} seamConfig
   * @param {SeamState} seamState
   * @param {Record<string, unknown>} record
   * @returns {Promise<void>}
   */
  async function writeRecordWithMeta(seam, seamConfig, seamState, record) {
    const capturedAt = typeof record.capturedAt === "string" ? new Date(record.capturedAt) : now();
    const filePath = rotatedCapturePath(baseDir, seam, capturedAt, seamConfig.rotateMinutes ?? DEFAULT_ROTATE_MINUTES);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (!seamState.metaWrittenPaths.has(filePath)) {
      await pruneOldCaptureFiles(baseDir, seam, capturedAt, seamConfig.retentionHours ?? DEFAULT_RETENTION_HOURS);
      await appendJsonLine(filePath, buildMetaRecord(seam, seamConfig, capturedAt));
      seamState.metaWrittenPaths.add(filePath);
    }
    if (options.writeDelay) {
      await options.writeDelay();
    }
    await appendJsonLine(filePath, record);
  }

  return {
    capture,
    async waitForIdle() {
      const waits = [];
      for (const seamState of seamStates.values()) {
        if (seamState.active || seamState.queue.length > 0 || seamState.droppedRecords > 0) {
          waits.push(new Promise((resolve) => {
            seamState.idleWaiters.push(() => resolve(undefined));
          }));
        }
      }
      await Promise.all(waits);
    },
  };
}

/**
 * @typedef {{
 *   seq: number,
 *   queue: Record<string, unknown>[],
 *   active: boolean,
 *   idleWaiters: Array<() => void>,
 *   metaWrittenPaths: Set<string>,
 *   droppedRecords: number,
 * }} SeamState
 */

/**
 * @param {SeamState} seamState
 * @returns {void}
 */
function resolveIdle(seamState) {
  const waiters = seamState.idleWaiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
}

/**
 * @param {{
 *   input: FixtureCaptureInput,
 *   seamConfig: import("../diagnostics-config.js").CaptureSeamConfig,
 *   capturedAt: Date,
 *   seq: number,
 * }} options
 * @returns {Record<string, unknown>}
 */
function buildEventRecord(options) {
  const { input, seamConfig, capturedAt, seq } = options;
  return {
    recordType: "fixtureCapture.event",
    schemaVersion: SCHEMA_VERSION,
    seam: input.seam,
    seq,
    capturedAt: capturedAt.toISOString(),
    ...(input.direction ? { direction: input.direction } : {}),
    event: input.event,
    payload: applyCapturePolicies(input.seam, { payload: input.payload }, seamConfig, capturedAt).payload,
  };
}

/**
 * @param {string} seam
 * @param {import("../diagnostics-config.js").CaptureSeamConfig} seamConfig
 * @param {Date} capturedAt
 * @returns {Record<string, unknown>}
 */
function buildMetaRecord(seam, seamConfig, capturedAt) {
  const configuredGroups = Object.keys(seamConfig.fieldPolicies ?? {});
  const knownGroups = KNOWN_FIELD_GROUPS[seam] ?? {};
  const knownGroupNames = Object.keys(knownGroups);
  const unknownGroups = configuredGroups.filter((group) => !(group in knownGroups));
  return {
    recordType: "fixtureCapture.meta",
    schemaVersion: SCHEMA_VERSION,
    seam,
    capturedAt: capturedAt.toISOString(),
    rotation: {
      minutes: seamConfig.rotateMinutes ?? DEFAULT_ROTATE_MINUTES,
    },
    retention: {
      hours: seamConfig.retentionHours ?? DEFAULT_RETENTION_HOURS,
    },
    capPolicy: {
      mode: "known-field-groups-only",
      note: "Only configured known field groups are inspected for capping. Other fields are not scanned for size.",
      knownFieldGroups: knownGroupNames,
      configuredFieldGroups: configuredGroups.filter((group) => group in knownGroups),
      unknownFieldPolicyGroups: unknownGroups,
      precedence: [
        "fieldPolicy.fullRawUntil",
        "seam.fullRawUntil",
        "fieldPolicy.capBytes",
        "no cap",
      ],
    },
    truncation: {
      marker: "__fixtureCaptureTruncated",
      meaning: "Large configured values are replaced by metadata plus head/tail preview chunks.",
      hash: "sha256 is computed from the original raw value before truncation.",
    },
  };
}

/**
 * @param {import("../diagnostics-config.js").RuntimeDiagnosticsConfig} config
 * @param {string} seam
 * @param {Date} now
 * @returns {import("../diagnostics-config.js").CaptureSeamConfig | null}
 */
function getActiveSeamConfig(config, seam, now) {
  const seamConfig = config.capture.seams[seam];
  if (!seamConfig?.enabledUntil) {
    return null;
  }
  const enabledUntil = new Date(seamConfig.enabledUntil);
  if (Number.isNaN(enabledUntil.getTime()) || enabledUntil <= now) {
    return null;
  }
  return seamConfig;
}

/**
 * @param {string} seam
 * @param {{ payload: unknown }} root
 * @param {import("../diagnostics-config.js").CaptureSeamConfig} seamConfig
 * @param {Date} now
 * @returns {{ payload: unknown }}
 */
function applyCapturePolicies(seam, root, seamConfig, now) {
  const clonedRoot = /** @type {{ payload: unknown }} */ (cloneJsonish(root));
  if (isFullRawActive(seamConfig.fullRawUntil, now)) {
    return clonedRoot;
  }
  const knownGroups = KNOWN_FIELD_GROUPS[seam] ?? {};
  for (const [group, policy] of Object.entries(seamConfig.fieldPolicies ?? {})) {
    const paths = knownGroups[group];
    if (!paths || isFullRawActive(policy.fullRawUntil, now) || typeof policy.capBytes !== "number") {
      continue;
    }
    for (const pathPattern of paths) {
      applyCapAtPath(clonedRoot, parsePathPattern(pathPattern), policy.capBytes);
    }
  }
  return clonedRoot;
}

/**
 * @param {string | undefined} value
 * @param {Date} now
 * @returns {boolean}
 */
function isFullRawActive(value, now) {
  if (!value) {
    return false;
  }
  const until = new Date(value);
  return !Number.isNaN(until.getTime()) && until > now;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneJsonish(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonish(item));
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const cloned = {};
    for (const [key, child] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      cloned[key] = cloneJsonish(child);
    }
    return cloned;
  }
  return value;
}

/**
 * @param {string} pathPattern
 * @returns {Array<{ key: string, array: boolean }>}
 */
function parsePathPattern(pathPattern) {
  return pathPattern.split(".").map((part) => {
    if (part.endsWith("[]")) {
      return { key: part.slice(0, -2), array: true };
    }
    return { key: part, array: false };
  });
}

/**
 * @param {unknown} target
 * @param {Array<{ key: string, array: boolean }>} parts
 * @param {number} capBytes
 * @returns {void}
 */
function applyCapAtPath(target, parts, capBytes) {
  if (parts.length === 0 || !target || typeof target !== "object") {
    return;
  }
  const [part, ...rest] = parts;
  if (!part) {
    return;
  }
  const record = /** @type {Record<string, unknown>} */ (target);
  const value = record[part.key];
  if (part.array) {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      applyCapAtPath(item, rest, capBytes);
    }
    return;
  }
  if (rest.length === 0) {
    record[part.key] = capValue(value, capBytes);
    return;
  }
  applyCapAtPath(value, rest, capBytes);
}

/**
 * @param {unknown} value
 * @param {number} capBytes
 * @returns {unknown}
 */
function capValue(value, capBytes) {
  if (typeof value === "string") {
    if (value.length <= capBytes) {
      return value;
    }
    const headLength = Math.ceil(capBytes * 0.75);
    const tailLength = Math.max(0, capBytes - headLength);
    return {
      __fixtureCaptureTruncated: true,
      __fixtureCaptureType: "string",
      originalChars: value.length,
      sha256: sha256String(value),
      head: value.slice(0, headLength),
      tail: tailLength > 0 ? value.slice(-tailLength) : "",
    };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (buffer.byteLength <= capBytes) {
      return value;
    }
    const headLength = Math.ceil(capBytes * 0.75);
    const tailLength = Math.max(0, capBytes - headLength);
    return {
      __fixtureCaptureTruncated: true,
      __fixtureCaptureType: Buffer.isBuffer(value) ? "Buffer" : "Uint8Array",
      originalBytes: buffer.byteLength,
      sha256: sha256Buffer(buffer),
      headBase64: buffer.subarray(0, headLength).toString("base64"),
      tailBase64: tailLength > 0 ? buffer.subarray(buffer.byteLength - tailLength).toString("base64") : "",
    };
  }
  return value;
}

/**
 * @param {string} value
 * @returns {string}
 */
function sha256String(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {Buffer} value
 * @returns {string}
 */
function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} baseDir
 * @param {string} seam
 * @param {Date} date
 * @param {number} rotateMinutes
 * @returns {string}
 */
function rotatedCapturePath(baseDir, seam, date, rotateMinutes) {
  const stamp = formatRotationStamp(date, rotateMinutes);
  return path.join(baseDir, `${seamToFilePrefix(seam)}.${stamp}.ndjson`);
}

/**
 * @param {Date} date
 * @param {number} rotateMinutes
 * @returns {string}
 */
function formatRotationStamp(date, rotateMinutes) {
  const rotationMs = rotateMinutes * 60_000;
  const startMs = Math.floor(date.getTime() / rotationMs) * rotationMs;
  return new Date(startMs).toISOString().slice(0, 16).replace(":", "-") + "Z";
}

/**
 * @param {string} seam
 * @returns {string}
 */
function seamToFilePrefix(seam) {
  return seam.replaceAll(".", "-");
}

/**
 * @param {string} baseDir
 * @param {string} seam
 * @param {Date} now
 * @param {number} retentionHours
 * @returns {Promise<void>}
 */
async function pruneOldCaptureFiles(baseDir, seam, now, retentionHours) {
  const cutoffMs = now.getTime() - retentionHours * 60 * 60 * 1000;
  const prefix = `${seamToFilePrefix(seam)}.`;
  let entries;
  try {
    entries = await fs.readdir(baseDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.startsWith(prefix) || !entry.endsWith(".ndjson")) {
      return;
    }
    const stamp = entry.slice(prefix.length, -".ndjson".length);
    const fileMs = parseRotationStampMs(stamp);
    if (fileMs === null || fileMs >= cutoffMs) {
      return;
    }
    await fs.unlink(path.join(baseDir, entry)).catch((error) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    });
  }));
}

/**
 * @param {string} stamp
 * @returns {number | null}
 */
function parseRotationStampMs(stamp) {
  const parsed = Date.parse(`${stamp.replace(/Z$/, "").replace(/-(\d\d)$/, ":$1")}:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
async function appendJsonLine(filePath, value) {
  await fs.appendFile(filePath, `${JSON.stringify(value, fixtureCaptureJsonReplacer)}\n`, "utf8");
}

/**
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function fixtureCaptureJsonReplacer(_key, value) {
  if (typeof value === "bigint") {
    return {
      __fixtureCaptureType: "BigInt",
      value: value.toString(),
    };
  }
  return value;
}

/** @type {FixtureCapture | null} */
let defaultFixtureCapture = null;

/**
 * @returns {FixtureCapture}
 */
export function getDefaultFixtureCapture() {
  if (!defaultFixtureCapture) {
    defaultFixtureCapture = createFixtureCapture();
  }
  return defaultFixtureCapture;
}

/**
 * @param {FixtureCapture | null} capture
 * @returns {void}
 */
export function setDefaultFixtureCaptureForTesting(capture) {
  defaultFixtureCapture = capture;
}

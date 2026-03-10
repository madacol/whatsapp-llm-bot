/**
 * In-memory cache that maps WhatsApp message keys to tool results,
 * enabling "react to inspect" on tool-call messages.
 *
 * Two-phase population:
 * 1. `registerToolCall()` — called when a tool-call message is sent (records WA key + tool metadata)
 * 2. `registerToolResult()` — called when the SDK emits the tool result (fills in the result text)
 *
 * Lookup via `getByWaKeyId()` when a reaction arrives on a tool-call message.
 */

import { createLogger } from "./logger.js";

const log = createLogger("tool-inspect-cache");

/**
 * @typedef {{
 *   toolUseId: string;
 *   toolName: string;
 *   chatId: string;
 *   result: string | null;
 *   createdAt: number;
 * }} ToolInspectEntry
 */

/**
 * @typedef {{
 *   maxEntries?: number;
 *   ttlMs?: number;
 * }} ToolInspectCacheOptions
 */

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create a tool inspect cache instance.
 * @param {ToolInspectCacheOptions} [options]
 */
export function createToolInspectCache(options) {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;

  /** @type {Map<string, ToolInspectEntry>} WA message key ID → entry */
  const byWaKeyId = new Map();

  /** @type {Map<string, string>} tool_use_id → WA message key ID */
  const toolIdToWaKey = new Map();

  /**
   * Register a tool call after its WhatsApp message was sent.
   * @param {string} toolUseId  — SDK tool_use block ID
   * @param {string} waKeyId    — WhatsApp message key ID of the sent message
   * @param {string} chatId     — chat where the message was sent
   * @param {string} toolName   — name of the tool
   */
  function registerToolCall(toolUseId, waKeyId, chatId, toolName) {
    evictStale();

    // Enforce max size (FIFO)
    if (byWaKeyId.size >= maxEntries) {
      const oldest = byWaKeyId.keys().next().value;
      if (oldest) removeByWaKey(oldest);
    }

    /** @type {ToolInspectEntry} */
    const entry = { toolUseId, toolName, chatId, result: null, createdAt: Date.now() };
    byWaKeyId.set(waKeyId, entry);
    toolIdToWaKey.set(toolUseId, waKeyId);
    log.debug(`Registered tool call ${toolName} (${toolUseId}) → WA key ${waKeyId}`);
  }

  /**
   * Register a tool result from the SDK.
   * @param {string} toolUseId — the tool_use block ID this result belongs to
   * @param {string} resultText — the tool's output text
   */
  function registerToolResult(toolUseId, resultText) {
    const waKeyId = toolIdToWaKey.get(toolUseId);
    if (!waKeyId) {
      log.debug(`No WA key found for tool_use_id ${toolUseId}, skipping result registration`);
      return;
    }
    const entry = byWaKeyId.get(waKeyId);
    if (entry) {
      entry.result = resultText;
      log.debug(`Registered result for ${entry.toolName} (${toolUseId}), ${resultText.length} chars`);
    }
  }

  /**
   * Look up a tool inspect entry by WhatsApp message key ID.
   * @param {string} waKeyId
   * @returns {ToolInspectEntry | undefined}
   */
  function getByWaKeyId(waKeyId) {
    const entry = byWaKeyId.get(waKeyId);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > ttlMs) {
      removeByWaKey(waKeyId);
      return undefined;
    }
    return entry;
  }

  /**
   * Remove an entry by WA key ID.
   * @param {string} waKeyId
   */
  function removeByWaKey(waKeyId) {
    const entry = byWaKeyId.get(waKeyId);
    if (entry) {
      toolIdToWaKey.delete(entry.toolUseId);
      byWaKeyId.delete(waKeyId);
    }
  }

  /** Evict entries older than TTL. */
  function evictStale() {
    const now = Date.now();
    for (const [waKeyId, entry] of byWaKeyId) {
      if (now - entry.createdAt > ttlMs) {
        removeByWaKey(waKeyId);
      } else {
        // Map is insertion-ordered, so once we hit a fresh entry, all subsequent are fresher
        break;
      }
    }
  }

  /** Current cache size (for testing/debugging). */
  function size() {
    return byWaKeyId.size;
  }

  return { registerToolCall, registerToolResult, getByWaKeyId, size };
}

/** @typedef {ReturnType<typeof createToolInspectCache>} ToolInspectCache */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getChatBaseDir, getChatRootDir } from "./chat-paths.js";
import { normalizeChatRow } from "./store/normalizers.js";
import {
  hasLegacyOutputVisibilityOverrides,
  migrateLegacyOutputVisibilityOverrides,
} from "./chat-output-visibility.js";

/**
 * @param {string} chatId
 * @returns {string}
 */
export function getChatConfigPath(chatId) {
  return resolve(getChatRootDir(chatId), "config.json");
}

/**
 * @param {string} chatId
 * @returns {Record<string, unknown>}
 */
function createDefaultChatConfig(chatId) {
  return {
    chat_id: chatId,
    is_enabled: false,
    system_prompt: null,
    model: null,
    respond_on_any: false,
    respond_on_mention: true,
    respond_on_reply: false,
    respond_on: "mention",
    debug: false,
    media_to_text_models: {},
    memory: false,
    memory_threshold: null,
    model_roles: {},
    active_persona: null,
    harness: null,
    harness_cwd: null,
    output_visibility: {},
    harness_config: {},
    harness_session_id: null,
    harness_session_kind: null,
    harness_session_history: [],
    harness_fork_stack: [],
    timestamp: new Date().toISOString(),
  };
}

/**
 * @param {string} chatId
 * @param {unknown} value
 * @returns {import("./store.js").ChatRow}
 */
export function normalizeChatConfig(chatId, value) {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? { ...createDefaultChatConfig(chatId), .../** @type {Record<string, unknown>} */ (value), chat_id: chatId }
    : createDefaultChatConfig(chatId);
  const chat = normalizeChatRow(raw);
  if (!chat) {
    throw new Error(`Invalid chat config for ${chatId}`);
  }
  return chat;
}

/**
 * @param {string} chatId
 * @returns {Promise<import("./store.js").ChatRow | null>}
 */
export async function readChatConfig(chatId) {
  try {
    const text = await readFile(getChatConfigPath(chatId), "utf8");
    return normalizeChatConfig(chatId, JSON.parse(text));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} chatId
 * @param {import("./store.js").ChatRow | Record<string, unknown>} config
 * @returns {Promise<import("./store.js").ChatRow>}
 */
export async function writeChatConfig(chatId, config) {
  const normalized = normalizeChatConfig(chatId, config);
  const filePath = getChatConfigPath(chatId);
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
  await rename(tempPath, filePath);
  return normalized;
}

/**
 * Explicitly migrate one chat config from legacy output visibility flags to
 * the new category-owned presentation contract.
 * @param {string} chatId
 * @returns {Promise<{ migrated: boolean, outputVisibility: import("./chat-output-visibility.js").OutputVisibilityOverrides }>}
 */
export async function migrateChatConfigOutputVisibility(chatId) {
  const filePath = getChatConfigPath(chatId);
  const text = await readFile(filePath, "utf8");
  const raw = JSON.parse(text);
  const rawConfig = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const rawOutputVisibility = rawConfig.output_visibility;
  if (!hasLegacyOutputVisibilityOverrides(rawOutputVisibility)) {
    return {
      migrated: false,
      outputVisibility: normalizeChatConfig(chatId, rawConfig).output_visibility,
    };
  }
  const outputVisibility = migrateLegacyOutputVisibilityOverrides(rawOutputVisibility);
  const normalized = await writeChatConfig(chatId, {
    ...rawConfig,
    output_visibility: outputVisibility,
  });
  return { migrated: true, outputVisibility: normalized.output_visibility };
}

/**
 * Migrate all chat config files under the configured chat base directory.
 * @returns {Promise<{ scanned: number, migrated: number }>}
 */
export async function migrateAllChatConfigOutputVisibility() {
  let entries;
  try {
    entries = await readdir(getChatBaseDir(), { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { scanned: 0, migrated: 0 };
    }
    throw error;
  }

  let scanned = 0;
  let migrated = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const result = await migrateChatConfigOutputVisibility(entry.name);
      scanned += 1;
      if (result.migrated) {
        migrated += 1;
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return { scanned, migrated };
}

/**
 * @param {string} chatId
 * @param {Record<string, unknown>} [seed]
 * @returns {Promise<import("./store.js").ChatRow>}
 */
export async function ensureChatConfig(chatId, seed) {
  const existing = await readChatConfig(chatId);
  if (existing) {
    return existing;
  }
  return writeChatConfig(chatId, seed ?? createDefaultChatConfig(chatId));
}

/**
 * @param {string} chatId
 * @param {(chat: import("./store.js").ChatRow) => import("./store.js").ChatRow | Record<string, unknown>} updater
 * @param {Record<string, unknown>} [seed]
 * @returns {Promise<import("./store.js").ChatRow>}
 */
export async function updateChatConfig(chatId, updater, seed) {
  const current = await ensureChatConfig(chatId, seed);
  return writeChatConfig(chatId, updater(current));
}

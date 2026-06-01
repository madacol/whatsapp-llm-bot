import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getChatRootDir } from "./chat-paths.js";
import { normalizeChatRow } from "./store/normalizers.js";

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

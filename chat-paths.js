import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import config from "./config.js";

const DEFAULT_CHAT_DIR = resolve(homedir(), "chat");

/** @type {string | null} */
let testingChatDir = null;
let registeredTestingChatCleanup = false;

/**
 * Keep test-created chat state out of the real home directory by default.
 * @returns {string}
 */
function getTestingChatDir() {
  if (!testingChatDir) {
    testingChatDir = mkdtempSync(resolve(tmpdir(), "whatsapp-llm-bot-chat-"));
  }
  if (!registeredTestingChatCleanup) {
    process.once("exit", () => {
      if (testingChatDir) {
        rmSync(testingChatDir, { recursive: true, force: true });
      }
    });
    registeredTestingChatCleanup = true;
  }
  return testingChatDir;
}

/**
 * @returns {string}
 */
export function getChatBaseDir() {
  if (config.chat_dir) {
    return resolve(config.chat_dir);
  }
  if (process.env.TESTING || process.env.NODE_TEST_CONTEXT) {
    return getTestingChatDir();
  }
  return DEFAULT_CHAT_DIR;
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function getChatRootDir(chatId) {
  return resolve(getChatBaseDir(), chatId);
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function getChatWorkspaceDir(chatId) {
  return resolve(getChatRootDir(chatId), "workspace");
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function getChatPgDataDir(chatId) {
  return resolve(getChatRootDir(chatId), "pgdata");
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function getChatSqlitePath(chatId) {
  return resolve(getChatRootDir(chatId), "chat.sqlite");
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function getChatActionsDir(chatId) {
  return resolve(getChatRootDir(chatId), "actions");
}

/**
 * @param {string} chatId
 * @param {string} actionName
 * @returns {string}
 */
export function getChatActionDbDir(chatId, actionName) {
  return resolve(getChatActionsDir(chatId), actionName);
}

/**
 * @param {string} chatId
 * @param {string} actionName
 * @returns {string}
 */
export function getChatActionSqlitePath(chatId, actionName) {
  return resolve(getChatActionDbDir(chatId, actionName), "action.sqlite");
}

/**
 * Ensure the standard per-chat directory skeleton exists.
 * @param {string} chatId
 * @returns {void}
 */
export function ensureChatDirs(chatId) {
  mkdirSync(getChatWorkspaceDir(chatId), { recursive: true });
  mkdirSync(getChatActionsDir(chatId), { recursive: true });
}

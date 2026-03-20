import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("action-catalog");

/** @type {string | undefined} */
let actionsDir;

/** @type {AppAction[]} */
let actionsCache = [];

/**
 * Ensure the on-disk actions directory exists and return its absolute path.
 * @returns {Promise<string>}
 */
async function initializeActionsDirectory() {
  const dir = path.resolve(process.cwd(), "actions");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Load a single action module from disk.
 * @param {string} filePath
 * @param {string} fileName
 * @returns {Promise<AppAction | null>}
 */
async function loadActionModule(filePath, fileName) {
  try {
    const module = await import(`file://${filePath}`);
    if (!module.default) {
      log.error(`Action ${fileName} has no default export`);
      return null;
    }

    return {
      ...module.default,
      fileName,
      app_name: "",
    };
  } catch (error) {
    log.error(`Error importing action ${fileName}:`, error);
    return null;
  }
}

/**
 * Get the absolute actions directory path, initializing it on first use.
 * @returns {Promise<string>}
 */
async function getActionsDirectory() {
  if (!actionsDir) {
    actionsDir = await initializeActionsDirectory();
  }
  return actionsDir;
}

/**
 * Read all available actions from the filesystem.
 * @returns {Promise<AppAction[]>}
 */
export async function getActions() {
  const dir = await getActionsDirectory();
  const files = await fs.readdir(dir, { recursive: true });

  const loadedActions = await Promise.all(
    files
      .filter((file) => file.endsWith(".js") && !path.basename(file).startsWith("_"))
      .map((file) => loadActionModule(path.join(dir, file), file)),
  );

  actionsCache = loadedActions.filter(
    /** @type {(action: AppAction | null) => action is AppAction} */
    (action) => action !== null,
  );

  return actionsCache;
}

/**
 * Get a specific action by name from the filesystem.
 * Re-imports the matched module to preserve hot-reload behavior.
 * @param {string} actionName
 * @returns {Promise<AppAction | null>}
 */
export async function getAction(actionName) {
  const dir = await getActionsDirectory();

  if (actionsCache.length === 0) {
    await getActions();
  }

  let fileName = actionsCache.find((action) => action.name === actionName)?.fileName;
  if (!fileName) {
    const refreshedActions = await getActions();
    fileName = refreshedActions.find((action) => action.name === actionName)?.fileName;
    if (!fileName) {
      return null;
    }
  }

  return loadActionModule(path.join(dir, fileName), fileName);
}

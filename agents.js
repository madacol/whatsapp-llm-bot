import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("agents");

/** @type {string | undefined} */
let agentsDir;

/** @type {AppAgent[]} */
let agents = [];

/**
 * Initializes and returns the absolute path to the 'agents' directory.
 * @returns {Promise<string>}
 */
async function initializeDirectoryHandle() {
  const dir = path.resolve(process.cwd(), "agents");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Load all agent definitions from the agents/ directory.
 * Each file should export a default AgentDefinition.
 * @returns {Promise<AppAgent[]>}
 */
export async function getAgents() {
  if (!agentsDir) {
    agentsDir = await initializeDirectoryHandle();
  }

  const dir = agentsDir;
  const files = await fs.readdir(dir);
  agents = (
    await Promise.all(
      files
        .filter((file) => file.endsWith(".js") && !file.startsWith("_"))
        .map(async (file) => {
          const filePath = path.join(dir, file);
          try {
            const module = await import(`file://${filePath}`);
            if (module.default) {
              return /** @type {AppAgent} */ ({
                ...module.default,
                fileName: file,
              });
            }
            log.error(`Agent ${file} has no default export`);
            return null;
          } catch (importError) {
            log.error(`Error importing agent ${file}:`, importError);
            return null;
          }
        }),
    )
  ).filter((agent) => agent !== null);

  return agents;
}

/**
 * Get a specific agent by name. Re-imports the module for hot-reload.
 * @param {string} agentName
 * @returns {Promise<AppAgent | null>}
 */
export async function getAgent(agentName) {
  if (!agentsDir) {
    agentsDir = await initializeDirectoryHandle();
  }

  // Ensure agents are loaded at least once
  if (agents.length === 0) {
    await getAgents();
  }

  const fileName = agents.find((a) => a.name === agentName)?.fileName;
  if (!fileName) {
    return null;
  }

  const filePath = path.join(agentsDir, fileName);
  try {
    const module = await import(`file://${filePath}`);
    if (module.default) {
      return /** @type {AppAgent} */ ({
        ...module.default,
        fileName,
      });
    }
    log.error(`Agent ${fileName} has no default export`);
    return null;
  } catch (error) {
    log.error(`Error importing agent file for ${agentName}:`, error);
    return null;
  }
}

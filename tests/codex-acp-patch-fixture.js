import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openAcpConnection } from "../harnesses/acp-client.js";

export const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const codexAcpEntryPoint = path.join(
  testsDir,
  "..",
  "node_modules",
  "@agentclientprotocol",
  "codex-acp",
  "dist",
  "index.js",
);
export const fakeCodexPath = path.join(testsDir, "fixtures", "fake-codex-app-server.js");

/**
 * @param {Record<string, string>} [env]
 */
export async function openFakeCodexAcpConnection(env = {}) {
  await fs.chmod(fakeCodexPath, 0o755);
  return openAcpConnection({
    command: process.execPath,
    args: [codexAcpEntryPoint],
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      ...env,
    },
  });
}

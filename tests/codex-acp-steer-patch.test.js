import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openAcpConnection } from "../harnesses/acp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("patched codex-acp steering", () => {
  it("advertises ACP steer and forwards session/steer to the active Codex turn", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-steer-"));
    const recordPath = path.join(tempDir, "events.jsonl");
    const fakeCodexPath = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
    await fs.chmod(fakeCodexPath, 0o755);

    const connection = await openAcpConnection({
      command: path.join(__dirname, "..", "node_modules", ".bin", "codex-acp"),
      env: {
        ...process.env,
        CODEX_PATH: fakeCodexPath,
        FAKE_CODEX_RECORD_PATH: recordPath,
      },
    });

    try {
      const initialized = /** @type {{ agentCapabilities?: { sessionCapabilities?: unknown } }} */ (await connection.sendRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "madabot-test", version: "0" },
        clientCapabilities: {},
      }));
      assert.deepEqual(
        initialized?.agentCapabilities?.sessionCapabilities,
        { resume: {}, list: {}, steer: {} },
      );

      const session = /** @type {{ sessionId?: string }} */ (await connection.sendRequest("session/new", { cwd: process.cwd(), mcpServers: [] }));
      assert.equal(session?.sessionId, "fake-thread-1");

      const prompt = connection.sendRequest("session/prompt", {
        sessionId: "fake-thread-1",
        prompt: [{ type: "text", text: "first" }],
      });

      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await connection.sendRequest("session/steer", {
            sessionId: "fake-thread-1",
            text: "follow up",
          });
          break;
        } catch (error) {
          if (attempt === 19) {
            throw error;
          }
          await delay(10);
        }
      }

      const promptResult = /** @type {{ stopReason?: string }} */ (await prompt);
      assert.equal(promptResult?.stopReason, "end_turn");

      const records = (await fs.readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(records, [{
        event: "turn/steer",
        value: {
          threadId: "fake-thread-1",
          input: [{ type: "text", text: "follow up" }],
          expectedTurnId: "fake-turn-1",
        },
      }]);
    } finally {
      await connection.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DB_MODULE_URL = pathToFileURL(path.resolve(TEST_DIR, "../db.js")).href;

describe("db storage layout", () => {
  it("keeps one physical database per chat and stores actions inside it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-llm-bot-db-"));

    try {
      const script = `
        import assert from "node:assert/strict";
        import fs from "node:fs/promises";
        import path from "node:path";
        import { closeAllDbs, getActionDb, getChatDb, getRootDb } from ${JSON.stringify(DB_MODULE_URL)};

        delete process.env.TESTING;
        process.chdir(${JSON.stringify(tempDir)});

        await closeAllDbs();

        try {
          const rootDb = getRootDb();
          const chatDb = getChatDb("chat-a");
          const otherChatDb = getChatDb("chat-b");
          const actionDb = getActionDb("chat-a", "demo-action");

          await rootDb.sql\`SELECT 1\`;
          await chatDb.sql\`CREATE TABLE items (value TEXT NOT NULL)\`;
          await chatDb.sql\`INSERT INTO items (value) VALUES (\${"chat-a"})\`;
          await otherChatDb.sql\`CREATE TABLE items (value TEXT NOT NULL)\`;
          await otherChatDb.sql\`INSERT INTO items (value) VALUES (\${"chat-b"})\`;
          await actionDb.sql\`CREATE TABLE items (value TEXT NOT NULL)\`;
          await actionDb.sql\`INSERT INTO items (value) VALUES (\${"demo-action"})\`;

          const { rows: chatRows } = await chatDb.sql\`SELECT value FROM items\`;
          const { rows: otherChatRows } = await otherChatDb.sql\`SELECT value FROM items\`;
          const { rows: actionRows } = await actionDb.sql\`SELECT value FROM items\`;

          assert.deepEqual(chatRows.map((row) => row.value), ["chat-a"]);
          assert.deepEqual(otherChatRows.map((row) => row.value), ["chat-b"]);
          assert.deepEqual(actionRows.map((row) => row.value), ["demo-action"]);

          await assert.rejects(
            () => rootDb.sql\`SELECT value FROM items\`,
            { message: /items/ },
          );

          await closeAllDbs();

          const pgdataEntries = await fs.readdir(path.join(${JSON.stringify(tempDir)}, "pgdata"));
          assert.ok(pgdataEntries.includes("root"));
          assert.ok(pgdataEntries.includes("chat-a"));
          assert.ok(pgdataEntries.includes("chat-b"));
          await assert.rejects(
            fs.access(path.join(${JSON.stringify(tempDir)}, "pgdata", "chat-a", "demo-action")),
          );
        } finally {
          await closeAllDbs();
        }
      `;

      await execFile(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: tempDir,
      });
    } catch (error) {
      const failure = /** @type {Error & { stdout?: string, stderr?: string }} */ (error);
      assert.fail(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

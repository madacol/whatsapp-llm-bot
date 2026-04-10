import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { getChatWorkDir } from "../../../utils.js";

const execFile = promisify(execFileCallback);

/** @type {ActionDbTestFn[]} */
export default [
  async function clones_repository_into_chat_workdir_root(action_fn, db) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clone-action-"));
    const sourceRepo = path.join(tempDir, "source.git");
    const chatId = "clone-action-chat";

    await execFile("git", ["init", "--bare", sourceRepo]);
    await db.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT DO NOTHING`;

    const result = await action_fn(
      { chatId, rootDb: db },
      { repository: sourceRepo },
    );

    const workdir = getChatWorkDir(chatId);
    const gitDir = path.join(workdir, ".git");
    const stat = await fs.stat(gitDir);

    assert.equal(stat.isDirectory(), true);
    await assert.rejects(fs.stat(path.join(workdir, "source")));
    assert.equal(result, `Cloned into \`${workdir}\`.`);
  },
];

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { handleSlashDiffCommand } from "../slash-diff-command.js";

const execFileAsync = promisify(execFile);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

describe("slash diff command", () => {
  it("emits file-change events for the current git diff", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "slash-diff-"));
    try {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test User"]);
      await fs.writeFile(path.join(repo, "app.js"), "const value = 1;\n", "utf8");
      await git(repo, ["add", "app.js"]);
      await git(repo, ["commit", "-m", "initial"]);
      await fs.writeFile(path.join(repo, "app.js"), "const value = 2;\n", "utf8");

      /** @type {OutboundEvent[]} */
      const events = [];
      const handled = await handleSlashDiffCommand({
        command: "diff",
        workdir: repo,
        context: /** @type {ExecuteActionContext} */ ({
          reply: async (event) => {
            events.push(event);
            return undefined;
          },
        }),
      });

      assert.equal(handled, true);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.kind, "file_change");
      assert.equal(events[0]?.kind === "file_change" ? events[0].path : "", "app.js");
      assert.equal(events[0]?.kind === "file_change" ? events[0].changeKind : "", "update");
      assert.match(events[0]?.kind === "file_change" ? events[0].diff ?? "" : "", /-const value = 1;/);
      assert.match(events[0]?.kind === "file_change" ? events[0].diff ?? "" : "", /\+const value = 2;/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

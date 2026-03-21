import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getChatWorkDir } from "../utils.js";

describe("getChatWorkDir", () => {
  /** @type {string | undefined} */
  let originalWorkspacesDir;
  /** @type {string} */
  let tempDir;

  beforeEach(async () => {
    originalWorkspacesDir = process.env.WORKSPACES_DIR;
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-workspaces-"));
    process.env.WORKSPACES_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalWorkspacesDir === undefined) {
      delete process.env.WORKSPACES_DIR;
    } else {
      process.env.WORKSPACES_DIR = originalWorkspacesDir;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it("starts the default workspace folder with a sanitized chat name", () => {
    const workdir = getChatWorkDir("12345@g.us", undefined, "Family / Planning: 2026");

    assert.equal(path.basename(workdir), "Family Planning 2026--12345@g.us");
    assert.ok(fs.existsSync(workdir));
  });

  it("migrates a legacy chatId-only workspace to the named folder", async () => {
    const legacyDir = path.join(tempDir, "12345@g.us");
    await fsp.mkdir(legacyDir, { recursive: true });
    await fsp.writeFile(path.join(legacyDir, "notes.txt"), "existing workspace");

    const workdir = getChatWorkDir("12345@g.us", undefined, "Family Chat");

    assert.equal(path.basename(workdir), "Family Chat--12345@g.us");
    assert.equal(fs.existsSync(legacyDir), false);
    assert.equal(await fsp.readFile(path.join(workdir, "notes.txt"), "utf8"), "existing workspace");
  });

  it("reuses an existing named workspace even when the current call has no chat name", async () => {
    const namedDir = path.join(tempDir, "Family Chat--12345@g.us");
    await fsp.mkdir(namedDir, { recursive: true });

    const workdir = getChatWorkDir("12345@g.us");

    assert.equal(workdir, namedDir);
  });
});

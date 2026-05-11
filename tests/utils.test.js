import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import { getChatWorkDir } from "../utils.js";
import {
  getChatActionDbDir,
  getChatActionsDir,
  getChatEtcDir,
  getChatPgDataDir,
  getChatRootDir,
  getChatWorkspaceDir,
} from "../chat-paths.js";

describe("getChatWorkDir", () => {
  /** @type {string | undefined} */
  let originalChatDir;
  /** @type {string | undefined} */
  let originalWorkspacesDir;
  /** @type {string | undefined} */
  let originalTesting;
  /** @type {string} */
  let tempChatDir;
  /** @type {string} */
  let tempWorkspacesDir;

  beforeEach(async () => {
    originalChatDir = process.env.CHAT_DIR;
    originalWorkspacesDir = process.env.WORKSPACES_DIR;
    originalTesting = process.env.TESTING;
    tempChatDir = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-root-"));
    tempWorkspacesDir = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-workspaces-"));
    process.env.CHAT_DIR = tempChatDir;
    process.env.WORKSPACES_DIR = tempWorkspacesDir;
  });

  afterEach(async () => {
    if (originalChatDir === undefined) {
      delete process.env.CHAT_DIR;
    } else {
      process.env.CHAT_DIR = originalChatDir;
    }
    if (originalWorkspacesDir === undefined) {
      delete process.env.WORKSPACES_DIR;
    } else {
      process.env.WORKSPACES_DIR = originalWorkspacesDir;
    }
    if (originalTesting === undefined) {
      delete process.env.TESTING;
    } else {
      process.env.TESTING = originalTesting;
    }
    await fsp.rm(tempChatDir, { recursive: true, force: true });
    await fsp.rm(tempWorkspacesDir, { recursive: true, force: true });
  });

  it("uses the chat ID as the canonical chat folder", async () => {
    const chatId = "12345@g.us";
    const workdir = getChatWorkDir(chatId, undefined, "Family / Planning: 2026");
    const readableLink = path.join(tempWorkspacesDir, "Family Planning 2026");

    assert.equal(workdir, path.join(tempChatDir, chatId, "workspace"));
    assert.ok(fs.existsSync(workdir));
    assert.equal(getChatRootDir(chatId), path.join(tempChatDir, chatId));
    assert.equal(getChatWorkspaceDir(chatId), path.join(tempChatDir, chatId, "workspace"));
    assert.equal(getChatPgDataDir(chatId), path.join(tempChatDir, chatId, "pgdata"));
    assert.equal(getChatActionsDir(chatId), path.join(tempChatDir, chatId, "actions"));
    assert.equal(getChatActionDbDir(chatId, "create_action"), path.join(tempChatDir, chatId, "actions", "create_action"));
    assert.equal(getChatEtcDir(chatId), path.join(tempChatDir, chatId, "etc"));
    assert.ok(fs.existsSync(getChatPgDataDir(chatId)));
    assert.ok(fs.existsSync(getChatActionsDir(chatId)));
    assert.ok(fs.existsSync(getChatEtcDir(chatId)));
    assert.equal((await fsp.lstat(readableLink)).isSymbolicLink(), true);
    assert.equal(path.resolve(tempWorkspacesDir, await fsp.readlink(readableLink)), workdir);
  });

  it("adds the chat ID to the readable link only when the chat name conflicts", async () => {
    const existingTarget = path.join(tempChatDir, "existing-chat", "workspace");
    await fsp.mkdir(existingTarget, { recursive: true });
    await fsp.symlink(existingTarget, path.join(tempWorkspacesDir, "Family Chat"), "dir");

    const workdir = getChatWorkDir("12345@g.us", undefined, "Family Chat");
    const fallbackLink = path.join(tempWorkspacesDir, "Family Chat--12345@g.us");

    assert.equal(workdir, path.join(tempChatDir, "12345@g.us", "workspace"));
    assert.equal((await fsp.lstat(fallbackLink)).isSymbolicLink(), true);
    assert.equal(path.resolve(tempWorkspacesDir, await fsp.readlink(fallbackLink)), workdir);
  });

  it("returns the canonical workspace even when the current call has no chat name", async () => {
    const namedWorkdir = getChatWorkDir("12345@g.us", undefined, "Family Chat");
    const unnamedWorkdir = getChatWorkDir("12345@g.us");
    const chatIdLink = path.join(tempWorkspacesDir, "12345@g.us");

    assert.equal(unnamedWorkdir, namedWorkdir);
    assert.equal((await fsp.lstat(chatIdLink)).isSymbolicLink(), true);
    assert.equal(path.resolve(tempWorkspacesDir, await fsp.readlink(chatIdLink)), namedWorkdir);
  });

  it("keeps test chat folders out of the real home directory by default", () => {
    delete process.env.CHAT_DIR;
    delete process.env.WORKSPACES_DIR;
    process.env.TESTING = "1";

    const workdir = getChatWorkDir("test-chat");

    assert.ok(workdir.startsWith(path.join(os.tmpdir(), "whatsapp-llm-bot-chat-")));
    assert.equal(workdir.startsWith(path.join(homedir(), "chat")), false);
  });
});

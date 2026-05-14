import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTestDb } from "./helpers.js";
import config from "../config.js";
import { initStore } from "../store.js";
import { setConfigValue } from "../actions/settings/chatSettings/_service.js";
import { readChatConfig, writeChatConfig } from "../chat-config.js";
import { SqliteDb } from "../sqlite-db.js";

const CACHE_PATH = path.resolve("data/models.json");
const execFileAsync = promisify(execFile);

/** @type {string[]} */
const tempDirs = [];

/** @type {import("../models-cache.js").OpenRouterModel[]} */
const fakeModels = [
  { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
];

async function writeFakeCache() {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(fakeModels));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function runGit(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

/**
 * @returns {Promise<{ repoRoot: string, worktreePath: string }>}
 */
async function createRepoWithWorkspaceFixture() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-settings-workspace-"));
  tempDirs.push(repoRoot);
  await runGit(repoRoot, ["init", "--initial-branch=master"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(repoRoot, "app.txt"), "base\n");
  await runGit(repoRoot, ["add", "app.txt"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  const worktreePath = path.join(repoRoot, "..", `ws-${path.basename(repoRoot)}`);
  await runGit(repoRoot, ["worktree", "add", "-b", "ws/settings", worktreePath, "master"]);
  return { repoRoot, worktreePath };
}

describe("per-chat model selection", () => {
  /** @type {import("../sqlite-db.js").SqliteDb} */
  let db;

  before(async () => {
    db = await createTestDb();
    await writeFakeCache();
  });

  /** @param {string} chatId @param {Record<string, unknown>} [settings] */
  async function seedConfigChat(chatId, settings = {}) {
    await db.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT DO NOTHING`;
    await writeChatConfig(chatId, { chat_id: chatId, ...settings });
  }

  after(async () => {
    await fs.rm(CACHE_PATH, { force: true });
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  describe("chat_settings info includes model", () => {
    it("throws if chat does not exist", async () => {
      const settingsModule = await import("../actions/settings/chatSettings/index.js");
      const action = settingsModule.default;
      await assert.rejects(
        () => action.action_fn({ chatId: "nonexistent", rootDb: db, senderIds: [] }, { setting: "" }),
        { message: /does not exist/ },
      );
    });
  });

  describe("chat_settings model via dispatch", () => {
    it("updates the model in the config file", async () => {
      await seedConfigChat("chat-set-1");

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-1", rootDb: db },
        { setting: "model", value: "openai/gpt-4.1-mini" },
      );
      assert.ok(result.includes("openai/gpt-4.1-mini"));

      const chat = await readChatConfig("chat-set-1");
      assert.equal(chat.model, "openai/gpt-4.1-mini");
    });

    it("reverts to default when given empty string", async () => {
      await seedConfigChat("chat-set-2", { model: "some-model" });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-2", rootDb: db },
        { setting: "model", value: "" },
      );
      assert.ok(result.includes("default"));

      const chat = await readChatConfig("chat-set-2");
      assert.equal(chat.model, null);
    });

    it("rejects invalid model with suggestions", async () => {
      await seedConfigChat("chat-set-3");

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-3", rootDb: db },
        { setting: "model", value: "nonexistent/fake-model" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));

      const chat = await readChatConfig("chat-set-3");
      assert.equal(chat.model, null);
    });

    it("suggests close matches for partial model names", async () => {
      await seedConfigChat("chat-set-4");

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-4", rootDb: db },
        { setting: "model", value: "gpt-4" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));
      assert.ok(result.includes("openai/gpt-4"));
    });

    it("throws if chat does not exist", async () => {
      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      await assert.rejects(
        () => action.action_fn({ chatId: "nonexistent", rootDb: db }, { setting: "model", value: "x" }),
        { message: /does not exist/ },
      );
    });
  });

  describe("toBool accepts 'on'/'off' for boolean settings", () => {
    it("'on' enables memory", async () => {
      await seedConfigChat("mem-on-1", { memory: false });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-on-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "on" },
      );
      assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);

      const chat = await readChatConfig("mem-on-1");
      assert.equal(chat.memory, true);
    });

    it("'off' disables memory", async () => {
      await seedConfigChat("mem-off-1", { memory: true });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-off-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "off" },
      );
      assert.ok(result.includes("disabled"), `expected 'disabled' in: ${result}`);

      const chat = await readChatConfig("mem-off-1");
      assert.equal(chat.memory, false);
    });

    it("'true' still works", async () => {
      await seedConfigChat("mem-true-1", { memory: false });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-true-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "true" },
      );
      assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);
    });

    it("throws on unrecognized boolean value", async () => {
      await seedConfigChat("mem-bad-1");

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      await assert.rejects(
        () => action.action_fn(
          { chatId: "mem-bad-1", rootDb: db, senderIds: ["u1"] },
          { setting: "memory", value: "banana" },
        ),
        { message: /must be one of.*on.*off.*true.*false/i },
      );
    });
  });

  describe("debug 'on' enables debug", () => {
    it("'on' enables debug", async () => {
      await seedConfigChat("dbg-on-1");

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "dbg-on-1", rootDb: db, senderIds: ["u1"] },
        { setting: "debug", value: "on" },
      );
      assert.ok(result.includes("Debug on"), `expected 'Debug on' in: ${result}`);

      const chat = await readChatConfig("dbg-on-1");
      assert.equal(chat.debug, true, "debug should be true");
    });
  });

  describe("enabled setting accepts 'enabled'/'disabled'", () => {
    it("'enabled' enables the bot", async () => {
      await seedConfigChat("en-1", { is_enabled: false });

      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const mod = await import("../actions/settings/chatSettings/index.js");
        const action = mod.default;
        const result = await action.action_fn(
          { chatId: "en-1", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "enabled" },
        );
        assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);

        const chat = await readChatConfig("en-1");
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });

    it("'disabled' disables the bot", async () => {
      await seedConfigChat("en-2", { is_enabled: true });

      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const mod = await import("../actions/settings/chatSettings/index.js");
        const action = mod.default;
        const result = await action.action_fn(
          { chatId: "en-2", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "disabled" },
        );
        assert.ok(result.includes("disabled"), `expected 'disabled' in: ${result}`);

        const chat = await readChatConfig("en-2");
        assert.equal(chat.is_enabled, false);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });

    it("shows local and remote enable commands in disabled chat info", async () => {
      await seedConfigChat("disabled-info-chat", { is_enabled: false });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "disabled-info-chat", rootDb: db, senderIds: ["u1"] },
        { setting: "" },
      );

      assert.ok(result.includes("enabled: off"), `expected disabled status, got: ${result}`);
      assert.ok(result.includes("!s enabled on`"), `expected local enable command, got: ${result}`);
      assert.ok(result.includes("!s enabled on disabled-info-chat"), `expected remote enable command, got: ${result}`);
    });

    it("master can enable another chat by target chat id", async () => {
      await seedConfigChat("admin-chat");
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const mod = await import("../actions/settings/chatSettings/index.js");
        const action = mod.default;
        const result = await action.action_fn(
          { chatId: "admin-chat", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "on remote-chat@s.whatsapp.net" },
        );
        assert.ok(result.includes("remote-chat@s.whatsapp.net"), `expected target chat in response, got: ${result}`);

        const chat = await readChatConfig("remote-chat@s.whatsapp.net");
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });

    it("registers remote enabled chats in root while storing settings in the target chat DB", async () => {
      const rootDb = new SqliteDb(":memory:");
      /** @type {Map<string, import("../sqlite-db.js").SqliteDb>} */
      const chatDbs = new Map();
      /** @param {string} chatId */
      const resolveChatDb = (chatId) => {
        const existing = chatDbs.get(chatId);
        if (existing) return existing;
        const created = new SqliteDb(":memory:");
        chatDbs.set(chatId, created);
        return created;
      };
      const store = await initStore(rootDb, { getChatDb: resolveChatDb });
      await store.createChat("admin-chat-isolated");

      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        await setConfigValue(
          resolveChatDb("admin-chat-isolated"),
          "admin-chat-isolated",
          "enabled",
          "on remote-isolated@g.us",
          { senderIds: ["master-user"], rootDb, getChatDb: resolveChatDb },
        );

        const { rows: [rootChat] } = await rootDb.sql`
          SELECT chat_id FROM chats WHERE chat_id = 'remote-isolated@g.us'
        `;
        const targetChat = await readChatConfig("remote-isolated@g.us");
        assert.equal(rootChat.chat_id, "remote-isolated@g.us");
        assert.equal(targetChat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });

    it("master can disable another chat with chat id before the value", async () => {
      await seedConfigChat("admin-chat");
      await seedConfigChat("remote-off@g.us", { is_enabled: true });
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const mod = await import("../actions/settings/chatSettings/index.js");
        const action = mod.default;
        const result = await action.action_fn(
          { chatId: "admin-chat", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "remote-off@g.us off" },
        );
        assert.ok(result.includes("remote-off@g.us"), `expected target chat in response, got: ${result}`);

        const chat = await readChatConfig("remote-off@g.us");
        assert.equal(chat.is_enabled, false);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });
  });

  describe("mobile-first config command semantics", () => {
    it("shows the resolved workspace path when workspace uses the chat default", async () => {
      const { repoRoot, worktreePath } = await createRepoWithWorkspaceFixture();
      const { initStore } = await import("../store.js");
      const store = await initStore(db);
      await store.createProject({
        name: `settings-repo-${Date.now()}`,
        rootPath: repoRoot,
        defaultBaseBranch: "master",
      });
      await seedConfigChat("cfg-folder-workspace", { harness_cwd: null });
      const repo = await store.getProjectByRootPath(repoRoot);
      assert.ok(repo);
      await store.saveWhatsAppWorkspacePresentation({
        projectId: repo.project_id,
        workspaceId: "cfg-folder-workspace-ws",
        workspaceChatId: "cfg-folder-workspace",
        workspaceChatSubject: "settings",
      });
      await store.createWorkspace({
        workspaceId: "cfg-folder-workspace-ws",
        projectId: repo.project_id,
        name: "settings",
        branch: "settings",
        baseBranch: "master",
        worktreePath,
        status: "ready",
      });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;

      const workspaceResult = await action.action_fn(
        { chatId: "cfg-folder-workspace", rootDb: db, senderIds: ["u1"] },
        { setting: "workspace" },
      );
      assert.ok(workspaceResult.includes(worktreePath), `expected resolved worktree path, got: ${workspaceResult}`);
      assert.ok(!workspaceResult.includes("workspace worktree"), `expected plain path only, got: ${workspaceResult}`);

      const infoResult = await action.action_fn(
        { chatId: "cfg-folder-workspace", rootDb: db, senderIds: ["u1"] },
        { setting: "" },
      );
      assert.ok(infoResult.includes(worktreePath), `expected settings summary to include worktree path, got: ${infoResult}`);
      assert.ok(!infoResult.includes("workspace worktree"), `expected plain path only, got: ${infoResult}`);
    });

    it("shows help text for the workspace key", async () => {
      await seedConfigChat("cfg-help-1", { harness_cwd: "/tmp" });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-help-1", rootDb: db, senderIds: ["u1"] },
        { setting: "workspace" },
      );

      assert.ok(result.includes("Workspace"), `expected setting title, got: ${result}`);
      assert.ok(result.includes("/tmp"), `expected current value, got: ${result}`);
      assert.ok(result.toLowerCase().includes("what it does"), `expected description section, got: ${result}`);
      assert.ok(result.toLowerCase().includes("examples"), `expected examples section, got: ${result}`);
    });

    it("keeps folder as an alias for workspace", async () => {
      await seedConfigChat("cfg-folder-alias", { harness_cwd: "/tmp" });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-folder-alias", rootDb: db, senderIds: ["u1"] },
        { setting: "folder" },
      );

      assert.ok(result.includes("Workspace"), `expected workspace setting title through folder alias, got: ${result}`);
      assert.ok(result.includes("/tmp"), `expected current value, got: ${result}`);
    });

    it("formats harness help as sectioned bullet points", async () => {
      await seedConfigChat("cfg-help-2", { harness: "codex" });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-help-2", rootDb: db, senderIds: ["u1"] },
        { setting: "harness" },
      );

      assert.ok(result.includes("*Harness*"), `expected titled header, got: ${result}`);
      assert.ok(result.includes("- Current: codex"), `expected current bullet, got: ${result}`);
      assert.ok(result.includes("*Options*"), `expected options section, got: ${result}`);
      assert.ok(result.includes("- native"), `expected native option bullet, got: ${result}`);
      assert.ok(result.includes("*Examples*"), `expected examples section, got: ${result}`);
    });

    it("keeps picker prompts compact for selectable settings", async () => {
      await seedConfigChat("cfg-help-3", { harness: "codex" });

      /** @type {string | null} */
      let promptText = null;
      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        {
          chatId: "cfg-help-3",
          rootDb: db,
          senderIds: ["u1"],
          select: async (question) => {
            promptText = question;
            return "";
          },
        },
        { setting: "harness" },
      );

      assert.equal(result, promptText);
      assert.ok(promptText?.includes("*Harness*"), `expected titled header, got: ${promptText}`);
      assert.ok(promptText?.includes("- Current: codex"), `expected current bullet, got: ${promptText}`);
      assert.ok(!promptText?.includes("*Options*"), `picker prompt should omit options, got: ${promptText}`);
      assert.ok(!promptText?.includes("*Examples*"), `picker prompt should omit examples, got: ${promptText}`);
    });

    it("resets a friendly key through the reset verb", async () => {
      await seedConfigChat("cfg-reset-1", { harness_cwd: "/tmp" });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-reset-1", rootDb: db, senderIds: ["u1"] },
        { setting: "reset", value: "folder" },
      );

      assert.ok(result.toLowerCase().includes("default") || result.toLowerCase().includes("workspace"), `expected reset confirmation, got: ${result}`);

      const chat = await readChatConfig("cfg-reset-1");
      assert.equal(chat.harness_cwd, null);
    });

    it("describes grouped visibility controls with per-flag defaults", async () => {
      await seedConfigChat("cfg-show-1", { output_visibility: {} });

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-show-1", rootDb: db, senderIds: ["u1"] },
        { setting: "show" },
      );

      assert.ok(result.includes("*Show*"), `expected setting title, got: ${result}`);
      assert.ok(result.includes("- Current: tools off, thinking on, changes on, subagents on"), `expected current summary, got: ${result}`);
      assert.ok(result.includes("*Controls*"), `expected controls section, got: ${result}`);
      assert.ok(result.includes("- tools"), `expected tools flag, got: ${result}`);
      assert.ok(result.includes("- thinking"), `expected thinking flag, got: ${result}`);
      assert.ok(result.includes("- changes"), `expected changes flag, got: ${result}`);
      assert.ok(result.includes("- subagents"), `expected subagents flag, got: ${result}`);
    });

    it("does not accept text subcommands for show anymore", async () => {
      await seedConfigChat("cfg-show-2");

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-show-2", rootDb: db, senderIds: ["u1"] },
        { setting: "show", value: "commands off" },
      );

      assert.ok(result.includes("Use `!s show`"), `expected picker guidance, got: ${result}`);
      assert.ok(result.includes("!s reset show"), `expected reset guidance, got: ${result}`);

      const chat = await readChatConfig("cfg-show-2");
      assert.deepEqual(chat.output_visibility, {});
    });

    it("uses a multi-select picker for show and stores the selected outputs", async () => {
      await seedConfigChat("cfg-show-3");

      /** @type {string | null} */
      let promptText = null;
      /** @type {SelectOption[] | null} */
      let pickerOptions = null;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        {
          chatId: "cfg-show-3",
          rootDb: db,
          senderIds: ["u1"],
          selectMany: async (question, options) => {
            promptText = question;
            pickerOptions = options;
            return { kind: "selected", ids: ["tools", "changes"] };
          },
        },
        { setting: "show" },
      );

      assert.equal(
        promptText,
        "Choose which extra agent progress outputs are shown in chat.",
        `expected concise show prompt, got: ${promptText}`,
      );
      assert.deepEqual(
        pickerOptions,
        [
          { id: "tools", label: "⚪ Show tool activity" },
          { id: "thinking", label: "🟢 Hide thinking" },
          { id: "changes", label: "🟢 Hide file changes" },
          { id: "subagents", label: "🟢 Hide sub-agent output" },
          { id: "none", label: "⚪ Hide all extras" },
        ],
      );
      assert.ok(result.includes("Show tool activity"), `expected show summary, got: ${result}`);
      assert.ok(result.includes("Hide file changes"), `expected hide summary, got: ${result}`);
      assert.ok(!result.includes("thinking"), `did not expect unchanged thinking summary, got: ${result}`);

      const chat = await readChatConfig("cfg-show-3");
      assert.deepEqual(chat.output_visibility, {
        tools: true,
        changes: false,
      });
    });

    it("treats an empty multi-select result as a no-op for show", async () => {
      await seedConfigChat("cfg-show-4");

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        {
          chatId: "cfg-show-4",
          rootDb: db,
          senderIds: ["u1"],
          selectMany: async () => ({ kind: "unchanged" }),
        },
        { setting: "show" },
      );

      assert.equal(result, "");

      const chat = await readChatConfig("cfg-show-4");
      assert.deepEqual(chat.output_visibility, {});
    });
  });

});

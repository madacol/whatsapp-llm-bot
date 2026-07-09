import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTestDb } from "./helpers.js";
import config from "../config.js";
import { initStore } from "../store.js";
import { setConfigValue } from "../chat-settings-service.js";
import { readChatConfig, writeChatConfig } from "../chat-config.js";
import { SqliteDb } from "../sqlite-db.js";
import { runChatSettingsCommand } from "../commands/chat-settings-command.js";

const CACHE_PATH = path.resolve("data/models.json");
const execFileAsync = promisify(execFile);

/** @type {string[]} */
const tempDirs = [];

/** @type {import("../models-cache.js").OpenRouterModel[]} */
const fakeModels = [
  { id: "openai/gpt-4o", name: "GPT-4o", description: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", description: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", description: "Claude 3.5 Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
];

async function writeFakeCache() {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(fakeModels));
}

/**
 * @param {string} chatId
 * @returns {Promise<NonNullable<Awaited<ReturnType<typeof readChatConfig>>>>}
 */
async function readRequiredChatConfig(chatId) {
  const chat = await readChatConfig(chatId);
  assert.ok(chat, `Expected chat config ${chatId} to exist`);
  return chat;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireString(value) {
  assert.ok(typeof value === "string", "Expected string value");
  return value;
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
      await assert.rejects(
        () => runChatSettingsCommand({ chatId: "nonexistent", rootDb: db, senderIds: [] }, { setting: "" }),
        { message: /does not exist/ },
      );
    });
  });

  describe("chat_settings model via dispatch", () => {
    it("updates the model in the config file", async () => {
      await seedConfigChat("chat-set-1");
      const result = await runChatSettingsCommand(
        { chatId: "chat-set-1", rootDb: db },
        { setting: "model", value: "openai/gpt-4.1-mini" },
      );
      assert.ok(result.includes("openai/gpt-4.1-mini"));

      const chat = await readRequiredChatConfig("chat-set-1");
      assert.equal(chat.model, "openai/gpt-4.1-mini");
    });

    it("reverts to default when given empty string", async () => {
      await seedConfigChat("chat-set-2", { model: "some-model" });
      const result = await runChatSettingsCommand(
        { chatId: "chat-set-2", rootDb: db },
        { setting: "model", value: "" },
      );
      assert.ok(result.includes("default"));

      const chat = await readRequiredChatConfig("chat-set-2");
      assert.equal(chat.model, null);
    });

    it("rejects invalid model with suggestions", async () => {
      await seedConfigChat("chat-set-3");
      const result = await runChatSettingsCommand(
        { chatId: "chat-set-3", rootDb: db },
        { setting: "model", value: "nonexistent/fake-model" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));

      const chat = await readRequiredChatConfig("chat-set-3");
      assert.equal(chat.model, null);
    });

    it("suggests close matches for partial model names", async () => {
      await seedConfigChat("chat-set-4");
      const result = await runChatSettingsCommand(
        { chatId: "chat-set-4", rootDb: db },
        { setting: "model", value: "gpt-4" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));
      assert.ok(result.includes("openai/gpt-4"));
    });

    it("throws if chat does not exist", async () => {
      await assert.rejects(
        () => runChatSettingsCommand({ chatId: "nonexistent", rootDb: db }, { setting: "model", value: "x" }),
        { message: /does not exist/ },
      );
    });
  });

  describe("toBool accepts 'on'/'off' for boolean settings", () => {
    it("'on' enables memory", async () => {
      await seedConfigChat("mem-on-1", { memory: false });
      const result = await runChatSettingsCommand(
        { chatId: "mem-on-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "on" },
      );
      assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);

      const chat = await readRequiredChatConfig("mem-on-1");
      assert.equal(chat.memory, true);
    });

    it("'off' disables memory", async () => {
      await seedConfigChat("mem-off-1", { memory: true });
      const result = await runChatSettingsCommand(
        { chatId: "mem-off-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "off" },
      );
      assert.ok(result.includes("disabled"), `expected 'disabled' in: ${result}`);

      const chat = await readRequiredChatConfig("mem-off-1");
      assert.equal(chat.memory, false);
    });

    it("'true' still works", async () => {
      await seedConfigChat("mem-true-1", { memory: false });
      const result = await runChatSettingsCommand(
        { chatId: "mem-true-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "true" },
      );
      assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);
    });

    it("throws on unrecognized boolean value", async () => {
      await seedConfigChat("mem-bad-1");
      await assert.rejects(
        () => runChatSettingsCommand(
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
      const result = await runChatSettingsCommand(
        { chatId: "dbg-on-1", rootDb: db, senderIds: ["u1"] },
        { setting: "debug", value: "on" },
      );
      assert.ok(result.includes("Debug on"), `expected 'Debug on' in: ${result}`);

      const chat = await readRequiredChatConfig("dbg-on-1");
      assert.equal(chat.debug, true, "debug should be true");
    });
  });

  describe("enabled setting accepts 'enabled'/'disabled'", () => {
    it("'enabled' enables the bot", async () => {
      await seedConfigChat("en-1", { is_enabled: false });

      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await runChatSettingsCommand(
          { chatId: "en-1", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "enabled" },
        );
        assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);

        const chat = await readRequiredChatConfig("en-1");
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
        const result = await runChatSettingsCommand(
          { chatId: "en-2", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "disabled" },
        );
        assert.ok(result.includes("disabled"), `expected 'disabled' in: ${result}`);

        const chat = await readRequiredChatConfig("en-2");
        assert.equal(chat.is_enabled, false);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });

    it("shows local and remote enable commands in disabled chat info", async () => {
      await seedConfigChat("disabled-info-chat", { is_enabled: false });
      const result = await runChatSettingsCommand(
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
        const result = await runChatSettingsCommand(
          { chatId: "admin-chat", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "on remote-chat@s.whatsapp.net" },
        );
        assert.ok(result.includes("remote-chat@s.whatsapp.net"), `expected target chat in response, got: ${result}`);

        const chat = await readRequiredChatConfig("remote-chat@s.whatsapp.net");
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
        const targetChat = await readRequiredChatConfig("remote-isolated@g.us");
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
        const result = await runChatSettingsCommand(
          { chatId: "admin-chat", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "remote-off@g.us off" },
        );
        assert.ok(result.includes("remote-off@g.us"), `expected target chat in response, got: ${result}`);

        const chat = await readRequiredChatConfig("remote-off@g.us");
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

      const workspaceResult = await runChatSettingsCommand(
        { chatId: "cfg-folder-workspace", rootDb: db, senderIds: ["u1"] },
        { setting: "workspace" },
      );
      assert.ok(workspaceResult.includes(worktreePath), `expected resolved worktree path, got: ${workspaceResult}`);
      assert.ok(!workspaceResult.includes("workspace worktree"), `expected plain path only, got: ${workspaceResult}`);

      const infoResult = await runChatSettingsCommand(
        { chatId: "cfg-folder-workspace", rootDb: db, senderIds: ["u1"] },
        { setting: "" },
      );
      assert.ok(infoResult.includes(worktreePath), `expected settings summary to include worktree path, got: ${infoResult}`);
      assert.ok(!infoResult.includes("workspace worktree"), `expected plain path only, got: ${infoResult}`);
    });

    it("shows help text for the workspace key", async () => {
      await seedConfigChat("cfg-help-1", { harness_cwd: "/tmp" });
      const result = await runChatSettingsCommand(
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
      const result = await runChatSettingsCommand(
        { chatId: "cfg-folder-alias", rootDb: db, senderIds: ["u1"] },
        { setting: "folder" },
      );

      assert.ok(result.includes("Workspace"), `expected workspace setting title through folder alias, got: ${result}`);
      assert.ok(result.includes("/tmp"), `expected current value, got: ${result}`);
    });

    it("formats harness help as sectioned bullet points", async () => {
      await seedConfigChat("cfg-help-2", { harness: "codex" });
      const result = await runChatSettingsCommand(
        { chatId: "cfg-help-2", rootDb: db, senderIds: ["u1"] },
        { setting: "harness" },
      );

      assert.ok(result.includes("*Harness*"), `expected titled header, got: ${result}`);
      assert.ok(result.includes("- Current: codex"), `expected current bullet, got: ${result}`);
      assert.ok(result.includes("*Options*"), `expected options section, got: ${result}`);
      assert.ok(!result.includes("- app"), `expected no legacy app option bullet, got: ${result}`);
      assert.ok(result.includes("- codex"), `expected codex option bullet, got: ${result}`);
      assert.ok(result.includes("*Examples*"), `expected examples section, got: ${result}`);
    });

    it("keeps picker prompts compact for selectable settings", async () => {
      await seedConfigChat("cfg-help-3", { harness: "codex" });

      /** @type {string | null} */
      let promptText = null;
      const result = await runChatSettingsCommand(
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

      const prompt = requireString(promptText);
      assert.equal(result, prompt);
      assert.ok(prompt.includes("*Harness*"), `expected titled header, got: ${prompt}`);
      assert.ok(prompt.includes("- Current: codex"), `expected current bullet, got: ${prompt}`);
      assert.ok(!prompt.includes("*Options*"), `picker prompt should omit options, got: ${prompt}`);
      assert.ok(!prompt.includes("*Examples*"), `picker prompt should omit examples, got: ${prompt}`);
    });

    it("resets a friendly key through the reset verb", async () => {
      await seedConfigChat("cfg-reset-1", { harness_cwd: "/tmp" });
      const result = await runChatSettingsCommand(
        { chatId: "cfg-reset-1", rootDb: db, senderIds: ["u1"] },
        { setting: "reset", value: "folder" },
      );

      assert.ok(result.toLowerCase().includes("default") || result.toLowerCase().includes("workspace"), `expected reset confirmation, got: ${result}`);

      const chat = await readRequiredChatConfig("cfg-reset-1");
      assert.equal(chat.harness_cwd, null);
    });

    it("describes side-channel presentation categories", async () => {
      await seedConfigChat("cfg-show-1", { output_visibility: {} });
      const result = await runChatSettingsCommand(
        { chatId: "cfg-show-1", rootDb: db, senderIds: ["u1"] },
        { setting: "show" },
      );

      assert.ok(result.includes("*Show*"), `expected setting title, got: ${result}`);
      assert.ok(result.includes("reasoning indicator + inspectable"), `expected current reasoning summary, got: ${result}`);
      assert.ok(result.includes("tools indicator + inspectable"), `expected current tools summary, got: ${result}`);
      assert.ok(result.includes("*Presets*"), `expected presets section, got: ${result}`);
      assert.ok(result.includes("- compact: Move progress into pinned status"), `expected compact preset, got: ${result}`);
      assert.ok(result.includes("- custom: configure individual categories"), `expected custom preset option, got: ${result}`);
      assert.ok(result.includes("*Categories*"), `expected categories section, got: ${result}`);
      assert.ok(result.includes("- reasoning: full details, indicator + inspectable, indicator in pinned status, hidden"), `expected reasoning options, got: ${result}`);
      assert.ok(result.includes("- snapshots: on, off"), `expected snapshot options, got: ${result}`);
      assert.ok(result.includes("- middle assistant messages: on, off"), `expected middle assistant options, got: ${result}`);
    });

    it("sets a show category with a text command", async () => {
      await seedConfigChat("cfg-show-2");
      const result = await runChatSettingsCommand(
        { chatId: "cfg-show-2", rootDb: db, senderIds: ["u1"] },
        { setting: "show", value: "tools pinned" },
      );

      assert.ok(result.includes("tools set to indicator in pinned status"), `expected set confirmation, got: ${result}`);

      const chat = await readRequiredChatConfig("cfg-show-2");
      assert.deepEqual(chat.output_visibility, { tools: "pinnedIndicator" });
    });

    it("sets a show preset with a text command", async () => {
      await seedConfigChat("cfg-show-preset-text-1");
      const result = await runChatSettingsCommand(
        { chatId: "cfg-show-preset-text-1", rootDb: db, senderIds: ["u1"] },
        { setting: "show", value: "compact" },
      );

      assert.ok(result.includes("Show preset set to compact"), `expected preset confirmation, got: ${result}`);

      const chat = await readRequiredChatConfig("cfg-show-preset-text-1");
      assert.deepEqual(chat.output_visibility, {
        reasoning: "pinnedIndicator",
        tools: "pinnedIndicator",
        plans: "pinnedCurrentStep",
        snapshots: "off",
        usage: "pinned",
        transcription: "pinnedIndicator",
        middleAssistantMessages: "off",
      });
    });

    it("uses the reusable picker flow for show presets", async () => {
      await seedConfigChat("cfg-show-preset-picker-1");
      /** @type {Array<{ question: string, options: SelectOption[], currentId?: string }>} */
      const selections = [];
      const result = await runChatSettingsCommand(
        {
          chatId: "cfg-show-preset-picker-1",
          rootDb: db,
          senderIds: ["u1"],
          select: async (question, options, config) => {
            selections.push({
              question,
              options,
              ...(config?.currentId ? { currentId: config.currentId } : {}),
            });
            return "compact";
          },
        },
        { setting: "show" },
      );

      assert.equal(selections.length, 1);
      assert.ok(selections[0]?.question.includes("Choose a preset"), `expected preset prompt, got: ${selections[0]?.question}`);
      assert.equal(selections[0]?.currentId, "default");
      assert.deepEqual(
        selections[0]?.options.map((option) => typeof option === "string" ? option : option.id),
        ["default", "compact", "minimal", "custom"],
      );
      assert.ok(result.includes("Show preset set to compact"), `expected preset confirmation, got: ${result}`);

      const chat = await readRequiredChatConfig("cfg-show-preset-picker-1");
      assert.equal(chat.output_visibility.tools, "pinnedIndicator");
      assert.equal(chat.output_visibility.middleAssistantMessages, "off");
    });

    it("uses the reusable picker flow for custom show category options", async () => {
      await seedConfigChat("cfg-show-picker-1");
      /** @type {Array<{ question: string, options: SelectOption[], currentId?: string }>} */
      const selections = [];
      const result = await runChatSettingsCommand(
        {
          chatId: "cfg-show-picker-1",
          rootDb: db,
          senderIds: ["u1"],
          select: async (question, options, config) => {
            selections.push({
              question,
              options,
              ...(config?.currentId ? { currentId: config.currentId } : {}),
            });
            if (selections.length === 1) return "custom";
            if (selections.length === 2) return "tools";
            return "pinnedIndicator";
          },
        },
        { setting: "show" },
      );

      assert.equal(selections.length, 3);
      assert.ok(selections[0]?.question.includes("Choose a preset"), `expected preset prompt, got: ${selections[0]?.question}`);
      assert.equal(selections[0]?.currentId, "default");
      assert.ok(selections[1]?.question.includes("Choose what to configure."), `expected category prompt, got: ${selections[1]?.question}`);
      assert.ok(selections[1]?.options.some((option) =>
        typeof option !== "string" && option.id === "tools" && option.label.includes("indicator + inspectable")));
      assert.ok(selections[2]?.question.includes("*Show: tools*"), `expected option prompt, got: ${selections[2]?.question}`);
      assert.equal(selections[2]?.currentId, "indicatorInspectable");
      assert.deepEqual(
        selections[2]?.options.map((option) => typeof option === "string" ? option : option.id),
        ["fullDetails", "indicatorInspectable", "pinnedIndicator", "hidden"],
      );
      assert.ok(result.includes("tools set to indicator in pinned status"), `expected set confirmation, got: ${result}`);

      const chat = await readRequiredChatConfig("cfg-show-picker-1");
      assert.deepEqual(chat.output_visibility, { tools: "pinnedIndicator" });
    });

    it("does not use a multi-select picker for show", async () => {
      await seedConfigChat("cfg-show-3");

      const result = await runChatSettingsCommand(
        {
          chatId: "cfg-show-3",
          rootDb: db,
          senderIds: ["u1"],
          selectMany: async () => {
            assert.fail("show should not use the legacy multi-select picker");
          },
        },
        { setting: "show" },
      );

      assert.ok(result.includes("*Categories*"), `expected show help, got: ${result}`);

      const chat = await readRequiredChatConfig("cfg-show-3");
      assert.deepEqual(chat.output_visibility, {});
    });

    it("rejects unknown show category commands with category guidance", async () => {
      await seedConfigChat("cfg-show-4");
      const result = await runChatSettingsCommand(
        { chatId: "cfg-show-4", rootDb: db, senderIds: ["u1"] },
        { setting: "show", value: "commands off" },
      );

      assert.ok(result.includes("show <category> <option>"), `expected command guidance, got: ${result}`);
      assert.ok(result.includes("*Presets*"), `expected preset guidance, got: ${result}`);
      assert.ok(result.includes("*Categories*"), `expected category guidance, got: ${result}`);

      const chat = await readRequiredChatConfig("cfg-show-4");
      assert.deepEqual(chat.output_visibility, {});
    });
  });

});

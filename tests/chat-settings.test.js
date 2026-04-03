import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTestDb } from "./helpers.js";
import config from "../config.js";

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
  /** @type {import("@electric-sql/pglite").PGlite} */
  let db;

  before(async () => {
    db = await createTestDb();
    await writeFakeCache();
  });

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

  describe("config metadata", () => {
    it("marks picker-backed settings in the registry", async () => {
      const service = await import("../actions/settings/chatSettings/_service.js");
      const enabled = service.getConfigKeyDefinition("enabled");
      const harness = service.getConfigKeyDefinition("harness");
      const prompt = service.getConfigKeyDefinition("prompt");
      const show = service.getConfigKeyDefinition("show");

      assert.ok(enabled?.picker?.options, "expected enabled picker options in metadata");
      assert.equal(Object.hasOwn(enabled ?? {}, "options"), false, "top-level options should be gone");
      assert.ok(harness?.picker, "expected harness picker metadata");
      assert.equal(prompt?.picker, undefined, "prompt should remain free-text");
      assert.equal(show?.setting, "output_visibility");
      assert.deepEqual(show?.flags?.map((flag) => flag.key), ["tools", "thinking", "changes"]);
      assert.ok(show?.multiPicker, "expected show multi-picker metadata");
    });
  });

  describe("chat_settings model via dispatch", () => {
    it("updates the model in the DB", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-1') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-1", rootDb: db },
        { setting: "model", value: "openai/gpt-4.1-mini" },
      );
      assert.ok(result.includes("openai/gpt-4.1-mini"));

      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-1'`;
      assert.equal(chat.model, "openai/gpt-4.1-mini");
    });

    it("reverts to default when given empty string", async () => {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('chat-set-2', 'some-model') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-2", rootDb: db },
        { setting: "model", value: "" },
      );
      assert.ok(result.includes("default"));

      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-2'`;
      assert.equal(chat.model, null);
    });

    it("rejects invalid model with suggestions", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-3') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-3", rootDb: db },
        { setting: "model", value: "nonexistent/fake-model" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));

      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-3'`;
      assert.equal(chat.model, null);
    });

    it("suggests close matches for partial model names", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-4') ON CONFLICT DO NOTHING`;

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
      await db.sql`INSERT INTO chats(chat_id, memory) VALUES ('mem-on-1', false) ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-on-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "on" },
      );
      assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);

      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'mem-on-1'`;
      assert.equal(chat.memory, true);
    });

    it("'off' disables memory", async () => {
      await db.sql`INSERT INTO chats(chat_id, memory) VALUES ('mem-off-1', true) ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-off-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "off" },
      );
      assert.ok(result.includes("disabled"), `expected 'disabled' in: ${result}`);

      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'mem-off-1'`;
      assert.equal(chat.memory, false);
    });

    it("'true' still works", async () => {
      await db.sql`INSERT INTO chats(chat_id, memory) VALUES ('mem-true-1', false) ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-true-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "true" },
      );
      assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);
    });

    it("throws on unrecognized boolean value", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('mem-bad-1') ON CONFLICT DO NOTHING`;

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
      await db.sql`INSERT INTO chats(chat_id) VALUES ('dbg-on-1') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "dbg-on-1", rootDb: db, senderIds: ["u1"] },
        { setting: "debug", value: "on" },
      );
      assert.ok(result.includes("Debug on"), `expected 'Debug on' in: ${result}`);

      const { rows: [chat] } = await db.sql`SELECT debug FROM chats WHERE chat_id = 'dbg-on-1'`;
      assert.equal(chat.debug, true, "debug should be true");
    });
  });

  describe("enabled setting accepts 'enabled'/'disabled'", () => {
    it("'enabled' enables the bot", async () => {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('en-1', false) ON CONFLICT DO NOTHING`;

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

        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'en-1'`;
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });

    it("'disabled' disables the bot", async () => {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('en-2', true) ON CONFLICT DO NOTHING`;

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

        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'en-2'`;
        assert.equal(chat.is_enabled, false);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });
  });

  describe("mobile-first config command semantics", () => {
    it("shows the resolved workspace folder path when folder uses the workspace default", async () => {
      const { repoRoot, worktreePath } = await createRepoWithWorkspaceFixture();
      const { initStore } = await import("../store.js");
      const store = await initStore(db);
      await store.createProject({
        name: `settings-repo-${Date.now()}`,
        rootPath: repoRoot,
        defaultBaseBranch: "master",
      });
      await db.sql`
        INSERT INTO chats(chat_id, harness_cwd)
        VALUES ('cfg-folder-workspace', NULL)
        ON CONFLICT DO NOTHING
      `;
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

      const folderResult = await action.action_fn(
        { chatId: "cfg-folder-workspace", rootDb: db, senderIds: ["u1"] },
        { setting: "folder" },
      );
      assert.ok(folderResult.includes(worktreePath), `expected resolved worktree path, got: ${folderResult}`);
      assert.ok(!folderResult.includes("workspace worktree"), `expected plain path only, got: ${folderResult}`);

      const infoResult = await action.action_fn(
        { chatId: "cfg-folder-workspace", rootDb: db, senderIds: ["u1"] },
        { setting: "" },
      );
      assert.ok(infoResult.includes(worktreePath), `expected settings summary to include worktree path, got: ${infoResult}`);
      assert.ok(!infoResult.includes("workspace worktree"), `expected plain path only, got: ${infoResult}`);
    });

    it("shows help text for a friendly key", async () => {
      await db.sql`INSERT INTO chats(chat_id, harness_cwd) VALUES ('cfg-help-1', '/tmp') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-help-1", rootDb: db, senderIds: ["u1"] },
        { setting: "folder" },
      );

      assert.ok(result.includes("folder"), `expected setting title, got: ${result}`);
      assert.ok(result.includes("/tmp"), `expected current value, got: ${result}`);
      assert.ok(result.toLowerCase().includes("what it does"), `expected description section, got: ${result}`);
      assert.ok(result.toLowerCase().includes("examples"), `expected examples section, got: ${result}`);
    });

    it("formats harness help as sectioned bullet points", async () => {
      await db.sql`INSERT INTO chats(chat_id, harness) VALUES ('cfg-help-2', 'codex') ON CONFLICT DO NOTHING`;

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
      await db.sql`INSERT INTO chats(chat_id, harness) VALUES ('cfg-help-3', 'codex') ON CONFLICT DO NOTHING`;

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
      await db.sql`INSERT INTO chats(chat_id, harness_cwd) VALUES ('cfg-reset-1', '/tmp') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-reset-1", rootDb: db, senderIds: ["u1"] },
        { setting: "reset", value: "folder" },
      );

      assert.ok(result.toLowerCase().includes("default") || result.toLowerCase().includes("workspace"), `expected reset confirmation, got: ${result}`);

      const { rows: [chat] } = await db.sql`SELECT harness_cwd FROM chats WHERE chat_id = 'cfg-reset-1'`;
      assert.equal(chat.harness_cwd, null);
    });

    it("describes grouped visibility controls with per-flag defaults", async () => {
      await db.sql`
        INSERT INTO chats(chat_id, output_visibility)
        VALUES ('cfg-show-1', '{}'::jsonb)
        ON CONFLICT DO NOTHING
      `;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-show-1", rootDb: db, senderIds: ["u1"] },
        { setting: "show" },
      );

      assert.ok(result.includes("*Show*"), `expected setting title, got: ${result}`);
      assert.ok(result.includes("- Current: tools off, thinking on, changes on"), `expected current summary, got: ${result}`);
      assert.ok(result.includes("*Controls*"), `expected controls section, got: ${result}`);
      assert.ok(result.includes("- tools"), `expected tools flag, got: ${result}`);
      assert.ok(result.includes("- thinking"), `expected thinking flag, got: ${result}`);
      assert.ok(result.includes("- changes"), `expected changes flag, got: ${result}`);
    });

    it("does not accept text subcommands for show anymore", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cfg-show-2') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "cfg-show-2", rootDb: db, senderIds: ["u1"] },
        { setting: "show", value: "commands off" },
      );

      assert.ok(result.includes("Use `!s show`"), `expected picker guidance, got: ${result}`);
      assert.ok(result.includes("!s reset show"), `expected reset guidance, got: ${result}`);

      const rows = await db.sql`SELECT output_visibility FROM chats WHERE chat_id = 'cfg-show-2'`;
      assert.deepEqual(rows.rows[0]?.output_visibility, {});
    });

    it("uses a multi-select picker for show and stores the selected outputs", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cfg-show-3') ON CONFLICT DO NOTHING`;

      /** @type {string | null} */
      let promptText = null;
      /** @type {SelectOption[] | null} */
      let pickerOptions = null;
      /** @type {SelectManyConfig | null} */
      let pickerConfig = null;

      const mod = await import("../actions/settings/chatSettings/index.js");
      const action = mod.default;
      const result = await action.action_fn(
        {
          chatId: "cfg-show-3",
          rootDb: db,
          senderIds: ["u1"],
          selectMany: async (question, options, config) => {
            promptText = question;
            pickerOptions = options;
            pickerConfig = config ?? null;
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
          { id: "none", label: "⚪ Hide all extras" },
        ],
      );
      assert.deepEqual(pickerConfig, {
        deleteOnSelect: true,
        currentIds: [],
      });
      assert.ok(result.includes("Show tool activity"), `expected show summary, got: ${result}`);
      assert.ok(result.includes("Hide file changes"), `expected hide summary, got: ${result}`);
      assert.ok(!result.includes("thinking"), `did not expect unchanged thinking summary, got: ${result}`);

      const rows = await db.sql`SELECT output_visibility FROM chats WHERE chat_id = 'cfg-show-3'`;
      assert.deepEqual(rows.rows[0]?.output_visibility, {
        tools: true,
        changes: false,
      });
    });

    it("treats an empty multi-select result as a no-op for show", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cfg-show-4') ON CONFLICT DO NOTHING`;

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

      const rows = await db.sql`SELECT output_visibility FROM chats WHERE chat_id = 'cfg-show-4'`;
      assert.deepEqual(rows.rows[0]?.output_visibility, {});
    });
  });

});

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { initStore, getChatOrThrow } from "../store.js";
import { createTestDb } from "./helpers.js";

describe("store with injected DB", () => {
  /** @type {import("@electric-sql/pglite").PGlite} */
  let db;
  /** @type {Awaited<ReturnType<typeof initStore>>} */
  let store;

  before(async () => {
    db = await createTestDb();
    store = await initStore(db);
  });

  it("does not create module-owned tables (reminders, media_to_text_cache)", async () => {
    // Use a fresh DB to avoid pollution from other test files sharing createTestDb()
    const freshDb = new PGlite("memory://", { extensions: { vector } });
    await initStore(freshDb);
    const { rows } = await freshDb.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    const tableNames = rows.map(r => r.table_name);
    assert.ok(!tableNames.includes("reminders"), `initStore() should not create 'reminders' table, got: ${tableNames}`);
    assert.ok(!tableNames.includes("media_to_text_cache"), `initStore() should not create 'media_to_text_cache' table, got: ${tableNames}`);
  });

  it("memories table is created by initStore", async () => {
    const freshDb = new PGlite("memory://", { extensions: { vector } });
    await initStore(freshDb);
    const { rows } = await freshDb.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'memories'
    `;
    assert.equal(rows.length, 1, "memories table should exist");
  });

  describe("createChat / getChat", () => {
    it("new chat has model_roles defaulting to empty object", async () => {
      await store.createChat("store-model-roles-1");
      const chat = await store.getChat("store-model-roles-1");
      assert.ok(chat);
      assert.deepEqual(chat.model_roles, {});
    });

  });

  describe("workspace persistence", () => {
    it("stores and updates workspace domain state without exposing WhatsApp surface fields", async () => {
      await store.createChat("store-workspace-chat");
      const repo = await store.createProject({
        name: `store-workspace-repo-${Date.now()}`,
        rootPath: `/repo/store-${Date.now()}`,
        defaultBaseBranch: "master",
      });
      await store.saveWhatsAppWorkspacePresentation({
        projectId: repo.project_id,
        workspaceId: "workspace-store-1",
        workspaceChatId: "store-workspace-chat",
        workspaceChatSubject: "[payments] Original Group",
      });
      const workspace = await store.createWorkspace({
        workspaceId: "workspace-store-1",
        projectId: repo.project_id,
        name: "payments",
        branch: "payments",
        baseBranch: "master",
        worktreePath: "/repo/store/payments",
      });

      assert.deepEqual(workspace, {
        workspace_id: "workspace-store-1",
        project_id: repo.project_id,
        name: "payments",
        branch: "payments",
        base_branch: "master",
        worktree_path: "/repo/store/payments",
        status: "ready",
        last_test_status: "not_run",
        last_commit_oid: null,
        conflicted_files: [],
        archived_at: null,
        timestamp: workspace.timestamp,
      });

      const reset = await store.resetWorkspace({
        workspaceId: workspace.workspace_id,
        branch: "payments",
        baseBranch: "main",
        worktreePath: "/repo/store/payments-v2",
      });

      assert.equal(reset.base_branch, "main");
      assert.equal(reset.worktree_path, "/repo/store/payments-v2");
    });
  });

  describe("WhatsApp presentation mappings", () => {
    it("stores repo and workspace presentation state separately from the workspace row", async () => {
      await store.createChat("wa-workspace-chat");
      const repo = await store.createProject({
        name: `store-whatsapp-repo-${Date.now()}`,
        rootPath: `/repo/whatsapp-${Date.now()}`,
        defaultBaseBranch: "master",
      });

      await store.upsertWhatsAppProjectPresentation({
        projectId: repo.project_id,
        topologyKind: "groups",
      });

      await store.saveWhatsAppWorkspacePresentation({
        projectId: repo.project_id,
        workspaceId: "ws-presentation-1",
        workspaceChatId: "wa-workspace-chat",
        workspaceChatSubject: "[payments] Original Group",
      });

      const repoPresentation = await store.getWhatsAppProjectPresentation(repo.project_id);
      const workspacePresentation = await store.getWhatsAppWorkspacePresentation("ws-presentation-1");
      const byChat = await store.getWhatsAppWorkspacePresentationByChat("wa-workspace-chat");

      assert.deepEqual(repoPresentation && {
        project_id: repoPresentation.project_id,
        topology_kind: repoPresentation.topology_kind,
        community_chat_id: repoPresentation.community_chat_id,
        main_workspace_id: repoPresentation.main_workspace_id,
      }, {
        project_id: repo.project_id,
        topology_kind: "groups",
        community_chat_id: null,
        main_workspace_id: null,
      });
      assert.deepEqual(workspacePresentation && {
        workspace_id: workspacePresentation.workspace_id,
        project_id: workspacePresentation.project_id,
        workspace_chat_id: workspacePresentation.workspace_chat_id,
        workspace_chat_subject: workspacePresentation.workspace_chat_subject,
        role: workspacePresentation.role,
        linked_community_chat_id: workspacePresentation.linked_community_chat_id,
      }, {
        workspace_id: "ws-presentation-1",
        project_id: repo.project_id,
        workspace_chat_id: "wa-workspace-chat",
        workspace_chat_subject: "[payments] Original Group",
        role: "workspace",
        linked_community_chat_id: null,
      });
      assert.deepEqual(byChat && {
        workspace_id: byChat.workspace_id,
        project_id: byChat.project_id,
        workspace_chat_id: byChat.workspace_chat_id,
        workspace_chat_subject: byChat.workspace_chat_subject,
      }, {
        workspace_id: "ws-presentation-1",
        project_id: repo.project_id,
        workspace_chat_id: "wa-workspace-chat",
        workspace_chat_subject: "[payments] Original Group",
      });
    });
  });

  describe("chat bindings", () => {
    it("stores new control-chat bindings as project bindings", async () => {
      const chatId = `binding-project-${Date.now()}`;
      await store.createChat(chatId);
      const project = await store.createProject({
        name: `binding-project-${Date.now()}`,
        rootPath: `/repo/binding-${Date.now()}`,
        defaultBaseBranch: "main",
        controlChatId: chatId,
      });

      const binding = await store.getChatBinding(chatId);

      assert.deepEqual(binding && {
        binding_kind: binding.binding_kind,
        project_id: binding.project_id,
        workspace_id: binding.workspace_id,
      }, {
        binding_kind: "project",
        project_id: project.project_id,
        workspace_id: null,
      });
    });

    it("normalizes legacy repo bindings to project bindings when read", async () => {
      const chatId = `legacy-binding-${Date.now()}`;
      const projectId = `legacy-project-${Date.now()}`;
      await store.createChat(chatId);
      await db.sql`
        INSERT INTO projects (project_id, name, root_path, default_base_branch, control_chat_id)
        VALUES (${projectId}, ${`legacy-project-${Date.now()}`}, ${`/repo/legacy-${Date.now()}`}, 'main', NULL)
      `;
      await db.sql`
        INSERT INTO chat_bindings (chat_id, binding_kind, project_id, workspace_id)
        VALUES (${chatId}, 'repo', ${projectId}, NULL)
      `;

      const binding = await store.getChatBinding(chatId);

      assert.equal(binding?.binding_kind, "project");
      assert.equal(binding?.project_id, projectId);
      assert.equal(binding?.workspace_id, null);
    });

    it("migrates legacy repo schema tables and ids to the project schema", async () => {
      const freshDb = new PGlite("memory://", { extensions: { vector } });
      const projectId = `legacy-project-${Date.now()}`;
      const workspaceId = `legacy-workspace-${Date.now()}`;
      await freshDb.sql`
        CREATE TABLE chats (
          chat_id VARCHAR(50) PRIMARY KEY,
          is_enabled BOOLEAN DEFAULT FALSE,
          system_prompt TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await freshDb.sql`
        CREATE TABLE repos (
          repo_id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          root_path TEXT NOT NULL,
          default_base_branch TEXT NOT NULL,
          control_chat_id VARCHAR(50),
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await freshDb.sql`
        CREATE TABLE workspaces (
          workspace_id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          name TEXT NOT NULL,
          branch TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          workspace_chat_id VARCHAR(50) NOT NULL,
          workspace_chat_subject TEXT,
          last_test_status TEXT NOT NULL DEFAULT 'not_run',
          last_commit_oid TEXT,
          conflicted_files JSONB NOT NULL DEFAULT '[]',
          archived_at TIMESTAMP,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await freshDb.sql`
        CREATE TABLE chat_bindings (
          chat_id VARCHAR(50) PRIMARY KEY,
          binding_kind TEXT NOT NULL,
          repo_id TEXT,
          workspace_id TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await freshDb.sql`
        CREATE TABLE whatsapp_repo_presentations (
          repo_id TEXT PRIMARY KEY,
          topology_kind TEXT NOT NULL DEFAULT 'groups',
          community_chat_id VARCHAR(50),
          main_workspace_id TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await freshDb.sql`
        CREATE TABLE whatsapp_workspace_presentations (
          workspace_id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          workspace_chat_id VARCHAR(50) NOT NULL,
          workspace_chat_subject TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'workspace',
          linked_community_chat_id VARCHAR(50),
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await freshDb.sql`
        INSERT INTO chats(chat_id) VALUES ('legacy-project-chat'), ('legacy-workspace-chat')
      `;
      await freshDb.sql`
        INSERT INTO repos (repo_id, name, root_path, default_base_branch, control_chat_id)
        VALUES (${projectId}, 'legacy-project', '/repo/legacy', 'main', 'legacy-project-chat')
      `;
      await freshDb.sql`
        INSERT INTO workspaces (
          workspace_id, repo_id, name, branch, base_branch, worktree_path, status, workspace_chat_id, workspace_chat_subject
        )
        VALUES (
          ${workspaceId}, ${projectId}, 'payments', 'payments', 'main', '/repo/legacy/.madabot/worktrees/payments', 'ready',
          'legacy-workspace-chat', 'payments'
        )
      `;
      await freshDb.sql`
        INSERT INTO chat_bindings (chat_id, binding_kind, repo_id, workspace_id)
        VALUES ('legacy-project-chat', 'repo', ${projectId}, NULL)
      `;
      await freshDb.sql`
        INSERT INTO whatsapp_repo_presentations (repo_id, topology_kind, community_chat_id, main_workspace_id)
        VALUES (${projectId}, 'groups', NULL, ${workspaceId})
      `;
      await freshDb.sql`
        INSERT INTO whatsapp_workspace_presentations (
          workspace_id, repo_id, workspace_chat_id, workspace_chat_subject, role, linked_community_chat_id
        )
        VALUES (${workspaceId}, ${projectId}, 'legacy-workspace-chat', 'payments', 'main', NULL)
      `;

      const migratedStore = await initStore(freshDb);
      const tables = await freshDb.sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('repos', 'projects', 'whatsapp_repo_presentations', 'whatsapp_project_presentations')
        ORDER BY table_name
      `;
      const project = await migratedStore.getProject(projectId);
      const workspace = await migratedStore.getWorkspace(workspaceId);
      const binding = await migratedStore.getChatBinding("legacy-project-chat");
      const projectPresentation = await migratedStore.getWhatsAppProjectPresentation(projectId);
      const workspacePresentation = await migratedStore.getWhatsAppWorkspacePresentation(workspaceId);

      assert.deepEqual(tables.rows.map((row) => row.table_name), ["projects", "whatsapp_project_presentations"]);
      assert.equal(project?.project_id, projectId);
      assert.equal(project?.control_chat_id, "legacy-project-chat");
      assert.equal(workspace?.project_id, projectId);
      assert.equal(binding?.binding_kind, "project");
      assert.equal(binding?.project_id, projectId);
      assert.equal(projectPresentation?.project_id, projectId);
      assert.equal(projectPresentation?.main_workspace_id, workspaceId);
      assert.equal(workspacePresentation?.project_id, projectId);
    });
  });

  describe("getChatOrThrow", () => {
    it("returns the ChatRow for an existing chat", async () => {
      await store.createChat("assert-exists-1");
      const chat = await getChatOrThrow(db, "assert-exists-1");
      assert.equal(chat.chat_id, "assert-exists-1");
      assert.equal(typeof chat.is_enabled, "boolean");
    });

    it("throws for a nonexistent chat", async () => {
      await assert.rejects(
        () => getChatOrThrow(db, "no-such-chat"),
        { message: "Chat no-such-chat does not exist." }
      );
    });

    it("migrates legacy output visibility keys to the unified tools flag", async () => {
      const freshDb = new PGlite("memory://", { extensions: { vector } });
      await initStore(freshDb);
      await freshDb.sql`
        INSERT INTO chats(chat_id, output_visibility)
        VALUES (
          'legacy-output-visibility-1',
          '{"commands":true,"tools":false,"thinking":true,"changes":false}'::jsonb
        )
      `;

      await initStore(freshDb);

      const { rows: [chat] } = await freshDb.sql`
        SELECT output_visibility
        FROM chats
        WHERE chat_id = 'legacy-output-visibility-1'
      `;

      assert.deepEqual(chat.output_visibility, {
        changes: false,
      });
    });
  });

  describe("addMessage / getMessages", () => {
    it("returns messages in descending timestamp order", async () => {
      await store.createChat("msg-test-2");

      /** @type {UserMessage} */
      const msg1 = { role: "user", content: [{ type: "text", text: "first" }] };
      /** @type {UserMessage} */
      const msg2 = { role: "user", content: [{ type: "text", text: "second" }] };
      await store.addMessage("msg-test-2", msg1, ["s1"]);
      await store.addMessage("msg-test-2", msg2, ["s1"]);

      const messages = await store.getMessages("msg-test-2");
      assert.equal(messages.length, 2);
      // Newest first (DESC order)
      assert.equal(messages[0].message_data.content[0].text, "second");
      assert.equal(messages[1].message_data.content[0].text, "first");
    });

    it("respects the limit parameter", async () => {
      await store.createChat("msg-test-3");

      for (let i = 0; i < 5; i++) {
        /** @type {UserMessage} */
        const msg = { role: "user", content: [{ type: "text", text: `msg ${i}` }] };
        await store.addMessage("msg-test-3", msg, ["s1"]);
      }

      const messages = await store.getMessages("msg-test-3", undefined, 2);
      assert.equal(messages.length, 2);
    });

    it("excludes messages older than 8h by default", async () => {
      await store.createChat("msg-test-time-1");

      // Insert a message timestamped 10 hours ago
      const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('msg-test-time-1', 's1', '{"role":"user","content":[{"type":"text","text":"old msg"}]}', ${tenHoursAgo})`;

      const messages = await store.getMessages("msg-test-time-1");
      assert.equal(messages.length, 0, "message older than 8h should be excluded");
    });

    it("includes messages within the 8h default window", async () => {
      await store.createChat("msg-test-time-2");

      // Insert a message timestamped 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('msg-test-time-2', 's1', '{"role":"user","content":[{"type":"text","text":"recent msg"}]}', ${twoHoursAgo})`;

      const messages = await store.getMessages("msg-test-time-2");
      assert.equal(messages.length, 1, "message within 8h should be included");
      assert.equal(messages[0].message_data.content[0].text, "recent msg");
    });

    it("caps results at 300 by default", async () => {
      await store.createChat("msg-test-time-3");

      // Insert 305 messages all within the 8h window
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const values = Array.from({ length: 305 }, (_, i) =>
        `('msg-test-time-3', 's1', '{"role":"user","content":[{"type":"text","text":"m${i}"}]}', '${oneHourAgo}')`
      ).join(",");
      await db.exec(`INSERT INTO messages(chat_id, sender_id, message_data, timestamp) VALUES ${values}`);

      const messages = await store.getMessages("msg-test-time-3");
      assert.equal(messages.length, 300, "should cap at 300 messages");
    });

    it("allows custom since to override the default 8h window", async () => {
      await store.createChat("msg-test-time-4");

      // Insert a message 10 hours ago (outside default 8h window)
      const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('msg-test-time-4', 's1', '{"role":"user","content":[{"type":"text","text":"old but wanted"}]}', ${tenHoursAgo})`;

      // Use custom since = 12 hours ago to include it
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const messages = await store.getMessages("msg-test-time-4", twelveHoursAgo);
      assert.equal(messages.length, 1, "custom since should override default 8h");
      assert.equal(messages[0].message_data.content[0].text, "old but wanted");
    });

    it("excludes cleared messages by default", async () => {
      await store.createChat("msg-test-cleared");

      /** @type {UserMessage} */
      const msg1 = { role: "user", content: [{ type: "text", text: "before clear" }] };
      /** @type {UserMessage} */
      const msg2 = { role: "user", content: [{ type: "text", text: "after clear" }] };
      await store.addMessage("msg-test-cleared", msg1, ["s1"]);
      // Mark existing messages as cleared
      await db.sql`UPDATE messages SET cleared_at = NOW() WHERE chat_id = 'msg-test-cleared'`;
      await store.addMessage("msg-test-cleared", msg2, ["s1"]);

      const messages = await store.getMessages("msg-test-cleared");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message_data.content[0].text, "after clear");
    });
  });

  describe("updateToolMessage", () => {
    it("updates the correct tool message by JSONB lookup", async () => {
      await store.createChat("msg-test-update-tool");

      /** @type {ToolMessage} */
      const stub = {
        role: "tool",
        tool_id: "call_xyz",
        content: [{ type: "text", text: "[executing searchWeb...]" }],
      };
      await store.addMessage("msg-test-update-tool", stub, ["bot"]);

      /** @type {ToolMessage} */
      const updated = {
        role: "tool",
        tool_id: "call_xyz",
        content: [{ type: "text", text: "real result" }],
      };
      const result = await store.updateToolMessage("msg-test-update-tool", "call_xyz", updated);

      assert.ok(result, "should return the updated row");
      assert.equal(result.message_data.role, "tool");
      assert.equal(/** @type {ToolMessage} */ (result.message_data).tool_id, "call_xyz");
      assert.equal(result.message_data.content[0].text, "real result");

      // Verify via getMessages
      const messages = await store.getMessages("msg-test-update-tool");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message_data.content[0].text, "real result");
    });

    it("returns null when no matching tool message exists", async () => {
      await store.createChat("msg-test-update-miss");

      /** @type {ToolMessage} */
      const updated = {
        role: "tool",
        tool_id: "nonexistent",
        content: [{ type: "text", text: "nope" }],
      };
      const result = await store.updateToolMessage("msg-test-update-miss", "nonexistent", updated);
      assert.equal(result, null);
    });

    it("does not update tool messages in a different chat", async () => {
      await store.createChat("msg-test-update-a");
      await store.createChat("msg-test-update-b");

      /** @type {ToolMessage} */
      const stub = {
        role: "tool",
        tool_id: "call_shared",
        content: [{ type: "text", text: "[executing...]" }],
      };
      await store.addMessage("msg-test-update-a", stub, ["bot"]);

      /** @type {ToolMessage} */
      const updated = {
        role: "tool",
        tool_id: "call_shared",
        content: [{ type: "text", text: "wrong chat" }],
      };
      const result = await store.updateToolMessage("msg-test-update-b", "call_shared", updated);
      assert.equal(result, null);

      // Original should be unchanged
      const messages = await store.getMessages("msg-test-update-a");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message_data.content[0].text, "[executing...]");
    });
  });

  describe("harness session persistence", () => {
    it("saves and clears the current harness session", async () => {
      await store.createChat("harness-session-1");

      await store.saveHarnessSession("harness-session-1", { id: "sess-123", kind: "claude-sdk" });
      let chat = await store.getChat("harness-session-1");
      assert.equal(chat.harness_session_id, "sess-123");
      assert.equal(chat.harness_session_kind, "claude-sdk");

      await store.saveHarnessSession("harness-session-1", null);
      chat = await store.getChat("harness-session-1");
      assert.equal(chat.harness_session_id, null);
      assert.equal(chat.harness_session_kind, null);
    });

    it("archives and restores harness sessions generically", async () => {
      await store.createChat("harness-session-2");

      await store.saveHarnessSession("harness-session-2", { id: "sess-a", kind: "claude-sdk" });
      await store.archiveHarnessSession("harness-session-2", { title: "Debugging payment sync" });

      let history = await store.getHarnessSessionHistory("harness-session-2");
      assert.equal(history.length, 1);
      assert.equal(history[0].id, "sess-a");
      assert.equal(history[0].kind, "claude-sdk");
      assert.equal(history[0].title, "Debugging payment sync");

      await store.saveHarnessSession("harness-session-2", { id: "sess-b", kind: "codex" });
      await store.archiveHarnessSession("harness-session-2");

      history = await store.getHarnessSessionHistory("harness-session-2");
      assert.equal(history.length, 2);
      assert.equal(history[1].id, "sess-b");
      assert.equal(history[1].kind, "codex");

      const restored = await store.restoreHarnessSession("harness-session-2", 0);
      assert.ok(restored);
      assert.equal(restored.id, "sess-b");
      assert.equal(restored.kind, "codex");
      assert.equal(restored.title, null);

      const chat = await store.getChat("harness-session-2");
      assert.equal(chat.harness_session_id, "sess-b");
      assert.equal(chat.harness_session_kind, "codex");
      assert.equal(chat.harness_session_history.length, 1);
      assert.equal(chat.harness_session_history[0].id, "sess-a");
      assert.equal(chat.harness_session_history[0].title, "Debugging payment sync");
    });

    it("pushes and pops the harness fork stack", async () => {
      await store.createChat("harness-fork-stack-1");

      await store.pushHarnessForkStack("harness-fork-stack-1", { id: "sess-parent", kind: "codex", label: "Parent thread" });
      await store.pushHarnessForkStack("harness-fork-stack-1", { id: "sess-grandparent", kind: "codex", label: null });

      let stack = await store.getHarnessForkStack("harness-fork-stack-1");
      assert.deepEqual(stack, [
        { id: "sess-parent", kind: "codex", label: "Parent thread" },
        { id: "sess-grandparent", kind: "codex", label: null },
      ]);

      const popped = await store.popHarnessForkStack("harness-fork-stack-1");
      assert.deepEqual(popped, { id: "sess-grandparent", kind: "codex", label: null });

      stack = await store.getHarnessForkStack("harness-fork-stack-1");
      assert.deepEqual(stack, [
        { id: "sess-parent", kind: "codex", label: "Parent thread" },
      ]);
    });
  });
});

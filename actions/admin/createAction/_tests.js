import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../../../config.js";
import {
  ensureChatActionsSchema,
  saveChatAction,
  readChatAction,
  deleteChatAction,
} from "../../../actions.js";

/** @type {ActionDbTestFn[]} */
export default [
    async function global_scope_rejects_non_master(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const context = {
          senderIds: ["non-master-user"],
          confirm: async () => true,
        };
        await assert.rejects(
          async () => action_fn(context, { file_name: "testGlobalPerm", code: "// code", scope: "global" }),
          { message: /requires master/ },
        );
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function chat_scope_stores_in_db(action_fn, db) {
      await ensureChatActionsSchema(db);
      const context = {
        db,
        getIsAdmin: async () => true,
        confirm: async () => true,
      };
      const result = await action_fn(context, {
        file_name: "testChatAction",
        code: '// chat action code',
        proposed_tests: "- test: basic test",
        scope: "chat",
      });
      assert.ok(typeof result === "string");
      assert.ok(result.includes("testChatAction"), `Expected name in result, got: ${result}`);
      // Verify stored in DB, not filesystem
      const code = await readChatAction(db, "testChatAction");
      assert.equal(code, "// chat action code");
      const filePath = path.join(process.cwd(), "actions", "testChatAction.js");
      await assert.rejects(() => fs.access(filePath), "File should NOT exist on filesystem");
      // Cleanup
      await deleteChatAction(db, "testChatAction");
    },
    async function chat_scope_reads_from_db(action_fn, db) {
      await ensureChatActionsSchema(db);
      await saveChatAction(db, "testChatRead", "// chat read content");
      const context = {
        db,
        getIsAdmin: async () => true,
      };
      const result = await action_fn(context, {
        file_name: "testChatRead",
        mode: "read",
        scope: "chat",
      });
      assert.ok(typeof result === "string");
      assert.ok(result.includes("// chat read content"), `Expected code content, got: ${result}`);
      // Cleanup
      await deleteChatAction(db, "testChatRead");
    },
    async function chat_scope_deletes_from_db(action_fn, db) {
      await ensureChatActionsSchema(db);
      await saveChatAction(db, "testChatDelete", "// to delete");
      const context = {
        db,
        getIsAdmin: async () => true,
        confirm: async () => true,
      };
      const result = await action_fn(context, {
        file_name: "testChatDelete",
        mode: "delete",
        scope: "chat",
      });
      assert.ok(typeof result === "string");
      assert.ok(result.toLowerCase().includes("deleted"), `Expected deleted message, got: ${result}`);
      const code = await readChatAction(db, "testChatDelete");
      assert.equal(code, null);
    },
    async function chat_scope_rejects_non_admin_in_group(action_fn, db) {
      await ensureChatActionsSchema(db);
      const context = {
        db,
        chatId: "group-chat",
        getIsAdmin: async () => false,
        confirm: async () => true,
      };
      await assert.rejects(
        async () => action_fn(context, { file_name: "testChatNonAdmin", code: "// code", scope: "chat" }),
        { message: /admin/ },
      );
    },
    async function rejects_invalid_file_name(action_fn, _db) {
      const result = await action_fn({}, { file_name: "../evil", code: "// code" });
      assert.ok(typeof result === "string");
      assert.ok(result.includes("alphanumeric camelCase"), `Expected validation message, got: ${result}`);
    },
    async function rejects_on_user_denial(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        let confirmCalled = false;
        const context = {
          senderIds: ["master-user"],
          confirm: async () => { confirmCalled = true; return false; },
        };
        const result = await action_fn(context, {
          file_name: "testDenied",
          code: "// denied code",
          proposed_tests: "- checks_something: verifies basic behavior",
        });
        assert.ok(confirmCalled, "confirm should have been called");
        assert.ok(typeof result === "string");
        assert.ok(result.toLowerCase().includes("revise"), `Expected revision message, got: ${result}`);
        // Verify file was NOT written
        const filePath = path.join(process.cwd(), "actions", "testDenied.js");
        await assert.rejects(() => fs.access(filePath), "File should not exist");
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function shows_proposed_tests_in_confirm(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        /** @type {string} */
        let capturedMessage = "";
        const context = {
          senderIds: ["master-user"],
          confirm: async (/** @type {string} */ msg) => { capturedMessage = msg; return true; },
        };
        const filePath = path.join(process.cwd(), "actions", "testConfirmMsg.js");
        try {
          await action_fn(context, {
            file_name: "testConfirmMsg",
            code: "// confirm msg code",
            proposed_tests: "- validates_input: checks required fields\n- handles_error: returns error on failure",
          });
          assert.ok(capturedMessage.includes("validates_input"), `Confirm message should contain proposed test name, got: ${capturedMessage}`);
          assert.ok(capturedMessage.includes("handles_error"), `Confirm message should contain second test name, got: ${capturedMessage}`);
        } finally {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function reads_existing_action(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const filePath = path.join(process.cwd(), "actions", "testReadTarget.js");
        try {
          await fs.writeFile(filePath, "// read target content", "utf-8");
          const context = { senderIds: ["master-user"], confirm: async () => true };
          const result = await action_fn(context, {
            file_name: "testReadTarget",
            mode: "read",
          });
          assert.ok(typeof result === "string");
          assert.ok(result.includes("// read target content"), `Expected file contents, got: ${result}`);
        } finally {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function edit_rejects_nonexistent(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const result = await action_fn({ senderIds: ["master-user"] }, {
          file_name: "testNonexistentEdit",
          mode: "edit",
          code: "// edit code",
          proposed_tests: "- test: checks something",
        });
        assert.ok(typeof result === "string");
        assert.ok(result.toLowerCase().includes("create"), `Expected suggestion to use create, got: ${result}`);
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function create_rejects_existing(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const filePath = path.join(process.cwd(), "actions", "testExistingCreate.js");
        try {
          await fs.writeFile(filePath, "// existing", "utf-8");
          const result = await action_fn({ senderIds: ["master-user"] }, {
            file_name: "testExistingCreate",
            mode: "create",
            code: "// new code",
            proposed_tests: "- test: checks something",
          });
          assert.ok(typeof result === "string");
          assert.ok(result.toLowerCase().includes("edit"), `Expected suggestion to use edit, got: ${result}`);
        } finally {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function writes_file_on_confirmation(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const context = {
          senderIds: ["master-user"],
          confirm: async () => true,
        };
        const filePath = path.join(process.cwd(), "actions", "testConfirmWrite.js");
        try {
          const result = await action_fn(context, {
            file_name: "testConfirmWrite",
            code: "// confirmed write",
            proposed_tests: "- basic_test: verifies something",
          });
          assert.ok(result.includes("testConfirmWrite"), `Should confirm creation, got: ${result}`);
          const content = await fs.readFile(filePath, "utf-8");
          assert.equal(content, "// confirmed write");
        } finally {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        config.MASTER_IDs = saved;
      }
    },
];

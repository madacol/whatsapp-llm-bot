import assert from "node:assert/strict";
import { getChatOrThrow } from "../../store.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_optional_action",
  command: "set action",
  description: "Enable or disable an optional (opt-in) action for this chat.",
  parameters: {
    type: "object",
    properties: {
      action_name: {
        type: "string",
        description: "Name of the opt-in action to enable or disable",
      },
      enabled: {
        type: "boolean",
        description: "true to enable, false to disable",
      },
    },
    required: ["action_name", "enabled"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function enables_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('soa-1') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => [
        { name: "test_opt", optIn: true },
      ];
      const result = await action_fn(
        { chatId: "soa-1", rootDb: db, getActions: mockGetActions },
        { action_name: "test_opt", enabled: "true" },
      );
      assert.ok(result.includes("enabled"));
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'soa-1'`;
      const actions = chat.enabled_actions;
      assert.ok(actions.includes("test_opt"));
    },
    async function disables_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('soa-2', '["test_opt"]'::jsonb) ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => [
        { name: "test_opt", optIn: true },
      ];
      const result = await action_fn(
        { chatId: "soa-2", rootDb: db, getActions: mockGetActions },
        { action_name: "test_opt", enabled: "false" },
      );
      assert.ok(result.includes("disabled"));
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'soa-2'`;
      const actions = chat.enabled_actions;
      assert.ok(!actions.includes("test_opt"));
    },
    async function rejects_non_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('soa-3') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => [
        { name: "regular_action" },
      ];
      const result = await action_fn(
        { chatId: "soa-3", rootDb: db, getActions: mockGetActions },
        { action_name: "regular_action", enabled: "true" },
      );
      assert.ok(result.includes("not an opt-in action"));
    },
    async function rejects_unknown_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('soa-4') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => /** @type {Action[]} */ ([]);
      const result = await action_fn(
        { chatId: "soa-4", rootDb: db, getActions: mockGetActions },
        { action_name: "nonexistent", enabled: "true" },
      );
      assert.ok(result.includes("not found"));
    },
    async function does_not_duplicate_on_double_enable(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('soa-5', '["test_opt"]'::jsonb) ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => [
        { name: "test_opt", optIn: true },
      ];
      await action_fn(
        { chatId: "soa-5", rootDb: db, getActions: mockGetActions },
        { action_name: "test_opt", enabled: "true" },
      );
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'soa-5'`;
      const actions = chat.enabled_actions;
      const count = actions.filter(/** @param {string} a */ (a) => a === "test_opt").length;
      assert.equal(count, 1);
    },
  ],
  action_fn: async function ({ chatId, rootDb, getActions }, { action_name, enabled }) {
    await getChatOrThrow(rootDb, chatId);

    const allActions = await getActions();
    const targetAction = allActions.find((a) => a.name === action_name);
    if (!targetAction) {
      return `Action \`${action_name}\` not found.`;
    }
    if (!targetAction.optIn) {
      return `Action \`${action_name}\` is not an opt-in action.`;
    }

    const value = typeof enabled === "boolean" ? enabled : String(enabled).toLowerCase() === "true";

    const { rows: [chat] } = await rootDb.sql`SELECT enabled_actions FROM chats WHERE chat_id = ${chatId}`;
    /** @type {string[]} */
    const current = chat.enabled_actions ?? [];

    /** @type {string[]} */
    let updated;
    if (value) {
      updated = current.includes(action_name) ? current : [...current, action_name];
    } else {
      updated = current.filter(/** @param {string} a */ (a) => a !== action_name);
    }

    await rootDb.sql`UPDATE chats SET enabled_actions = ${JSON.stringify(updated)}::jsonb WHERE chat_id = ${chatId}`;

    return `Action \`${action_name}\` ${value ? "enabled" : "disabled"} for this chat.`;
  },
});

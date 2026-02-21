import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "debug_chat",
  command: "debug",
  description:
    "Toggle per-chat debug mode. Shows verbose tool call details and action logs when enabled. Default: 10 minutes.",
  parameters: {
    type: "object",
    properties: {
      minutes: {
        type: "string",
        description:
          "Minutes to enable debug (0=permanent, 'off'=disable). Default: 10",
      },
    },
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function enables_debug_for_default_10_minutes(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-debug-1') ON CONFLICT DO NOTHING`;
      const before = Date.now();
      const result = await action_fn(
        { chatId: "act-debug-1", rootDb: db },
        {},
      );
      const after = Date.now();

      assert.ok(typeof result === "string");
      assert.ok(result.includes("10"));

      const {
        rows: [chat],
      } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'act-debug-1'`;
      const debugUntil = new Date(chat.debug_until).getTime();
      const tenMinMs = 10 * 60 * 1000;
      assert.ok(
        debugUntil >= before + tenMinMs - 1000 &&
          debugUntil <= after + tenMinMs + 1000,
        `debug_until should be ~10min in future, got ${chat.debug_until}`,
      );
    },

    async function enables_debug_for_custom_minutes(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-debug-2') ON CONFLICT DO NOTHING`;
      const before = Date.now();
      const result = await action_fn(
        { chatId: "act-debug-2", rootDb: db },
        { minutes: "30" },
      );
      const after = Date.now();

      assert.ok(result.includes("30"));

      const {
        rows: [chat],
      } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'act-debug-2'`;
      const debugUntil = new Date(chat.debug_until).getTime();
      const thirtyMinMs = 30 * 60 * 1000;
      assert.ok(
        debugUntil >= before + thirtyMinMs - 1000 &&
          debugUntil <= after + thirtyMinMs + 1000,
        `debug_until should be ~30min in future, got ${chat.debug_until}`,
      );
    },

    async function permanent_mode_with_zero(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-debug-3') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-debug-3", rootDb: db },
        { minutes: "0" },
      );

      assert.ok(result.toLowerCase().includes("permanent"));

      const {
        rows: [chat],
      } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'act-debug-3'`;
      assert.equal(
        new Date(chat.debug_until).toISOString().slice(0, 10),
        "9999-01-01",
      );
    },

    async function disables_with_off(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-debug-4') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET debug_until = '9999-01-01' WHERE chat_id = 'act-debug-4'`;
      const result = await action_fn(
        { chatId: "act-debug-4", rootDb: db },
        { minutes: "off" },
      );

      assert.ok(result.toLowerCase().includes("off"));

      const {
        rows: [chat],
      } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'act-debug-4'`;
      assert.equal(chat.debug_until, null);
    },
  ],
  action_fn: async function ({ chatId, rootDb }, { minutes }) {
    const input = (minutes ?? "").trim().toLowerCase();

    if (input === "off") {
      await rootDb.sql`UPDATE chats SET debug_until = NULL WHERE chat_id = ${chatId}`;
      return "Debug off.";
    }

    const mins = input === "" ? 10 : Number(input);
    if (Number.isNaN(mins) || mins < 0) {
      return `❌ Invalid value: "${minutes}". Use a number of minutes, 0 for permanent, or "off" to disable.`;
    }

    if (mins === 0) {
      await rootDb.sql`UPDATE chats SET debug_until = '9999-01-01' WHERE chat_id = ${chatId}`;
      return "Debug on (permanent).";
    }

    const until = new Date(Date.now() + mins * 60 * 1000);
    const untilIso = until.toISOString();
    await rootDb.sql`UPDATE chats SET debug_until = ${untilIso} WHERE chat_id = ${chatId}`;
    const timeStr = until.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `Debug on for ${mins}min (until ${timeStr}).`;
  },
});

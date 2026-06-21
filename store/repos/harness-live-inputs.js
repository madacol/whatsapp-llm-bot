import { normalizeHarnessLiveInputRow } from "../normalizers.js";

/**
 * @param {{
 *   db: import("../../sqlite-db.js").SqliteDb,
 *   ensureChatExists: (chatId: string) => Promise<void>,
 * }} deps
 * @returns {{
 *   enqueueHarnessLiveInput: (input: {
 *     chatId: string,
 *     turnId: string,
 *     text: string,
 *   }) => Promise<import("../../store.js").HarnessLiveInputRow>,
 *   listPendingHarnessLiveInputs: (chatId?: string | null) => Promise<import("../../store.js").HarnessLiveInputRow[]>,
 *   deleteHarnessLiveInput: (id: number) => Promise<void>,
 * }}
 */
export function createHarnessLiveInputStore({ db, ensureChatExists }) {
  return {
    async enqueueHarnessLiveInput({ chatId, turnId, text }) {
      await ensureChatExists(chatId);
      const { rows: [row] } = await db.sql`
        INSERT INTO harness_live_input_journal (chat_id, turn_id, text)
        VALUES (${chatId}, ${turnId}, ${text})
        RETURNING *
      `;
      const liveInput = normalizeHarnessLiveInputRow(row);
      if (!liveInput) {
        throw new Error(`Failed to normalize harness live input row for ${chatId}.`);
      }
      return liveInput;
    },

    async listPendingHarnessLiveInputs(chatId = null) {
      const { rows } = chatId
        ? await db.sql`
          SELECT *
          FROM harness_live_input_journal
          WHERE chat_id = ${chatId}
          ORDER BY id ASC
        `
        : await db.sql`
          SELECT *
          FROM harness_live_input_journal
          ORDER BY id ASC
        `;
      return rows
        .map(normalizeHarnessLiveInputRow)
        .filter(/** @returns {row is import("../../store.js").HarnessLiveInputRow} */ (row) => row !== null);
    },

    async deleteHarnessLiveInput(id) {
      await db.sql`DELETE FROM harness_live_input_journal WHERE id = ${id}`;
    },
  };
}

import {
  normalizeWhatsAppEditHandleRow,
  normalizeWhatsAppIngressJournalRow,
  normalizeWhatsAppOutboundQueueRow,
  normalizeWhatsAppWorkspacePresentationRow,
} from "../normalizers.js";

/** @typedef {import("../../store.js").Store} Store */

/**
 * @typedef {{
 *   db: import("../../sqlite-db.js").SqliteDb;
 *   getChatDb: (chatId: string) => Promise<import("../../sqlite-db.js").SqliteDb>;
 *   listChatIds: () => Promise<string[]>;
 *   ensureChatExists: (chatId: string) => Promise<void>;
 * }} WhatsAppStoreDeps
 */

/**
 * Internal WhatsApp persistence helpers shared by other repos.
 * @param {WhatsAppStoreDeps} deps
 * @returns {{
 *   persistWhatsAppWorkspacePresentation: (input: {
 *     projectId: string,
 *     workspaceId: string,
 *     workspaceChatId: string,
 *     workspaceChatSubject: string,
 *     role?: WhatsAppWorkspacePresentationRole,
 *     linkedCommunityChatId?: string | null,
 *   }) => Promise<WhatsAppWorkspacePresentationRow>;
 *   getRequiredWhatsAppWorkspacePresentation: (workspaceId: string) => Promise<WhatsAppWorkspacePresentationRow>;
 *   enqueueWhatsAppOutboundQueueEntry: (input: {
 *     chatId: string,
 *     payloadJson: unknown,
 *   }) => Promise<import("../../store.js").WhatsAppOutboundQueueRow>;
 *   listWhatsAppOutboundQueueEntries: () => Promise<import("../../store.js").WhatsAppOutboundQueueRow[]>;
 *   deleteWhatsAppOutboundQueueEntry: (chatId: string, id: number) => Promise<void>;
 *   quarantineWhatsAppOutboundQueueEntry: (input: {
 *     row: import("../../store.js").WhatsAppOutboundQueueRow,
 *     reason: string,
 *   }) => Promise<void>;
 *   saveWhatsAppEditHandle: (input: {
 *     id: string,
 *     chatId: string,
 *     messageKeyJson: unknown,
 *     messageKind: "text" | "image",
 *     createdAt: string,
 *     expiresAt: string,
 *   }) => Promise<import("../../store.js").WhatsAppEditHandleRow>;
 *   getWhatsAppEditHandle: (id: string) => Promise<import("../../store.js").WhatsAppEditHandleRow | null>;
 *   deleteExpiredWhatsAppEditHandles: (now: string) => Promise<void>;
 *   enqueueWhatsAppIngressJournalEntry: (input: {
 *     ingressKey: string,
 *     sourceEventType: string,
 *     chatId: string,
 *     payloadJson: unknown,
 *   }) => Promise<import("../../store.js").WhatsAppIngressJournalRow>;
 *   listDispatchableWhatsAppIngressJournalEntries: () => Promise<import("../../store.js").WhatsAppIngressJournalRow[]>;
 *   markWhatsAppIngressJournalRouting: (id: number) => Promise<void>;
 *   markWhatsAppIngressJournalDone: (id: number) => Promise<void>;
 *   markWhatsAppIngressJournalIgnored: (id: number) => Promise<void>;
 *   markWhatsAppIngressJournalFailed: (id: number, reason: string) => Promise<void>;
 *   markWhatsAppIngressJournalDeadLetter: (id: number, reason: string) => Promise<void>;
 * }}
 */
export function createWhatsAppStoreInternals({ db, getChatDb, listChatIds, ensureChatExists }) {
  return {
    /**
     * @param {{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }} input
     * @returns {Promise<WhatsAppWorkspacePresentationRow>}
     */
    async persistWhatsAppWorkspacePresentation({
      projectId,
      workspaceId,
      workspaceChatId,
      workspaceChatSubject,
      role = "workspace",
      linkedCommunityChatId = null,
    }) {
      await ensureChatExists(workspaceChatId);
      if (linkedCommunityChatId) {
        await ensureChatExists(linkedCommunityChatId);
      }

      const { rows: [row] } = await db.sql`
        INSERT INTO whatsapp_workspace_presentations (
          workspace_id,
          project_id,
          workspace_chat_id,
          workspace_chat_subject,
          role,
          linked_community_chat_id
        )
        VALUES (
          ${workspaceId},
          ${projectId},
          ${workspaceChatId},
          ${workspaceChatSubject},
          ${role},
          ${linkedCommunityChatId}
        )
        ON CONFLICT (workspace_id) DO UPDATE
        SET
          project_id = EXCLUDED.project_id,
          workspace_chat_id = EXCLUDED.workspace_chat_id,
          workspace_chat_subject = EXCLUDED.workspace_chat_subject,
          role = EXCLUDED.role,
          linked_community_chat_id = EXCLUDED.linked_community_chat_id
        RETURNING *
      `;
      const presentation = normalizeWhatsAppWorkspacePresentationRow(row);
      if (!presentation) {
        throw new Error(`Failed to normalize WhatsApp workspace presentation for ${workspaceId}.`);
      }
      return presentation;
    },

    /**
     * @param {string} workspaceId
     * @returns {Promise<WhatsAppWorkspacePresentationRow>}
     */
    async getRequiredWhatsAppWorkspacePresentation(workspaceId) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM whatsapp_workspace_presentations
        WHERE workspace_id = ${workspaceId}
        LIMIT 1
      `;
      const presentation = normalizeWhatsAppWorkspacePresentationRow(row);
      if (!presentation) {
        throw new Error(`WhatsApp workspace presentation for ${workspaceId} does not exist.`);
      }
      return presentation;
    },

    /**
     * @param {{
     *   chatId: string,
     *   payloadJson: unknown,
     * }} input
     * @returns {Promise<import("../../store.js").WhatsAppOutboundQueueRow>}
     */
    async enqueueWhatsAppOutboundQueueEntry({ chatId, payloadJson }) {
      await ensureChatExists(chatId);
      const chatDb = await getChatDb(chatId);

      const { rows: [row] } = await chatDb.sql`
        INSERT INTO whatsapp_outbound_queue (chat_id, payload_json)
        VALUES (${chatId}, ${payloadJson})
        RETURNING *
      `;
      const queueRow = normalizeWhatsAppOutboundQueueRow(row);
      if (!queueRow) {
        throw new Error(`Failed to normalize WhatsApp outbound queue row for ${chatId}.`);
      }
      return queueRow;
    },

    /**
     * @returns {Promise<import("../../store.js").WhatsAppOutboundQueueRow[]>}
     */
    async listWhatsAppOutboundQueueEntries() {
      /** @type {import("../../store.js").WhatsAppOutboundQueueRow[]} */
      const queued = [];
      /** @type {WeakSet<import("../../sqlite-db.js").SqliteDb>} */
      const seenDbs = new WeakSet();
      for (const chatId of await listChatIds()) {
        const chatDb = await getChatDb(chatId);
        if (seenDbs.has(chatDb)) {
          continue;
        }
        seenDbs.add(chatDb);
        const { rows } = await chatDb.sql`
          SELECT *
          FROM whatsapp_outbound_queue
          ORDER BY id ASC
        `;
        queued.push(...rows
          .map(normalizeWhatsAppOutboundQueueRow)
          .filter(/** @returns {row is import("../../store.js").WhatsAppOutboundQueueRow} */ (row) => row !== null));
      }
      return queued.sort((a, b) => a.id - b.id);
    },

    /**
     * @param {string} chatId
     * @param {number} id
     * @returns {Promise<void>}
     */
    async deleteWhatsAppOutboundQueueEntry(chatId, id) {
      const chatDb = await getChatDb(chatId);
      await chatDb.sql`DELETE FROM whatsapp_outbound_queue WHERE id = ${id}`;
    },

    /**
     * @param {{
     *   row: import("../../store.js").WhatsAppOutboundQueueRow,
     *   reason: string,
     * }} input
     * @returns {Promise<void>}
     */
    async quarantineWhatsAppOutboundQueueEntry({ row, reason }) {
      const chatDb = await getChatDb(row.chat_id);
      await chatDb.sql`
        INSERT INTO whatsapp_outbound_dead_letter (
          original_queue_id,
          chat_id,
          payload_json,
          reason,
          created_at
        )
        VALUES (${row.id}, ${row.chat_id}, ${row.payload_json}, ${reason}, ${row.created_at ?? null})
      `;
      await chatDb.sql`DELETE FROM whatsapp_outbound_queue WHERE id = ${row.id}`;
    },

    /**
     * @param {{
     *   id: string,
     *   chatId: string,
     *   messageKeyJson: unknown,
     *   messageKind: "text" | "image",
     *   createdAt: string,
     *   expiresAt: string,
     * }} input
     * @returns {Promise<import("../../store.js").WhatsAppEditHandleRow>}
     */
    async saveWhatsAppEditHandle({ id, chatId, messageKeyJson, messageKind, createdAt, expiresAt }) {
      await ensureChatExists(chatId);
      const { rows: [row] } = await db.sql`
        INSERT INTO whatsapp_edit_handles (
          id,
          chat_id,
          message_key_json,
          message_kind,
          created_at,
          expires_at
        )
        VALUES (
          ${id},
          ${chatId},
          ${messageKeyJson},
          ${messageKind},
          ${createdAt},
          ${expiresAt}
        )
        ON CONFLICT (id) DO UPDATE
        SET
          chat_id = EXCLUDED.chat_id,
          message_key_json = EXCLUDED.message_key_json,
          message_kind = EXCLUDED.message_kind,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
        RETURNING *
      `;
      const handle = normalizeWhatsAppEditHandleRow(row);
      if (!handle) {
        throw new Error(`Failed to normalize WhatsApp edit handle ${id}.`);
      }
      return handle;
    },

    /**
     * @param {string} id
     * @returns {Promise<import("../../store.js").WhatsAppEditHandleRow | null>}
     */
    async getWhatsAppEditHandle(id) {
      const { rows: [row] } = await db.sql`
        SELECT *
        FROM whatsapp_edit_handles
        WHERE id = ${id}
        LIMIT 1
      `;
      return normalizeWhatsAppEditHandleRow(row);
    },

    /**
     * @param {string} now
     * @returns {Promise<void>}
     */
    async deleteExpiredWhatsAppEditHandles(now) {
      await db.sql`DELETE FROM whatsapp_edit_handles WHERE expires_at <= ${now}`;
    },

    /**
     * @param {{
     *   ingressKey: string,
     *   sourceEventType: string,
     *   chatId: string,
     *   payloadJson: unknown,
     * }} input
     * @returns {Promise<import("../../store.js").WhatsAppIngressJournalRow>}
     */
    async enqueueWhatsAppIngressJournalEntry({ ingressKey, sourceEventType, chatId, payloadJson }) {
      await ensureChatExists(chatId);
      const { rows: [inserted] } = await db.sql`
        INSERT INTO whatsapp_ingress_journal (
          ingress_key,
          source_event_type,
          chat_id,
          payload_json
        )
        VALUES (
          ${ingressKey},
          ${sourceEventType},
          ${chatId},
          ${payloadJson}
        )
        ON CONFLICT (ingress_key) DO NOTHING
        RETURNING *
      `;
      const row = normalizeWhatsAppIngressJournalRow(inserted);
      if (row) {
        return row;
      }

      const { rows: [existing] } = await db.sql`
        SELECT *
        FROM whatsapp_ingress_journal
        WHERE ingress_key = ${ingressKey}
        LIMIT 1
      `;
      const existingRow = normalizeWhatsAppIngressJournalRow(existing);
      if (!existingRow) {
        throw new Error(`Failed to normalize WhatsApp ingress journal row ${ingressKey}.`);
      }
      return existingRow;
    },

    /**
     * @returns {Promise<import("../../store.js").WhatsAppIngressJournalRow[]>}
     */
    async listDispatchableWhatsAppIngressJournalEntries() {
      const { rows } = await db.sql`
        SELECT *
        FROM whatsapp_ingress_journal
        WHERE state IN ('received', 'routing')
        ORDER BY id ASC
      `;
      return rows
        .map(normalizeWhatsAppIngressJournalRow)
        .filter(/** @returns {row is import("../../store.js").WhatsAppIngressJournalRow} */ (row) => row !== null);
    },

    /**
     * @param {number} id
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalRouting(id) {
      await db.sql`
        UPDATE whatsapp_ingress_journal
        SET state = 'routing',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
          AND state IN ('received', 'routing')
      `;
    },

    /**
     * @param {number} id
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalDone(id) {
      await db.sql`
        UPDATE whatsapp_ingress_journal
        SET state = 'done',
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
      `;
    },

    /**
     * @param {number} id
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalIgnored(id) {
      await db.sql`
        UPDATE whatsapp_ingress_journal
        SET state = 'ignored',
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
      `;
    },

    /**
     * @param {number} id
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalFailed(id, reason) {
      await db.sql`
        UPDATE whatsapp_ingress_journal
        SET state = 'received',
            attempt_count = attempt_count + 1,
            last_error = ${reason},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
      `;
    },

    /**
     * @param {number} id
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalDeadLetter(id, reason) {
      await db.sql`
        UPDATE whatsapp_ingress_journal
        SET state = 'dead_letter',
            attempt_count = attempt_count + 1,
            last_error = ${reason},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
      `;
    },
  };
}

/**
 * Build WhatsApp-facing store methods.
 * @param {ReturnType<typeof createWhatsAppStoreInternals>} internals
 * @param {import("../../sqlite-db.js").SqliteDb} db
 * @returns {Pick<Store,
 *   "getWhatsAppWorkspacePresentation"
 *   | "getWhatsAppWorkspacePresentationByChat"
 *   | "listWhatsAppWorkspacePresentations"
 *   | "saveWhatsAppWorkspacePresentation"
 *   | "enqueueWhatsAppOutboundQueueEntry"
 *   | "listWhatsAppOutboundQueueEntries"
 *   | "deleteWhatsAppOutboundQueueEntry"
 *   | "quarantineWhatsAppOutboundQueueEntry"
 *   | "saveWhatsAppEditHandle"
 *   | "getWhatsAppEditHandle"
 *   | "deleteExpiredWhatsAppEditHandles"
 *   | "enqueueWhatsAppIngressJournalEntry"
 *   | "listDispatchableWhatsAppIngressJournalEntries"
 *   | "markWhatsAppIngressJournalRouting"
 *   | "markWhatsAppIngressJournalDone"
 *   | "markWhatsAppIngressJournalIgnored"
 *   | "markWhatsAppIngressJournalFailed"
 *   | "markWhatsAppIngressJournalDeadLetter"
 * >}
 */
export function createWhatsAppStore(internals, db) {
  return {
    /**
     * @param {string} workspaceId
     * @returns {Promise<WhatsAppWorkspacePresentationRow | null>}
     */
    async getWhatsAppWorkspacePresentation(workspaceId) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM whatsapp_workspace_presentations
        WHERE workspace_id = ${workspaceId}
        LIMIT 1
      `;
      return normalizeWhatsAppWorkspacePresentationRow(row);
    },

    /**
     * @param {string} chatId
     * @returns {Promise<WhatsAppWorkspacePresentationRow | null>}
     */
    async getWhatsAppWorkspacePresentationByChat(chatId) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM whatsapp_workspace_presentations
        WHERE workspace_chat_id = ${chatId}
        LIMIT 1
      `;
      return normalizeWhatsAppWorkspacePresentationRow(row);
    },

    /**
     * @param {string} projectId
     * @returns {Promise<WhatsAppWorkspacePresentationRow[]>}
     */
    async listWhatsAppWorkspacePresentations(projectId) {
      const { rows } = await db.sql`
        SELECT * FROM whatsapp_workspace_presentations
        WHERE project_id = ${projectId}
        ORDER BY workspace_id
      `;
      return rows
        .map(normalizeWhatsAppWorkspacePresentationRow)
        .filter(/** @returns {row is WhatsAppWorkspacePresentationRow} */ (row) => row !== null);
    },

    /**
     * @param {{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }} input
     * @returns {Promise<WhatsAppWorkspacePresentationRow>}
     */
    async saveWhatsAppWorkspacePresentation(input) {
      return internals.persistWhatsAppWorkspacePresentation(input);
    },

    /**
     * @param {{
     *   chatId: string,
     *   payloadJson: unknown,
     * }} input
     * @returns {Promise<import("../../store.js").WhatsAppOutboundQueueRow>}
     */
    async enqueueWhatsAppOutboundQueueEntry(input) {
      return internals.enqueueWhatsAppOutboundQueueEntry(input);
    },

    /**
     * @returns {Promise<import("../../store.js").WhatsAppOutboundQueueRow[]>}
     */
    async listWhatsAppOutboundQueueEntries() {
      return internals.listWhatsAppOutboundQueueEntries();
    },

    /**
     * @param {string} chatId
     * @param {number} id
     * @returns {Promise<void>}
     */
    async deleteWhatsAppOutboundQueueEntry(chatId, id) {
      await internals.deleteWhatsAppOutboundQueueEntry(chatId, id);
    },

    /**
     * @param {{
     *   row: import("../../store.js").WhatsAppOutboundQueueRow,
     *   reason: string,
     * }} input
     * @returns {Promise<void>}
     */
    async quarantineWhatsAppOutboundQueueEntry(input) {
      await internals.quarantineWhatsAppOutboundQueueEntry(input);
    },

    /**
     * @param {{
     *   id: string,
     *   chatId: string,
     *   messageKeyJson: unknown,
     *   messageKind: "text" | "image",
     *   createdAt: string,
     *   expiresAt: string,
     * }} input
     * @returns {Promise<import("../../store.js").WhatsAppEditHandleRow>}
     */
    async saveWhatsAppEditHandle(input) {
      return internals.saveWhatsAppEditHandle(input);
    },

    /**
     * @param {string} id
     * @returns {Promise<import("../../store.js").WhatsAppEditHandleRow | null>}
     */
    async getWhatsAppEditHandle(id) {
      return internals.getWhatsAppEditHandle(id);
    },

    /**
     * @param {string} now
     * @returns {Promise<void>}
     */
    async deleteExpiredWhatsAppEditHandles(now) {
      await internals.deleteExpiredWhatsAppEditHandles(now);
    },

    /**
     * @param {{
     *   ingressKey: string,
     *   sourceEventType: string,
     *   chatId: string,
     *   payloadJson: unknown,
     * }} input
     * @returns {Promise<import("../../store.js").WhatsAppIngressJournalRow>}
     */
    async enqueueWhatsAppIngressJournalEntry(input) {
      return internals.enqueueWhatsAppIngressJournalEntry(input);
    },

    /**
     * @returns {Promise<import("../../store.js").WhatsAppIngressJournalRow[]>}
     */
    async listDispatchableWhatsAppIngressJournalEntries() {
      return internals.listDispatchableWhatsAppIngressJournalEntries();
    },

    /**
     * @param {number} id
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalRouting(id) {
      await internals.markWhatsAppIngressJournalRouting(id);
    },

    /**
     * @param {number} id
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalDone(id) {
      await internals.markWhatsAppIngressJournalDone(id);
    },

    /**
     * @param {number} id
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalIgnored(id) {
      await internals.markWhatsAppIngressJournalIgnored(id);
    },

    /**
     * @param {number} id
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalFailed(id, reason) {
      await internals.markWhatsAppIngressJournalFailed(id, reason);
    },

    /**
     * @param {number} id
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async markWhatsAppIngressJournalDeadLetter(id, reason) {
      await internals.markWhatsAppIngressJournalDeadLetter(id, reason);
    },
  };
}

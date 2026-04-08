import { getRootDb } from "./db.js";
import { createLogger } from "./logger.js";
import { normalizeChatRow } from "./store/normalizers.js";
import { createChatStore } from "./store/repos/chats.js";
import { createMessageStore } from "./store/repos/messages.js";
import { createProjectStore } from "./store/repos/projects.js";
import { createWhatsAppStore, createWhatsAppStoreInternals } from "./store/repos/whatsapp.js";
import { bootstrapStoreSchema } from "./store/schema/bootstrap.js";
import { runStoreMigrations } from "./store/schema/migrations.js";

const log = createLogger("store");

/**
 * @typedef {{
 *   chat_id: string;
 *   is_enabled: boolean;
 *   system_prompt: string | null;
 *   model: string | null;
 *   respond_on_any: boolean;
 *   respond_on_mention: boolean;
 *   respond_on_reply: boolean;
 *   respond_on: "any" | "mention+reply" | "mention";
 *   debug: boolean;
 *   media_to_text_models: { image?: string, audio?: string, video?: string, general?: string };
 *   model_roles: Record<string, string>;
 *   memory: boolean;
 *   memory_threshold: number | null;
 *   enabled_actions: string[];
 *   active_persona: string | null;
 *   harness: string | null;
 *   harness_cwd: string | null;
 *   output_visibility: import("./chat-output-visibility.js").OutputVisibilityOverrides;
 *   harness_config: Record<string, unknown>;
 *   harness_session_id: string | null;
 *   harness_session_kind: HarnessSessionRef["kind"] | null;
 *   harness_session_history: HarnessSessionHistoryEntry[];
 *   harness_fork_stack: HarnessForkStackEntry[];
 *   timestamp: string;
 * }} ChatRow
 *
 * @typedef {{
 *   id: string;
 *   kind: HarnessSessionRef["kind"];
 *   cleared_at: string;
 *   title: string | null;
 * }} HarnessSessionHistoryEntry
 *
 * @typedef {{
 *   id: string;
 *   kind: HarnessSessionRef["kind"];
 *   label: string | null;
 * }} HarnessForkStackEntry
 *
 * @typedef {{
 *   message_id: number;
 *   chat_id: string;
 *   sender_id: string;
 *   message_data: Message;
 *   timestamp: Date;
 *   display_key: string | null;
 * }} MessageRow
 *
 * @typedef {{
 *   id: number;
 *   chat_id: string;
 *   payload_json: unknown;
 *   created_at?: string;
 * }} WhatsAppOutboundQueueRow
 */

/**
 * Returns the ChatRow for the given chat, or throws if it does not exist.
 * @param {PGlite} db
 * @param {string} chatId
 * @returns {Promise<ChatRow>}
 */
export async function getChatOrThrow(db, chatId) {
  const { rows: [row] } = await db.sql`SELECT * FROM chats WHERE chat_id = ${chatId}`;
  const chat = normalizeChatRow(row);
  if (!chat) {
    throw new Error(`Chat ${chatId} does not exist.`);
  }
  return chat;
}

/**
 * @param {PGlite} [injectedDb]
 * @returns {Promise<{
 *   getChat: (chatId: ChatRow["chat_id"]) => Promise<ChatRow | undefined>;
 *   closeDb: () => Promise<void>;
 *   getMessages: (chatId: MessageRow["chat_id"], since?: Date, limit?: number) => Promise<MessageRow[]>;
 *   createChat: (chatId: ChatRow["chat_id"]) => Promise<void>;
 *   setChatEnabled: (chatId: string, enabled: boolean) => Promise<void>;
 *   copyChatCustomizations: (sourceChatId: string, targetChatId: string) => Promise<void>;
 *   createProject: (input: {
 *     name: string,
 *     rootPath: string,
 *     defaultBaseBranch: string,
 *     controlChatId?: string | null,
 *   }) => Promise<ProjectRow>;
 *   getProject: (projectId: string) => Promise<ProjectRow | null>;
 *   getProjectByChat: (chatId: string) => Promise<ProjectRow | null>;
 *   getProjectByRootPath: (rootPath: string) => Promise<ProjectRow | null>;
 *   createWorkspace: (input: {
 *     workspaceId?: string,
 *     projectId: string,
 *     name: string,
 *     branch: string,
 *     baseBranch: string,
 *     worktreePath: string,
 *     status?: WorkspaceStatus,
 *   }) => Promise<WorkspaceRow>;
 *   getWorkspace: (workspaceId: string) => Promise<WorkspaceRow | null>;
 *   getWorkspaceByName: (projectId: string, name: string) => Promise<WorkspaceRow | null>;
 *   getWorkspaceByWorktreePath: (worktreePath: string) => Promise<WorkspaceRow | null>;
 *   listActiveWorkspaces: (projectId: string) => Promise<WorkspaceRow[]>;
 *   resetWorkspace: (input: {
 *     workspaceId: string,
 *     branch: string,
 *     baseBranch: string,
 *     worktreePath: string,
 *     status?: WorkspaceStatus,
 *   }) => Promise<WorkspaceRow>;
 *   bindChatToProject: (chatId: string, projectId: string) => Promise<ChatBindingRow>;
 *   bindChatToWorkspace: (chatId: string, workspaceId: string) => Promise<ChatBindingRow>;
 *   getChatBinding: (chatId: string) => Promise<ChatBindingRow | null>;
 *   getWhatsAppProjectPresentationCache: (projectId: string) => Promise<WhatsAppProjectPresentationCacheRow | null>;
 *   upsertWhatsAppProjectPresentationCache: (input: {
 *     projectId: string,
 *     cachedTopologyKind?: WhatsAppProjectTopologyKind,
 *     cachedCommunityChatId?: string | null,
 *     cachedMainWorkspaceId?: string | null,
 *   }) => Promise<WhatsAppProjectPresentationCacheRow>;
 *   getWhatsAppWorkspacePresentation: (workspaceId: string) => Promise<WhatsAppWorkspacePresentationRow | null>;
 *   getWhatsAppWorkspacePresentationByChat: (chatId: string) => Promise<WhatsAppWorkspacePresentationRow | null>;
 *   listWhatsAppWorkspacePresentations: (projectId: string) => Promise<WhatsAppWorkspacePresentationRow[]>;
 *   saveWhatsAppWorkspacePresentation: (input: {
 *     projectId: string,
 *     workspaceId: string,
 *     workspaceChatId: string,
 *     workspaceChatSubject: string,
 *     role?: WhatsAppWorkspacePresentationRole,
 *     linkedCommunityChatId?: string | null,
 *   }) => Promise<WhatsAppWorkspacePresentationRow>;
 *   enqueueWhatsAppOutboundQueueEntry: (input: {
 *     chatId: string,
 *     payloadJson: unknown,
 *   }) => Promise<WhatsAppOutboundQueueRow>;
 *   listWhatsAppOutboundQueueEntries: () => Promise<WhatsAppOutboundQueueRow[]>;
 *   deleteWhatsAppOutboundQueueEntry: (id: number) => Promise<void>;
 *   archiveWorkspace: (workspaceId: string) => Promise<WorkspaceRow | null>;
 *   setWorkspaceStatus: (workspaceId: string, status: WorkspaceStatus, options?: { conflictedFiles?: string[] }) => Promise<WorkspaceRow | null>;
 *   updateWorkspaceLastTestStatus: (workspaceId: string, lastTestStatus: WorkspaceRow["last_test_status"]) => Promise<WorkspaceRow | null>;
 *   updateWorkspaceLastCommitOid: (workspaceId: string, lastCommitOid: string | null) => Promise<WorkspaceRow | null>;
 *   addMessage: (
 *     chatId: MessageRow["chat_id"],
 *     messageData: MessageRow["message_data"],
 *     senderIds?: MessageRow["sender_id"][] | null,
 *     displayKey?: string | null,
 *   ) => Promise<MessageRow>;
 *   updateToolMessage: (chatId: MessageRow["chat_id"], toolCallId: string, messageData: ToolMessage) => Promise<MessageRow | null>;
 *   getMessageByDisplayKey: (chatId: MessageRow["chat_id"], displayKey: string) => Promise<MessageRow | null>;
 *   saveHarnessSession: (chatId: ChatRow["chat_id"], session: HarnessSessionRef | null) => Promise<void>;
 *   archiveHarnessSession: (chatId: ChatRow["chat_id"], options?: { maxEntries?: number, title?: string | null }) => Promise<HarnessSessionHistoryEntry | null>;
 *   getHarnessSessionHistory: (chatId: ChatRow["chat_id"]) => Promise<HarnessSessionHistoryEntry[]>;
 *   restoreHarnessSession: (chatId: ChatRow["chat_id"], indexOrId: number | string) => Promise<HarnessSessionHistoryEntry | null>;
 *   getHarnessForkStack: (chatId: ChatRow["chat_id"]) => Promise<HarnessForkStackEntry[]>;
 *   pushHarnessForkStack: (chatId: ChatRow["chat_id"], entry: HarnessForkStackEntry) => Promise<void>;
 *   popHarnessForkStack: (chatId: ChatRow["chat_id"]) => Promise<HarnessForkStackEntry | null>;
 * }>}
 */
export async function initStore(injectedDb) {
  const db = injectedDb || getRootDb();

  await bootstrapStoreSchema(db);
  await runStoreMigrations(db);

  /**
   * @param {string} chatId
   * @returns {Promise<void>}
   */
  async function ensureChatExists(chatId) {
    await db.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING;`;
  }

  const chatStore = createChatStore({ db, ensureChatExists });
  const messageStore = createMessageStore({ db });
  const whatsappInternals = createWhatsAppStoreInternals({ db, ensureChatExists });
  const whatsappStore = createWhatsAppStore(whatsappInternals, db);
  const projectStore = createProjectStore({
    db,
    ensureChatExists,
    ensureWhatsAppProjectPresentationCacheExists: whatsappInternals.ensureWhatsAppProjectPresentationCacheExists,
    getRequiredWhatsAppWorkspacePresentation: whatsappInternals.getRequiredWhatsAppWorkspacePresentation,
  });

  return {
    ...chatStore,

    async closeDb() {
      log.info("Closing database...");
      await db.close();
      log.info("Database closed");
    },

    ...projectStore,
    ...whatsappStore,
    ...messageStore,
  };
}

/** @typedef {Awaited<ReturnType<typeof initStore>>} Store */

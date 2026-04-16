import { normalizeOutputVisibility } from "../chat-output-visibility.js";
import { normalizeHarnessConfig } from "../harness-config.js";

/** @typedef {import("../store.js").ChatRow} ChatRow */
/** @typedef {import("../store.js").MessageRow} MessageRow */
/** @typedef {import("../store.js").HarnessSessionHistoryEntry} HarnessSessionHistoryEntry */
/** @typedef {import("../store.js").HarnessForkStackEntry} HarnessForkStackEntry */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is WorkspaceStatus}
 */
function isWorkspaceStatus(value) {
  return value === "ready" || value === "busy" || value === "conflicted" || value === "archived";
}

/**
 * @param {unknown} value
 * @returns {value is WorkspaceRow["last_test_status"]}
 */
function isWorkspaceTestStatus(value) {
  return value === "not_run" || value === "passed" || value === "failed";
}

/**
 * @param {unknown} value
 * @returns {value is WhatsAppProjectTopologyKind}
 */
function isWhatsAppProjectTopologyKind(value) {
  return value === "groups" || value === "community";
}

/**
 * @param {unknown} value
 * @returns {value is WhatsAppWorkspacePresentationRole}
 */
function isWhatsAppWorkspacePresentationRole(value) {
  return value === "workspace" || value === "main";
}

/**
 * @param {unknown} value
 * @returns {value is HarnessSessionRef["kind"]}
 */
function isHarnessSessionKind(value) {
  return value === "native" || value === "claude-sdk" || value === "codex" || value === "pi";
}

/**
 * @param {unknown} value
 * @returns {value is ChatRow["respond_on"]}
 */
function isRespondOnValue(value) {
  return value === "any" || value === "mention+reply" || value === "mention";
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeTimestampValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeIntegerId(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string");
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeStringRecord(value) {
  if (!isRecord(value)) {
    return {};
  }

  /** @type {Record<string, string>} */
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      normalized[key] = entry;
    }
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {ChatRow["media_to_text_models"]}
 */
function normalizeMediaToTextModels(value) {
  if (!isRecord(value)) {
    return {};
  }

  /** @type {ChatRow["media_to_text_models"]} */
  const normalized = {};
  if (typeof value.image === "string") {
    normalized.image = value.image;
  }
  if (typeof value.audio === "string") {
    normalized.audio = value.audio;
  }
  if (typeof value.video === "string") {
    normalized.video = value.video;
  }
  if (typeof value.general === "string") {
    normalized.general = value.general;
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {value is Message}
 */
function isStoredMessage(value) {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return false;
  }

  if (value.role === "user" || value.role === "assistant") {
    return true;
  }

  return value.role === "tool" && typeof value.tool_id === "string";
}

/**
 * @param {unknown} raw
 * @returns {import("../store.js").WhatsAppOutboundQueueRow | null}
 */
export function normalizeWhatsAppOutboundQueueRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const id = normalizeIntegerId(raw.id);
  const createdAt = raw.created_at === undefined ? undefined : normalizeTimestampValue(raw.created_at);
  if (
    id === null
    || typeof raw.chat_id !== "string"
    || (raw.created_at !== undefined && !createdAt)
  ) {
    return null;
  }

  return {
    id,
    chat_id: raw.chat_id,
    payload_json: raw.payload_json,
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

/**
 * @param {unknown} raw
 * @returns {ProjectRow | null}
 */
export function normalizeProjectRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const timestamp = normalizeTimestampValue(raw.timestamp);
  if (
    typeof raw.project_id !== "string"
    || typeof raw.name !== "string"
    || typeof raw.root_path !== "string"
    || typeof raw.default_base_branch !== "string"
    || (raw.control_chat_id !== null && typeof raw.control_chat_id !== "string")
    || !timestamp
  ) {
    return null;
  }

  return {
    project_id: raw.project_id,
    name: raw.name,
    root_path: raw.root_path,
    default_base_branch: raw.default_base_branch,
    control_chat_id: raw.control_chat_id,
    timestamp,
  };
}

/**
 * @param {unknown} raw
 * @returns {WorkspaceRow | null}
 */
export function normalizeWorkspaceRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const timestamp = normalizeTimestampValue(raw.timestamp);
  const archivedAt = raw.archived_at === null ? null : normalizeTimestampValue(raw.archived_at);
  const conflictedFiles = normalizeStringArray(raw.conflicted_files);
  if (
    typeof raw.workspace_id !== "string"
    || typeof raw.project_id !== "string"
    || typeof raw.name !== "string"
    || typeof raw.branch !== "string"
    || typeof raw.base_branch !== "string"
    || typeof raw.worktree_path !== "string"
    || !isWorkspaceStatus(raw.status)
    || !isWorkspaceTestStatus(raw.last_test_status)
    || (raw.last_commit_oid !== null && typeof raw.last_commit_oid !== "string")
    || (raw.archived_at !== null && !archivedAt)
    || conflictedFiles.length !== (Array.isArray(raw.conflicted_files) ? raw.conflicted_files.length : 0)
    || !timestamp
  ) {
    return null;
  }

  return {
    workspace_id: raw.workspace_id,
    project_id: raw.project_id,
    name: raw.name,
    branch: raw.branch,
    base_branch: raw.base_branch,
    worktree_path: raw.worktree_path,
    status: raw.status,
    last_test_status: raw.last_test_status,
    last_commit_oid: raw.last_commit_oid,
    conflicted_files: conflictedFiles,
    archived_at: archivedAt,
    timestamp,
  };
}

/**
 * @param {unknown} raw
 * @returns {ChatBindingRow | null}
 */
export function normalizeChatBindingRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const timestamp = normalizeTimestampValue(raw.timestamp);
  if (
    typeof raw.chat_id !== "string"
    || (raw.binding_kind !== "repo" && raw.binding_kind !== "project" && raw.binding_kind !== "workspace")
    || (raw.project_id !== null && typeof raw.project_id !== "string")
    || (raw.workspace_id !== null && typeof raw.workspace_id !== "string")
    || !timestamp
  ) {
    return null;
  }

  return {
    chat_id: raw.chat_id,
    binding_kind: raw.binding_kind === "repo" ? "project" : raw.binding_kind,
    project_id: raw.project_id,
    workspace_id: raw.workspace_id,
    timestamp,
  };
}

/**
 * @param {unknown} raw
 * @returns {WhatsAppProjectPresentationCacheRow | null}
 */
export function normalizeWhatsAppProjectPresentationCacheRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const cachedTopologyKind = raw.cached_topology_kind ?? raw.topology_kind;
  const cachedCommunityChatId = raw.cached_community_chat_id ?? raw.community_chat_id ?? null;
  const cachedMainWorkspaceId = raw.cached_main_workspace_id ?? raw.main_workspace_id ?? null;
  const timestamp = normalizeTimestampValue(raw.timestamp);
  if (
    typeof raw.project_id !== "string"
    || !isWhatsAppProjectTopologyKind(cachedTopologyKind)
    || (cachedCommunityChatId !== null && typeof cachedCommunityChatId !== "string")
    || (cachedMainWorkspaceId !== null && typeof cachedMainWorkspaceId !== "string")
    || !timestamp
  ) {
    return null;
  }

  return {
    project_id: raw.project_id,
    cached_topology_kind: cachedTopologyKind,
    cached_community_chat_id: cachedCommunityChatId,
    cached_main_workspace_id: cachedMainWorkspaceId,
    timestamp,
  };
}

/**
 * @param {unknown} raw
 * @returns {WhatsAppWorkspacePresentationRow | null}
 */
export function normalizeWhatsAppWorkspacePresentationRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const timestamp = normalizeTimestampValue(raw.timestamp);
  if (
    typeof raw.workspace_id !== "string"
    || typeof raw.project_id !== "string"
    || typeof raw.workspace_chat_id !== "string"
    || typeof raw.workspace_chat_subject !== "string"
    || !isWhatsAppWorkspacePresentationRole(raw.role)
    || (raw.linked_community_chat_id !== null && typeof raw.linked_community_chat_id !== "string")
    || !timestamp
  ) {
    return null;
  }

  return {
    workspace_id: raw.workspace_id,
    project_id: raw.project_id,
    workspace_chat_id: raw.workspace_chat_id,
    workspace_chat_subject: raw.workspace_chat_subject,
    role: raw.role,
    linked_community_chat_id: raw.linked_community_chat_id,
    timestamp,
  };
}

/**
 * @param {unknown} raw
 * @returns {ChatRow | null}
 */
export function normalizeChatRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const timestamp = normalizeTimestampValue(raw.timestamp);
  if (
    typeof raw.chat_id !== "string"
    || typeof raw.is_enabled !== "boolean"
    || !timestamp
  ) {
    return null;
  }

  const respondOnAny = raw.respond_on_any === true;
  const respondOnMention = raw.respond_on_mention !== false;
  const respondOnReply = raw.respond_on_reply === true;
  const respondOn = isRespondOnValue(raw.respond_on)
    ? raw.respond_on
    : respondOnAny
      ? "any"
      : respondOnReply && respondOnMention
        ? "mention+reply"
        : "mention";

  return {
    chat_id: raw.chat_id,
    is_enabled: raw.is_enabled,
    system_prompt: typeof raw.system_prompt === "string" ? raw.system_prompt : null,
    model: typeof raw.model === "string" ? raw.model : null,
    respond_on_any: respondOnAny,
    respond_on_mention: respondOnMention,
    respond_on_reply: respondOnReply,
    respond_on: respondOn,
    debug: raw.debug === true,
    media_to_text_models: normalizeMediaToTextModels(raw.media_to_text_models),
    model_roles: normalizeStringRecord(raw.model_roles),
    memory: raw.memory === true,
    memory_threshold: typeof raw.memory_threshold === "number" ? raw.memory_threshold : null,
    enabled_actions: normalizeStringArray(raw.enabled_actions),
    active_persona: typeof raw.active_persona === "string" ? raw.active_persona : null,
    harness: typeof raw.harness === "string" ? raw.harness : null,
    harness_cwd: typeof raw.harness_cwd === "string" ? raw.harness_cwd : null,
    output_visibility: normalizeOutputVisibility(raw.output_visibility),
    harness_config: normalizeHarnessConfig(raw.harness_config, typeof raw.harness === "string" ? raw.harness : null),
    harness_session_id: typeof raw.harness_session_id === "string" ? raw.harness_session_id : null,
    harness_session_kind: isHarnessSessionKind(raw.harness_session_kind) ? raw.harness_session_kind : null,
    harness_session_history: normalizeHarnessSessionHistory(raw.harness_session_history),
    harness_fork_stack: normalizeHarnessForkStack(raw.harness_fork_stack),
    timestamp,
  };
}

/**
 * @param {unknown} raw
 * @returns {MessageRow | null}
 */
export function normalizeMessageRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  const messageId = normalizeIntegerId(raw.message_id);
  const timestamp = normalizeTimestampValue(raw.timestamp);
  if (
    messageId === null
    || typeof raw.chat_id !== "string"
    || (raw.sender_id !== null && typeof raw.sender_id !== "string")
    || !isStoredMessage(raw.message_data)
    || (raw.display_key !== null && raw.display_key !== undefined && typeof raw.display_key !== "string")
    || !timestamp
  ) {
    return null;
  }

  return {
    message_id: messageId,
    chat_id: raw.chat_id,
    sender_id: raw.sender_id ?? "",
    message_data: raw.message_data,
    timestamp: new Date(timestamp),
    display_key: raw.display_key ?? null,
  };
}

/**
 * Normalize one persisted harness session history entry from JSONB.
 * @param {unknown} raw
 * @returns {HarnessSessionHistoryEntry | null}
 */
export function normalizeHarnessSessionHistoryEntry(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  if (
    typeof raw.id !== "string"
    || !isHarnessSessionKind(raw.kind)
    || typeof raw.cleared_at !== "string"
  ) {
    return null;
  }

  return {
    id: raw.id,
    kind: raw.kind,
    cleared_at: raw.cleared_at,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : null,
  };
}

/**
 * @param {unknown} raw
 * @returns {HarnessSessionHistoryEntry[]}
 */
export function normalizeHarnessSessionHistory(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map(normalizeHarnessSessionHistoryEntry)
    .filter(/** @returns {entry is HarnessSessionHistoryEntry} */ (entry) => entry !== null);
}

/**
 * @param {unknown} raw
 * @returns {HarnessForkStackEntry | null}
 */
export function normalizeHarnessForkStackEntry(raw) {
  if (!isRecord(raw)) {
    return null;
  }

  if (typeof raw.id !== "string" || !isHarnessSessionKind(raw.kind)) {
    return null;
  }

  return {
    id: raw.id,
    kind: raw.kind,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label : null,
  };
}

/**
 * @param {unknown} raw
 * @returns {HarnessForkStackEntry[]}
 */
export function normalizeHarnessForkStack(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map(normalizeHarnessForkStackEntry)
    .filter(/** @returns {entry is HarnessForkStackEntry} */ (entry) => entry !== null);
}

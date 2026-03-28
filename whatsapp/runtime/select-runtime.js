import { createHash } from "node:crypto";
import { decryptPollVote, getKeyAuthor, isLidUser, jidNormalizedUser } from "@whiskeysockets/baileys";
import { createLogger } from "../../logger.js";

const log = createLogger("whatsapp:select");

/**
 * @typedef {{ chatId: string, pollMsgId: string, selectedOptions: string[] }} PollVoteEvent
 */

const POLL_TTL_MS = 10 * 60 * 1000;
const MAX_SENT_POLLS = 200;
const SELECT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @typedef {import('@whiskeysockets/baileys').WASocket | (() => import('@whiskeysockets/baileys').WASocket | null)} SocketResolver
 */

/**
 * Resolve the poll creation data from any Baileys poll message version (V1–V5).
 * @param {import('@whiskeysockets/baileys').WAMessage["message"] | null | undefined} msg
 * @returns {{ options: Array<{optionName?: string | null}> } | null}
 */
export function getPollCreationData(msg) {
  const data = msg?.pollCreationMessage
    || msg?.pollCreationMessageV2
    || msg?.pollCreationMessageV3
    || msg?.pollCreationMessageV4
    || msg?.pollCreationMessageV5;
  if (!data || !("options" in data)) return null;
  return { options: data.options ?? [] };
}

/**
 * @typedef {{
 *   suppressEffects?: boolean;
 * }} SelectSettlementOptions
 */

/**
 * @typedef {{
 *   timer: ReturnType<typeof setTimeout>;
 *   labelToId: Map<string, string>;
 * }} PendingSelectBase
 */

/**
 * @typedef {PendingSelectBase & {
 *   mode: "single";
 *   settle: (id: string, options?: SelectSettlementOptions) => void;
 * }} PendingSingleSelect
 */

/**
 * @typedef {PendingSelectBase & {
 *   mode: "multi";
 *   settle: (ids: string[], options?: SelectSettlementOptions) => void;
 * }} PendingMultiSelect
 */

/**
 * @typedef {PendingSingleSelect | PendingMultiSelect} PendingSelect
 */

/**
 * @typedef {{
 *   handlePollVote: (event: PollVoteEvent) => boolean;
 *   createSelect: (sock: SocketResolver, chatId: string) => (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
 *   createSelectMany: (sock: SocketResolver, chatId: string) => (question: string, options: SelectOption[], config?: SelectManyConfig) => Promise<string[]>;
 *   resolvePollVoteMessage: (message: import('@whiskeysockets/baileys').WAMessage, sock: import('@whiskeysockets/baileys').WASocket) => Promise<PollVoteEvent | null>;
 *   readonly size: number;
 *   clear: () => void;
 * }} SelectRuntime
 */

/**
 * Normalize SelectOption[] into poll labels and a label->id map.
 * @param {SelectOption[]} options
 * @param {readonly string[] | undefined} currentIds
 * @returns {{ labels: string[], labelToId: Map<string, string> }}
 */
function normalizeSelectOptions(options, currentIds) {
  /** @type {Map<string, string>} */
  const labelToId = new Map();
  /** @type {Set<string>} */
  const usedLabels = new Set();
  const selectedIds = new Set(currentIds ?? []);
  const labels = options.map((option) => {
    const id = typeof option === "string" ? option : option.id;
    const baseLabel = typeof option === "string" ? option : option.label;
    const preferredLabel = selectedIds.has(id) ? `✅ ${baseLabel}` : baseLabel;
    const label = createUniquePollLabel(preferredLabel, usedLabels);
    labelToId.set(label, id);
    return label;
  });
  return { labels, labelToId };
}

/**
 * Ensure each poll label is unique so selections map back to the right option ID.
 * WhatsApp poll votes are reported by option label, so duplicate labels would
 * otherwise collapse onto the last option stored in the map.
 * @param {string} preferredLabel
 * @param {Set<string>} usedLabels
 * @returns {string}
 */
function createUniquePollLabel(preferredLabel, usedLabels) {
  if (!usedLabels.has(preferredLabel)) {
    usedLabels.add(preferredLabel);
    return preferredLabel;
  }

  let suffix = 2;
  while (true) {
    const candidate = `${preferredLabel} (${suffix})`;
    if (!usedLabels.has(candidate)) {
      usedLabels.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

/**
 * @param {SocketResolver} socketResolver
 * @returns {() => import('@whiskeysockets/baileys').WASocket | null}
 */
function createSocketGetter(socketResolver) {
  return typeof socketResolver === "function" ? socketResolver : () => socketResolver;
}

/**
 * @param {() => import('@whiskeysockets/baileys').WASocket | null} getSocket
 * @returns {import('@whiskeysockets/baileys').WASocket}
 */
function requireSocket(getSocket) {
  const sock = getSocket();
  if (!sock) {
    throw new Error("WhatsApp socket is not connected");
  }
  return sock;
}

/**
 * Track a sent poll message long enough to decrypt later votes.
 * @param {Map<string, import('@whiskeysockets/baileys').WAMessage>} sentPolls
 * @param {string} pollMsgId
 * @param {import('@whiskeysockets/baileys').WAMessage} sent
 * @returns {void}
 */
function rememberSentPoll(sentPolls, pollMsgId, sent) {
  if (sentPolls.size >= MAX_SENT_POLLS) {
    const oldestKey = sentPolls.keys().next().value;
    if (oldestKey) {
      sentPolls.delete(oldestKey);
    }
  }
  sentPolls.set(pollMsgId, sent);
  const cleanupTimer = setTimeout(() => sentPolls.delete(pollMsgId), POLL_TTL_MS);
  cleanupTimer.unref?.();
}

/**
 * Send a poll prompt and return the metadata needed to track its result.
 * @param {() => import('@whiskeysockets/baileys').WASocket | null} getSocket
 * @param {Map<string, import('@whiskeysockets/baileys').WAMessage>} sentPolls
 * @param {string} chatId
 * @param {string} question
 * @param {SelectOption[]} options
 * @param {readonly string[] | undefined} currentIds
 * @param {number} selectableCount
 * @returns {Promise<{
 *   pollMsgId: string;
 *   sentPollKey: import('@whiskeysockets/baileys').WAMessageKey;
 *   labelToId: Map<string, string>;
 * } | null>}
 */
async function sendPollPrompt(getSocket, sentPolls, chatId, question, options, currentIds, selectableCount) {
  const { labels, labelToId } = normalizeSelectOptions(options, currentIds);
  const sent = await requireSocket(getSocket).sendMessage(chatId, {
    poll: { name: question, values: labels, selectableCount },
  });
  const pollMsgId = sent?.key?.id;
  const pollKey = sent?.key;

  if (pollMsgId && sent) {
    rememberSentPoll(sentPolls, pollMsgId, sent);
  }

  if (!pollMsgId || !pollKey) {
    return null;
  }

  /** @type {import('@whiskeysockets/baileys').WAMessageKey} */
  const sentPollKey = pollKey;
  getSocket()?.sendMessage(chatId, { react: { text: "⏳", key: sentPollKey } });

  return { pollMsgId, sentPollKey, labelToId };
}

/**
 * Apply the transport-side effect after a selection settles.
 * @param {() => import('@whiskeysockets/baileys').WASocket | null} getSocket
 * @param {string} chatId
 * @param {import('@whiskeysockets/baileys').WAMessageKey} sentPollKey
 * @param {boolean} isCancelled
 * @param {boolean} deleteOnSelect
 * @returns {void}
 */
function applySettlementEffect(getSocket, chatId, sentPollKey, isCancelled, deleteOnSelect) {
  if (isCancelled) {
    getSocket()?.sendMessage(chatId, { react: { text: "❌", key: sentPollKey } });
  } else if (deleteOnSelect) {
    getSocket()?.sendMessage(chatId, { delete: sentPollKey });
  } else {
    getSocket()?.sendMessage(chatId, { react: { text: "", key: sentPollKey } });
  }
}

/**
 * Decrypt a poll vote message and resolve the selected option names.
 * @param {Map<string, import('@whiskeysockets/baileys').WAMessage>} sentPolls
 * @param {import('@whiskeysockets/baileys').WAMessage} message
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @returns {Promise<PollVoteEvent | null>}
 */
async function decryptAndResolvePollVote(sentPolls, message, sock) {
  const pollUpdate = message.message?.pollUpdateMessage;
  if (!pollUpdate) return null;

  const creationKeyId = pollUpdate.pollCreationMessageKey?.id;
  log.debug(`Poll vote upsert: creationKeyId=${creationKeyId}`);
  if (!creationKeyId) return null;

  const pollCreation = sentPolls.get(creationKeyId);
  if (!pollCreation) {
    log.debug(`Poll creation not found in sentPolls for id=${creationKeyId}`);
    return null;
  }

  const encKey = pollCreation.message?.messageContextInfo?.messageSecret;
  if (!encKey || !pollUpdate.vote) {
    log.debug("Poll vote missing encKey or vote payload, skipping");
    return null;
  }

  const voteJid = message.key.participant || message.key.remoteJid || "";
  const isLidVote = isLidUser(voteJid);

  /** @type {string} */
  let meId;
  /** @type {string} */
  let pollCreatorJid;
  /** @type {string} */
  let voterJid;

  if (isLidVote) {
    meId = sock.user?.lid
      ? jidNormalizedUser(sock.user.lid)
      : jidNormalizedUser(sock.user?.id ?? "");
    pollCreatorJid = pollCreation.key?.fromMe
      ? meId
      : (pollCreation.key?.participant || pollCreation.key?.remoteJid || "");
    voterJid = message.key.fromMe
      ? meId
      : (message.key.participant || message.key.remoteJid || "");
  } else {
    meId = jidNormalizedUser(sock.user?.id ?? "");
    pollCreatorJid = getKeyAuthor(pollCreation.key, meId);
    voterJid = getKeyAuthor(message.key, meId);
  }

  const decrypted = decryptPollVote(pollUpdate.vote, {
    pollEncKey: encKey,
    pollCreatorJid,
    pollMsgId: creationKeyId,
    voterJid,
  });

  const pollData = getPollCreationData(pollCreation.message);
  const options = pollData?.options ?? [];
  const selectedHashes = (decrypted.selectedOptions ?? []).map((hash) => Buffer.from(hash).toString("hex"));

  const selectedOptions = options
    .filter((option) => {
      if (!option.optionName) return false;
      const optionHash = createHash("sha256").update(option.optionName).digest("hex");
      return selectedHashes.includes(optionHash);
    })
    .map((option) => option.optionName ?? "");

  if (selectedOptions.length === 0) return null;

  let chatId = message.key.remoteJid || pollCreation.key?.remoteJid || "";
  if (isLidUser(chatId)) {
    const phoneNumber = await sock.signalRepository.lidMapping.getPNForLID(chatId);
    if (phoneNumber) {
      chatId = jidNormalizedUser(phoneNumber);
    }
  }

  return { chatId, pollMsgId: creationKeyId, selectedOptions };
}

/**
 * Create a runtime that manages pending select responses and poll decoding.
 * @returns {SelectRuntime}
 */
export function createSelectRuntime() {
  /** @type {Map<string, PendingSelect>} */
  const pending = new Map();
  /** @type {Map<string, import('@whiskeysockets/baileys').WAMessage>} */
  const sentPolls = new Map();

  return {
    /**
     * Resolve a pending select response with a poll vote.
     * @param {PollVoteEvent} event
     * @returns {boolean}
     */
    handlePollVote(event) {
      const entry = pending.get(event.pollMsgId);
      if (!entry || event.selectedOptions.length === 0) return false;

      clearTimeout(entry.timer);
      pending.delete(event.pollMsgId);

      const selectedIds = event.selectedOptions
        .map((label) => entry.labelToId.get(label) ?? label)
        .filter((id) => id.length > 0);

      if (entry.mode === "multi") {
        entry.settle(selectedIds);
      } else {
        entry.settle(selectedIds[0] ?? "");
      }
      return true;
    },

    /**
     * Create a select function scoped to a chat.
     * @param {SocketResolver} sock
     * @param {string} chatId
     * @returns {(question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>}
     */
    createSelect(sock, chatId) {
      const getSocket = createSocketGetter(sock);

      return async (question, options, config) => {
        const prompt = await sendPollPrompt(
          getSocket,
          sentPolls,
          chatId,
          question,
          options,
          config?.currentId ? [config.currentId] : [],
          1,
        );
        if (!prompt) {
          return "";
        }

        const promptData = prompt;
        const cancelIds = config?.cancelIds ? new Set(config.cancelIds) : null;
        const deleteOnSelect = config?.deleteOnSelect ?? false;
        const timeout = config?.timeout ?? SELECT_TIMEOUT_MS;

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(promptData.pollMsgId);
            settle("");
          }, timeout);
          timer.unref?.();

          /**
           * Complete the pending selection and optionally suppress transport-side effects.
           * @param {string} id
           * @param {SelectSettlementOptions} [options]
           * @returns {void}
           */
          function settle(id, options = {}) {
            if (!options.suppressEffects) {
              const isCancelled = !id || (cancelIds !== null && cancelIds.has(id));
              applySettlementEffect(getSocket, chatId, promptData.sentPollKey, isCancelled, deleteOnSelect);
            }

            resolve(id);
          }

          pending.set(promptData.pollMsgId, { mode: "single", settle, timer, labelToId: promptData.labelToId });
        });
      };
    },

    /**
     * Create a multi-select function scoped to a chat.
     * @param {SocketResolver} sock
     * @param {string} chatId
     * @returns {(question: string, options: SelectOption[], config?: SelectManyConfig) => Promise<string[]>}
     */
    createSelectMany(sock, chatId) {
      const getSocket = createSocketGetter(sock);

      return async (question, options, config) => {
        const selectableCount = Math.max(options.length, 1);
        const prompt = await sendPollPrompt(
          getSocket,
          sentPolls,
          chatId,
          question,
          options,
          config?.currentIds,
          selectableCount,
        );
        if (!prompt) {
          return [];
        }

        const promptData = prompt;
        const cancelIds = config?.cancelIds ? new Set(config.cancelIds) : null;
        const deleteOnSelect = config?.deleteOnSelect ?? false;
        const timeout = config?.timeout ?? SELECT_TIMEOUT_MS;

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(promptData.pollMsgId);
            settle([]);
          }, timeout);
          timer.unref?.();

          /**
           * Complete the pending selection and optionally suppress transport-side effects.
           * @param {string[]} ids
           * @param {SelectSettlementOptions} [options]
           * @returns {void}
           */
          function settle(ids, options = {}) {
            if (!options.suppressEffects) {
              const isCancelled = ids.length === 0 || (
                cancelIds !== null
                && ids.length === 1
                && cancelIds.has(ids[0] ?? "")
              );
              applySettlementEffect(getSocket, chatId, promptData.sentPollKey, isCancelled, deleteOnSelect);
            }

            resolve(ids);
          }

          pending.set(promptData.pollMsgId, { mode: "multi", settle, timer, labelToId: promptData.labelToId });
        });
      };
    },

    /**
     * Decrypt and resolve an incoming poll vote message.
     * @param {import('@whiskeysockets/baileys').WAMessage} message
     * @param {import('@whiskeysockets/baileys').WASocket} sock
     * @returns {Promise<PollVoteEvent | null>}
     */
    resolvePollVoteMessage(message, sock) {
      return decryptAndResolvePollVote(sentPolls, message, sock);
    },

    get size() {
      return pending.size;
    },

    clear() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        if (entry.mode === "multi") {
          entry.settle([], { suppressEffects: true });
        } else {
          entry.settle("", { suppressEffects: true });
        }
      }
      pending.clear();
      sentPolls.clear();
    },
  };
}

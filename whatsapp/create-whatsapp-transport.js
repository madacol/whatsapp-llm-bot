import {
  Browsers,
  fetchLatestWaWebVersion,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { exec } from "node:child_process";
import { rm } from "node:fs/promises";
import { createLogger } from "../logger.js";
import { needsAuthReset, sendAlertEmail } from "../notifications.js";
import { adaptIncomingMessage } from "./inbound/chat-turn.js";
import { createConfirmRuntime } from "./runtime/confirm-runtime.js";
import { createReactionRuntime } from "./runtime/reaction-runtime.js";
import { createSelectRuntime } from "./runtime/select-runtime.js";

const log = createLogger("whatsapp");

const AUTH_DIR = "./auth_info_baileys";
const QR_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Print a WhatsApp QR code to the terminal.
 * @param {string} qr
 * @returns {void}
 */
function printQrCode(qr) {
  exec(`echo "${qr}" | qrencode -t ansiutf8`, (error, stdout, stderr) => {
    if (error) {
      log.error(error);
      log.error(stderr);
      return;
    }
    log.info(stdout);
  });
}

/**
 * Create the normalized payload used by reaction runtimes.
 * @param {Array<{
 *   key?: { id?: string | null, remoteJid?: string | null, participant?: string | null };
 *   reaction?: { text?: string | null };
 * }>} events
 * @returns {Array<{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string }>}
 */
function normalizeReactionEvents(events) {
  /** @type {Array<{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string }>} */
  const normalized = [];

  for (const event of events) {
    const { key, reaction } = event;
    if (!key?.id || !key.remoteJid || !reaction?.text) continue;

    normalized.push({
      key: { id: key.id, remoteJid: key.remoteJid },
      reaction: { text: reaction.text },
      senderId: (key.participant || key.remoteJid).split("@")[0],
    });
  }

  return normalized;
}

/**
 * Normalize a reaction that arrived as a `messages.upsert` payload instead of
 * the dedicated `messages.reaction` event stream.
 * @param {BaileysMessage} message
 * @returns {Array<{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string }>}
 */
export function normalizeUpsertReactionMessage(message) {
  const reactionMessage = message.message?.reactionMessage;
  const reactedKey = reactionMessage?.key;
  if (!reactedKey?.id || !reactionMessage?.text) {
    return [];
  }

  const remoteJid = reactedKey.remoteJid || message.key.remoteJid;
  if (!remoteJid) {
    return [];
  }

  const senderId = (
    message.key.participant
    || /** @type {{ participantAlt?: string | null }} */ (message.key).participantAlt
    || message.key.remoteJid
    || "unknown"
  ).split("@")[0];

  return [{
    key: { id: reactedKey.id, remoteJid },
    reaction: { text: reactionMessage.text },
    senderId,
  }];
}

/**
 * Build a WASocket instance from auth state.
 * @param {Awaited<ReturnType<typeof useMultiFileAuthState>>["state"]} auth
 * @param {[number, number, number]} version
 * @returns {import('@whiskeysockets/baileys').WASocket}
 */
function createSocket(auth, version) {
  return makeWASocket({
    version,
    auth,
    browser: Browsers.ubuntu("Chrome"),
  });
}

/**
 * @typedef {{
 *   start: (onTurn: (turn: ChatTurn) => Promise<void>) => Promise<void>;
 *   stop: () => Promise<void>;
 *   sendText: (chatId: string, text: string) => Promise<void>;
 * }} ChatTransport
 */

/**
 * Create a WhatsApp transport with a minimal app-facing surface.
 * @returns {Promise<ChatTransport>}
 */
export async function createWhatsAppTransport() {
  const { version: latestVersion } = await fetchLatestWaWebVersion();
  /** @type {[number, number, number]} */
  const version = [latestVersion[0], latestVersion[1], latestVersion[2]];
  log.info("Using WA Web version:", version);

  const confirmRuntime = createConfirmRuntime();
  const selectRuntime = createSelectRuntime();
  const reactionRuntime = createReactionRuntime();

  /** @type {{ current: import('@whiskeysockets/baileys').WASocket | null }} */
  const sockRef = { current: null };
  /** @type {(turn: ChatTurn) => Promise<void>} */
  let onTurn = async () => {};
  /** @type {ReturnType<typeof setTimeout> | null} */
  let qrExitTimer = null;
  let sessionResetInProgress = false;

  /**
   * Create a new socket, wire handlers, and swap it into the ref.
   * @returns {Promise<void>}
   */
  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sockRef.current = createSocket(state, version);
    registerHandlers(sockRef.current, saveCreds);
  }

  /**
   * Reconnect the socket using fresh auth state.
   * @returns {Promise<void>}
   */
  async function reconnect() {
    await connect();
  }

  /**
   * Register socket handlers on the current socket instance.
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   * @param {() => Promise<void>} saveCreds
   * @returns {void}
   */
  function registerHandlers(sock, saveCreds) {
    sock.ev.process(async (events) => {
      if (events["connection.update"]) {
        const update = events["connection.update"];
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          printQrCode(qr);
        }

        if (connection === "close") {
          const statusCode = /** @type {{ output?: { statusCode?: number } } | undefined} */ (lastDisconnect?.error)?.output?.statusCode;
          log.info("Connection closed due to ", lastDisconnect?.error, ", status code:", statusCode);

          if (needsAuthReset(lastDisconnect) && !sessionResetInProgress) {
            sessionResetInProgress = true;
            log.warn(`Auth failure (${statusCode}). Clearing auth and requesting re-pair...`);
            await rm(AUTH_DIR, { recursive: true, force: true });
            sendAlertEmail(
              `WhatsApp Bot: Auth failure (${statusCode})`,
              `The WhatsApp bot connection failed with status ${statusCode}.\n`
              + "Auth credentials have been cleared and a QR code is being displayed.\n"
              + "Please scan the QR code within 5 minutes or the process will exit.\n"
              + `Time: ${new Date().toISOString()}`,
            );
            sock.end(undefined);
            await reconnect();
            qrExitTimer = setTimeout(() => {
              log.error("QR code was not scanned within 5 minutes. Exiting.");
              process.exit(1);
            }, QR_TIMEOUT_MS);
          } else if (needsAuthReset(lastDisconnect) && sessionResetInProgress) {
            log.error(`Auth still failing (${statusCode}) after reset. Exiting.`);
            process.exit(1);
          } else if (statusCode !== 401) {
            sock.end(undefined);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await reconnect();
          }
        } else if (connection === "open") {
          if (qrExitTimer) {
            clearTimeout(qrExitTimer);
            qrExitTimer = null;
            sessionResetInProgress = false;
            log.info("QR code scanned successfully, exit timer cancelled.");
          }
          log.info("WhatsApp connection opened");
        }
      }

      if (events["creds.update"]) {
        await saveCreds();
      }

      if (events["messages.upsert"]) {
        const { messages } = events["messages.upsert"];
        for (const message of messages) {
          if (message.key.fromMe || !message.message) continue;

          const upsertReactions = normalizeUpsertReactionMessage(message);
          if (upsertReactions.length > 0) {
            confirmRuntime.handleReactions(upsertReactions, sock);
            reactionRuntime.handleReactions(upsertReactions);
            continue;
          }

          if (message.message.pollUpdateMessage) {
            try {
              const pollVoteEvent = await selectRuntime.resolvePollVoteMessage(message, sock);
              if (pollVoteEvent) {
                selectRuntime.handlePollVote(pollVoteEvent);
              }
            } catch (error) {
              log.error("Error processing poll vote from upsert:", error);
            }
            continue;
          }

          await adaptIncomingMessage(
            message,
            sock,
            onTurn,
            confirmRuntime,
            selectRuntime,
            reactionRuntime,
          );
        }
      }

      if (events["messages.reaction"]) {
        const normalized = normalizeReactionEvents(events["messages.reaction"]);
        confirmRuntime.handleReactions(normalized, sock);
        reactionRuntime.handleReactions(normalized);
      }
    });
  }

  return {
    async start(turnHandler) {
      onTurn = turnHandler;
      await connect();
    },

    async stop() {
      log.info("Cleaning up WhatsApp connection...");
      try {
        sockRef.current?.end(undefined);
      } catch (error) {
        log.error("Error during WhatsApp cleanup:", error);
      }
    },

    async sendText(chatId, text) {
      const sock = sockRef.current;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      await sock.sendMessage(chatId, { text });
    },
  };
}

/**
 * Compatibility wrapper for the previous adapter API.
 * @param {(message: ChatTurn) => Promise<void>} onMessage
 * @returns {Promise<{ closeWhatsapp: () => Promise<void>, sendToChat: (chatId: string, text: string) => Promise<void> }>}
 */
export async function connectToWhatsApp(onMessage) {
  const transport = await createWhatsAppTransport();
  await transport.start(onMessage);
  return {
    closeWhatsapp: transport.stop,
    sendToChat: transport.sendText,
  };
}

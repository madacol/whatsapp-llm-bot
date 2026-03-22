import { createLogger } from "../logger.js";
import { adaptIncomingMessage } from "./inbound/chat-turn.js";
import { createWhatsAppConnectionSupervisor } from "./connection-supervisor.js";
import { classifyIncomingMessageEvent, normalizeReactionEvents } from "./inbound/message-event-classifier.js";
import { createConfirmRuntime } from "./runtime/confirm-runtime.js";
import { createReactionRuntime } from "./runtime/reaction-runtime.js";
import { createSelectRuntime } from "./runtime/select-runtime.js";

const log = createLogger("whatsapp");

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
  const confirmRuntime = createConfirmRuntime();
  const selectRuntime = createSelectRuntime();
  const reactionRuntime = createReactionRuntime();

  /** @type {(turn: ChatTurn) => Promise<void>} */
  let onTurn = async () => {};

  /**
   * Clear all transport-owned runtime state and timers.
   * @returns {void}
   */
  function clearRuntimeState() {
    confirmRuntime.clear();
    selectRuntime.clear();
    reactionRuntime.clear();
  }

  const connectionSupervisor = await createWhatsAppConnectionSupervisor({
    onSocketReady: registerHandlers,
    onClearState: clearRuntimeState,
  });

  /**
   * Register socket handlers on the current socket instance.
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   * @param {() => Promise<void>} saveCreds
   * @returns {void}
   */
  function registerHandlers(sock, saveCreds) {
    sock.ev.process(async (events) => {
      if (connectionSupervisor.isStopped()) {
        return;
      }

      if (events["connection.update"]) {
        await connectionSupervisor.handleConnectionUpdate(events["connection.update"], sock);
      }

      if (events["creds.update"]) {
        await saveCreds();
      }

      if (events["messages.upsert"]) {
        const { messages } = events["messages.upsert"];
        for (const message of messages) {
          if (message.key.fromMe) continue;

          const incomingEvent = classifyIncomingMessageEvent(message);
          switch (incomingEvent.kind) {
            case "ignore":
              continue;
            case "reaction":
              confirmRuntime.handleReactions(incomingEvent.reactions, sock);
              reactionRuntime.handleReactions(incomingEvent.reactions);
              continue;
            case "poll_update":
              try {
                const pollVoteEvent = await selectRuntime.resolvePollVoteMessage(incomingEvent.message, sock);
                if (pollVoteEvent) {
                  selectRuntime.handlePollVote(pollVoteEvent);
                }
              } catch (error) {
                log.error("Error processing poll vote from upsert:", error);
              }
              continue;
            case "turn":
              await adaptIncomingMessage(
                incomingEvent.message,
                sock,
                onTurn,
                confirmRuntime,
                selectRuntime,
                reactionRuntime,
              );
              continue;
            default:
              continue;
          }
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
      await connectionSupervisor.start();
    },

    async stop() {
      onTurn = async () => {};
      await connectionSupervisor.stop();
    },

    async sendText(chatId, text) {
      await connectionSupervisor.sendText(chatId, text);
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

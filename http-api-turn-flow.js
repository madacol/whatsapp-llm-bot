import { createHttpTransportTurnLedger } from "./http-api-transport-ledger.js";

/**
 * @typedef {import("./http-api-transport-ledger.js").HttpApiLedgerTurnPayload} HttpApiLedgerTurnPayload
 * @typedef {import("./http-api-transport-ledger.js").HttpApiTurnRecord} HttpApiTurnRecord
 * @typedef {import("./http-api-transport-ledger.js").HttpApiOutboundEvent} HttpApiOutboundEvent
 *
 * @typedef {{
 *   write: (row: HttpApiOutboundEvent) => void,
 *   close?: () => void,
 * }} HttpApiEventStreamWriter
 *
 * @typedef {{
 *   chatId: string,
 *   writer: HttpApiEventStreamWriter,
 * }} HttpApiEventStreamClient
 */

/**
 * @param {((row: HttpApiOutboundEvent) => void) | HttpApiEventStreamWriter} writer
 * @returns {HttpApiEventStreamWriter}
 */
function normalizeStreamWriter(writer) {
  return typeof writer === "function" ? { write: writer } : writer;
}

/**
 * App-owned turn/event flow for the HTTP API Transport. The HTTP wire module
 * handles routing and response headers; this module owns turn records, active
 * turn correlation, event cursors, assistant text accumulation, and stream
 * fanout.
 * @param {import("./http-api-transport-ledger.js").HttpTransportTurnLedgerOptions & {
 *   onEvent?: (row: HttpApiOutboundEvent) => void,
 * }} [options]
 */
export function createHttpApiTurnFlow(options = {}) {
  const ledger = createHttpTransportTurnLedger(options);
  const onEvent = options.onEvent ?? (() => {});
  /** @type {Set<HttpApiEventStreamClient>} */
  const streamClients = new Set();

  /**
   * @param {string} chatId
   * @param {OutboundEvent} event
   * @param {string | null} turnId
   * @returns {HttpApiOutboundEvent}
   */
  function appendEvent(chatId, event, turnId) {
    const row = ledger.appendEvent(chatId, event, turnId);
    for (const client of streamClients) {
      if (client.chatId === chatId) {
        client.writer.write(row);
      }
    }
    onEvent(row);
    return row;
  }

  return {
    createOrGetTurn: ledger.createOrGetTurn,
    getTurn: ledger.getTurn,
    updateTurnStatus: ledger.updateTurnStatus,
    setActiveTurn: ledger.setActiveTurn,
    clearActiveTurn: ledger.clearActiveTurn,
    getActiveTurnId: ledger.getActiveTurnId,
    getLastEventId: ledger.getLastEventId,
    listEvents: ledger.listEvents,
    appendEvent,

    /**
     * @param {string} chatId
     * @param {string | null} turnId
     * @returns {ChannelInputIO}
     */
    createChannelInputIo(chatId, turnId) {
      return {
        send: async (event) => {
          appendEvent(chatId, event, turnId);
          return undefined;
        },
        reply: async (event) => {
          appendEvent(chatId, event, turnId);
          return undefined;
        },
        select: async () => "",
        selectMany: async () => ({ kind: "cancelled" }),
        confirm: async () => false,
        react: async () => {},
        getIsAdmin: async () => true,
        prepareMediaRegistry: () => {},
      };
    },

    /**
     * @param {string} chatId
     * @param {number} after
     * @param {((row: HttpApiOutboundEvent) => void) | HttpApiEventStreamWriter} writer
     * @returns {HttpApiEventStreamClient}
     */
    openEventStream(chatId, after, writer) {
      const normalizedWriter = normalizeStreamWriter(writer);
      for (const row of ledger.listEvents(chatId, after)) {
        normalizedWriter.write(row);
      }
      const client = { chatId, writer: normalizedWriter };
      streamClients.add(client);
      return client;
    },

    /**
     * @param {HttpApiEventStreamClient} client
     * @returns {void}
     */
    closeEventStream(client) {
      streamClients.delete(client);
    },

    /**
     * @returns {void}
     */
    closeEventStreams() {
      for (const client of streamClients) {
        client.writer.close?.();
      }
      streamClients.clear();
    },
  };
}

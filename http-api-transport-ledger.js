import { randomUUID } from "node:crypto";

const DEFAULT_MAX_EVENTS = 1000;

/**
 * @param {SendContent} content
 * @returns {string}
 */
function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      if ((block.type === "text" || block.type === "markdown") && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * @typedef {{
 *   eventId: string;
 *   turnId: string | null;
 *   chatId: string;
 *   kind: OutboundEvent["kind"];
 *   event: OutboundEvent;
 * }} HttpApiOutboundEvent
 *
 * @typedef {{
 *   turnId: string;
 *   requestId: string;
 *   transportId: string;
 *   chatId: string;
 *   status: "accepted" | "running" | "completed" | "failed" | "cancelled";
 *   createdAt: string;
 *   updatedAt: string;
 *   text: string;
 * }} HttpApiTurnRecord
 *
 * @typedef {{
 *   requestId: string;
 *   chatId: string;
 * }} HttpApiLedgerTurnPayload
 *
 * @typedef {{
 *   maxEvents?: number;
 *   createTurnId?: () => string;
 *   now?: () => string;
 * }} HttpTransportTurnLedgerOptions
 */

/**
 * @param {HttpTransportTurnLedgerOptions} [options]
 * @returns {{
 *   createOrGetTurn: (transportId: string, payload: HttpApiLedgerTurnPayload) => { created: boolean, record: HttpApiTurnRecord },
 *   getTurn: (turnId: string) => HttpApiTurnRecord | null,
 *   updateTurnStatus: (record: HttpApiTurnRecord, status: HttpApiTurnRecord["status"]) => void,
 *   appendEvent: (chatId: string, event: OutboundEvent, turnId: string | null) => HttpApiOutboundEvent,
 *   listEvents: (chatId: string, after: number) => HttpApiOutboundEvent[],
 *   setActiveTurn: (chatId: string, turnId: string) => void,
 *   clearActiveTurn: (chatId: string, turnId: string) => void,
 *   getActiveTurnId: (chatId: string) => string | null,
 *   getLastEventId: () => string,
 * }}
 */
export function createHttpTransportTurnLedger(options = {}) {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const createTurnId = options.createTurnId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  let nextEventId = 1;
  /** @type {HttpApiOutboundEvent[]} */
  const events = [];
  /** @type {Map<string, HttpApiTurnRecord>} */
  const turnsById = new Map();
  /** @type {Map<string, string>} */
  const turnIdByRequestKey = new Map();
  /** @type {Map<string, string>} */
  const activeTurnByChatId = new Map();

  /**
   * @param {string} transportId
   * @param {HttpApiLedgerTurnPayload} payload
   * @returns {HttpApiTurnRecord}
   */
  function createTurnRecord(transportId, payload) {
    const timestamp = now();
    return {
      turnId: createTurnId(),
      requestId: payload.requestId,
      transportId,
      chatId: payload.chatId,
      status: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
      text: "",
    };
  }

  return {
    createOrGetTurn(transportId, payload) {
      const requestKey = `${transportId}\u0000${payload.requestId}`;
      const existingTurnId = turnIdByRequestKey.get(requestKey);
      const existing = existingTurnId ? turnsById.get(existingTurnId) : null;
      if (existing) {
        return { created: false, record: existing };
      }

      const record = createTurnRecord(transportId, payload);
      turnsById.set(record.turnId, record);
      turnIdByRequestKey.set(requestKey, record.turnId);
      return { created: true, record };
    },

    getTurn(turnId) {
      return turnsById.get(turnId) ?? null;
    },

    updateTurnStatus(record, status) {
      record.status = status;
      record.updatedAt = now();
    },

    appendEvent(chatId, event, turnId) {
      const row = {
        eventId: String(nextEventId),
        turnId,
        chatId,
        kind: event.kind,
        event,
      };
      nextEventId += 1;
      events.push(row);
      while (events.length > maxEvents) {
        events.shift();
      }
      if (turnId) {
        const turn = turnsById.get(turnId);
        if (turn && event.kind === "content" && event.source === "llm") {
          const text = extractTextContent(event.content);
          if (text) {
            turn.text = turn.text ? `${turn.text}\n${text}` : text;
          }
        }
      }
      return row;
    },

    listEvents(chatId, after) {
      return events.filter((row) => row.chatId === chatId && Number(row.eventId) > after);
    },

    setActiveTurn(chatId, turnId) {
      activeTurnByChatId.set(chatId, turnId);
    },

    clearActiveTurn(chatId, turnId) {
      if (activeTurnByChatId.get(chatId) === turnId) {
        activeTurnByChatId.delete(chatId);
      }
    },

    getActiveTurnId(chatId) {
      return activeTurnByChatId.get(chatId) ?? null;
    },

    getLastEventId() {
      return String(nextEventId - 1);
    },
  };
}

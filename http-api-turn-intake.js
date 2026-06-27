import { withChannelIdentity } from "./conversation/channel-identity.js";

/**
 * @typedef {import("./http-api-transport-ledger.js").HttpApiTurnRecord} HttpApiTurnRecord
 * @typedef {import("./http-api-transport-ledger.js").HttpApiOutboundEvent} HttpApiOutboundEvent
 *
 * @typedef {{
 *   statusCode: number,
 *   body: Record<string, unknown>,
 * }} HttpApiTurnIntakeResponse
 */

/**
 * @param {HttpApiTurnRecord} record
 * @param {boolean} waitForCompletion
 * @returns {HttpApiTurnIntakeResponse}
 */
function duplicateTurnResponse(record, waitForCompletion) {
  const completedWait = waitForCompletion && record.status === "completed";
  return {
    statusCode: completedWait ? 200 : 202,
    body: {
      turnId: record.turnId,
      requestId: record.requestId,
      status: completedWait ? "completed" : "accepted",
      ...(completedWait ? { text: record.text } : {}),
    },
  };
}

/**
 * @param {HttpApiTurnRecord} record
 * @returns {Record<string, unknown>}
 */
function acceptedBody(record) {
  return {
    turnId: record.turnId,
    requestId: record.requestId,
    status: "accepted",
  };
}

/**
 * @param {{
 *   payload: {
 *     chatId: string,
 *     senderIds: string[],
 *     senderName: string,
 *     timestamp: Date,
 *     content: IncomingContentBlock[],
 *     facts: ChannelInputFacts,
 *   },
 *   record: HttpApiTurnRecord,
 *   turnFlow: ReturnType<typeof import("./http-api-turn-flow.js").createHttpApiTurnFlow>,
 * }} input
 * @returns {ChannelInput}
 */
function buildChannelInput({ payload, record, turnFlow }) {
  return withChannelIdentity({
    chatId: payload.chatId,
    senderIds: payload.senderIds,
    senderName: payload.senderName,
    chatName: payload.chatId,
    content: payload.content,
    timestamp: payload.timestamp,
    facts: payload.facts,
    io: turnFlow.createChannelInputIo(payload.chatId, record.turnId),
  });
}

/**
 * @param {{
 *   turnFlow: ReturnType<typeof import("./http-api-turn-flow.js").createHttpApiTurnFlow>,
 *   getBaseUrl?: () => string,
 *   log?: Pick<Console, "error">,
 * }} deps
 */
export function createHttpApiTurnIntake({
  turnFlow,
  getBaseUrl = () => "",
  log = console,
}) {
  void getBaseUrl;

  return {
    /**
     * @param {{
     *   transportId: string,
     *   payload: {
     *     requestId: string,
     *     chatId: string,
     *     senderIds: string[],
     *     senderName: string,
     *     timestamp: Date,
     *     content: IncomingContentBlock[],
     *     facts: ChannelInputFacts,
     *   },
     *   waitForCompletion: boolean,
     *   runTurn: (turn: ChannelInput) => Promise<void>,
     *   afterTurnCompleted?: (input: {
     *     payload: {
     *       requestId: string,
     *       chatId: string,
     *       senderIds: string[],
     *       senderName: string,
     *       timestamp: Date,
     *       content: IncomingContentBlock[],
     *       facts: ChannelInputFacts,
     *     },
     *     record: HttpApiTurnRecord,
     *     appendEvent: (chatId: string, event: OutboundEvent, turnId: string | null) => HttpApiOutboundEvent,
     *   }) => Promise<Record<string, unknown> | null | undefined>,
     * }} input
     * @returns {Promise<HttpApiTurnIntakeResponse>}
     */
    async submitTurn({
      transportId,
      payload,
      waitForCompletion,
      runTurn,
      afterTurnCompleted,
    }) {
      const ledgerTurn = turnFlow.createOrGetTurn(transportId, payload);
      if (!ledgerTurn.created) {
        return duplicateTurnResponse(ledgerTurn.record, waitForCompletion);
      }

      const record = ledgerTurn.record;
      const turn = buildChannelInput({ payload, record, turnFlow });

      /**
       * @returns {Promise<Record<string, unknown> | null>}
       */
      const run = async () => {
        turnFlow.setActiveTurn(payload.chatId, record.turnId);
        try {
          turnFlow.updateTurnStatus(record, "running");
          await runTurn(turn);
          const extra = await afterTurnCompleted?.({
            payload,
            record,
            appendEvent: turnFlow.appendEvent,
          });
          turnFlow.updateTurnStatus(record, "completed");
          return extra ?? null;
        } catch (error) {
          turnFlow.updateTurnStatus(record, "failed");
          log.error("HTTP API transport turn handler failed:", error);
          return null;
        } finally {
          turnFlow.clearActiveTurn(payload.chatId, record.turnId);
        }
      };

      if (!waitForCompletion) {
        void run();
        return {
          statusCode: 202,
          body: acceptedBody(record),
        };
      }

      const extraBody = await run();
      if (record.status === "failed") {
        return {
          statusCode: 500,
          body: {
            turnId: record.turnId,
            requestId: record.requestId,
            status: "failed",
          },
        };
      }

      return {
        statusCode: 200,
        body: {
          turnId: record.turnId,
          requestId: record.requestId,
          status: record.status,
          text: record.text,
          ...(extraBody ?? {}),
        },
      };
    },
  };
}

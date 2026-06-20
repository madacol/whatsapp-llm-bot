import {
  formatIngressError,
  isWhatsAppIngressPayload,
  WHATSAPP_INGRESS_SOURCE_UPSERT,
} from "./ingress-journal.js";

/**
 * @typedef {"done" | "ignored"} WhatsAppIngressDispatchResult
 */

/**
 * @param {{
 *   store: Pick<import("../../store.js").Store,
 *     "listDispatchableWhatsAppIngressJournalEntries"
 *     | "markWhatsAppIngressJournalRouting"
 *     | "markWhatsAppIngressJournalDone"
 *     | "markWhatsAppIngressJournalIgnored"
 *     | "markWhatsAppIngressJournalFailed"
 *     | "markWhatsAppIngressJournalDeadLetter"
 *   >,
 *   inboundDispatchReady?: Promise<void>,
 *   processUpsertMessage: (message: BaileysMessage) => Promise<WhatsAppIngressDispatchResult>,
 *   processReactionEvents: (reactions: unknown[]) => WhatsAppIngressDispatchResult,
 *   log: Pick<ReturnType<typeof import("../../logger.js").createLogger>, "error">,
 * }} input
 * @returns {{ scheduleDrain: () => void }}
 */
export function createWhatsAppIngressDispatcher(input) {
  const {
    store,
    processUpsertMessage,
    processReactionEvents,
    log,
  } = input;
  const inboundDispatchReady = input.inboundDispatchReady ?? Promise.resolve();
  /** @type {Set<number>} */
  const rowsInFlight = new Set();
  let drainScheduled = false;
  let isDispatchReady = false;

  void inboundDispatchReady.then(
    () => {
      isDispatchReady = true;
    },
    (error) => {
      isDispatchReady = true;
      log.error("WhatsApp inbound dispatch readiness failed; continuing ingress dispatch.", error);
    },
  );

  /**
   * @param {import("../../store.js").WhatsAppIngressJournalRow} row
   * @returns {Promise<void>}
   */
  async function processRow(row) {
    await store.markWhatsAppIngressJournalRouting(row.id);
    try {
      const payload = row.payload_json;
      if (!isWhatsAppIngressPayload(payload)) {
        await store.markWhatsAppIngressJournalDeadLetter(row.id, "Unsupported WhatsApp ingress payload.");
        return;
      }

      const result = payload.kind === WHATSAPP_INGRESS_SOURCE_UPSERT
        ? await processUpsertMessage(payload.message)
        : processReactionEvents(payload.reactions);
      if (result === "ignored") {
        await store.markWhatsAppIngressJournalIgnored(row.id);
      } else {
        await store.markWhatsAppIngressJournalDone(row.id);
      }
    } catch (error) {
      log.error("Error processing WhatsApp ingress journal row:", error);
      await store.markWhatsAppIngressJournalFailed(row.id, formatIngressError(error));
    }
  }

  function scheduleDrain() {
    if (drainScheduled) {
      return;
    }
    drainScheduled = true;
    setTimeout(() => {
      drainScheduled = false;
      void (async () => {
        if (!isDispatchReady) {
          await inboundDispatchReady.catch(() => {});
        }
        const rows = await store.listDispatchableWhatsAppIngressJournalEntries();
        for (const row of rows) {
          if (rowsInFlight.has(row.id)) {
            continue;
          }
          rowsInFlight.add(row.id);
          void processRow(row).finally(() => {
            rowsInFlight.delete(row.id);
          });
        }
      })().catch((error) => {
        log.error("Error draining WhatsApp ingress journal:", error);
      });
    }, 0);
  }

  return { scheduleDrain };
}

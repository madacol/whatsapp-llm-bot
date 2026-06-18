import { getHarnessRuntimeDiagnosticRaw, normalizeHarnessRuntimeEvent } from "./harness-runtime-events.js";

/**
 * Semantic harness adapter contract and runtime event stream helpers.
 */

/**
 * @typedef {{
 *   chatId: string,
 *   harnessName: string,
 *   instanceId: string,
 *   continuationKey: string,
 *   status: "starting" | "ready" | "running" | "stopped" | "error",
 *   workdir?: string | null,
 *   model?: string | null,
 *   resumeCursor?: string | null,
 *   capabilities?: HarnessCapabilities,
 * }} HarnessRuntimeSession
 */

/**
 * @typedef {{
 *   chatId: string,
 *   runConfig?: HarnessRunConfig,
 *   resumeCursor?: string | null,
 * }} HarnessStartSessionInput
 */

/**
 * @typedef {{
 *   chatId: string,
 * }} HarnessInterruptInput
 */

/**
 * @typedef {{
 *   startSession: (input: HarnessStartSessionInput) => Promise<HarnessRuntimeSession>,
 *   sendTurn: (input: HarnessTurnInput) => Promise<AgentResult>,
 *   interruptTurn: (input: HarnessInterruptInput) => Promise<boolean>,
 *   respondToRequest: (requestId: string, response: unknown) => Promise<boolean>,
 *   respondToUserInput: (requestId: string, response: unknown) => Promise<boolean>,
 *   injectMessage: (chatId: string | HarnessSessionRef, text: string) => Promise<boolean>,
 *   stopSession: (chatId: string | HarnessSessionRef) => Promise<boolean>,
 *   hasSession: (chatId: string | HarnessSessionRef) => boolean,
 *   stopAll: () => Promise<void>,
 *   listSessions: () => HarnessRuntimeSession[],
 *   rollbackThread: (sessionId: string, numTurns: number) => Promise<unknown | null>,
 *   streamEvents: AsyncIterable<{ type: string, provider: string } & Record<string, unknown>>,
 *   subscribeEvents?: (handler: (event: { type: string, provider: string } & Record<string, unknown>) => void | Promise<void>) => () => void,
 * }} HarnessAdapter
 */

/**
 * @param {string} provider
 * @param {Partial<import("./harness-runtime-events.js").HarnessRuntimeEventEnvelope> & import("./harness-runtime-events.js").HarnessRuntimeDiagnosticInput} [defaults]
 * @returns {{
 *   emit: (event: { type: string, provider?: string } & Record<string, unknown>) => void,
 *   subscribe: (handler: (event: { type: string, provider: string } & Record<string, unknown>) => void | Promise<void>) => () => void,
 *   stream: AsyncIterable<{ type: string, provider: string } & Record<string, unknown>>,
 * }}
 */
export function createHarnessEventStreamController(provider, defaults = {}) {
  /** @type {Set<(event: { type: string, provider: string } & Record<string, unknown>) => void | Promise<void>>} */
  const listeners = new Set();
  return {
    emit(event) {
      const normalized = normalizeHarnessRuntimeEvent({
        ...event,
        provider: event.provider ?? provider,
      }, defaults);
      const diagnosticRaw = getHarnessRuntimeDiagnosticRaw(
        /** @type {import("./harness-runtime-events.js").HarnessRuntimeDiagnosticInput} */ (event),
        defaults,
      );
      const streamEvent = diagnosticRaw ? { ...normalized, diagnosticRaw } : normalized;
      for (const listener of listeners) {
        void listener(streamEvent);
      }
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    stream: {
      async *[Symbol.asyncIterator]() {
        /** @type {Array<{ type: string, provider: string } & Record<string, unknown>>} */
        const queue = [];
        /** @type {(() => void) | null} */
        let notify = null;
        const listener = (/** @type {{ type: string, provider: string } & Record<string, unknown>} */ event) => {
          queue.push(event);
          notify?.();
          notify = null;
        };
        listeners.add(listener);
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise((resolve) => {
                notify = () => resolve(undefined);
              });
            }
            while (queue.length > 0) {
              const event = queue.shift();
              if (event) {
                yield event;
              }
            }
          }
        } finally {
          listeners.delete(listener);
        }
      },
    },
  };
}

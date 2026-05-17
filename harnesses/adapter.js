/**
 * Narrow adapter facade over the legacy AgentHarness contract.
 *
 * Provider-specific implementations can grow into this shape incrementally.
 * Existing harnesses are wrapped so callers can start depending on the
 * session/turn seam without forcing a provider rewrite in the same migration.
 */

/**
 * @typedef {{
 *   chatId: string,
 *   harnessName: string,
 *   instanceId: string,
 *   continuationKey: string,
 *   status: "ready" | "running" | "stopped",
 *   workdir?: string | null,
 *   model?: string | null,
 *   resumeCursor?: string | null,
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
 *   params: AgentHarnessParams,
 * }} HarnessSendTurnInput
 */

/**
 * @typedef {{
 *   chatId: string,
 * }} HarnessInterruptInput
 */

/**
 * @typedef {{
 *   name: string,
 *   instanceId: string,
 *   continuationKey: string,
 *   harness: AgentHarness,
 * }} CreateHarnessAdapterInput
 */

/**
 * @typedef {{
 *   startSession: (input: HarnessStartSessionInput) => Promise<HarnessRuntimeSession>,
 *   sendTurn: (input: HarnessSendTurnInput) => Promise<AgentResult>,
 *   interruptTurn: (input: HarnessInterruptInput) => Promise<boolean>,
 *   injectMessage: (chatId: string | HarnessSessionRef, text: string) => Promise<boolean>,
 *   stopSession: (chatId: string | HarnessSessionRef) => Promise<boolean>,
 *   listSessions: () => HarnessRuntimeSession[],
 *   readThread: (sessionId: string) => Promise<null>,
 *   rollbackThread: (sessionId: string, numTurns: number) => Promise<null>,
 *   streamEvents: AsyncIterable<never>,
 * }} HarnessAdapter
 */

/**
 * @returns {AsyncIterable<never>}
 */
function emptyEventStream() {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}

/**
 * @param {CreateHarnessAdapterInput} input
 * @returns {HarnessAdapter}
 */
export function createHarnessAdapterFromHarness(input) {
  /** @type {Map<string, HarnessRuntimeSession>} */
  const sessions = new Map();

  return {
    async startSession({ chatId, runConfig, resumeCursor }) {
      /** @type {HarnessRuntimeSession} */
      const session = {
        chatId,
        harnessName: input.name,
        instanceId: input.instanceId,
        continuationKey: input.continuationKey,
        status: "ready",
        workdir: runConfig?.workdir ?? null,
        model: runConfig?.model ?? null,
        ...(resumeCursor ? { resumeCursor } : {}),
      };
      sessions.set(chatId, session);
      return session;
    },
    async sendTurn({ params }) {
      const session = sessions.get(params.session.chatId);
      if (session) {
        sessions.set(params.session.chatId, { ...session, status: "running" });
      }
      try {
        return await input.harness.run(params);
      } finally {
        const current = sessions.get(params.session.chatId);
        if (current) {
          sessions.set(params.session.chatId, { ...current, status: "ready" });
        }
      }
    },
    async interruptTurn({ chatId }) {
      return !!(await input.harness.cancel?.(chatId));
    },
    async injectMessage(chatId, text) {
      return !!(await input.harness.injectMessage?.(chatId, text));
    },
    async stopSession(chatId) {
      const key = typeof chatId === "string" ? chatId : chatId.id;
      sessions.delete(key);
      return !!(await input.harness.cancel?.(chatId));
    },
    listSessions() {
      return [...sessions.values()];
    },
    async readThread(_sessionId) {
      return null;
    },
    async rollbackThread(_sessionId, _numTurns) {
      return null;
    },
    streamEvents: emptyEventStream(),
  };
}

/**
 * Semantic adapter facade over the legacy AgentHarness contract.
 *
 * Provider-specific implementations can grow into this shape incrementally.
 * Existing harnesses are wrapped at the registry boundary so callers depend on
 * session/turn semantics instead of app-shaped harness parameters.
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
 *   name: string,
 *   instanceId: string,
 *   continuationKey: string,
 *   harness: AgentHarness,
 * }} CreateHarnessAdapterInput
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
 *   readThread: (sessionId: string) => Promise<unknown | null>,
 *   rollbackThread: (sessionId: string, numTurns: number) => Promise<unknown | null>,
 *   streamEvents: AsyncIterable<{ type: string, provider: string } & Record<string, unknown>>,
 *   subscribeEvents?: (handler: (event: { type: string, provider: string } & Record<string, unknown>) => void | Promise<void>) => () => void,
 * }} HarnessAdapter
 */

/**
 * @param {string} provider
 * @returns {{
 *   emit: (event: { type: string, provider?: string } & Record<string, unknown>) => void,
 *   subscribe: (handler: (event: { type: string, provider: string } & Record<string, unknown>) => void | Promise<void>) => () => void,
 *   stream: AsyncIterable<{ type: string, provider: string } & Record<string, unknown>>,
 * }}
 */
export function createHarnessEventStreamController(provider) {
  /** @type {Set<(event: { type: string, provider: string } & Record<string, unknown>) => void | Promise<void>>} */
  const listeners = new Set();
  return {
    emit(event) {
      const normalized = {
        ...event,
        provider: event.provider ?? provider,
      };
      for (const listener of listeners) {
        void listener(normalized);
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

/**
 * @param {HarnessTurnInput} turn
 * @returns {AgentHarnessParams}
 */
function buildLegacyParamsFromSemanticTurn(turn) {
  const now = new Date();
  /**
   * @param {Message} messageData
   * @returns {import("../store.js").MessageRow}
   */
  const makeMessageRow = (messageData) => ({
    message_id: 0,
    chat_id: turn.chatId,
    sender_id: "",
    message_data: messageData,
    timestamp: now,
    display_key: null,
  });
  const messages = turn.messages ?? [
    {
      role: "user",
      content: turn.input
        ? [{ type: "text", text: turn.input }]
        : [],
    },
  ];
  return {
    session: {
      chatId: turn.chatId,
      senderIds: [],
      context: /** @type {ExecuteActionContext} */ ({
        chatId: turn.chatId,
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
      addMessage: async (_chatId, messageData) => makeMessageRow(messageData),
      updateToolMessage: async (_chatId, _toolCallId, messageData) => makeMessageRow(messageData),
      harnessSession: null,
      saveHarnessSession: async () => undefined,
    },
    llmConfig: {
      llmClient: /** @type {LlmClient} */ ({}),
      chatModel: "",
      externalInstructions: "",
      mediaToTextModels: {},
      toolRuntime: {
        listTools: () => [],
        getTool: async () => null,
        executeTool: async () => {
          throw new Error("Semantic harness adapter bridge cannot execute app tools.");
        },
      },
    },
    messages,
    mediaRegistry: new Map(),
    hooks: turn.hooks ?? {},
    runConfig: turn.runConfig,
  };
}

/**
 * @param {CreateHarnessAdapterInput} input
 * @returns {HarnessAdapter}
 */
export function createHarnessAdapterFromHarness(input) {
  /** @type {Map<string, HarnessRuntimeSession>} */
  const sessions = new Map();
  const events = createHarnessEventStreamController(input.name);

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
      events.emit({ type: "session.started", session });
      return session;
    },
    async sendTurn(turn) {
      const params = buildLegacyParamsFromSemanticTurn(turn);
      const session = sessions.get(params.session.chatId);
      if (session) {
        const running = /** @type {HarnessRuntimeSession} */ ({ ...session, status: "running" });
        sessions.set(params.session.chatId, running);
        events.emit({ type: "session.updated", session: running });
      }
      try {
        events.emit({
          type: "turn.started",
          turn: { id: params.session.chatId, chatId: params.session.chatId, status: "started" },
        });
        const result = await input.harness.run(params);
        events.emit({
          type: "turn.completed",
          turn: { id: params.session.chatId, chatId: params.session.chatId, status: "completed" },
        });
        return result;
      } finally {
        const current = sessions.get(params.session.chatId);
        if (current) {
          const ready = /** @type {HarnessRuntimeSession} */ ({ ...current, status: "ready" });
          sessions.set(params.session.chatId, ready);
          events.emit({ type: "session.updated", session: ready });
        }
      }
    },
    async interruptTurn({ chatId }) {
      return !!(await input.harness.cancel?.(chatId));
    },
    async respondToRequest() {
      return false;
    },
    async respondToUserInput() {
      return false;
    },
    async injectMessage(chatId, text) {
      return !!(await input.harness.injectMessage?.(chatId, text));
    },
    async stopSession(chatId) {
      const key = typeof chatId === "string" ? chatId : chatId.id;
      sessions.delete(key);
      events.emit({
        type: "session.stopped",
        session: {
          chatId: key,
          harnessName: input.name,
          instanceId: input.instanceId,
          continuationKey: input.continuationKey,
          status: "stopped",
        },
      });
      return !!(await input.harness.cancel?.(chatId));
    },
    hasSession(chatId) {
      const key = typeof chatId === "string" ? chatId : chatId.id;
      return sessions.has(key);
    },
    async stopAll() {
      const keys = [...sessions.keys()];
      sessions.clear();
      for (const key of keys) {
        await input.harness.cancel?.(key);
      }
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
    streamEvents: events.stream,
    subscribeEvents: events.subscribe,
  };
}

import { registerHarnessDriver } from "../harnesses/index.js";

/** @type {HarnessCapabilities} */
const DEFAULT_CAPABILITIES = {
  supportsResume: true,
  supportsCancel: false,
  supportsLiveInput: false,
  supportsApprovals: false,
  supportsWorkdir: true,
  supportsSandboxConfig: false,
  supportsModelSelection: false,
  supportsReasoningEffort: false,
  supportsSessionFork: false,
};

/** @type {HarnessUsage} */
export const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cost: 0,
};

/**
 * @typedef {{
 *   turns: HarnessTurnInput[],
 *   reset: () => void,
 * }} AcpTestHarnessState
 */

/**
 * @typedef {{
 *   provider: string,
 *   emitRuntimeEvent: (event: { type: string, provider?: string } & Record<string, unknown>) => Promise<void>,
 * }} AcpTestHarnessTurnContext
 */

/**
 * @typedef {{
 *   name: string,
 *   errorMessage?: string,
 *   state?: AcpTestHarnessState,
 *   capabilities?: Partial<HarnessCapabilities>,
 *   onSendTurn?: (input: HarnessTurnInput, context: AcpTestHarnessTurnContext) => Promise<AgentResult> | AgentResult,
 * }} AcpTestHarnessOptions
 */

/**
 * @returns {AcpTestHarnessState}
 */
export function createAcpTestHarnessState() {
  const state = {
    /** @type {HarnessTurnInput[]} */
    turns: [],
    reset() {
      state.turns.length = 0;
    },
  };
  return state;
}

/**
 * @param {AcpTestHarnessOptions} options
 * @returns {AcpTestHarnessState}
 */
export function registerAcpTestHarness(options) {
  const state = options.state ?? createAcpTestHarnessState();
  const capabilities = { ...DEFAULT_CAPABILITIES, ...(options.capabilities ?? {}) };
  const errorMessage = options.errorMessage ?? `${options.name} tests must use the semantic ACP adapter`;

  registerHarnessDriver({
    name: options.name,
    supportsInstances: true,
    createInstance: () => {
      /** @type {Set<(event: { type: string, provider: string } & Record<string, unknown>) => void | Promise<void>>} */
      const subscribers = new Set();

      /**
       * @param {{ type: string, provider?: string } & Record<string, unknown>} event
       * @returns {Promise<void>}
       */
      async function emitRuntimeEvent(event) {
        const normalizedEvent = { ...event, provider: event.provider ?? options.name };
        for (const subscriber of subscribers) {
          await subscriber(normalizedEvent);
        }
      }

      return {
        harness: {
          getName: () => options.name,
          getCapabilities: () => capabilities,
          run: async () => {
            throw new Error(errorMessage);
          },
          handleCommand: async () => false,
          listSlashCommands: () => [],
          createAdapter: ({ name, instanceId, continuationKey }) => ({
            startSession: async (input) => ({
              chatId: input.chatId,
              harnessName: name,
              instanceId,
              continuationKey,
              status: "ready",
              workdir: input.runConfig?.workdir ?? null,
              model: input.runConfig?.model ?? null,
              resumeCursor: input.resumeCursor ?? null,
            }),
            sendTurn: async (input) => {
              state.turns.push(input);
              if (options.onSendTurn) {
                return options.onSendTurn(input, {
                  provider: name,
                  emitRuntimeEvent,
                });
              }
              return {
                response: [{ type: "markdown", text: input.input ?? "" }],
                messages: input.messages ?? [],
                usage: ZERO_USAGE,
              };
            },
            interruptTurn: async () => false,
            respondToRequest: async () => false,
            respondToUserInput: async () => false,
            injectMessage: async () => false,
            stopSession: async () => false,
            hasSession: () => false,
            stopAll: async () => {},
            listSessions: () => [],
            readThread: async () => null,
            rollbackThread: async () => null,
            streamEvents: {
              async *[Symbol.asyncIterator]() {},
            },
            subscribeEvents: (handler) => {
              subscribers.add(handler);
              return () => {
                subscribers.delete(handler);
              };
            },
          }),
        },
      };
    },
  });

  return state;
}

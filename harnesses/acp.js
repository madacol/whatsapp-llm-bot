import { createHarnessEventStreamController } from "./adapter.js";
import { forkAcpSession, readAcpSession, rollbackAcpSession, startAcpRun } from "./acp-runner.js";
import { buildTextHarnessPromptFromBlocks } from "./prompt-media.js";
import { updateActiveHarnessConfig, getActiveHarnessConfig } from "../harness-config.js";
import { contentEvent } from "../outbound-events.js";
import { handleSessionControlCommand } from "../session-control-commands.js";

/** @type {HarnessCapabilities} */
const ACP_HARNESS_CAPABILITIES = {
  supportsResume: true,
  supportsCancel: true,
  supportsLiveInput: true,
  supportsApprovals: true,
  supportsWorkdir: true,
  supportsSandboxConfig: true,
  supportsModelSelection: true,
  supportsReasoningEffort: true,
  supportsSessionFork: true,
  supportsRollback: true,
  supportsUserInputRequests: true,
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeArgs(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];
}

/**
 * @param {Message[]} messages
 * @returns {string}
 */
function buildPrompt(messages) {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser) {
    return "";
  }
  return buildTextHarnessPromptFromBlocks(latestUser.content);
}

/**
 * @param {Record<string, unknown>} config
 * @param {string | undefined} defaultCommand
 * @returns {{ command: string, args: string[] }}
 */
function resolveAcpCommand(config, defaultCommand) {
  const command = typeof config.command === "string" && config.command.trim()
    ? config.command.trim()
    : defaultCommand;
  if (!command) {
    throw new Error("ACP harness requires a command in harness instance config.");
  }
  return {
    command,
    args: normalizeArgs(config.args),
  };
}

/**
 * @param {unknown} response
 * @returns {string | null}
 */
function extractRequestResponseText(response) {
  if (typeof response === "string") {
    return response;
  }
  if (!isRecord(response)) {
    return null;
  }
  for (const key of ["optionId", "label", "value", "selected"]) {
    const value = response[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

/**
 * @param {{
 *   name?: string,
 *   label?: string,
 *   sessionKind?: HarnessSessionRef["kind"],
 *   config?: Record<string, unknown>,
 *   defaultCommand?: string,
 * }} [options]
 * @returns {AgentHarness}
 */
export function createAcpHarness(options = {}) {
  const name = options.name ?? "acp";
  const label = options.label ?? name;
  const sessionKind = options.sessionKind ?? "native";
  const config = options.config ?? {};
  const commandSpec = resolveAcpCommand(config, options.defaultCommand);
  /** @type {Map<string, { abortController: AbortController, steer?: (text: string) => Promise<boolean>, setMode?: (mode: string) => Promise<boolean>, pendingRequests?: Map<string, (value: string | null) => void>, pendingUserInputs?: Map<string, (value: unknown) => void> }>} */
  const activeRuns = new Map();
  const commandHandler = createGenericAcpCommandHandler({
    harnessName: name,
    label,
    sessionKind,
    commandSpec,
    cancelActiveQuery: cancel,
  });

  return {
    getName: () => name,
    getCapabilities: () => ACP_HARNESS_CAPABILITIES,
    async run({ messages, hooks, runConfig }) {
      const prompt = buildPrompt(messages);
      if (!prompt) {
        return {
          response: [{ type: "text", text: "No input message found." }],
          messages,
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        };
      }
      const abortController = new AbortController();
      activeRuns.set("__legacy__", { abortController, pendingRequests: new Map(), pendingUserInputs: new Map() });
      try {
        const completed = await startAcpRun({
          ...commandSpec,
          prompt,
          messages,
          runConfig,
          hooks,
          signal: abortController.signal,
          onActiveRun: ({ connection, sessionId }) => {
            const active = activeRuns.get("__legacy__");
            if (!active) {
              return undefined;
            }
            active.steer = async (text) => {
              if (!sessionId) {
                return false;
              }
              await connection.sendRequest("session/steer", { sessionId, text });
              return true;
            };
            active.setMode = async (mode) => {
              if (!sessionId) {
                return false;
              }
              await connection.sendRequest("session/set_config_option", { sessionId, configId: "mode", value: mode });
              return true;
            };
            return () => {
              delete active.steer;
              delete active.setMode;
            };
          },
          requestDecision: createActiveRequestDecision("__legacy__"),
        });
        return completed.result;
      } finally {
        activeRuns.delete("__legacy__");
      }
    },
    handleCommand: commandHandler,
    listSlashCommands,
    cancel,
    createAdapter(input) {
      /** @type {Map<string, HarnessRuntimeSession>} */
      const sessions = new Map();
      /** @type {Map<string, HarnessRunConfig | undefined>} */
      const sessionRunConfigs = new Map();
      const events = createHarnessEventStreamController(name);
      return {
        async startSession({ chatId, runConfig, resumeCursor }) {
          /** @type {HarnessRuntimeSession} */
          const session = {
            chatId,
            harnessName: name,
            instanceId: input.instanceId,
            continuationKey: input.continuationKey,
            status: "ready",
            workdir: runConfig?.workdir ?? null,
            model: runConfig?.model ?? null,
            ...(resumeCursor ? { resumeCursor } : {}),
          };
          sessions.set(chatId, session);
          events.emit({ chatId, type: "session.started", session });
          return session;
        },
        async sendTurn(turn) {
          const prompt = turn.input?.trim() || buildPrompt(turn.messages ?? []);
          if (!prompt) {
            return {
              response: [{ type: "text", text: "No input message found." }],
              messages: turn.messages ?? [],
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
            };
          }
          const existing = sessions.get(turn.chatId);
          const sessionId = turn.resumeCursor ?? existing?.resumeCursor ?? null;
          const running = /** @type {HarnessRuntimeSession} */ ({
            ...(existing ?? {
              chatId: turn.chatId,
              harnessName: name,
              instanceId: input.instanceId,
              continuationKey: input.continuationKey,
            }),
            status: "running",
            workdir: turn.runConfig?.workdir ?? null,
            model: turn.runConfig?.model ?? null,
            ...(sessionId ? { resumeCursor: sessionId } : {}),
          });
          sessions.set(turn.chatId, running);
          events.emit({ chatId: turn.chatId, type: "session.updated", session: running });
          events.emit({
            chatId: turn.chatId,
            type: "turn.started",
            turn: { id: turn.chatId, chatId: turn.chatId, status: "started" },
          });
          const abortController = new AbortController();
          activeRuns.set(turn.chatId, { abortController, pendingRequests: new Map(), pendingUserInputs: new Map() });
          try {
            const completed = await startAcpRun({
              ...commandSpec,
              prompt,
              messages: turn.messages ?? [],
              sessionId,
              runConfig: turn.runConfig,
              hooks: turn.hooks,
              signal: abortController.signal,
              onActiveRun: ({ connection, sessionId }) => {
                const active = activeRuns.get(turn.chatId);
                if (!active) {
                  return undefined;
                }
                active.steer = async (text) => {
                  if (!sessionId) {
                    return false;
                  }
                  await connection.sendRequest("session/steer", { sessionId, text });
                  return true;
                };
                active.setMode = async (mode) => {
                  if (!sessionId) {
                    return false;
                  }
                  await connection.sendRequest("session/set_config_option", { sessionId, configId: "mode", value: mode });
                  return true;
                };
                return () => {
                  delete active.steer;
                  delete active.setMode;
                };
              },
              requestDecision: createActiveRequestDecision(turn.chatId),
              emitEvent: (event) => events.emit({ ...event, chatId: turn.chatId }),
            });
            const ready = /** @type {HarnessRuntimeSession} */ ({
              ...running,
              status: "ready",
              resumeCursor: completed.sessionId ?? sessionId ?? null,
            });
            sessions.set(turn.chatId, ready);
            if (ready.resumeCursor) {
              sessionRunConfigs.set(ready.resumeCursor, turn.runConfig);
            }
            events.emit({ chatId: turn.chatId, type: "session.updated", session: ready });
            events.emit({
              chatId: turn.chatId,
              type: "turn.completed",
              turn: { id: turn.chatId, chatId: turn.chatId, status: "completed" },
            });
            return completed.result;
          } finally {
            activeRuns.delete(turn.chatId);
          }
        },
        async interruptTurn({ chatId }) {
          const active = activeRuns.get(chatId);
          if (!active) {
            return false;
          }
          active.abortController.abort();
          activeRuns.delete(chatId);
          return true;
        },
        /**
         * @param {string} requestId
         * @param {unknown} response
         * @returns {Promise<boolean>}
         */
        async respondToRequest(requestId, response) {
          for (const active of activeRuns.values()) {
            const resolve = active.pendingRequests?.get(requestId);
            if (!resolve) {
              continue;
            }
            active.pendingRequests?.delete(requestId);
            resolve(extractRequestResponseText(response));
            return true;
          }
          return false;
        },
        /**
         * @param {string} requestId
         * @param {unknown} response
         * @returns {Promise<boolean>}
         */
        async respondToUserInput(requestId, response) {
          for (const active of activeRuns.values()) {
            const resolve = active.pendingUserInputs?.get(requestId);
            if (!resolve) {
              continue;
            }
            active.pendingUserInputs?.delete(requestId);
            resolve(response);
            return true;
          }
          return false;
        },
        async injectMessage(chatId, text) {
          const key = typeof chatId === "string" ? chatId : chatId.id;
          const active = activeRuns.get(key);
          if (!active?.steer) {
            return false;
          }
          try {
            return await active.steer(text);
          } catch {
            return false;
          }
        },
        async stopSession(chatId) {
          const key = typeof chatId === "string" ? chatId : chatId.id;
          sessions.delete(key);
          activeRuns.get(key)?.abortController.abort();
          activeRuns.delete(key);
          return true;
        },
        /**
         * @param {string | HarnessSessionRef} chatId
         * @returns {boolean}
         */
        hasSession(chatId) {
          const key = typeof chatId === "string" ? chatId : chatId.id;
          return sessions.has(key);
        },
        async stopAll() {
          for (const active of activeRuns.values()) {
            active.abortController.abort();
          }
          activeRuns.clear();
          sessions.clear();
        },
        listSessions: () => [...sessions.values()],
        readThread: async (sessionId) => readAcpSession({
          ...commandSpec,
          sessionId,
          includeTurns: true,
          runConfig: sessionRunConfigs.get(sessionId),
        }),
        rollbackThread: async (sessionId, numTurns) => rollbackAcpSession({
          ...commandSpec,
          sessionId,
          numTurns,
          runConfig: sessionRunConfigs.get(sessionId),
        }),
        streamEvents: events.stream,
        subscribeEvents: events.subscribe,
      };
    },
  };

  /**
   * @param {string | HarnessSessionRef} chatId
   * @returns {boolean}
   */
  function cancel(chatId) {
    const key = typeof chatId === "string" ? chatId : chatId.id;
    const active = activeRuns.get(key) ?? activeRuns.get("__legacy__");
    if (!active) {
      return false;
    }
    active.abortController.abort();
    activeRuns.delete(key);
    activeRuns.delete("__legacy__");
    return true;
  }

  /**
   * @param {string} chatId
   * @returns {(request: { id: string }) => Promise<string | null>}
   */
  function createActiveRequestDecision(chatId) {
    return async (request) => new Promise((resolve) => {
      const active = activeRuns.get(chatId);
      if (!active?.pendingRequests) {
        resolve(null);
        return;
      }
      active.pendingRequests.set(request.id, resolve);
    });
  }

  /**
   * @returns {SlashCommandDescriptor[]}
   */
  function listSlashCommands() {
    return [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
      { name: "fork", description: `Fork the current ${label} ACP session` },
      { name: "back", description: `Return to the previous ${label} ACP fork parent` },
      { name: "mode", description: `Show or set the ${label} ACP mode` },
      { name: "model", description: `Choose or set the ${label} model` },
      { name: "sandbox", description: "Alias of /permissions" },
      { name: "permissions", description: `Show or set the ${label} permissions mode` },
      { name: "approval", description: `Show or set the ${label} approval policy` },
    ];
  }
}

/**
 * @param {{
 *   harnessName: string,
 *   label: string,
 *   sessionKind: HarnessSessionRef["kind"],
 *   commandSpec: { command: string, args: string[] },
 *   cancelActiveQuery: (chatId: string | HarnessSessionRef) => boolean,
 * }} options
 * @returns {(input: HarnessCommandContext) => Promise<boolean>}
 */
function createGenericAcpCommandHandler(options) {
  return async (input) => {
    const handledSessionCommand = await handleSessionControlCommand({
      command: input.command,
      chatId: input.chatId,
      context: input.context,
      cancelActiveQuery: () => options.cancelActiveQuery(input.chatId),
      sessionControl: input.sessionControl,
    });
    if (handledSessionCommand) {
      return true;
    }

    const trimmed = input.command.trim();
    if (/^fork$/i.test(trimmed)) {
      const currentSessionId = input.chatInfo?.harness_session_id ?? null;
      const currentKind = input.chatInfo?.harness_session_kind ?? options.sessionKind;
      if (!currentSessionId || !input.sessionForkControl) {
        await input.context.reply(contentEvent("tool-result", `Can't fork yet. Start a ${options.label} ACP session first.`));
        return true;
      }
      try {
        const forkedSessionId = await forkAcpSession({
          ...options.commandSpec,
          sessionId: currentSessionId,
        });
        await input.sessionForkControl.push(input.chatId, {
          id: currentSessionId,
          kind: currentKind,
          label: `${options.label} ACP session`,
        });
        await input.sessionForkControl.save(input.chatId, { id: forkedSessionId, kind: currentKind });
        await input.context.reply(contentEvent("tool-result", `Forked ${options.label} ACP session. You are now in a side thread. Use \`/back\` to return.`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await input.context.reply(contentEvent("tool-result", `${options.label} ACP fork failed: ${message}`));
        return true;
      }
    }

    if (/^back$/i.test(trimmed)) {
      if (!input.sessionForkControl) {
        await input.context.reply(contentEvent("tool-result", "No parent fork to return to."));
        return true;
      }
      const parent = await input.sessionForkControl.pop(input.chatId);
      if (!parent) {
        await input.context.reply(contentEvent("tool-result", "No parent fork to return to."));
        return true;
      }
      await input.sessionForkControl.save(input.chatId, { id: parent.id, kind: parent.kind });
      await input.context.reply(contentEvent("tool-result", `Returned to previous ${options.label} ACP session${parent.label ? `: ${parent.label}` : ""}.`));
      return true;
    }

    const modeMatch = trimmed.match(/^mode(?:\s+(.+))?$/i);
    if (modeMatch) {
      const arg = modeMatch[1]?.trim() ?? null;
      if (!arg) {
        const config = await getActiveHarnessConfig(input.chatId, options.harnessName);
        const mode = typeof config.mode === "string" ? config.mode : "default";
        await input.context.reply(contentEvent("tool-result", `${options.label} mode: \`${mode}\``));
        return true;
      }
      const lowered = arg.toLowerCase();
      if (lowered === "off" || lowered === "default" || lowered === "none") {
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { mode: null });
        await input.context.reply(contentEvent("tool-result", `${options.label} mode reset to default.`));
        return true;
      }
      await updateActiveHarnessConfig(input.chatId, options.harnessName, { mode: arg });
      await input.context.reply(contentEvent("tool-result", `${options.label} mode set to \`${arg}\``));
      return true;
    }

    const modelMatch = trimmed.match(/^model(?:\s+(.+))?$/i);
    if (modelMatch) {
      const arg = modelMatch[1]?.trim() ?? null;
      if (!arg) {
        const config = await getActiveHarnessConfig(input.chatId, options.harnessName);
        const model = typeof config.model === "string" ? config.model : "default";
        const effort = typeof config.reasoningEffort === "string" ? config.reasoningEffort : "default";
        await input.context.reply(contentEvent("tool-result", `${options.label} model: \`${model}\`\n${options.label} effort: \`${effort}\``));
        return true;
      }
      const effortMatch = arg.match(/^effort\s+(.+)$/i);
      if (effortMatch) {
        const effort = effortMatch[1].trim().toLowerCase();
        if (effort === "off" || effort === "default" || effort === "none") {
          await updateActiveHarnessConfig(input.chatId, options.harnessName, { reasoningEffort: null });
          await input.context.reply(contentEvent("tool-result", `${options.label} effort reset to default.`));
          return true;
        }
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { reasoningEffort: effort });
        await input.context.reply(contentEvent("tool-result", `${options.label} effort set to \`${effort}\``));
        return true;
      }
      const modelReset = arg.toLowerCase();
      if (modelReset === "off" || modelReset === "default" || modelReset === "none") {
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { model: null });
        await input.context.reply(contentEvent("tool-result", `${options.label} model reset to default.`));
        return true;
      }
      await updateActiveHarnessConfig(input.chatId, options.harnessName, { model: arg });
      await input.context.reply(contentEvent("tool-result", `${options.label} model set to \`${arg}\``));
      return true;
    }

    const permissionsMatch = trimmed.match(/^(?:permissions|sandbox)(?:\s+(.+))?$/i);
    if (permissionsMatch) {
      const arg = permissionsMatch[1]?.trim().toLowerCase() ?? null;
      if (arg) {
        if (arg === "off" || arg === "default" || arg === "none") {
          await updateActiveHarnessConfig(input.chatId, options.harnessName, { sandboxMode: null });
          await input.context.reply(contentEvent("tool-result", `${options.label} permissions reset to default.`));
          return true;
        }
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { sandboxMode: arg });
        await input.context.reply(contentEvent("tool-result", `${options.label} permissions set to \`${arg}\``));
        return true;
      }
      const config = await getActiveHarnessConfig(input.chatId, options.harnessName);
      const permissions = typeof config.sandboxMode === "string" ? config.sandboxMode : "default";
      await input.context.reply(contentEvent("tool-result", `${options.label} permissions: \`${permissions}\``));
      return true;
    }

    const approvalMatch = trimmed.match(/^(?:approval|approvals)(?:\s+(.+))?$/i);
    if (approvalMatch) {
      const arg = approvalMatch[1]?.trim().toLowerCase() ?? null;
      if (arg) {
        if (arg === "off" || arg === "default" || arg === "none") {
          await updateActiveHarnessConfig(input.chatId, options.harnessName, { approvalPolicy: null });
          await input.context.reply(contentEvent("tool-result", `${options.label} approval policy reset to default.`));
          return true;
        }
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { approvalPolicy: arg });
        await input.context.reply(contentEvent("tool-result", `${options.label} approval policy set to \`${arg}\``));
        return true;
      }
      const config = await getActiveHarnessConfig(input.chatId, options.harnessName);
      const approval = typeof config.approvalPolicy === "string" ? config.approvalPolicy : "default";
      await input.context.reply(contentEvent("tool-result", `${options.label} approval policy: \`${approval}\``));
      return true;
    }

    return false;
  };
}

/**
 * @param {Record<string, unknown>} config
 * @param {string | undefined} defaultCommand
 * @returns {Record<string, unknown>}
 */
export function normalizeAcpHarnessConfig(config, defaultCommand) {
  const normalized = isRecord(config) ? { ...config } : {};
  if (typeof normalized.command !== "string" && defaultCommand) {
    normalized.command = defaultCommand;
  }
  normalized.args = normalizeArgs(normalized.args);
  return normalized;
}

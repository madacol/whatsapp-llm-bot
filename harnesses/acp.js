import { createHarnessEventStreamController } from "./adapter.js";
import { forkAcpSession, startAcpRun } from "./acp-runner.js";
import { buildTextHarnessPromptFromBlocks } from "./prompt-media.js";
import { updateHarnessConfig, getHarnessConfig } from "../harness-config.js";
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
  supportsReasoningEffort: false,
  supportsSessionFork: true,
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
 * @param {{
 *   name?: string,
 *   config?: Record<string, unknown>,
 *   defaultCommand?: string,
 * }} [options]
 * @returns {AgentHarness}
 */
export function createAcpHarness(options = {}) {
  const name = options.name ?? "acp";
  const config = options.config ?? {};
  const commandSpec = resolveAcpCommand(config, options.defaultCommand);
  /** @type {Map<string, { abortController: AbortController, steer?: (text: string) => Promise<boolean> }>} */
  const activeRuns = new Map();
  const commandHandler = createGenericAcpCommandHandler({
    harnessName: name,
    label: getHarnessDisplayLabel(name),
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
      activeRuns.set("__legacy__", { abortController });
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
            return () => {
              delete active.steer;
            };
          },
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
          activeRuns.set(turn.chatId, { abortController });
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
                return () => {
                  delete active.steer;
                };
              },
              emitEvent: (event) => events.emit({ ...event, chatId: turn.chatId }),
            });
            const ready = /** @type {HarnessRuntimeSession} */ ({
              ...running,
              status: "ready",
              resumeCursor: completed.sessionId ?? sessionId ?? null,
            });
            sessions.set(turn.chatId, ready);
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
          return true;
        },
        listSessions: () => [...sessions.values()],
        readThread: async () => null,
        rollbackThread: async () => null,
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
   * @returns {SlashCommandDescriptor[]}
   */
  function listSlashCommands() {
    return [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
      { name: "fork", description: `Fork the current ${getHarnessDisplayLabel(name)} ACP session` },
      { name: "back", description: `Return to the previous ${getHarnessDisplayLabel(name)} ACP fork parent` },
      { name: "model", description: `Choose or set the ${getHarnessDisplayLabel(name)} model` },
      { name: "sandbox", description: "Alias of /permissions" },
      { name: "permissions", description: `Show or set the ${getHarnessDisplayLabel(name)} permissions mode` },
      { name: "approval", description: `Show or set the ${getHarnessDisplayLabel(name)} approval policy` },
    ];
  }
}

/**
 * @param {string} harnessName
 * @returns {string}
 */
function getHarnessDisplayLabel(harnessName) {
  if (harnessName === "codex") return "Codex";
  if (harnessName === "claude-agent-sdk") return "Claude";
  if (harnessName === "pi") return "Pi";
  return "ACP";
}

/**
 * @param {string} harnessName
 * @returns {HarnessSessionRef["kind"]}
 */
function getHarnessSessionKind(harnessName) {
  if (harnessName === "claude-agent-sdk") return "claude-sdk";
  if (harnessName === "codex") return "codex";
  if (harnessName === "pi") return "pi";
  return "native";
}

/**
 * @param {{
 *   harnessName: string,
 *   label: string,
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
      const currentKind = input.chatInfo?.harness_session_kind ?? getHarnessSessionKind(options.harnessName);
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

    const modelMatch = trimmed.match(/^model(?:\s+(.+))?$/i);
    if (modelMatch) {
      const arg = modelMatch[1]?.trim() ?? null;
      if (!arg) {
        const config = await getHarnessConfig(input.chatId, options.harnessName);
        const model = typeof config.model === "string" ? config.model : "default";
        const effort = typeof config.reasoningEffort === "string" ? config.reasoningEffort : "default";
        await input.context.reply(contentEvent("tool-result", `${options.label} model: \`${model}\`\n${options.label} effort: \`${effort}\``));
        return true;
      }
      const effortMatch = arg.match(/^effort\s+(.+)$/i);
      if (effortMatch) {
        const effort = effortMatch[1].trim().toLowerCase();
        if (effort === "off" || effort === "default" || effort === "none") {
          await updateHarnessConfig(input.chatId, options.harnessName, { reasoningEffort: null });
          await input.context.reply(contentEvent("tool-result", `${options.label} effort reset to default.`));
          return true;
        }
        await updateHarnessConfig(input.chatId, options.harnessName, { reasoningEffort: effort });
        await input.context.reply(contentEvent("tool-result", `${options.label} effort set to \`${effort}\``));
        return true;
      }
      const model = arg.toLowerCase();
      if (model === "off" || model === "default" || model === "none") {
        await updateHarnessConfig(input.chatId, options.harnessName, { model: null });
        await input.context.reply(contentEvent("tool-result", `${options.label} model reset to default.`));
        return true;
      }
      await updateHarnessConfig(input.chatId, options.harnessName, { model });
      await input.context.reply(contentEvent("tool-result", `${options.label} model set to \`${model}\``));
      return true;
    }

    const permissionsMatch = trimmed.match(/^(?:permissions|sandbox)(?:\s+(.+))?$/i);
    if (permissionsMatch) {
      const arg = permissionsMatch[1]?.trim().toLowerCase() ?? null;
      if (arg) {
        if (arg === "off" || arg === "default" || arg === "none") {
          await updateHarnessConfig(input.chatId, options.harnessName, { sandboxMode: null });
          await input.context.reply(contentEvent("tool-result", `${options.label} permissions reset to default.`));
          return true;
        }
        await updateHarnessConfig(input.chatId, options.harnessName, { sandboxMode: arg });
        await input.context.reply(contentEvent("tool-result", `${options.label} permissions set to \`${arg}\``));
        return true;
      }
      const config = await getHarnessConfig(input.chatId, options.harnessName);
      const permissions = typeof config.sandboxMode === "string" ? config.sandboxMode : "default";
      await input.context.reply(contentEvent("tool-result", `${options.label} permissions: \`${permissions}\``));
      return true;
    }

    const approvalMatch = trimmed.match(/^(?:approval|approvals)(?:\s+(.+))?$/i);
    if (approvalMatch) {
      const arg = approvalMatch[1]?.trim().toLowerCase() ?? null;
      if (arg) {
        if (arg === "off" || arg === "default" || arg === "none") {
          await updateHarnessConfig(input.chatId, options.harnessName, { approvalPolicy: null });
          await input.context.reply(contentEvent("tool-result", `${options.label} approval policy reset to default.`));
          return true;
        }
        await updateHarnessConfig(input.chatId, options.harnessName, { approvalPolicy: arg });
        await input.context.reply(contentEvent("tool-result", `${options.label} approval policy set to \`${arg}\``));
        return true;
      }
      const config = await getHarnessConfig(input.chatId, options.harnessName);
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

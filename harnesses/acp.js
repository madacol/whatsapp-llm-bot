import { createHarnessEventStreamController } from "./adapter.js";
import { deriveAcpHarnessCapabilities, hasAcpSessionCapability } from "./acp-capabilities.js";
import {
  compactAcpSession,
  forkAcpSession,
  getAcpInitialSessionControlState,
  getAcpInitialSessionConfigOptions,
  getAcpSessionControlState,
  getAcpSessionConfigOptions,
  rollbackAcpSession,
  setAcpSessionConfigOption,
  setAcpSessionModel,
  startAcpRun,
} from "./acp-runner.js";
import { buildTextHarnessPromptFromBlocks } from "./prompt-media.js";
import { formatCodexStatusForReply, readCodexCliStatus } from "./codex-cli-status.js";
import { updateActiveHarnessConfig, getActiveHarnessConfig } from "../harness-config.js";
import { createAppOutputPort } from "../app-output-port.js";
import { handleSessionControlCommand } from "../session-control-commands.js";
import { createLogger } from "../logger.js";

const log = createLogger("harness:acp");

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
 * @param {unknown} value
 * @returns {NodeJS.ProcessEnv | undefined}
 */
function normalizeEnv(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      env[key] = raw;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
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
  return buildTextHarnessPromptFromBlocks(latestUser.content, { includeMediaReferences: false });
}

/**
 * @param {IncomingContentBlock[]} blocks
 * @param {IncomingContentBlock[]} attachments
 * @returns {void}
 */
function collectAttachmentBlocks(blocks, attachments) {
  for (const block of blocks) {
    if (block.type === "quote") {
      collectAttachmentBlocks(block.content, attachments);
      continue;
    }
    if (block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file") {
      attachments.push(block);
    }
  }
}

/**
 * @param {Message[]} messages
 * @returns {IncomingContentBlock[]}
 */
function getLatestUserAttachments(messages) {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser) {
    return [];
  }
  /** @type {IncomingContentBlock[]} */
  const attachments = [];
  collectAttachmentBlocks(latestUser.content, attachments);
  return attachments;
}

/**
 * @param {Record<string, unknown>} config
 * @param {string | undefined} defaultCommand
 * @returns {{ command: string, args: string[], env?: NodeJS.ProcessEnv }}
 */
function resolveAcpCommand(config, defaultCommand) {
  const command = typeof config.command === "string" && config.command.trim()
    ? config.command.trim()
    : defaultCommand;
  if (!command) {
    throw new Error("ACP harness requires a command in harness instance config.");
  }
  const env = normalizeEnv(config.env);
  return {
    command,
    args: normalizeArgs(config.args),
    ...(env ? { env } : {}),
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
 * @param {{ steer?: (text: string) => Promise<boolean>, setMode?: (mode: string) => Promise<boolean> }} active
 * @param {{
 *   connection: Awaited<ReturnType<typeof import("./acp-client.js").openAcpConnection>>,
 *   sessionId: string | null,
 *   capabilities: Record<string, unknown>,
 * }} input
 * @returns {() => void}
 */
function installActiveAcpRunControls(active, input) {
  active.steer = async (text) => {
    if (!input.sessionId || !hasAcpSessionCapability(input.capabilities, "steer")) {
      return false;
    }
    await input.connection.sendRequest("session/steer", { sessionId: input.sessionId, text });
    return true;
  };
  active.setMode = async (mode) => {
    if (!input.sessionId) {
      return false;
    }
    await input.connection.sendRequest("session/set_config_option", { sessionId: input.sessionId, configId: "mode", value: mode });
    return true;
  };
  return () => {
    delete active.steer;
    delete active.setMode;
  };
}

/**
 * @returns {{ promise: Promise<void>, resolve: () => void }}
 */
function createActiveRunCompletion() {
  /** @type {() => void} */
  let resolve = () => {};
  /** @type {Promise<void>} */
  const promise = new Promise((innerResolve) => {
    resolve = () => innerResolve(undefined);
  });
  return { promise, resolve };
}

/**
 * @param {{
 *   name?: string,
 *   label?: string,
 *   sessionKind?: HarnessSessionRef["kind"],
 *   config?: Record<string, unknown>,
 *   defaultCommand?: string,
 *   readCodexStatus?: () => Promise<string>,
 *   startRun?: typeof startAcpRun,
 * }} [options]
 * @returns {AgentHarness}
 */
export function createAcpHarness(options = {}) {
  const name = options.name ?? "acp";
  const label = options.label ?? name;
  const sessionKind = options.sessionKind ?? "native";
  const config = options.config ?? {};
  const commandSpec = resolveAcpCommand(config, options.defaultCommand);
  const startRun = options.startRun ?? startAcpRun;
  /** @type {Map<string, { abortController: AbortController, completed: Promise<void>, steer?: (text: string) => Promise<boolean>, setMode?: (mode: string) => Promise<boolean>, pendingRequests?: Map<string, (value: string | null) => void>, pendingUserInputs?: Map<string, (value: unknown) => void> }>} */
  const activeRuns = new Map();
  const commandHandler = createGenericAcpCommandHandler({
    harnessName: name,
    label,
    sessionKind,
    commandSpec,
    cancelActiveQuery: cancel,
    ...(sessionKind === "codex" ? { readCodexStatus: options.readCodexStatus ?? (() => readCodexCliStatus({ workdir: process.cwd() })) } : {}),
  });

  return {
    getName: () => name,
    getCapabilities: () => ACP_HARNESS_CAPABILITIES,
    listActiveSessions: () => [...activeRuns.keys()].filter((chatId) => chatId !== "__legacy__"),
    async waitForIdle() {
      const entries = [...activeRuns.entries()].filter(([chatId]) => chatId !== "__legacy__");
      await Promise.all(entries.map(([, active]) => active.completed.catch(() => {})));
      return entries.map(([chatId]) => chatId);
    },
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
      const completion = createActiveRunCompletion();
      activeRuns.set("__legacy__", {
        abortController,
        completed: completion.promise,
        pendingRequests: new Map(),
        pendingUserInputs: new Map(),
      });
      try {
        const completed = await startRun({
          ...commandSpec,
          prompt,
          attachments: getLatestUserAttachments(messages),
          messages,
          runConfig,
          hooks,
          signal: abortController.signal,
          onActiveRun: ({ connection, sessionId, capabilities }) => {
            const active = activeRuns.get("__legacy__");
            if (!active) {
              return undefined;
            }
            return installActiveAcpRunControls(active, { connection, sessionId, capabilities });
          },
          requestDecision: createActiveRequestDecision("__legacy__"),
          userInputDecision: createActiveUserInputDecision("__legacy__"),
        });
        return completed.result;
      } finally {
        activeRuns.delete("__legacy__");
        completion.resolve();
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
      const events = createHarnessEventStreamController(name, {
        providerInstanceId: input.instanceId,
      });
      return {
        async startSession({ chatId, runConfig, resumeCursor }) {
          log.info("ACP adapter startSession", {
            name,
            chatId,
            instanceId: input.instanceId,
            resumeCursor: resumeCursor ?? null,
            workdir: runConfig?.workdir ?? null,
          });
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
          const turnId = turn.turnId ?? turn.chatId;
          const prompt = turn.input?.trim() || buildPrompt(turn.messages ?? []);
          log.info("ACP adapter sendTurn starting", {
            name,
            chatId: turn.chatId,
            instanceId: input.instanceId,
            turnId,
            promptLength: prompt.length,
            messageCount: turn.messages?.length ?? 0,
            resumeCursor: turn.resumeCursor ?? null,
          });
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
          events.emit({ chatId: turn.chatId, type: "session.updated", turnId, session: running });
          events.emit({
            chatId: turn.chatId,
            type: "turn.started",
            turnId,
            turn: { id: turnId, chatId: turn.chatId, status: "started" },
          });
          const abortController = new AbortController();
          const completion = createActiveRunCompletion();
          activeRuns.set(turn.chatId, {
            abortController,
            completed: completion.promise,
            pendingRequests: new Map(),
            pendingUserInputs: new Map(),
          });
          try {
            log.info("ACP startAcpRun starting", {
              name,
              chatId: turn.chatId,
              instanceId: input.instanceId,
              turnId,
              sessionId,
            });
            const completed = await startRun({
              ...commandSpec,
              prompt,
              attachments: turn.attachments ?? getLatestUserAttachments(turn.messages ?? []),
              messages: turn.messages ?? [],
              sessionId,
              runConfig: turn.runConfig,
              hooks: turn.hooks,
              dispatchRuntimeEventsToHooks: false,
              signal: abortController.signal,
              onActiveRun: ({ connection, sessionId, capabilities }) => {
                const active = activeRuns.get(turn.chatId);
                if (!active) {
                  return undefined;
                }
                return installActiveAcpRunControls(active, { connection, sessionId, capabilities });
              },
              requestDecision: createActiveRequestDecision(turn.chatId),
              userInputDecision: createActiveUserInputDecision(turn.chatId),
              emitEvent: (event) => events.emit({ ...event, chatId: turn.chatId, turnId }),
            });
            log.info("ACP startAcpRun completed", {
              name,
              chatId: turn.chatId,
              instanceId: input.instanceId,
              turnId,
              sessionId: completed.sessionId ?? sessionId ?? null,
              responseBlocks: completed.result.response.length,
            });
            const ready = /** @type {HarnessRuntimeSession} */ ({
              ...running,
              status: "ready",
              resumeCursor: completed.sessionId ?? sessionId ?? null,
              capabilities: deriveAcpHarnessCapabilities(ACP_HARNESS_CAPABILITIES, completed.capabilities),
            });
            sessions.set(turn.chatId, ready);
            if (ready.resumeCursor) {
              sessionRunConfigs.set(ready.resumeCursor, turn.runConfig);
            }
            events.emit({ chatId: turn.chatId, type: "session.updated", turnId, session: ready });
            events.emit({
              chatId: turn.chatId,
              type: "turn.completed",
              turnId,
              turn: { id: turnId, chatId: turn.chatId, status: "completed" },
            });
            return completed.result;
          } finally {
            activeRuns.delete(turn.chatId);
            completion.resolve();
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
        compactThread: async (sessionId) => compactAcpSession({
          ...commandSpec,
          sessionId,
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
   * @param {string} chatId
   * @returns {(request: import("./harness-runtime-events.js").HarnessRuntimeUserInputRequest) => Promise<unknown>}
   */
  function createActiveUserInputDecision(chatId) {
    return async (request) => new Promise((resolve) => {
      const active = activeRuns.get(chatId);
      if (!active?.pendingUserInputs) {
        resolve(null);
        return;
      }
      active.pendingUserInputs.set(request.id, resolve);
    });
  }

  /**
   * @returns {SlashCommandDescriptor[]}
   */
  function listSlashCommands() {
    return [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
      ...(sessionKind === "codex" ? [{ name: "status", description: "Show Codex CLI status and usage" }] : []),
      { name: "compact", description: `Compact the current ${label} ACP session context` },
      { name: "fork", description: `Fork the current ${label} ACP session` },
      { name: "back", description: `Return to the previous ${label} ACP fork parent` },
      { name: "config", description: `Show or set ${label} ACP config options` },
      { name: "mode", description: `Show or set the ${label} ACP mode` },
      { name: "model", description: `Choose or set the ${label} model` },
      { name: "sandbox", description: "Alias of /permissions" },
      { name: "permissions", description: `Show or set the ${label} permissions mode` },
      { name: "approval", description: `Show or set the ${label} approval policy` },
    ];
  }
}

/**
 * @param {Record<string, unknown>} option
 * @returns {Array<{ id: string, label: string, description?: string }>}
 */
function configOptionValues(option) {
  if (option.type === "boolean") {
    return [
      { id: "true", label: "true" },
      { id: "false", label: "false" },
    ];
  }
  if (!Array.isArray(option.options)) {
    return [];
  }
  return option.options
    .filter(isRecord)
    .map((value) => ({
      id: typeof value.value === "string" ? value.value : String(value.value ?? ""),
      label: typeof value.name === "string" ? value.name : String(value.value ?? ""),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    }))
    .filter((value) => value.id.length > 0);
}

/**
 * @param {Record<string, unknown>[]} options
 * @param {"model" | "thought_level" | "mode"} category
 * @returns {Record<string, unknown> | null}
 */
function findConfigOptionByCategory(options, category) {
  const categoryMatch = options.find((option) => option.category === category);
  if (categoryMatch) {
    return categoryMatch;
  }
  const fallbackNames = category === "model"
    ? ["model"]
    : category === "mode" ? ["mode"] : ["effort", "reasoning", "thought"];
  return options.find((option) => {
    const id = typeof option.id === "string" ? option.id.toLowerCase() : "";
    const name = typeof option.name === "string" ? option.name.toLowerCase() : "";
    return fallbackNames.some((candidate) => id.includes(candidate) || name.includes(candidate));
  }) ?? null;
}

/**
 * @param {Record<string, unknown>[]} options
 * @returns {Record<string, unknown> | null}
 */
function findFastModeConfigOption(options) {
  const categoryMatch = options.find((option) => option.category === "fast_mode" || option.category === "fast-mode");
  if (categoryMatch) {
    return categoryMatch;
  }
  return options.find((option) => {
    const id = typeof option.id === "string" ? option.id.toLowerCase() : "";
    const name = typeof option.name === "string" ? option.name.toLowerCase() : "";
    return id.includes("fast") || name.includes("fast");
  }) ?? null;
}

/**
 * @param {string | null} sessionId
 * @param {{ command: string, args: string[] }} commandSpec
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function loadAcpCommandConfigOptions(sessionId, commandSpec) {
  return sessionId
    ? getAcpSessionConfigOptions({ ...commandSpec, sessionId })
    : getAcpInitialSessionConfigOptions(commandSpec);
}

/**
 * @param {string | null} sessionId
 * @param {{ command: string, args: string[] }} commandSpec
 * @returns {Promise<{ configOptions: Record<string, unknown>[], modelState: { currentModelId?: string, availableModels: Array<{ modelId: string, name: string, description?: string }> } | null }>}
 */
async function loadAcpCommandControlState(sessionId, commandSpec) {
  return sessionId
    ? getAcpSessionControlState({ ...commandSpec, sessionId })
    : getAcpInitialSessionControlState(commandSpec);
}

/**
 * @param {string} modelId
 * @returns {{ model: string, effort: string | null } | null}
 */
function parseAcpModelId(modelId) {
  const match = modelId.match(/^(?<model>[^\[]+?)(?:\[(?<effort>[^\]]+)\])?$/);
  const model = match?.groups?.model?.trim();
  if (!model) {
    return null;
  }
  const effort = match?.groups?.effort?.trim() || null;
  return { model, effort };
}

/**
 * @param {string} label
 * @param {string | null} effort
 * @returns {string}
 */
function stripEffortFromModelLabel(label, effort) {
  if (!effort) {
    return label;
  }
  return label.replace(new RegExp(`\\s*\\(${effort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\s*$`, "i"), "").trim() || label;
}

/**
 * @param {{ currentModelId?: string, availableModels: Array<{ modelId: string, name: string, description?: string }> } | null} modelState
 * @returns {SelectOption[]}
 */
function modelStateModelOptions(modelState) {
  if (!modelState) {
    return [];
  }
  /** @type {Map<string, SelectOption>} */
  const options = new Map();
  for (const entry of modelState.availableModels) {
    const parsed = parseAcpModelId(entry.modelId);
    if (!parsed || options.has(parsed.model)) {
      continue;
    }
    options.set(parsed.model, {
      id: parsed.model,
      label: stripEffortFromModelLabel(entry.name, parsed.effort),
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return [...options.values()];
}

/**
 * @param {{ currentModelId?: string, availableModels: Array<{ modelId: string, name: string, description?: string }> } | null} modelState
 * @param {string} model
 * @returns {SelectOption[]}
 */
function modelStateEffortOptions(modelState, model) {
  if (!modelState) {
    return [];
  }
  /** @type {Map<string, SelectOption>} */
  const options = new Map();
  for (const entry of modelState.availableModels) {
    const parsed = parseAcpModelId(entry.modelId);
    if (!parsed || parsed.model !== model || !parsed.effort || options.has(parsed.effort)) {
      continue;
    }
    options.set(parsed.effort, {
      id: parsed.effort,
      label: parsed.effort,
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return [...options.values()];
}

/**
 * @param {SelectOption} option
 * @returns {string}
 */
function selectOptionId(option) {
  return typeof option === "string" ? option : option.id;
}

/**
 * @param {string} model
 * @param {string} effort
 * @returns {string}
 */
function buildAcpModelStateId(model, effort) {
  return effort === "default" ? model : `${model}[${effort}]`;
}

/**
 * @param {{ command: string, args: string[] }} commandSpec
 * @param {string | null} currentSessionId
 * @param {string} model
 * @param {string} effort
 * @returns {Promise<void>}
 */
async function persistAcpModelStateSelection(commandSpec, currentSessionId, model, effort) {
  if (!currentSessionId || model === "default") {
    return;
  }
  await setAcpSessionModel({
    ...commandSpec,
    sessionId: currentSessionId,
    modelId: buildAcpModelStateId(model, effort),
  });
}

/**
 * @param {Record<string, unknown>} option
 * @returns {string}
 */
function formatConfigOption(option) {
  const id = typeof option.id === "string" ? option.id : "";
  const name = typeof option.name === "string" ? option.name : id;
  const current = typeof option.currentValue === "string" || typeof option.currentValue === "boolean"
    ? String(option.currentValue)
    : "default";
  const category = typeof option.category === "string" ? ` (${option.category})` : "";
  return `- \`${id}\` ${name}${category}: \`${current}\``;
}

/**
 * @param {Record<string, unknown>} option
 * @param {string} desired
 * @returns {string | boolean | null}
 */
function resolveCommandConfigValue(option, desired) {
  const normalized = desired.trim().toLowerCase();
  if (option.type === "boolean") {
    if (["true", "yes", "on", "1"].includes(normalized)) return true;
    if (["false", "no", "off", "0"].includes(normalized)) return false;
  }
  const values = configOptionValues(option);
  const match = values.find((value) => value.id.toLowerCase() === normalized)
    ?? values.find((value) => value.label.toLowerCase() === normalized);
  return match?.id ?? null;
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} configId
 * @param {string | boolean | null} value
 * @returns {Record<string, unknown>}
 */
function buildConfigValuesPatch(config, configId, value) {
  const existing = isRecord(config.configValues) ? config.configValues : {};
  return {
    configValues: {
      ...existing,
      [configId]: value,
    },
  };
}

/**
 * @param {{
 *   input: HarnessCommandContext,
 *   options: { harnessName: string, label: string, commandSpec: { command: string, args: string[] } },
 *   configId: string,
 *   value: string | boolean | null,
 *   currentSessionId: string | null,
 * }} params
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function persistAcpCommandConfigValue(params) {
  const activeConfig = await getActiveHarnessConfig(params.input.chatId, params.options.harnessName);
  await updateActiveHarnessConfig(
    params.input.chatId,
    params.options.harnessName,
    buildConfigValuesPatch(activeConfig, params.configId, params.value),
  );
  if (!params.currentSessionId || params.value === null) {
    return [];
  }
  return setAcpSessionConfigOption({
    ...params.options.commandSpec,
    sessionId: params.currentSessionId,
    configId: params.configId,
    value: params.value,
  });
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isUnsupportedCompactError(message) {
  const normalized = message.toLowerCase();
  return normalized.includes("did not acknowledge session/compact")
    || normalized.includes("method not found")
    || normalized.includes("unknown method")
    || (normalized.includes("session/compact") && normalized.includes("not found"));
}

/**
 * @param {{
 *   harnessName: string,
 *   label: string,
 *   sessionKind: HarnessSessionRef["kind"],
 *   commandSpec: { command: string, args: string[] },
 *   cancelActiveQuery: (chatId: string | HarnessSessionRef) => boolean,
 *   loadControlState?: typeof loadAcpCommandControlState,
 *   compactSession?: typeof compactAcpSession,
 *   readCodexStatus?: () => Promise<string>,
 * }} options
 * @returns {(input: HarnessCommandContext) => Promise<boolean>}
 */
function createGenericAcpCommandHandler(options) {
  return async (input) => {
    const appOutput = createAppOutputPort(input.context);
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
    if (/^status$/i.test(trimmed) && options.sessionKind === "codex" && options.readCodexStatus) {
      try {
        const status = await options.readCodexStatus();
        await appOutput.replyWithToolResult(formatCodexStatusForReply(status));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appOutput.replyWithToolResult(`Codex status failed: ${message}`);
      }
      return true;
    }

    if (/^compact$/i.test(trimmed)) {
      const currentSessionId = input.chatInfo?.harness_session_id ?? null;
      if (!currentSessionId) {
        await appOutput.replyWithToolResult(`Can't compact yet. Start a ${options.label} ACP session first.`);
        return true;
      }
      try {
        await (options.compactSession ?? compactAcpSession)({
          ...options.commandSpec,
          sessionId: currentSessionId,
        });
        await appOutput.replyWithToolResult(`${options.label} ACP context compaction requested.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isUnsupportedCompactError(message)) {
          await appOutput.replyWithToolResult(`${options.label} ACP does not support \`/compact\`.`);
        } else {
          await appOutput.replyWithToolResult(`${options.label} ACP compact failed: ${message}`);
        }
      }
      return true;
    }

    if (/^fork$/i.test(trimmed)) {
      const currentSessionId = input.chatInfo?.harness_session_id ?? null;
      const currentKind = input.chatInfo?.harness_session_kind ?? options.sessionKind;
      if (!currentSessionId || !input.sessionForkControl) {
        await appOutput.replyWithToolResult(`Can't fork yet. Start a ${options.label} ACP session first.`);
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
        await appOutput.replyWithToolResult(`Forked ${options.label} ACP session. You are now in a side thread. Use \`/back\` to return.`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appOutput.replyWithToolResult(`${options.label} ACP fork failed: ${message}`);
        return true;
      }
    }

    if (/^back$/i.test(trimmed)) {
      if (!input.sessionForkControl) {
        await appOutput.replyWithToolResult("No parent fork to return to.");
        return true;
      }
      const parent = await input.sessionForkControl.pop(input.chatId);
      if (!parent) {
        await appOutput.replyWithToolResult("No parent fork to return to.");
        return true;
      }
      await input.sessionForkControl.save(input.chatId, { id: parent.id, kind: parent.kind });
      await appOutput.replyWithToolResult(`Returned to previous ${options.label} ACP session${parent.label ? `: ${parent.label}` : ""}.`);
      return true;
    }

    const configMatch = trimmed.match(/^config(?:\s+(\S+)(?:\s+(.+))?)?$/i);
    if (configMatch) {
      const currentSessionId = input.chatInfo?.harness_session_id ?? null;
      const configOptions = await loadAcpCommandConfigOptions(currentSessionId, options.commandSpec);
      if (configOptions.length === 0) {
        await appOutput.replyWithToolResult(`${options.label} did not expose ACP config options for this session.`);
        return true;
      }
      const configId = configMatch[1]?.trim() ?? null;
      const rawValue = configMatch[2]?.trim() ?? null;
      if (!configId) {
        await appOutput.replyWithToolResult(`${options.label} config:\n${configOptions.map(formatConfigOption).join("\n")}`);
        return true;
      }
      const option = configOptions.find((candidate) => candidate.id === configId);
      if (!option || typeof option.id !== "string") {
        await appOutput.replyWithToolResult(`Unknown ${options.label} config option: \`${configId}\``);
        return true;
      }
      let value = rawValue ? resolveCommandConfigValue(option, rawValue) : null;
      if (value === null) {
        const values = configOptionValues(option);
        if (values.length === 0) {
          await appOutput.replyWithToolResult(`Config option \`${configId}\` cannot be set interactively.`);
          return true;
        }
        const selected = await input.context.select(`Choose ${option.name ?? configId}`, values, {
          deleteOnSelect: true,
          currentId: typeof option.currentValue === "string" ? option.currentValue : undefined,
        });
        value = resolveCommandConfigValue(option, selected);
      }
      if (value === null) {
        await appOutput.replyWithToolResult(`Unknown value for \`${configId}\`.`);
        return true;
      }
      const updatedOptions = await persistAcpCommandConfigValue({
        input,
        options,
        configId: option.id,
        value,
        currentSessionId,
      });
      const updated = updatedOptions.find((candidate) => candidate.id === option.id) ?? { ...option, currentValue: value };
      await appOutput.replyWithToolResult(`${options.label} config updated:\n${formatConfigOption(updated)}`);
      return true;
    }

    const modeMatch = trimmed.match(/^mode(?:\s+(.+))?$/i);
    if (modeMatch) {
      const arg = modeMatch[1]?.trim() ?? null;
      if (!arg) {
        const config = await getActiveHarnessConfig(input.chatId, options.harnessName);
        const mode = typeof config.mode === "string" ? config.mode : "default";
        await appOutput.replyWithToolResult(`${options.label} mode: \`${mode}\``);
        return true;
      }
      const lowered = arg.toLowerCase();
      if (lowered === "off" || lowered === "default" || lowered === "none") {
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { mode: null });
        await appOutput.replyWithToolResult(`${options.label} mode reset to default.`);
        return true;
      }
      await updateActiveHarnessConfig(input.chatId, options.harnessName, { mode: arg });
      await appOutput.replyWithToolResult(`${options.label} mode set to \`${arg}\``);
      return true;
    }

    const modelMatch = trimmed.match(/^model(?:\s+(.+))?$/i);
    if (modelMatch) {
      const arg = modelMatch[1]?.trim() ?? null;
      const currentSessionId = input.chatInfo?.harness_session_id ?? null;
      const controlState = await (options.loadControlState ?? loadAcpCommandControlState)(currentSessionId, options.commandSpec);
      const configOptions = controlState.configOptions;
      const modelOption = findConfigOptionByCategory(configOptions, "model");
      const effortOption = findConfigOptionByCategory(configOptions, "thought_level");
      const fastModeOption = findFastModeConfigOption(configOptions);
      if (!arg) {
        const config = await getActiveHarnessConfig(input.chatId, options.harnessName);
        let model = typeof config.model === "string" ? config.model : "default";
        let effort = typeof config.reasoningEffort === "string" ? config.reasoningEffort : "default";
        const configValues = isRecord(config.configValues) ? config.configValues : {};
        /** @type {string[]} */
        const replyOptions = [];

        const modelValues = modelOption ? configOptionValues(modelOption) : [];
        const modelStateValues = modelStateModelOptions(controlState.modelState);
        let usesModelStateSelection = false;
        if (modelValues.length > 0 && typeof modelOption?.id === "string") {
          const selected = await input.context.select(`Choose ${options.label} model`, modelValues, {
            deleteOnSelect: true,
            currentId: model,
          });
          const value = resolveCommandConfigValue(modelOption, selected);
          if (value !== null) {
            await persistAcpCommandConfigValue({
              input,
              options,
              configId: modelOption.id,
              value,
              currentSessionId,
            });
            await updateActiveHarnessConfig(input.chatId, options.harnessName, {
              model: value === "default" ? null : String(value),
            });
            model = value === "default" ? "default" : String(value);
          }
        } else if (modelStateValues.length > 0) {
          const selected = await input.context.select(`Choose ${options.label} model`, modelStateValues, {
            deleteOnSelect: true,
            currentId: model !== "default" ? model : parseAcpModelId(controlState.modelState?.currentModelId ?? "")?.model,
          });
          const matched = modelStateValues.find((option) => selectOptionId(option) === selected);
          if (matched) {
            const matchedId = selectOptionId(matched);
            await updateActiveHarnessConfig(input.chatId, options.harnessName, { model: matchedId });
            model = matchedId;
            usesModelStateSelection = true;
          }
        }

        const effortValues = effortOption ? configOptionValues(effortOption) : [];
        const effortStateValues = model !== "default" ? modelStateEffortOptions(controlState.modelState, model) : [];
        if (effortValues.length > 0 && typeof effortOption?.id === "string") {
          const selected = await input.context.select(`Choose ${options.label} effort`, effortValues, {
            deleteOnSelect: true,
            currentId: effort,
          });
          const value = resolveCommandConfigValue(effortOption, selected);
          if (value !== null) {
            await persistAcpCommandConfigValue({
              input,
              options,
              configId: effortOption.id,
              value,
              currentSessionId,
            });
            await updateActiveHarnessConfig(input.chatId, options.harnessName, {
              reasoningEffort: String(value),
            });
            effort = String(value);
          }
        } else if (effortStateValues.length > 0) {
          const selected = await input.context.select(`Choose ${options.label} effort`, effortStateValues, {
            deleteOnSelect: true,
            currentId: effort !== "default" ? effort : parseAcpModelId(controlState.modelState?.currentModelId ?? "")?.effort ?? undefined,
          });
          const matched = effortStateValues.find((option) => selectOptionId(option) === selected);
          if (matched) {
            const matchedId = selectOptionId(matched);
            await updateActiveHarnessConfig(input.chatId, options.harnessName, { reasoningEffort: matchedId });
            effort = matchedId;
            usesModelStateSelection = true;
          }
        }

        if (usesModelStateSelection) {
          await persistAcpModelStateSelection(options.commandSpec, currentSessionId, model, effort);
        }

        if (fastModeOption && typeof fastModeOption.id === "string") {
          const fastValues = configOptionValues(fastModeOption);
          if (fastValues.length > 0) {
            const selected = await input.context.select(`Choose ${options.label} fast mode`, fastValues, {
              deleteOnSelect: true,
              currentId: typeof configValues[fastModeOption.id] === "boolean"
                ? String(configValues[fastModeOption.id])
                : typeof fastModeOption.currentValue === "boolean" ? String(fastModeOption.currentValue) : undefined,
            });
            const value = resolveCommandConfigValue(fastModeOption, selected);
            if (value !== null) {
              await persistAcpCommandConfigValue({
                input,
                options,
                configId: fastModeOption.id,
                value,
                currentSessionId,
              });
            }
          }
        }

        const updated = await getActiveHarnessConfig(input.chatId, options.harnessName);
        const updatedConfigValues = isRecord(updated.configValues) ? updated.configValues : {};
        replyOptions.push(`${options.label} model: \`${typeof updated.model === "string" ? updated.model : model}\``);
        replyOptions.push(`${options.label} effort: \`${typeof updated.reasoningEffort === "string" ? updated.reasoningEffort : effort}\``);
        if (fastModeOption && typeof fastModeOption.id === "string" && updatedConfigValues[fastModeOption.id] !== undefined) {
          replyOptions.push(`${fastModeOption.name ?? "Fast mode"}: \`${String(updatedConfigValues[fastModeOption.id])}\``);
        }
        await appOutput.replyWithToolResult(replyOptions.join("\n"));
        return true;
      }
      const fastMatch = arg.match(/^fast(?:\s+(.+))?$/i);
      if (fastMatch) {
        if (!fastModeOption || typeof fastModeOption.id !== "string") {
          throw new Error(`${options.label} fast mode is not exposed by this ACP agent.`);
        }
        const fastValues = configOptionValues(fastModeOption);
        const selected = fastMatch[1]?.trim()
          ?? await input.context.select(`Choose ${options.label} fast mode`, fastValues, {
            deleteOnSelect: true,
            currentId: typeof fastModeOption.currentValue === "boolean" ? String(fastModeOption.currentValue) : undefined,
          });
        const value = resolveCommandConfigValue(fastModeOption, selected);
        if (value === null) {
          throw new Error(`Invalid ${options.label} fast mode value \`${selected}\`.`);
        }
        await persistAcpCommandConfigValue({
          input,
          options,
          configId: fastModeOption.id,
          value,
          currentSessionId,
        });
        await appOutput.replyWithToolResult(`${fastModeOption.name ?? "Fast mode"} set to \`${String(value)}\``);
        return true;
      }
      const effortMatch = arg.match(/^effort\s+(.+)$/i);
      if (effortMatch) {
        const effort = effortMatch[1].trim().toLowerCase();
        if (effort === "off" || effort === "default" || effort === "none") {
          await updateActiveHarnessConfig(input.chatId, options.harnessName, { reasoningEffort: null });
          await appOutput.replyWithToolResult(`${options.label} effort reset to default.`);
          return true;
        }
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { reasoningEffort: effort });
        await appOutput.replyWithToolResult(`${options.label} effort set to \`${effort}\``);
        return true;
      }
      const modelReset = arg.toLowerCase();
      if (modelReset === "off" || modelReset === "default" || modelReset === "none") {
        if (modelOption && typeof modelOption.id === "string") {
          await persistAcpCommandConfigValue({
            input,
            options,
            configId: modelOption.id,
            value: null,
            currentSessionId,
          });
        }
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { model: null });
        await appOutput.replyWithToolResult(`${options.label} model reset to default.`);
        return true;
      }
      if (modelOption && typeof modelOption.id === "string") {
        const value = resolveCommandConfigValue(modelOption, arg);
        if (value === null) {
          await appOutput.replyWithToolResult(`Unknown ${options.label} model \`${arg}\`.`);
          return true;
        }
        await persistAcpCommandConfigValue({
          input,
          options,
          configId: modelOption.id,
          value,
          currentSessionId,
        });
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { model: String(value) });
        await appOutput.replyWithToolResult(`${options.label} model set to \`${value}\``);
        return true;
      }
      await updateActiveHarnessConfig(input.chatId, options.harnessName, { model: arg });
      await appOutput.replyWithToolResult(`${options.label} model set to \`${arg}\``);
      return true;
    }

    const permissionsMatch = trimmed.match(/^(?:permissions|sandbox)(?:\s+(.+))?$/i);
    if (permissionsMatch) {
      const arg = permissionsMatch[1]?.trim().toLowerCase() ?? null;
      if (arg) {
        if (arg === "off" || arg === "default" || arg === "none") {
          await updateActiveHarnessConfig(input.chatId, options.harnessName, { sandboxMode: null });
          await appOutput.replyWithToolResult(`${options.label} permissions reset to default.`);
          return true;
        }
        const normalized = arg === "write" || arg === "workspace" ? "workspace-write"
          : arg === "readonly" || arg === "read" ? "read-only"
            : arg === "full" || arg === "full-access" ? "danger-full-access" : arg;
        if (!["read-only", "workspace-write", "danger-full-access"].includes(normalized)) {
          await appOutput.replyWithToolResult(`Unknown ${options.label} permissions mode \`${arg}\`. Use: read-only, workspace-write, danger-full-access.`);
          return true;
        }
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { sandboxMode: normalized });
        await appOutput.replyWithToolResult(`${options.label} permissions set to \`${normalized}\``);
        return true;
      }
      const config = await getActiveHarnessConfig(input.chatId, options.harnessName);
      const permissions = typeof config.sandboxMode === "string" ? config.sandboxMode : "default";
      const selected = await input.context.select(`Choose ${options.label} permissions`, [
        { id: "workspace-write", label: "Workspace Write" },
        { id: "read-only", label: "Read Only" },
        { id: "danger-full-access", label: "Full Access" },
        { id: "off", label: "Default" },
      ], { deleteOnSelect: true, currentId: permissions });
      if (selected) {
        await updateActiveHarnessConfig(input.chatId, options.harnessName, {
          sandboxMode: selected === "off" ? null : selected,
        });
      }
      const updated = await getActiveHarnessConfig(input.chatId, options.harnessName);
      await appOutput.replyWithToolResult(`${options.label} permissions: \`${typeof updated.sandboxMode === "string" ? updated.sandboxMode : "default"}\``);
      return true;
    }

    const approvalMatch = trimmed.match(/^(?:approval|approvals)(?:\s+(.+))?$/i);
    if (approvalMatch) {
      const arg = approvalMatch[1]?.trim().toLowerCase() ?? null;
      if (arg) {
        if (arg === "off" || arg === "default" || arg === "none") {
          await updateActiveHarnessConfig(input.chatId, options.harnessName, { approvalPolicy: null });
          await appOutput.replyWithToolResult(`${options.label} approval policy reset to default.`);
          return true;
        }
        if (!["untrusted", "on-failure", "on-request", "never"].includes(arg)) {
          await appOutput.replyWithToolResult(`Unknown ${options.label} approval policy \`${arg}\`. Use: untrusted, on-failure, on-request, never.`);
          return true;
        }
        await updateActiveHarnessConfig(input.chatId, options.harnessName, { approvalPolicy: arg });
        await appOutput.replyWithToolResult(`${options.label} approval policy set to \`${arg}\``);
        return true;
      }
      const config = await getActiveHarnessConfig(input.chatId, options.harnessName);
      const approval = typeof config.approvalPolicy === "string" ? config.approvalPolicy : "default";
      const selected = await input.context.select(`Choose ${options.label} approval policy`, [
        { id: "on-request", label: "On Request" },
        { id: "on-failure", label: "On Failure" },
        { id: "untrusted", label: "Untrusted" },
        { id: "never", label: "Never" },
        { id: "off", label: "Default" },
      ], { deleteOnSelect: true, currentId: approval });
      if (selected) {
        await updateActiveHarnessConfig(input.chatId, options.harnessName, {
          approvalPolicy: selected === "off" ? null : selected,
        });
      }
      const updated = await getActiveHarnessConfig(input.chatId, options.harnessName);
      await appOutput.replyWithToolResult(`${options.label} approval policy: \`${typeof updated.approvalPolicy === "string" ? updated.approvalPolicy : "default"}\``);
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
  const env = normalizeEnv(normalized.env);
  if (env) {
    normalized.env = env;
  } else {
    delete normalized.env;
  }
  return normalized;
}

export const __testAcpModelCommand = {
  createGenericAcpCommandHandler,
  findFastModeConfigOption,
  modelStateEffortOptions,
  modelStateModelOptions,
  parseAcpModelId,
};

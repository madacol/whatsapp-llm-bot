import { hasMediaPath } from "../attachment-paths.js";
import { contentEvent } from "../outbound-events.js";
import { createLogger } from "../logger.js";
import { renderContentBlock } from "../message-formatting.js";
import { getRootDb } from "../db.js";
import { NO_OP_HOOKS } from "./native.js";
import { buildSdkErrorResponse, clearStaleHarnessSession, getHarnessRunErrorMessage } from "./harness-run-errors.js";
import { augmentLatestUserMessageForTextHarness, renderMarkdownImageReference } from "./prompt-media.js";
import { handleHarnessSessionCommand } from "./session-commands.js";
import { openPiRpcConnection } from "./pi-rpc-client.js";
import { getPiConfig, getPiSessionPath, savePiSession, updatePiConfig } from "./pi-config.js";
import { startPiRpcRun } from "./pi-runner.js";

const log = createLogger("harness:pi");

/** @type {HarnessCapabilities} */
const PI_HARNESS_CAPABILITIES = {
  supportsResume: true,
  supportsCancel: true,
  supportsLiveInput: true,
  supportsApprovals: false,
  supportsWorkdir: true,
  supportsSandboxConfig: false,
  supportsModelSelection: true,
  supportsReasoningEffort: true,
  supportsSessionFork: true,
};

/** @type {ReadonlyArray<{ id: NonNullable<HarnessRunConfig["reasoningEffort"]>, label: string }>} */
const PI_EFFORT_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

/**
 * @typedef {{
 *   abortController: AbortController,
 *   done: Promise<{ result: AgentResult, sessionPath: string | null }>,
 *   steer?: (text: string) => boolean | Promise<boolean>,
 *   interrupt?: () => boolean | Promise<boolean>,
 *   aborted: boolean,
 * }} ActivePiRun
 */

/**
 * @typedef {{
 *   getAvailableModels?: () => Promise<Array<{ id: string, label: string }>>,
 *   startRun?: (input: Parameters<typeof startPiRpcRun>[0]) => Promise<{
 *     abortController: AbortController,
 *     done: Promise<{ result: AgentResult, sessionPath: string | null }>,
 *     steer?: (text: string) => boolean | Promise<boolean>,
 *     interrupt?: () => boolean | Promise<boolean>,
 *   }>,
 *   getForkMessages?: (sessionPath: string) => Promise<Array<{ entryId: string, text: string }>>,
 *   forkSession?: (sessionPath: string, entryId: string) => Promise<{ sessionPath: string | null, text: string | null }>,
 * }} PiHarnessDeps
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Array<IncomingContentBlock | ToolContentBlock>} blocks
 * @param {string[]} textParts
 * @param {string[]} mediaPaths
 * @returns {void}
 */
function collectPiPromptParts(blocks, textParts, mediaPaths) {
  for (const block of blocks) {
    if (block.type === "quote") {
      const renderedQuote = renderContentBlock(block);
      if (renderedQuote) {
        textParts.push(renderedQuote);
      }
      collectQuotedPiMediaPaths(block.content, mediaPaths);
      continue;
    }

    if (block.type === "image" && hasMediaPath(block)) {
      const markdownImage = renderMarkdownImageReference(block);
      if (markdownImage) {
        textParts.push(markdownImage);
        continue;
      }
      mediaPaths.push(block.path);
      continue;
    }

    if ((block.type === "video" || block.type === "audio" || block.type === "file") && hasMediaPath(block)) {
      mediaPaths.push(block.path);
      continue;
    }

    const rendered = renderContentBlock(block);
    if (rendered) {
      textParts.push(rendered);
    }
  }
}

/**
 * @param {IncomingContentBlock[]} blocks
 * @param {string[]} mediaPaths
 * @returns {void}
 */
function collectQuotedPiMediaPaths(blocks, mediaPaths) {
  for (const block of blocks) {
    if (block.type === "quote") {
      collectQuotedPiMediaPaths(block.content, mediaPaths);
      continue;
    }
    if ((block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file") && hasMediaPath(block)) {
      mediaPaths.push(block.path);
    }
  }
}

/**
 * @param {Message[]} messages
 * @returns {string}
 */
export function buildPiPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }

    /** @type {string[]} */
    const textParts = [];
    /** @type {string[]} */
    const mediaPaths = [];
    collectPiPromptParts(message.content, textParts, mediaPaths);

    const sections = [];
    if (textParts.length > 0) {
      sections.push(textParts.join("\n"));
    }
    if (mediaPaths.length > 0) {
      const heading = mediaPaths.length === 1
        ? "Media file available in this request:"
        : "Media files available in this request:";
      sections.push(`${heading}\n${mediaPaths.map((mediaPath) => `- ${mediaPath}`).join("\n")}`);
    }
    return sections.join("\n\n");
  }
  return "";
}

/**
 * @param {string} value
 * @returns {string}
 */
function compactLabel(value) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= 60) {
    return normalized;
  }
  return `${normalized.slice(0, 60).trimEnd()}...`;
}

/**
 * @param {string} modelId
 * @param {Array<{ id: string, label: string }>} options
 * @returns {boolean}
 */
function isSelectablePiModel(modelId, options) {
  return options.some((option) => option.id === modelId);
}

/**
 * @param {NonNullable<HarnessRunConfig["reasoningEffort"]>} effort
 * @returns {string}
 */
function formatEffortLabel(effort) {
  const match = PI_EFFORT_OPTIONS.find((option) => option.id === effort);
  return match?.label ?? effort;
}

/**
 * @param {string} sessionPath
 * @returns {Promise<Array<{ entryId: string, text: string }>>}
 */
async function getPiForkMessages(sessionPath) {
  const connection = await openPiRpcConnection();
  try {
    const switchResponse = await connection.sendRequest({
      id: "req-1",
      type: "switch_session",
      sessionPath,
    });
    if (switchResponse.success !== true) {
      throw new Error("Failed to switch Pi session before listing forks.");
    }
    const response = await connection.sendRequest({
      id: "req-2",
      type: "get_fork_messages",
    });
    if (response.success !== true) {
      throw new Error("Failed to load Pi fork messages.");
    }
    const data = isObjectRecord(response.data) ? response.data : {};
    if (!Array.isArray(data.messages)) {
      return [];
    }
    return data.messages
      .map((entry) => {
        if (!isObjectRecord(entry) || typeof entry.entryId !== "string" || typeof entry.text !== "string") {
          return null;
        }
        return { entryId: entry.entryId, text: entry.text };
      })
      .filter(/** @returns {entry is { entryId: string, text: string }} */ (entry) => entry !== null);
  } finally {
    await connection.close();
  }
}

/**
 * @param {string} sessionPath
 * @param {string} entryId
 * @returns {Promise<{ sessionPath: string | null, text: string | null }>}
 */
async function forkPiSession(sessionPath, entryId) {
  const connection = await openPiRpcConnection();
  try {
    const switchResponse = await connection.sendRequest({
      id: "req-1",
      type: "switch_session",
      sessionPath,
    });
    if (switchResponse.success !== true) {
      throw new Error("Failed to switch Pi session before forking.");
    }
    const forkResponse = await connection.sendRequest({
      id: "req-2",
      type: "fork",
      entryId,
    });
    if (forkResponse.success !== true) {
      throw new Error("Pi fork failed.");
    }
    const stateResponse = await connection.sendRequest({
      id: "req-3",
      type: "get_state",
    });
    if (stateResponse.success !== true) {
      throw new Error("Pi did not return fork session state.");
    }
    const forkData = isObjectRecord(forkResponse.data) ? forkResponse.data : {};
    const stateData = isObjectRecord(stateResponse.data) ? stateResponse.data : {};
    return {
      sessionPath: typeof stateData.sessionFile === "string" ? stateData.sessionFile : null,
      text: typeof forkData.text === "string" ? forkData.text : null,
    };
  } finally {
    await connection.close();
  }
}

/**
 * @returns {Promise<Array<{ id: string, label: string }>>}
 */
export async function getPiAvailableModels() {
  const connection = await openPiRpcConnection();
  try {
    const response = await connection.sendRequest({
      id: "req-1",
      type: "get_available_models",
    });
    if (response.success !== true) {
      return [];
    }
    const data = isObjectRecord(response.data) ? response.data : {};
    if (!Array.isArray(data.models)) {
      return [];
    }
    return data.models
      .map((entry) => {
        if (!isObjectRecord(entry) || typeof entry.id !== "string" || typeof entry.provider !== "string" || typeof entry.name !== "string") {
          return null;
        }
        return {
          id: `${entry.provider}/${entry.id}`,
          label: entry.name,
        };
      })
      .filter(/** @returns {entry is { id: string, label: string }} */ (entry) => entry !== null);
  } finally {
    await connection.close();
  }
}

/**
 * Create the Pi harness.
 * @param {PiHarnessDeps} [deps]
 * @returns {AgentHarness}
 */
export function createPiHarness(deps = {}) {
  /** @type {Map<string, ActivePiRun>} */
  const activeRuns = new Map();
  const loadAvailableModels = deps.getAvailableModels ?? getPiAvailableModels;
  const beginRun = deps.startRun ?? startPiRpcRun;
  const loadForkMessages = deps.getForkMessages ?? getPiForkMessages;
  const createFork = deps.forkSession ?? forkPiSession;

  return {
    getName: () => "pi",
    getCapabilities: () => PI_HARNESS_CAPABILITIES,
    run,
    handleCommand,
    listSlashCommands,
    injectMessage,
    cancel,
    waitForIdle,
  };

  /**
   * @param {string | HarnessSessionRef} chatId
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function injectMessage(chatId, text) {
    const key = typeof chatId === "string" ? chatId : chatId.id;
    const active = activeRuns.get(key);
    if (!active?.steer || !text) {
      return false;
    }
    return !!(await active.steer(text));
  }

  /**
   * @param {string | HarnessSessionRef} chatId
   * @returns {boolean}
   */
  function cancel(chatId) {
    const key = typeof chatId === "string" ? chatId : chatId.id;
    const active = activeRuns.get(key);
    if (!active) {
      return false;
    }
    active.aborted = true;
    if (active.interrupt) {
      void Promise.resolve(active.interrupt()).catch((error) => {
        log.warn("Pi abort failed, falling back to process abort:", error);
        active.abortController.abort();
      });
      return true;
    }
    active.abortController.abort();
    return true;
  }

  /**
   * @returns {SlashCommandDescriptor[]}
   */
  function listSlashCommands() {
    return [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
      { name: "fork", description: "Fork the current Pi session" },
      { name: "back", description: "Return to the previous Pi fork parent" },
      { name: "model", description: "Choose or set the Pi model" },
      { name: "effort", description: "Choose or set the Pi reasoning effort" },
    ];
  }

  /**
   * @returns {Promise<string[]>}
   */
  async function waitForIdle() {
    const chatIds = [...activeRuns.keys()];
    await Promise.allSettled(chatIds.map((chatId) => activeRuns.get(chatId)?.done));
    return chatIds;
  }

  /**
   * @param {HarnessCommandContext} input
   * @returns {Promise<boolean>}
   */
  async function handleCommand(input) {
    const handledSessionCommand = await handleHarnessSessionCommand({
      command: input.command,
      chatId: input.chatId,
      context: input.context,
      cancelActiveQuery: () => cancel(input.chatId),
      sessionControl: input.sessionControl,
    });
    if (handledSessionCommand) {
      return true;
    }

    const trimmed = input.command.trim();

    if (/^fork$/i.test(trimmed)) {
      const currentSessionPath = input.chatInfo?.harness_session_kind === "pi"
        ? input.chatInfo.harness_session_id
        : null;
      if (!currentSessionPath || !input.sessionForkControl) {
        await input.context.reply(contentEvent("tool-result", "Can't fork yet. Start a Pi session first."));
        return true;
      }

      try {
        const forkMessages = await loadForkMessages(currentSessionPath);
        const latestMessage = forkMessages.at(-1) ?? null;
        if (!latestMessage) {
          await input.context.reply(contentEvent("tool-result", "Can't fork yet. Send at least one normal Pi turn first."));
          return true;
        }

        const forked = await createFork(currentSessionPath, latestMessage.entryId);
        if (!forked.sessionPath) {
          throw new Error("Pi did not return a fork session path.");
        }

        const label = compactLabel(forked.text ?? latestMessage.text);
        await input.sessionForkControl.push(input.chatId, {
          id: currentSessionPath,
          kind: "pi",
          label,
        });
        await input.sessionForkControl.save(input.chatId, { id: forked.sessionPath, kind: "pi" });
        await input.context.reply(contentEvent("tool-result", `Forked${label ? `: ${label}` : ""}. You are now in a side thread. Use \`/back\` to return.`));
        return true;
      } catch (error) {
        await input.context.reply(contentEvent("tool-result", `Pi fork failed: ${getHarnessRunErrorMessage(error)}`));
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
      await input.context.reply(contentEvent("tool-result", `Returned to previous thread${parent.label ? `: ${parent.label}` : ""}.`));
      return true;
    }

    const modelMatch = trimmed.match(/^model(?:\s+(.+))?$/i);
    if (modelMatch) {
      try {
        const arg = modelMatch[1]?.trim() ?? null;
        if (arg) {
          await input.context.reply(contentEvent("tool-result", await handleModelCommand(input.chatId, arg, loadAvailableModels)));
          return true;
        }

        const modelOptions = await loadAvailableModels();
        const config = await getPiConfig(input.chatId);
        const currentModel = typeof config.model === "string" && isSelectablePiModel(config.model, modelOptions)
          ? config.model
          : undefined;
        const modelChoice = await input.context.select(
          "Choose Pi model",
          [
            ...modelOptions.map((option) => ({ id: option.id, label: option.label })),
            { id: "off", label: "Default" },
          ],
          { currentId: currentModel },
        );
        if (modelChoice && modelChoice !== currentModel) {
          await handleModelCommand(input.chatId, modelChoice, loadAvailableModels);
        }
        const updatedConfig = await getPiConfig(input.chatId);
        const finalModel = typeof updatedConfig.model === "string" ? updatedConfig.model : "default";
        await input.context.reply(contentEvent("tool-result", `Pi model: \`${finalModel}\``));
        return true;
      } catch (error) {
        await input.context.reply(contentEvent("tool-result", `Pi model lookup failed: ${getHarnessRunErrorMessage(error)}`));
        return true;
      }
    }

    const effortMatch = trimmed.match(/^effort(?:\s+(.+))?$/i);
    if (effortMatch) {
      const arg = effortMatch[1]?.trim().toLowerCase() ?? null;
      if (arg) {
        await input.context.reply(contentEvent("tool-result", await handleEffortCommand(input.chatId, arg)));
        return true;
      }

      const config = await getPiConfig(input.chatId);
      const currentEffort = typeof config.reasoningEffort === "string"
        ? /** @type {NonNullable<HarnessRunConfig["reasoningEffort"]>} */ (config.reasoningEffort)
        : undefined;
      const choice = await input.context.select(
        "Choose Pi reasoning effort",
        [
          ...PI_EFFORT_OPTIONS.map((option) => ({ id: option.id, label: option.label })),
          { id: "off", label: "Default" },
        ],
        { currentId: currentEffort },
      );
      if (choice && choice !== currentEffort) {
        await handleEffortCommand(input.chatId, choice);
      }
      const updatedConfig = await getPiConfig(input.chatId);
      const finalEffort = typeof updatedConfig.reasoningEffort === "string" ? updatedConfig.reasoningEffort : "default";
      await input.context.reply(contentEvent("tool-result", `Pi reasoning effort: \`${finalEffort}\``));
      return true;
    }

    return false;
  }

  /**
   * @param {AgentHarnessParams} params
   * @returns {Promise<AgentResult>}
   */
  async function run({ session, llmConfig, messages, hooks: userHooks, runConfig }) {
    const hooks = { ...NO_OP_HOOKS, ...userHooks };
    const promptMessages = await augmentLatestUserMessageForTextHarness(messages, llmConfig, getRootDb());
    const prompt = buildPiPrompt(promptMessages);
    if (!prompt) {
      return {
        response: [{ type: "text", text: "No input message found." }],
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    }

    const sessionPath = getPiSessionPath(session);
    const effectiveRunConfig = await sanitizeRunConfig(session.chatId, runConfig, loadAvailableModels);
    /** @type {ActivePiRun | null} */
    let activeRun = null;
    try {
      const started = await beginRun({
        chatId: session.chatId,
        prompt,
        externalInstructions: llmConfig.externalInstructions,
        messages,
        sessionPath,
        runConfig: effectiveRunConfig,
        env: process.env,
        hooks,
        isAborted: () => activeRun?.aborted ?? false,
      });
      activeRun = {
        abortController: started.abortController,
        done: started.done,
        ...(started.steer ? { steer: started.steer } : {}),
        ...(started.interrupt ? { interrupt: started.interrupt } : {}),
        aborted: false,
      };
      activeRuns.set(session.chatId, activeRun);

      const completed = await started.done;

      if (completed.sessionPath !== sessionPath) {
        await savePiSession(session, completed.sessionPath);
      }

      return completed.result;
    } catch (error) {
      await clearStaleHarnessSession({
        existingSessionId: sessionPath,
        clearSession: async () => savePiSession(session, null),
        log,
        harnessLabel: "Pi",
      });
      const errorMessage = getHarnessRunErrorMessage(error);
      await hooks.onToolError(errorMessage);
      return {
        response: buildSdkErrorResponse(errorMessage),
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    } finally {
      activeRuns.delete(session.chatId);
    }
  }
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @param {() => Promise<Array<{ id: string, label: string }>>} loadAvailableModels
 * @returns {Promise<string>}
 */
export async function handleModelCommand(chatId, arg, loadAvailableModels = getPiAvailableModels) {
  const normalizedArg = arg.trim().toLowerCase();
  if (normalizedArg === "off" || normalizedArg === "default" || normalizedArg === "none") {
    await updatePiConfig(chatId, { model: null });
    return "Pi model reset to default.";
  }

  const models = await loadAvailableModels();
  const matchingModel = models.find((model) => model.id.toLowerCase() === normalizedArg);
  if (!matchingModel) {
    return `Unknown Pi model \`${arg}\`.`;
  }

  await updatePiConfig(chatId, { model: matchingModel.id });
  return `Pi model set to \`${matchingModel.id}\``;
}

/**
 * @param {string} chatId
 * @param {string} arg
 * @returns {Promise<string>}
 */
export async function handleEffortCommand(chatId, arg) {
  if (arg === "off" || arg === "default" || arg === "none") {
    await updatePiConfig(chatId, { reasoningEffort: null });
    return "Pi reasoning effort reset to default.";
  }

  const matchingOption = PI_EFFORT_OPTIONS.find((option) => option.id === arg);
  if (!matchingOption) {
    return "Unknown Pi reasoning effort `" + arg + "`. Use: low, medium, high, max";
  }

  await updatePiConfig(chatId, { reasoningEffort: matchingOption.id });
  return `Pi reasoning effort set to \`${matchingOption.id}\` (${formatEffortLabel(matchingOption.id)})`;
}

/**
 * Drop invalid persisted model overrides before starting Pi.
 * @param {string} chatId
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {() => Promise<Array<{ id: string, label: string }>>} loadAvailableModels
 * @returns {Promise<HarnessRunConfig | undefined>}
 */
async function sanitizeRunConfig(chatId, runConfig, loadAvailableModels) {
  if (!runConfig?.model) {
    return runConfig;
  }

  const modelOptions = await loadAvailableModels();
  if (modelOptions.length === 0 || isSelectablePiModel(runConfig.model, modelOptions)) {
    return runConfig;
  }

  log.warn(`Ignoring invalid Pi model "${runConfig.model}" for chat ${chatId}`);
  await updatePiConfig(chatId, { model: null });
  return {
    ...runConfig,
    model: undefined,
  };
}

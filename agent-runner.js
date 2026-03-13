import { resolveHarness, resolveHarnessName } from "./harnesses/index.js";
import { getActions, getAction, getChatAction, executeAction } from "./actions.js";
import { createSilentActionContext } from "./execute-action-context.js";
import { resolveChatModel } from "./model-roles.js";
import { getRootDb } from "./db.js";
import { createLogger } from "./logger.js";
import { getChatWorkDir } from "./utils.js";

const log = createLogger("agent-runner");

const MAX_AGENT_DEPTH = 3;

/**
 * @typedef {{
 *   agent: AgentDefinition,
 *   messages: Message[],
 *   llmClient: LlmClient,
 *   agentDepth?: number,
 *   chatId: string,
 *   senderIds?: string[],
 *   parentToolCallId?: string,
 *   hooks?: AgentIOHooks,
 *   addMessage?: Session['addMessage'],
 *   updateToolMessage?: Session['updateToolMessage'],
 * }} RunAgentOptions
 */

/**
 * Run an agent — wraps processLlmResponse with agent-specific config.
 *
 * Messages are stored in the `agent_runs` table (not the main `messages` table).
 * On completion, the full run is persisted for inspection.
 *
 * @param {RunAgentOptions} options
 * @returns {Promise<AgentResult>}
 */
export async function runAgent(options) {
  const {
    agent,
    messages,
    llmClient,
    agentDepth = 0,
    chatId,
    senderIds = [],
    parentToolCallId,
    hooks: userHooks,
  } = options;

  if (agentDepth >= MAX_AGENT_DEPTH) {
    throw new Error(
      `Maximum agent nesting depth (${MAX_AGENT_DEPTH}) reached. Cannot spawn sub-agent "${agent.name}".`,
    );
  }

  // Resolve model: role name or literal model ID
  const chatModel = resolveChatModel(agent);

  // Filter available actions by whitelist
  const allActions = await getActions();
  const actions = agent.allowedActions
    ? allActions.filter(a => agent.allowedActions?.includes(a.name))
    : allActions;

  // In-memory message storage for sub-agent runs
  /** @type {Message[]} */
  const storedMessages = [];

  /** @type {import("./store.js").Store['addMessage']} */
  const addMessage = options.addMessage ?? (async (_chatId, messageData, _senderIds, _displayKey) => {
    storedMessages.push(messageData);
    return /** @type {import("./store.js").MessageRow} */ ({
      message_id: storedMessages.length,
      chat_id: chatId,
      sender_id: senderIds.join(","),
      message_data: messageData,
      timestamp: new Date(),
      display_key: _displayKey ?? null,
    });
  });

  /** @type {import("./store.js").Store['updateToolMessage']} */
  const updateToolMessage = options.updateToolMessage ?? (async (_chatId, toolCallId, messageData) => {
    const idx = storedMessages.findIndex(
      m => m.role === "tool" && /** @type {ToolMessage} */ (m).tool_id === toolCallId,
    );
    if (idx !== -1) {
      storedMessages[idx] = messageData;
      return /** @type {import("./store.js").MessageRow} */ ({
        message_id: idx + 1,
        chat_id: chatId,
        sender_id: senderIds.join(","),
        message_data: messageData,
        timestamp: new Date(),
        display_key: null,
      });
    }
    return null;
  });

  // Build a minimal context for action execution (sub-agents don't do WhatsApp I/O)
  const context = createSilentActionContext(chatId, senderIds);

  /** @type {(name: string) => Promise<AppAction | null>} */
  const actionResolver = async (name) => {
    const chatAction = await getChatAction(chatId, name);
    if (chatAction) return chatAction;
    return getAction(name);
  };

  /** @type {Session} */
  const session = { chatId, senderIds, context, addMessage, updateToolMessage };

  /** @type {LlmConfig} */
  const llmConfig = {
    llmClient,
    chatModel,
    systemPrompt: agent.systemPrompt,
    actions,
    executeActionFn: executeAction,
    actionResolver,
    actionLlmClient: llmClient,
  };

  /** @type {MediaRegistry} */
  const mediaRegistry = new Map();

  const harness = resolveHarness(resolveHarnessName(agent, null));

  const result = await harness.processLlmResponse({
    session,
    llmConfig,
    messages,
    mediaRegistry,
    hooks: userHooks,
    maxDepth: agent.maxDepth,
    agentDepth: agentDepth + 1,
    cwd: getChatWorkDir(session.chatId),
  });

  // Persist the run to agent_runs table
  if (parentToolCallId) {
    try {
      const rootDb = getRootDb();
      const messagesJson = JSON.stringify(result.messages);
      const usageJson = JSON.stringify(result.usage);
      await rootDb.sql`INSERT INTO agent_runs (chat_id, parent_tool_call_id, agent_name, messages, usage)
         VALUES (${chatId}, ${parentToolCallId}, ${agent.name}, ${messagesJson}, ${usageJson})`;
    } catch (err) {
      log.error("Failed to persist agent run:", err);
    }
  }

  return result;
}

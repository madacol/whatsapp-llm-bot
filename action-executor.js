import { getDb, getRootDb, getChatDb, getActionDb } from "./db.js";
import config from "./config.js";
import { createCallLlm } from "./llm.js";
import { resolveModel } from "./model-roles.js";
import { createLogger } from "./logger.js";
import { getAction, getActions } from "./action-catalog.js";
import { formatSandboxEscapeConfirmMessage, getSandboxEscapeRequest } from "./harnesses/sandbox-approval.js";

const log = createLogger("action-executor");

/**
 * Define a lazy DB property on an object. The DB instance is only created when
 * first accessed, then the property is replaced with the resolved value.
 * @param {Record<string, any>} obj
 * @param {string} prop
 * @param {() => import("@electric-sql/pglite").PGlite} factory
 * @returns {void}
 */
function defineLazyDb(obj, prop, factory) {
  Object.defineProperty(obj, prop, {
    configurable: true,
    enumerable: true,
    get() {
      const instance = factory();
      Object.defineProperty(obj, prop, {
        value: instance,
        writable: false,
        configurable: true,
        enumerable: true,
      });
      return instance;
    },
  });
}

/**
 * Execute one action through the normalized action runtime.
 * @param {string} actionName
 * @param {ExecuteActionContext} context
 * @param {{} } params
 * @param {ExecuteActionOptions} [options]
 * @returns {Promise<{ result: ActionResultValue, permissions: Action["permissions"] }>}
 */
export async function executeAction(actionName, context, params, options = {}) {
  const {
    toolCallId = null,
    actionResolver = getAction,
    llmClient,
    agentDepth,
  } = options;

  const action = await actionResolver(actionName);
  if (!action) {
    throw new Error(`Action "${actionName}" not found`);
  }

  if (action.permissions?.requireAdmin && !(await context.getIsAdmin())) {
    throw new Error(`Action "${actionName}" requires admin permissions`);
  }

  if (
    action.permissions?.requireMaster
    && !context.senderIds.some((senderId) => config.MASTER_IDs.includes(senderId))
  ) {
    throw new Error(`Action "${actionName}" requires master permissions`);
  }

  /** @type {ActionContext & Partial<{ chatDb: PGlite, rootDb: PGlite, callLlm: CallLlm, llmClient: LlmClient }>} */
  const actionContext = {
    chatId: context.chatId,
    senderIds: context.senderIds,
    content: context.content,
    getIsAdmin: context.getIsAdmin,
    db: /** @type {PGlite} */ (/** @type {unknown} */ (undefined)),
    sessionDb: /** @type {PGlite} */ (/** @type {unknown} */ (undefined)),
    getActions,
    log: async (...args) => {
      const message = args.join(" ");
      log.info(...args);
      return message;
    },
    send: async (message) => {
      await context.send("tool-call", message);
    },
    reply: async (message) => {
      await context.reply("tool-call", message);
    },
    reactToMessage: context.reactToMessage,
    select: context.select,
    confirm: context.confirm,
    resolveModel: (role) => resolveModel(role),
    agentDepth,
    toolCallId,
  };

  defineLazyDb(actionContext, "db", () => getActionDb(context.chatId, actionName));
  defineLazyDb(actionContext, "sessionDb", () => getDb(`memory://${context.chatId}`));

  if (action.permissions?.useChatDb) {
    defineLazyDb(actionContext, "chatDb", () => getChatDb(context.chatId));
  }
  if (action.permissions?.useRootDb) {
    defineLazyDb(actionContext, "rootDb", () => getRootDb());
  }
  if (action.permissions?.useLlm) {
    if (!llmClient) {
      throw new Error(`Action "${actionName}" requires useLlm but no llmClient was provided`);
    }
    actionContext.callLlm = createCallLlm(llmClient);
    actionContext.llmClient = llmClient;
  }

  const sandboxEscapeRequest = getSandboxEscapeRequest(actionName, params, {
    workdir: options.workdir ?? null,
    sandboxMode: options.sandboxMode ?? null,
  });
  if (sandboxEscapeRequest) {
    const confirmed = await context.confirm(formatSandboxEscapeConfirmMessage(sandboxEscapeRequest));
    if (!confirmed) {
      return {
        result: `Action "${actionName}" was cancelled because sandbox escape was denied.`,
        permissions: action.permissions,
      };
    }
  }

  if (!action.permissions?.autoExecute) {
    const confirmed = await context.confirm(
      `⚠️ *Confirm action: ${actionName}*\n\n`
      + `${action.description}\n\n`
      + "React 👍 to confirm or 👎 to cancel.",
    );
    if (!confirmed) {
      return {
        result: `Action "${actionName}" was cancelled by user.`,
        permissions: action.permissions,
      };
    }
  }

  try {
    const raw = await action.action_fn(actionContext, params);

    /** @type {ActionResult} */
    const actionResult = (raw != null && typeof raw === "object" && !Array.isArray(raw) && "result" in raw)
      ? /** @type {ActionResult} */ (raw)
      : { result: /** @type {ActionResultValue} */ (raw) };

    const permissions = actionResult.autoContinue !== undefined
      ? { ...action.permissions, autoContinue: actionResult.autoContinue }
      : action.permissions;

    return { result: actionResult.result, permissions };
  } catch (error) {
    log.error(`Error executing action ${actionName}:`, error);
    throw error;
  }
}

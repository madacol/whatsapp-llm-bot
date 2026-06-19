import { generateSessionTitle } from "./session-title.js";
import { createLogger } from "../logger.js";

const defaultLog = createLogger("conversation:session-binding");

/**
 * @typedef {{
 *   chatId: string,
 *   harnessName: string,
 *   instanceId: string,
 *   status: "starting" | "ready" | "running" | "stopped" | "error",
 *   resumeCursor?: string | null,
 *   runtimeMode?: string | null,
 *   runtimePayload?: Record<string, unknown> | null,
 *   activeTurnId?: string | null,
 *   lastRuntimeEvent?: string | null,
 *   lastRuntimeEventAt?: string | null,
 *   updatedAt?: string,
 * }} HarnessSessionBinding
 *
 * @typedef {{
 *   upsert: (binding: HarnessSessionBinding) => HarnessSessionBinding,
 *   getBinding: (chatId: string) => HarnessSessionBinding | null,
 *   remove: (chatId: string) => void,
 * }} HarnessSessionDirectory
 */

/**
 * @typedef {{
 *   directory: HarnessSessionDirectory,
 *   saveHarnessSession: import("../store.js").Store["saveHarnessSession"],
 *   archiveHarnessSession: import("../store.js").Store["archiveHarnessSession"],
 *   getHarnessSessionHistory: import("../store.js").Store["getHarnessSessionHistory"],
 *   restoreHarnessSession: import("../store.js").Store["restoreHarnessSession"],
 *   pushHarnessForkStack: import("../store.js").Store["pushHarnessForkStack"],
 *   popHarnessForkStack: import("../store.js").Store["popHarnessForkStack"],
 *   getMessages: import("../store.js").Store["getMessages"],
 *   llmClient: LlmClient,
 *   resolveHarnessInstanceForChat: (chatInfo: import("../store.js").ChatRow | undefined) => Promise<ReturnType<typeof import("#harnesses").resolveHarnessInstance> | null>,
 *   generateTitle?: typeof generateSessionTitle,
 *   log?: Pick<Console, "info" | "warn">,
 * }} HarnessSessionBindingServiceDeps
 */

/**
 * @param {HarnessRunConfig} runConfig
 * @returns {Record<string, unknown>}
 */
function buildRuntimePayload(runConfig) {
  return {
    workdir: runConfig.workdir ?? null,
    model: runConfig.model ?? null,
    reasoningEffort: runConfig.reasoningEffort ?? null,
    approvalPolicy: runConfig.approvalPolicy ?? null,
    approvalsReviewer: runConfig.approvalsReviewer ?? null,
  };
}

/**
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @param {string} harnessName
 * @returns {string | null}
 */
function getDurableResumeCursor(chatInfo, harnessName) {
  return chatInfo?.harness_session_kind === harnessName
    ? chatInfo.harness_session_id
    : null;
}

/**
 * @param {HarnessSessionBindingServiceDeps} deps
 * @returns {{
 *   beginTurn: (input: {
 *     chatId: string,
 *     chatInfo: import("../store.js").ChatRow | undefined,
 *     harnessName: string,
 *     harnessInstance: ReturnType<typeof import("#harnesses").resolveHarnessInstance> | null,
 *     runConfig: HarnessRunConfig,
 *     turnId: string,
 *   }) => Promise<{
 *     getResumeCursor: () => string | null,
 *     markRunning: () => void,
 *     markReady: () => void,
 *     markError: () => void,
 *     saveHarnessSessionAndBinding: import("../store.js").Store["saveHarnessSession"],
 *     syncFromAdapter: (adapter: HarnessAdapter, sessionKind: HarnessSessionRef["kind"]) => Promise<void>,
 *   }>,
 *   markError: (chatId: string) => void,
 *   clearActiveSession: (chatId: string, chatInfo: import("../store.js").ChatRow | undefined) => Promise<boolean>,
 *   archiveWithGeneratedTitle: (chatId: string, chatInfo: import("../store.js").ChatRow | undefined) => Promise<import("../store.js").HarnessSessionHistoryEntry | null>,
 *   createCommandSessionControl: (chatInfo: import("../store.js").ChatRow | undefined) => HarnessCommandContext["sessionControl"],
 *   createSessionForkControl: () => HarnessCommandContext["sessionForkControl"],
 * }}
 */
export function createHarnessSessionBindingService(deps) {
  const titleGenerator = deps.generateTitle ?? generateSessionTitle;
  const log = deps.log ?? defaultLog;

  /**
   * @param {string} chatId
   * @param {import("../store.js").ChatRow | undefined} chatInfo
   * @returns {Promise<boolean>}
   */
  async function clearActiveSession(chatId, chatInfo) {
    const harnessInstance = await deps.resolveHarnessInstanceForChat(chatInfo);
    deps.directory.remove(chatId);
    let stopped = false;
    try {
      stopped = !!(await harnessInstance?.adapter?.stopSession(chatId));
    } finally {
      await deps.saveHarnessSession(chatId, null);
    }
    return stopped;
  }

  /**
   * @param {string} chatId
   * @param {import("../store.js").ChatRow | undefined} chatInfo
   * @returns {Promise<import("../store.js").HarnessSessionHistoryEntry | null>}
   */
  async function archiveWithGeneratedTitle(chatId, chatInfo) {
    if (!chatInfo?.harness_session_id || !chatInfo?.harness_session_kind) {
      return deps.archiveHarnessSession(chatId);
    }

    try {
      const messageRows = await deps.getMessages(chatId);
      const title = await titleGenerator({
        llmClient: deps.llmClient,
        chatInfo,
        messageRows,
      });
      return deps.archiveHarnessSession(chatId, { title });
    } catch (error) {
      log.warn("Failed to generate session title before archive:", error);
      return deps.archiveHarnessSession(chatId);
    }
  }

  /**
   * @param {string} chatId
   * @param {string} harnessName
   * @param {ReturnType<typeof import("#harnesses").resolveHarnessInstance> | null} harnessInstance
   * @param {HarnessRunConfig} runConfig
   * @param {string} turnId
   * @param {() => string | null} getResumeCursor
   * @param {(resumeCursor: string | null) => void} setResumeCursor
   * @param {"running" | "ready" | "stopped" | "error"} status
   * @param {string | null | undefined} resumeCursor
   * @returns {void}
   */
  function upsertBinding(chatId, harnessName, harnessInstance, runConfig, turnId, getResumeCursor, setResumeCursor, status, resumeCursor) {
    if (!harnessInstance) {
      return;
    }
    if (resumeCursor !== undefined) {
      setResumeCursor(resumeCursor);
    }
    deps.directory.upsert({
      chatId,
      harnessName,
      instanceId: harnessInstance.instanceId,
      status,
      activeTurnId: status === "running" ? turnId : null,
      resumeCursor: getResumeCursor(),
      runtimeMode: runConfig.sandboxMode ?? null,
      runtimePayload: buildRuntimePayload(runConfig),
    });
  }

  return {
    async beginTurn({
      chatId,
      chatInfo,
      harnessName,
      harnessInstance,
      runConfig,
      turnId,
    }) {
      let currentResumeCursor = getDurableResumeCursor(chatInfo, harnessName);
      log.info("Agent runtime session binding begin.", {
        chatId,
        harnessName,
        instanceId: harnessInstance?.instanceId ?? null,
        turnId,
        hasDurableResumeCursor: !!currentResumeCursor,
        durableResumeCursor: currentResumeCursor ?? null,
      });
      if (harnessInstance?.adapter) {
        const startedSession = await harnessInstance.adapter.startSession({
          chatId,
          runConfig,
          resumeCursor: currentResumeCursor,
        });
        log.info("Agent runtime adapter session started.", {
          chatId,
          harnessName,
          instanceId: harnessInstance.instanceId,
          turnId,
          inputResumeCursor: currentResumeCursor ?? null,
          adapterResumeCursor: startedSession.resumeCursor ?? null,
          reattachAttempted: !!currentResumeCursor,
          reattachAccepted: !!currentResumeCursor && (startedSession.resumeCursor ?? null) === currentResumeCursor,
          status: startedSession.status,
        });
        currentResumeCursor = startedSession.resumeCursor ?? currentResumeCursor;
      }

      const getResumeCursor = () => currentResumeCursor;
      const setResumeCursor = (/** @type {string | null} */ resumeCursor) => {
        currentResumeCursor = resumeCursor;
      };
      const mark = (
        /** @type {"running" | "ready" | "stopped" | "error"} */ status,
        /** @type {string | null | undefined} */ resumeCursor = undefined,
      ) => {
        upsertBinding(
          chatId,
          harnessName,
          harnessInstance,
          runConfig,
          turnId,
          getResumeCursor,
          setResumeCursor,
          status,
          resumeCursor,
        );
        log.info("Agent runtime session binding status updated.", {
          chatId,
          harnessName,
          instanceId: harnessInstance?.instanceId ?? null,
          turnId,
          status,
          activeTurnId: status === "running" ? turnId : null,
          resumeCursor: getResumeCursor(),
        });
      };

      const saveHarnessSessionAndBinding = async (
        /** @type {string} */ sessionChatId,
        /** @type {HarnessSessionRef | null} */ sessionRef,
      ) => {
        await deps.saveHarnessSession(sessionChatId, sessionRef);
        if (sessionChatId === chatId) {
          mark(sessionRef ? "ready" : "stopped", sessionRef?.id ?? null);
        }
      };

      return {
        getResumeCursor,
        markRunning: () => mark("running"),
        markReady: () => mark("ready"),
        markError: () => mark("error"),
        saveHarnessSessionAndBinding,
        async syncFromAdapter(adapter, sessionKind) {
          const activeSession = adapter
            .listSessions()
            .find((session) => session.chatId === chatId);
          if (activeSession?.resumeCursor) {
            log.info("Agent runtime adapter session synced to durable cursor.", {
              chatId,
              sessionKind,
              activeStatus: activeSession.status,
              resumeCursor: activeSession.resumeCursor,
            });
            await saveHarnessSessionAndBinding(chatId, {
              id: activeSession.resumeCursor,
              kind: sessionKind,
            });
          } else if (currentResumeCursor && activeSession && ["stopped", "error"].includes(activeSession.status)) {
            log.info("Agent runtime adapter session cleared durable cursor.", {
              chatId,
              sessionKind,
              activeStatus: activeSession.status,
              previousResumeCursor: currentResumeCursor,
            });
            await saveHarnessSessionAndBinding(chatId, null);
          }
        },
      };
    },

    markError(chatId) {
      const binding = deps.directory.getBinding(chatId);
      if (binding) {
        deps.directory.upsert({ ...binding, status: "error" });
      }
    },

    clearActiveSession,
    archiveWithGeneratedTitle,

    createCommandSessionControl(chatInfo) {
      return {
        archive: async (sessionChatId) => archiveWithGeneratedTitle(sessionChatId, chatInfo),
        getHistory: deps.getHarnessSessionHistory,
        restore: deps.restoreHarnessSession,
        clearRuntime: async (sessionChatId) => clearActiveSession(sessionChatId, chatInfo),
      };
    },

    createSessionForkControl() {
      return {
        save: deps.saveHarnessSession,
        push: deps.pushHarnessForkStack,
        pop: deps.popHarnessForkStack,
      };
    },
  };
}

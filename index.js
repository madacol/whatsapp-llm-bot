/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import fs from "node:fs";

import { getActions, executeAction } from "./actions.js";
import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { createWhatsAppTransport, createWhatsAppWorkspacePresenter } from "#whatsapp";
import { startReminderDaemon } from "./reminder-daemon.js";
import { startModelsCacheDaemon } from "./models-cache.js";
import { initStore } from "./store.js";
import { startHtmlServer, stopHtmlServer } from "./html-server.js";
import { registerOptionalHarnesses, waitForAllHarnesses } from "#harnesses";
import { createLogger } from "./logger.js";
import { createConversationRunner } from "./conversation/create-conversation-runner.js";
import { getDbCachePaths, getDbCacheSize } from "./db.js";
import { startProcessDiagnostics } from "./process-diagnostics.js";
import { deliverPendingRestartAck } from "./actions/admin/restart/_restart-ack-delivery.js";
import { createRestartAckStore } from "./actions/admin/restart/_restart-ack-store.js";

const log = createLogger("index");
const SHUTDOWN_FORCE_EXIT_MS = 10_000;

/**
 * @typedef {import('./store.js').Store} Store
 *
 * @typedef {{
 *   store: Store,
 *   llmClient: LlmClient,
 *   getActionsFn: typeof getActions,
 *   executeActionFn: typeof executeAction,
 *   transport?: ChatTransport,
 *   workspacePresentation?: WorkspacePresentationPort,
 * }} MessageHandlerDeps
 */

/**
 * Create a message handler with injected dependencies.
 * @param {MessageHandlerDeps} deps
 * @returns {{ handleMessage: (turn: ChatTurn) => Promise<void> }}
 */
export function createMessageHandler(deps) {
  const { store, llmClient, getActionsFn, executeActionFn, transport, workspacePresentation } = deps;
  return createConversationRunner({
    store,
    llmClient,
    getActionsFn,
    executeActionFn,
    transport,
    workspacePresentation,
  });
}

// ── Default initialization (production) ──

// Register optional harnesses
await registerOptionalHarnesses();

if (!process.env.TESTING) {
  // Prevent duplicate instances: if old PID is still running, kill it first
  const pidFile = ".bot.pid";
  if (fs.existsSync(pidFile)) {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
    try {
      process.kill(oldPid, 0); // check if alive
      log.info(`Killing previous instance (PID ${oldPid})...`);
      process.kill(oldPid, "SIGTERM");
      // Wait for graceful shutdown (active queries get 2min to finish)
      const start = Date.now();
      while (Date.now() - start < 125_000) {
        try { process.kill(oldPid, 0); } catch { break; }
      }
    } catch { /* not running, ok */ }
  }
  fs.writeFileSync(pidFile, process.pid.toString());
  function cleanupPidFile() {
    try {
      if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf-8").trim() === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // Nothing useful to do during process shutdown.
    }
  }
  process.on("exit", cleanupPidFile);

  const store = await initStore();
  const llmClient = createLlmClient();
  const restartAckStore = createRestartAckStore();
  const transport = await createWhatsAppTransport({
    onConnectionOpen: async ({ editMessage, sendText, recoverQueuedMessage }) => {
      await deliverPendingRestartAck({ store: restartAckStore, editMessage, sendText, recoverQueuedMessage });
    },
  }).catch(async (error) => {
      log.error("Initialization error:", error);
      await store.closeDb();
      process.exit(1);
    });
  const workspacePresentation = createWhatsAppWorkspacePresenter({ transport, store });

  const { handleMessage } = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
    transport,
    workspacePresentation,
  });

  await startHtmlServer(config.html_server_port);

  await transport.start(handleMessage).catch(async (error) => {
    log.error("Initialization error:", error);
    await store.closeDb();
    process.exit(1);
  });

  const stopReminders = startReminderDaemon(transport.sendText);
  const stopModelsCache = startModelsCacheDaemon();
  const stopProcessDiagnostics = startProcessDiagnostics({
    log,
    getDbCacheSize,
    getDbCachePaths,
  });

  async function cleanup() {
    try {
      stopReminders();
      stopModelsCache();
      stopProcessDiagnostics();
      const waitedOn = await waitForAllHarnesses();
      if (waitedOn.length > 0) {
        log.info(`Shutdown waited on ${waitedOn.length} chat(s): ${waitedOn.join(", ")}`);
      }
      await stopHtmlServer();
      await transport.stop();
      await store.closeDb();
    } catch (error) {
      log.error("Error during cleanup:", error);
    }
  }

  let shutdownStarted = false;
  /**
   * @param {"SIGINT" | "SIGTERM"} signal
   * @returns {Promise<void>}
   */
  async function shutdown(signal) {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    const exitCode = signal === "SIGINT" ? 130 : 0;
    const forceExitTimer = setTimeout(() => {
      log.error(`${signal} cleanup timed out after ${SHUTDOWN_FORCE_EXIT_MS}ms; exiting anyway.`);
      process.exit(exitCode);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExitTimer.unref();

    log.info(`${signal} received, cleaning up...`);
    await cleanup();
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("uncaughtException", async (error) => {
    // The Claude Agent SDK subprocess throws "Operation aborted" as an
    // uncaught exception when a query is cancelled via AbortController.
    // This is a known SDK internal error path (y9.write → handleControlRequest)
    // that escapes the async iterator's promise chain.  Suppress it instead
    // of crashing the whole bot.
    if (error?.message === "Operation aborted" || error?.name === "AbortError") {
      log.warn("Suppressed SDK abort exception:", error.message);
      return;
    }
    log.error("Uncaught Exception:", error);
    await cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    // Same suppression for abort errors surfacing as unhandled rejections
    if (reason instanceof Error && (reason.message === "Operation aborted" || reason.name === "AbortError")) {
      log.warn("Suppressed SDK abort rejection:", reason.message);
      return;
    }
    log.error("Unhandled Rejection:", reason);
    // Don't exit — unhandled rejections are non-fatal by default in Node ≥15
    // but log them so they're visible.
  });
}

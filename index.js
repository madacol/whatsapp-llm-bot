/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import config from "./config.js";
import { createLlmClient } from "./llm.js";
import { createWhatsAppTransport, createWhatsAppWorkspacePresenter } from "#whatsapp";
import { startReminderDaemon } from "./reminder-daemon.js";
import { startModelsCacheDaemon } from "./models-cache.js";
import { initStore } from "./store.js";
import { startHtmlServer, stopHtmlServer } from "./html-server.js";
import { createHttpApiTransport } from "./http-api-transport.js";
import { registerOptionalHarnesses, waitForAllHarnesses } from "#harnesses";
import { createLogger } from "./logger.js";
import { createConversationRunner } from "./conversation/create-conversation-runner.js";
import { deliverPendingRestartAck } from "./restart/restart-ack-delivery.js";
import { createRestartAckStore } from "./restart/restart-ack-store.js";
import { createRestartCommandHandler } from "./commands/restart-command.js";
import { createGracefulShutdownHandler } from "./shutdown-lifecycle.js";

const log = createLogger("index");
const SHUTDOWN_FORCE_EXIT_MS = 10_000;

/**
 * @typedef {import('./store.js').Store} Store
 *
 * @typedef {{
 *   store: Store,
 *   llmClient: LlmClient,
 *   restartCommandHandler?: ReturnType<typeof createRestartCommandHandler>,
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
  const { store, llmClient, restartCommandHandler, transport, workspacePresentation } = deps;
  return createConversationRunner({
    store,
    llmClient,
    restartCommandHandler,
    transport,
    workspacePresentation,
  });
}

/**
 * Wait until a PID disappears without monopolizing the event loop.
 *
 * @param {number} pid
 * @param {{
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   killFn?: typeof process.kill,
 *   nowFn?: () => number,
 *   sleepFn?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<boolean>} true when the process exits before timeout
 */
export async function waitForPidExit(pid, options = {}) {
  const {
    timeoutMs = 125_000,
    pollIntervalMs = 250,
    killFn = process.kill,
    nowFn = Date.now,
    sleepFn = delay,
  } = options;
  const deadline = nowFn() + timeoutMs;

  while (nowFn() < deadline) {
    try {
      killFn(pid, 0);
    } catch {
      return true;
    }

    const remainingMs = deadline - nowFn();
    if (remainingMs <= 0) {
      break;
    }
    await sleepFn(Math.min(pollIntervalMs, remainingMs));
  }

  return false;
}

/**
 * Create an explicit startup dependency for inbound message routing.
 * WhatsApp can receive and journal inbound events while this promise is
 * pending; routing starts only after markReady() resolves it.
 * @returns {{ ready: Promise<void>, markReady: () => void }}
 */
export function createStartupRecoveryCoordinator() {
  /** @type {() => void} */
  let resolveReady = () => {};
  /** @type {Promise<void>} */
  const ready = new Promise((resolve) => {
    resolveReady = () => resolve();
  });
  let resolved = false;
  return {
    ready,
    markReady() {
      if (resolved) {
        return;
      }
      resolved = true;
      resolveReady();
    },
  };
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
      await waitForPidExit(oldPid);
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
  const startupRecovery = createStartupRecoveryCoordinator();
  const transport = await createWhatsAppTransport({
    outboundStore: store,
    inboundDispatchReady: startupRecovery.ready,
    onConnectionOpen: async ({ editMessage, sendText, recoverQueuedMessage, phase }) => {
      await deliverPendingRestartAck({ store: restartAckStore, editMessage, sendText, recoverQueuedMessage, phase });
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
    restartCommandHandler: createRestartCommandHandler({ restartAckStore }),
    transport,
    workspacePresentation,
  });

  await startHtmlServer(config.html_server_port);
  startupRecovery.markReady();

  await transport.start(handleMessage).catch(async (error) => {
    log.error("Initialization error:", error);
    await store.closeDb();
    process.exit(1);
  });

  const apiTransport = config.api_transport_token
    ? await createHttpApiTransport({
        host: config.api_transport_host,
        port: config.api_transport_port,
        authToken: config.api_transport_token,
      })
    : null;
  if (apiTransport) {
    await apiTransport.start(handleMessage).catch(async (error) => {
      log.error("HTTP API transport initialization error:", error);
      await transport.stop();
      await store.closeDb();
      process.exit(1);
    });
    log.info(`HTTP API transport enabled on ${apiTransport.baseUrl}`);
  }

  const stopReminders = startReminderDaemon(transport.sendText);
  const stopModelsCache = startModelsCacheDaemon();

  async function cleanupResources() {
    try {
      stopReminders();
      stopModelsCache();
      await stopHtmlServer();
      await apiTransport?.stop();
      await transport.stop();
      await store.closeDb();
    } catch (error) {
      log.error("Error during cleanup:", error);
    }
  }

  const shutdown = createGracefulShutdownHandler({
    waitForActiveTurns: waitForAllHarnesses,
    cleanupResources,
    log,
    forceCleanupTimeoutMs: SHUTDOWN_FORCE_EXIT_MS,
  });

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
    await cleanupResources();
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

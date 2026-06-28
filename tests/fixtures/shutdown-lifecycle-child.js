import { createGracefulShutdownHandler } from "../../shutdown-lifecycle.js";

/** @type {(() => void) | undefined} */
let releaseActiveTurn;
const activeTurn = new Promise((resolve) => {
  releaseActiveTurn = () => resolve(undefined);
});
const activeTurnHandle = setInterval(() => {}, 1_000);

/**
 * @param {unknown} message
 */
function send(message) {
  if (process.send) {
    process.send(message);
  }
}

const shutdown = createGracefulShutdownHandler({
  forceCleanupTimeoutMs: 100,
  activeTurnTimeoutMs: 5_000,
  log: {
    info: (message) => send({ type: "log", level: "info", message }),
    error: (message) => send({ type: "log", level: "error", message }),
  },
  waitForActiveTurns: async () => {
    send({ type: "active-wait-started" });
    await activeTurn;
    clearInterval(activeTurnHandle);
    send({ type: "active-wait-finished" });
    return ["agent-run-chat@g.us"];
  },
  cleanupResources: async () => {
    send({ type: "cleanup" });
  },
});

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

process.on("message", (message) => {
  if (message === "release-active-turn") {
    releaseActiveTurn?.();
  }
});

send({ type: "ready" });

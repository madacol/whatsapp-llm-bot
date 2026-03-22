import {
  Browsers,
  fetchLatestWaWebVersion,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { exec } from "node:child_process";
import { rm } from "node:fs/promises";
import { createLogger } from "../logger.js";
import { needsAuthReset, sendAlertEmail } from "../notifications.js";

const log = createLogger("whatsapp");

const AUTH_DIR = "./auth_info_baileys";
const QR_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @typedef {{
 *   info: (...args: unknown[]) => void;
 *   warn: (...args: unknown[]) => void;
 *   error: (...args: unknown[]) => void;
 * }} SupervisorLogger
 */

/**
 * @typedef {{
 *   loadAuthState: typeof useMultiFileAuthState;
 *   createSocket: (
 *     auth: Awaited<ReturnType<typeof useMultiFileAuthState>>["state"],
 *     version: [number, number, number],
 *   ) => import("@whiskeysockets/baileys").WASocket;
 *   clearAuthState: (authDir: string) => Promise<void>;
 *   printQrCode: (qr: string) => void;
 *   wait: (ms: number) => Promise<void>;
 *   exit: (code: number) => never;
 *   requiresAuthReset: typeof needsAuthReset;
 *   sendAuthResetAlert: (statusCode: number | undefined) => Promise<void>;
 * }} ConnectionSupervisorDeps
 */

/**
 * @typedef {{
 *   version: [number, number, number];
 *   log: SupervisorLogger;
 *   onSocketReady: (
 *     sock: import("@whiskeysockets/baileys").WASocket,
 *     saveCreds: () => Promise<void>,
 *   ) => void;
 *   onClearState: () => void;
 *   authDir?: string;
 *   qrTimeoutMs?: number;
 * }} ConnectionSupervisorOptions
 */

/**
 * @typedef {{
 *   start: () => Promise<void>;
 *   stop: () => Promise<void>;
 *   sendText: (chatId: string, text: string) => Promise<void>;
 *   handleConnectionUpdate: (
 *     update: import("@whiskeysockets/baileys").BaileysEventMap["connection.update"],
 *     sock: import("@whiskeysockets/baileys").WASocket,
 *   ) => Promise<void>;
 *   isStopped: () => boolean;
 * }} WhatsAppConnectionSupervisor
 */

/**
 * Print a WhatsApp QR code to the terminal.
 * @param {string} qr
 * @returns {void}
 */
function printQrCode(qr) {
  exec(`echo "${qr}" | qrencode -t ansiutf8`, (error, stdout, stderr) => {
    if (error) {
      log.error(error);
      log.error(stderr);
      return;
    }
    log.info(stdout);
  });
}

/**
 * Build a WASocket instance from auth state.
 * @param {Awaited<ReturnType<typeof useMultiFileAuthState>>["state"]} auth
 * @param {[number, number, number]} version
 * @returns {import("@whiskeysockets/baileys").WASocket}
 */
function createSocket(auth, version) {
  return makeWASocket({
    version,
    auth,
    browser: Browsers.ubuntu("Chrome"),
  });
}

/**
 * Send an auth reset alert email.
 * @param {number | undefined} statusCode
 * @returns {Promise<void>}
 */
async function sendAuthResetAlert(statusCode) {
  await sendAlertEmail(
    `WhatsApp Bot: Auth failure (${statusCode})`,
    `The WhatsApp bot connection failed with status ${statusCode}.\n`
    + "Auth credentials have been cleared and a QR code is being displayed.\n"
    + "Please scan the QR code within 5 minutes or the process will exit.\n"
    + `Time: ${new Date().toISOString()}`,
  );
}

/**
 * Extract the Baileys disconnect status code if present.
 * @param {{ error?: Error | (Error & { output?: { statusCode?: number } }) } | undefined} lastDisconnect
 * @returns {number | undefined}
 */
function getDisconnectStatusCode(lastDisconnect) {
  const error = /** @type {{ output?: { statusCode?: number } } | undefined} */ (lastDisconnect?.error);
  return error?.output?.statusCode;
}

/**
 * Create the lifecycle controller for the WhatsApp socket connection.
 * @param {ConnectionSupervisorOptions} options
 * @param {ConnectionSupervisorDeps} deps
 * @returns {WhatsAppConnectionSupervisor}
 */
export function createConnectionSupervisor(options, deps) {
  const {
    version,
    log: logger,
    onSocketReady,
    onClearState,
    authDir = AUTH_DIR,
    qrTimeoutMs = QR_TIMEOUT_MS,
  } = options;

  /** @type {{ current: import("@whiskeysockets/baileys").WASocket | null }} */
  const sockRef = { current: null };
  /** @type {ReturnType<typeof setTimeout> | null} */
  let qrExitTimer = null;
  let sessionResetInProgress = false;
  let stopped = false;

  /**
   * Clear all supervisor-owned state.
   * @returns {void}
   */
  function clearManagedState() {
    if (qrExitTimer) {
      clearTimeout(qrExitTimer);
      qrExitTimer = null;
    }
    sessionResetInProgress = false;
    onClearState();
  }

  /**
   * Open a socket with the latest auth state and hand it off to the caller.
   * @returns {Promise<void>}
   */
  async function connect() {
    if (stopped) return;

    const { state, saveCreds } = await deps.loadAuthState(authDir);
    if (stopped) return;

    const sock = deps.createSocket(state, version);
    if (stopped) {
      sock.end(undefined);
      return;
    }

    sockRef.current = sock;
    onSocketReady(sock, saveCreds);
  }

  /**
   * Reconnect after a disconnect.
   * @returns {Promise<void>}
   */
  async function reconnect() {
    if (stopped) return;
    await connect();
  }

  return {
    async start() {
      stopped = false;
      await connect();
    },

    async stop() {
      logger.info("Cleaning up WhatsApp connection...");
      stopped = true;
      clearManagedState();
      const sock = sockRef.current;
      sockRef.current = null;
      try {
        sock?.end(undefined);
      } catch (error) {
        logger.error("Error during WhatsApp cleanup:", error);
      }
    },

    async sendText(chatId, text) {
      const sock = sockRef.current;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      await sock.sendMessage(chatId, { text });
    },

    async handleConnectionUpdate(update, sock) {
      if (stopped) return;

      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        deps.printQrCode(qr);
      }

      if (connection === "close") {
        const statusCode = getDisconnectStatusCode(lastDisconnect);
        logger.info("Connection closed due to ", lastDisconnect?.error, ", status code:", statusCode);

        if (deps.requiresAuthReset(lastDisconnect) && !sessionResetInProgress) {
          sessionResetInProgress = true;
          logger.warn(`Auth failure (${statusCode}). Clearing auth and requesting re-pair...`);
          await deps.clearAuthState(authDir);
          await deps.sendAuthResetAlert(statusCode);
          sock.end(undefined);
          await reconnect();
          qrExitTimer = setTimeout(() => {
            logger.error("QR code was not scanned within 5 minutes. Exiting.");
            deps.exit(1);
          }, qrTimeoutMs);
        } else if (deps.requiresAuthReset(lastDisconnect) && sessionResetInProgress) {
          logger.error(`Auth still failing (${statusCode}) after reset. Exiting.`);
          deps.exit(1);
        } else if (statusCode !== 401) {
          sock.end(undefined);
          await deps.wait(1000);
          await reconnect();
        }
        return;
      }

      if (connection === "open") {
        if (qrExitTimer) {
          clearTimeout(qrExitTimer);
          qrExitTimer = null;
          sessionResetInProgress = false;
          logger.info("QR code scanned successfully, exit timer cancelled.");
        }
        logger.info("WhatsApp connection opened");
      }
    },

    isStopped() {
      return stopped;
    },
  };
}

/**
 * Build the production WhatsApp connection supervisor with Baileys + notifications.
 * @param {{
 *   onSocketReady: ConnectionSupervisorOptions["onSocketReady"];
 *   onClearState: () => void;
 * }} options
 * @returns {Promise<WhatsAppConnectionSupervisor>}
 */
export async function createWhatsAppConnectionSupervisor(options) {
  const { version: latestVersion } = await fetchLatestWaWebVersion();
  /** @type {[number, number, number]} */
  const version = [latestVersion[0], latestVersion[1], latestVersion[2]];
  log.info("Using WA Web version:", version);

  return createConnectionSupervisor(
    {
      version,
      log,
      onSocketReady: options.onSocketReady,
      onClearState: options.onClearState,
    },
    {
      loadAuthState: useMultiFileAuthState,
      createSocket,
      clearAuthState: async (authDir) => {
        await rm(authDir, { recursive: true, force: true });
      },
      printQrCode,
      wait: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      exit: (code) => process.exit(code),
      requiresAuthReset: needsAuthReset,
      sendAuthResetAlert,
    },
  );
}

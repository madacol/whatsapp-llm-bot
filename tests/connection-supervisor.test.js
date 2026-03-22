import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConnectionSupervisor } from "../whatsapp/connection-supervisor.js";

/**
 * @typedef {{
 *   sendMessages: Array<{ chatId: string, message: Record<string, unknown> }>;
 *   endCalls: number;
 * }} MockSocketState
 */

/**
 * @typedef {{
 *   sock: BaileysSocket;
 *   state: MockSocketState;
 * }} MockSocket
 */

/**
 * @returns {{ info: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }}
 */
function createSilentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * @returns {MockSocket}
 */
function createMockSocket() {
  /** @type {MockSocketState} */
  const state = {
    sendMessages: [],
    endCalls: 0,
  };

  const sock = /** @type {BaileysSocket} */ (/** @type {unknown} */ ({
    ev: {
      process: () => {},
    },
    end: () => {
      state.endCalls += 1;
    },
    sendMessage: async (chatId, message) => {
      state.sendMessages.push({ chatId, message });
      return { key: { id: `sent-${state.sendMessages.length}`, remoteJid: chatId } };
    },
  }));

  return { sock, state };
}

describe("createConnectionSupervisor", () => {
  it("reconnects after non-auth disconnects", async () => {
    /** @type {MockSocket[]} */
    const sockets = [];
    /** @type {BaileysSocket[]} */
    const readySockets = [];

    const supervisor = createConnectionSupervisor(
      {
        version: [1, 2, 3],
        log: createSilentLogger(),
        onSocketReady: (sock) => {
          readySockets.push(sock);
        },
        onClearState: () => {},
      },
      {
        loadAuthState: async () => ({
          state: /** @type {Awaited<ReturnType<typeof import("@whiskeysockets/baileys").useMultiFileAuthState>>["state"]} */ (/** @type {unknown} */ ({})),
          saveCreds: async () => {},
        }),
        createSocket: () => {
          const socket = createMockSocket();
          sockets.push(socket);
          return socket.sock;
        },
        clearAuthState: async () => {},
        printQrCode: () => {},
        wait: async () => {},
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
        requiresAuthReset: () => false,
        sendAuthResetAlert: async () => {},
      },
    );

    await supervisor.start();
    assert.equal(readySockets.length, 1);

    await supervisor.handleConnectionUpdate(
      /** @type {import("@whiskeysockets/baileys").BaileysEventMap["connection.update"]} */ ({
        connection: "close",
        lastDisconnect: {
          error: /** @type {Error & { output: { statusCode: number } }} */ (Object.assign(new Error("closed"), {
            output: { statusCode: 500 },
          })),
        },
      }),
      sockets[0].sock,
    );

    assert.equal(sockets[0].state.endCalls, 1, "existing socket should be closed before reconnect");
    assert.equal(readySockets.length, 2, "a replacement socket should be created");
  });

  it("stops by clearing managed state and closing the current socket", async () => {
    let clearStateCalls = 0;
    /** @type {MockSocket[]} */
    const sockets = [];

    const supervisor = createConnectionSupervisor(
      {
        version: [1, 2, 3],
        log: createSilentLogger(),
        onSocketReady: () => {},
        onClearState: () => {
          clearStateCalls += 1;
        },
      },
      {
        loadAuthState: async () => ({
          state: /** @type {Awaited<ReturnType<typeof import("@whiskeysockets/baileys").useMultiFileAuthState>>["state"]} */ (/** @type {unknown} */ ({})),
          saveCreds: async () => {},
        }),
        createSocket: () => {
          const socket = createMockSocket();
          sockets.push(socket);
          return socket.sock;
        },
        clearAuthState: async () => {},
        printQrCode: () => {},
        wait: async () => {},
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
        requiresAuthReset: () => false,
        sendAuthResetAlert: async () => {},
      },
    );

    await supervisor.start();
    await supervisor.sendText("chat-1", "hello");
    assert.equal(sockets[0].state.sendMessages.length, 1);

    await supervisor.stop();

    assert.equal(clearStateCalls, 1);
    assert.equal(sockets[0].state.endCalls, 1);
    await assert.rejects(
      supervisor.sendText("chat-1", "after-stop"),
      /WhatsApp transport has not been started/,
    );
  });
});

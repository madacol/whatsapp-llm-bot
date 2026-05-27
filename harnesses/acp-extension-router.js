/**
 * Explicit ACP extension request/notification router.
 *
 * Core ACP methods should be registered as first-class handlers. Unknown
 * extension traffic is still surfaced as runtime events, but unsupported
 * requests now fail with a proper JSON-RPC method-not-found error instead of a
 * silent empty object.
 */

export class AcpUnsupportedMethodError extends Error {
  /**
   * @param {string} method
   */
  constructor(method) {
    super(`Unsupported ACP client request method: ${method}`);
    this.name = "AcpUnsupportedMethodError";
    this.code = -32601;
  }
}

/**
 * @typedef {{
 *   requestHandlers?: Map<string, (message: Record<string, unknown>) => Promise<unknown> | unknown>,
 *   notificationHandlers?: Map<string, (message: Record<string, unknown>) => Promise<void> | void>,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>,
 *   createRawPayload: (method: string, payload: unknown) => Record<string, unknown>,
 * }} AcpExtensionRouterInput
 */

/**
 * @param {AcpExtensionRouterInput} input
 * @returns {{
 *   handleRequest: (message: Record<string, unknown>) => Promise<unknown>,
 *   handleNotification: (message: Record<string, unknown>) => Promise<void>,
 * }}
 */
export function createAcpExtensionRouter(input) {
  const requestHandlers = input.requestHandlers ?? new Map();
  const notificationHandlers = input.notificationHandlers ?? new Map();

  return {
    async handleRequest(message) {
      const method = typeof message.method === "string" ? message.method : "";
      const handler = requestHandlers.get(method);
      if (handler) {
        return handler(message);
      }
      if (method) {
        await input.emitRuntimeEvent({
          type: "extension.request",
          provider: "acp",
          method,
          payload: message.params,
          raw: input.createRawPayload(method, message.params),
        });
        throw new AcpUnsupportedMethodError(method);
      }
      throw new AcpUnsupportedMethodError("<missing>");
    },

    async handleNotification(message) {
      const method = typeof message.method === "string" ? message.method : "";
      const handler = notificationHandlers.get(method);
      if (handler) {
        await handler(message);
        return;
      }
      if (!method) {
        return;
      }
      await input.emitRuntimeEvent({
        type: "extension.notification",
        provider: "acp",
        method,
        payload: message.params,
        raw: input.createRawPayload(method, message.params),
      });
    },
  };
}

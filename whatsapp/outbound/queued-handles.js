/** @type {Map<string, Array<(handle: MessageHandle | undefined) => void>>} */
const queuedHandleResolvers = new Map();

/**
 * @param {string} chatId
 * @param {number} queueId
 * @returns {string}
 */
function queuedHandleKey(chatId, queueId) {
  return `${chatId}:${queueId}`;
}

/**
 * @param {string} chatId
 * @param {number} queueId
 * @param {MessageHandle | undefined} handle
 * @returns {void}
 */
export function resolveQueuedHandle(chatId, queueId, handle) {
  const key = queuedHandleKey(chatId, queueId);
  const resolvers = queuedHandleResolvers.get(key);
  if (!resolvers) {
    return;
  }
  queuedHandleResolvers.delete(key);
  for (const resolve of resolvers) {
    resolve(handle);
  }
}

/**
 * @param {string} chatId
 * @param {number} queueId
 * @returns {Promise<MessageHandle | undefined>}
 */
function waitForQueuedHandle(chatId, queueId) {
  return new Promise((resolve) => {
    const key = queuedHandleKey(chatId, queueId);
    const resolvers = queuedHandleResolvers.get(key) ?? [];
    resolvers.push(resolve);
    queuedHandleResolvers.set(key, resolvers);
  });
}

/**
 * @param {string} chatId
 * @param {number} queueId
 * @returns {MessageHandle}
 */
export function createQueuedMessageHandle(chatId, queueId) {
  /** @type {MessageInspectState | null} */
  let inspectState = null;
  const sentPromise = waitForQueuedHandle(chatId, queueId);

  /**
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<MessageHandle | undefined>}
   */
  async function waitUntilSent(options = {}) {
    if (!options.timeoutMs) {
      return sentPromise;
    }
    return Promise.race([
      sentPromise,
      new Promise((resolve) => setTimeout(() => resolve(undefined), options.timeoutMs)),
    ]);
  }

  return {
    deliveryStatus: "queued",
    queueId,
    waitUntilSent,
    update: async (update) => {
      const sentHandle = await waitUntilSent();
      if (!sentHandle) {
        return;
      }
      await sentHandle.update(update);
    },
    setInspect: (inspect) => {
      inspectState = inspect;
      void waitUntilSent().then((sentHandle) => {
        sentHandle?.setInspect(inspectState);
      });
    },
  };
}

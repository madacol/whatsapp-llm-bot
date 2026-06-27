/**
 * @typedef {{
 *   method: string,
 *   resolve: (value: unknown) => void,
 *   reject: (error: Error) => void,
 *   refreshTimeout?: () => void,
 * }} PendingRequest
 */

/**
 * @typedef {{
 *   command: string,
 *   resolvedCommand: string,
 *   cwd?: string | null,
 *   getPid: () => number | undefined,
 *   endNotifications: () => void,
 *   kill: () => void,
 *   logger: {
 *     warn: (message: string, details?: Record<string, unknown>) => void,
 *   },
 * }} AcpConnectionFailureLifecycleOptions
 */

const ACP_STDERR_TAIL_MAX_CHARS = 4_000;

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function getErrorCode(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} current
 * @param {string} chunk
 * @returns {string}
 */
function appendStderrTail(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > ACP_STDERR_TAIL_MAX_CHARS ? next.slice(-ACP_STDERR_TAIL_MAX_CHARS) : next;
}

/**
 * @param {string} value
 * @returns {string}
 */
function cleanStderrTail(value) {
  return value.trim();
}

/**
 * @param {Map<number, PendingRequest>} pendingRequests
 * @returns {string[]}
 */
function pendingRequestSummaries(pendingRequests) {
  return [...pendingRequests].map(([id, pending]) => `${pending.method}#${id}`);
}

/**
 * @param {{
 *   command: string,
 *   resolvedCommand: string,
 *   cwd?: string | null,
 *   error: unknown,
 *   pendingRequests: string[],
 *   stderrTail?: string,
 * }} input
 * @returns {Error}
 */
function createAcpConnectionWriteError(input) {
  const parts = [
    "ACP connection write failed.",
    `command=${input.command}`,
    `resolved=${input.resolvedCommand}`,
  ];
  if (input.cwd) {
    parts.push(`cwd=${input.cwd}`);
  }
  const code = getErrorCode(input.error);
  if (code) {
    parts.push(`code=${code}`);
  }
  if (input.pendingRequests.length > 0) {
    parts.push(`pending=${input.pendingRequests.join(",")}`);
  }
  if (input.stderrTail) {
    parts.push(`stderrTail=${input.stderrTail}`);
  }
  parts.push(getErrorMessage(input.error));
  return new Error(parts.join(" "), { cause: input.error });
}

/**
 * @param {{
 *   command: string,
 *   resolvedCommand: string,
 *   cwd?: string | null,
 *   pendingRequests: string[],
 *   stderrTail?: string,
 * }} input
 * @returns {Error}
 */
function createAcpConnectionUnavailableError(input) {
  const parts = [
    "ACP connection is not writable.",
    `command=${input.command}`,
    `resolved=${input.resolvedCommand}`,
  ];
  if (input.cwd) {
    parts.push(`cwd=${input.cwd}`);
  }
  if (input.pendingRequests.length > 0) {
    parts.push(`pending=${input.pendingRequests.join(",")}`);
  }
  if (input.stderrTail) {
    parts.push(`stderrTail=${input.stderrTail}`);
  }
  return new Error(parts.join(" "));
}

/**
 * @param {{ phase: "startup" | "runtime", command: string, resolvedCommand: string, cwd?: string | null, error: unknown }} input
 * @returns {Error}
 */
function createAcpProcessError(input) {
  const parts = [
    input.phase === "startup"
      ? `Failed to start ACP command "${input.command}".`
      : `ACP command process error "${input.command}".`,
    `resolved=${input.resolvedCommand}`,
  ];
  if (input.cwd) {
    parts.push(`cwd=${input.cwd}`);
  }
  const code = getErrorCode(input.error);
  if (code) {
    parts.push(`code=${code}`);
  }
  parts.push(getErrorMessage(input.error));
  return new Error(parts.join(" "), { cause: input.error });
}

/**
 * @param {{
 *   exitCode: number | null,
 *   signal: NodeJS.Signals | null,
 *   pendingRequests: string[],
 * }} details
 * @returns {string}
 */
function formatConnectionClosedMessage(details) {
  const parts = [
    "ACP connection closed.",
    `exitCode=${details.exitCode === null ? "null" : details.exitCode}`,
    `signal=${details.signal === null ? "null" : details.signal}`,
  ];
  if (details.pendingRequests.length > 0) {
    parts.push(`pending=${details.pendingRequests.join(",")}`);
  }
  return parts.join(" ");
}

/**
 * @param {string} method
 * @param {number} timeoutMs
 * @param {{
 *   command: string,
 *   pid?: number,
 *   cwd?: string | null,
 *   pendingRequests: string[],
 *   stderrTail?: string,
 * }} details
 * @returns {Error}
 */
function createRequestTimeoutError(method, timeoutMs, details) {
  const parts = [
    `ACP request timed out after ${timeoutMs}ms: ${method}`,
    `command=${details.command}`,
  ];
  if (typeof details.pid === "number") {
    parts.push(`pid=${details.pid}`);
  }
  if (details.cwd) {
    parts.push(`cwd=${details.cwd}`);
  }
  if (details.pendingRequests.length > 0) {
    parts.push(`pending=${details.pendingRequests.join(",")}`);
  }
  if (details.stderrTail) {
    parts.push(`stderrTail=${details.stderrTail}`);
  }
  return new Error(parts.join(" "));
}

/**
 * @param {AcpConnectionFailureLifecycleOptions} options
 */
export function createAcpConnectionFailureLifecycle(options) {
  /** @type {Map<number, PendingRequest>} */
  const pendingRequests = new Map();
  let closed = false;
  let closeRequested = false;
  let processError = /** @type {Error | null} */ (null);
  let stderrTail = "";

  /**
   * @returns {string | undefined}
   */
  function maybeCleanStderrTail() {
    const cleanTail = cleanStderrTail(stderrTail);
    return cleanTail || undefined;
  }

  /**
   * @returns {{ command: string, resolvedCommand: string, cwd?: string | null }}
   */
  function commandContext() {
    return {
      command: options.command,
      resolvedCommand: options.resolvedCommand,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };
  }

  /**
   * @returns {void}
   */
  function endConnection() {
    closed = true;
    options.endNotifications();
  }

  /**
   * @param {Error} error
   * @returns {void}
   */
  function rejectPendingRequests(error) {
    for (const [id, pending] of [...pendingRequests]) {
      pendingRequests.delete(id);
      pending.reject(error);
    }
  }

  /**
   * @param {Error} error
   * @returns {void}
   */
  function failConnection(error) {
    if (!processError) {
      processError = error;
    }
    endConnection();
    rejectPendingRequests(processError);
  }

  /**
   * @param {unknown} error
   * @returns {Error}
   */
  function createWriteFailure(error) {
    return createAcpConnectionWriteError({
      ...commandContext(),
      error,
      pendingRequests: pendingRequestSummaries(pendingRequests),
      ...(maybeCleanStderrTail() ? { stderrTail: maybeCleanStderrTail() } : {}),
    });
  }

  /**
   * @returns {{
   *   command: string,
   *   pid?: number,
   *   cwd?: string | null,
   *   pendingRequests: string[],
   *   stderrTail?: string,
   * }}
   */
  function requestFailureDetails() {
    return {
      command: options.command,
      ...(typeof options.getPid() === "number" ? { pid: options.getPid() } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      pendingRequests: pendingRequestSummaries(pendingRequests),
      ...(maybeCleanStderrTail() ? { stderrTail: maybeCleanStderrTail() } : {}),
    };
  }

  /**
   * @param {number} id
   * @param {string} message
   * @returns {void}
   */
  function rejectRequestById(id, message) {
    const pending = pendingRequests.get(id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(id);
    pending.reject(new Error(message));
  }

  return {
    /**
     * @returns {boolean}
     */
    isClosed() {
      return closed;
    },

    /**
     * @returns {boolean}
     */
    isCloseRequested() {
      return closeRequested;
    },

    /**
     * @param {string} chunk
     * @returns {void}
     */
    appendStderr(chunk) {
      stderrTail = appendStderrTail(stderrTail, chunk);
    },

    /**
     * @param {number} id
     * @param {PendingRequest} pending
     * @returns {void}
     */
    addPendingRequest(id, pending) {
      pendingRequests.set(id, pending);
    },

    /**
     * @param {number} id
     * @returns {boolean}
     */
    deletePendingRequest(id) {
      return pendingRequests.delete(id);
    },

    /**
     * @param {number} id
     * @param {unknown} result
     * @returns {void}
     */
    resolveRequest(id, result) {
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(id);
      pending.resolve(result);
    },

    /**
     * @param {number} id
     * @param {string} message
     * @returns {void}
     */
    rejectRequest(id, message) {
      rejectRequestById(id, message);
    },

    /**
     * @returns {void}
     */
    refreshActivityTimeouts() {
      for (const pending of pendingRequests.values()) {
        pending.refreshTimeout?.();
      }
    },

    /**
     * @param {number} id
     * @param {string} method
     * @param {number} timeoutMs
     * @returns {void}
     */
    timeoutRequest(id, method, timeoutMs) {
      const details = requestFailureDetails();
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(id);
      options.logger.warn("ACP request timed out.", details);
      pending.reject(createRequestTimeoutError(method, timeoutMs, details));
    },

    /**
     * @param {unknown} error
     * @returns {Error}
     */
    failWrite(error) {
      const writeError = createWriteFailure(error);
      failConnection(writeError);
      return writeError;
    },

    /**
     * @returns {Error}
     */
    createUnavailableFailure() {
      return processError ?? createAcpConnectionUnavailableError({
        ...commandContext(),
        pendingRequests: pendingRequestSummaries(pendingRequests),
        ...(maybeCleanStderrTail() ? { stderrTail: maybeCleanStderrTail() } : {}),
      });
    },

    /**
     * @param {unknown} error
     * @returns {Error}
     */
    handleStdinError(error) {
      const pendingRequestList = pendingRequestSummaries(pendingRequests);
      const writeError = createWriteFailure(error);
      failConnection(writeError);
      if (!closeRequested) {
        options.logger.warn("ACP child stdin failed.", {
          ...commandContext(),
          code: getErrorCode(error),
          message: getErrorMessage(error),
          pendingRequests: pendingRequestList,
          ...(maybeCleanStderrTail() ? { stderrTail: maybeCleanStderrTail() } : {}),
        });
      }
      options.kill();
      return writeError;
    },

    /**
     * @param {{ phase: "startup" | "runtime", error: unknown }} input
     * @returns {Error}
     */
    handleProcessError(input) {
      const processFailure = createAcpProcessError({
        phase: input.phase,
        ...commandContext(),
        error: input.error,
      });
      processError = processFailure;
      endConnection();
      const pendingRequestList = pendingRequestSummaries(pendingRequests);
      rejectPendingRequests(processError);
      if (!closeRequested) {
        options.logger.warn(input.phase === "startup" ? "ACP child process failed to start." : "ACP child process error.", {
          ...commandContext(),
          code: getErrorCode(input.error),
          message: getErrorMessage(input.error),
          pendingRequests: pendingRequestList,
        });
      }
      return processFailure;
    },

    /**
     * @param {{ exitCode: number | null, signal: NodeJS.Signals | null }} input
     * @returns {void}
     */
    handleExit(input) {
      if (processError) {
        return;
      }
      endConnection();
      const pendingRequestList = pendingRequestSummaries(pendingRequests);
      const details = {
        command: options.command,
        pid: options.getPid(),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        exitCode: input.exitCode,
        signal: input.signal,
        pendingRequests: pendingRequestList,
        ...(maybeCleanStderrTail() ? { stderrTail: maybeCleanStderrTail() } : {}),
      };
      if (!closeRequested && (pendingRequestList.length > 0 || input.exitCode !== 0 || input.signal)) {
        options.logger.warn("ACP child process closed unexpectedly.", details);
      }
      const message = formatConnectionClosedMessage({
        exitCode: input.exitCode,
        signal: input.signal,
        pendingRequests: pendingRequestList,
      });
      for (const [id] of pendingRequests) {
        rejectRequestById(id, message);
      }
    },

    /**
     * @returns {boolean}
     */
    beginClose() {
      if (closed) {
        return false;
      }
      closed = true;
      closeRequested = true;
      options.endNotifications();
      return true;
    },
  };
}

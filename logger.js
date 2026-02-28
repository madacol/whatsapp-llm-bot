/** @type {Record<string, number>} */
export const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * Resolve the current log level from environment.
 * @returns {number}
 */
function getLevel() {
  if (process.env.LOG_LEVEL) {
    return LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
  }
  return process.env.TESTING ? LOG_LEVELS.error : LOG_LEVELS.info;
}

/**
 * Create a labelled logger that respects LOG_LEVEL and TESTING env vars.
 * @param {string} label
 * @returns {{ debug: (...args: any[]) => void, info: (...args: any[]) => void, warn: (...args: any[]) => void, error: (...args: any[]) => void }}
 */
export function createLogger(label) {
  const prefix = `[${label}]`;

  return {
    debug: (...args) => { if (getLevel() <= LOG_LEVELS.debug) console.debug(prefix, ...args); },
    info:  (...args) => { if (getLevel() <= LOG_LEVELS.info)  console.log(prefix, ...args); },
    warn:  (...args) => { if (getLevel() <= LOG_LEVELS.warn)  console.warn(prefix, ...args); },
    error: (...args) => { if (getLevel() <= LOG_LEVELS.error) console.error(prefix, ...args); },
  };
}

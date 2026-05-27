/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown> | undefined} capabilities
 * @param {string} name
 * @returns {boolean}
 */
export function hasAcpSessionCapability(capabilities, name) {
  const sessionCapabilities = isRecord(capabilities?.sessionCapabilities) ? capabilities.sessionCapabilities : null;
  const rfdSessionCapabilities = isRecord(capabilities?.session) ? capabilities.session : null;
  return isRecord(sessionCapabilities?.[name]) || isRecord(rfdSessionCapabilities?.[name]);
}

/**
 * @param {Record<string, unknown> | undefined} capabilities
 * @param {string} name
 * @returns {boolean}
 */
export function hasMadabotAcpSessionCapability(capabilities, name) {
  const meta = isRecord(capabilities?._meta) ? capabilities._meta : null;
  const madabot = isRecord(meta?.madabot) ? meta.madabot : null;
  const session = isRecord(madabot?.sessionCapabilities) ? madabot.sessionCapabilities : null;
  return session?.[name] === true || isRecord(session?.[name]);
}

/**
 * @param {Record<string, unknown> | undefined} capabilities
 * @returns {boolean}
 */
export function supportsAcpLoadSession(capabilities) {
  return capabilities?.loadSession === true;
}

/**
 * @param {HarnessCapabilities} base
 * @param {Record<string, unknown> | undefined} capabilities
 * @returns {HarnessCapabilities}
 */
export function deriveAcpHarnessCapabilities(base, capabilities) {
  return {
    ...base,
    supportsResume: base.supportsResume && (supportsAcpLoadSession(capabilities) || hasAcpSessionCapability(capabilities, "resume")),
    supportsLiveInput: base.supportsLiveInput && hasAcpSessionCapability(capabilities, "steer"),
    supportsSessionFork: base.supportsSessionFork && hasAcpSessionCapability(capabilities, "fork"),
    supportsRollback: base.supportsRollback && (
      hasAcpSessionCapability(capabilities, "rollback")
      || hasMadabotAcpSessionCapability(capabilities, "rollback")
    ),
  };
}

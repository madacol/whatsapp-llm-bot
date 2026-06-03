/**
 * Structured inspect-output formatters shared across transports.
 */

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseInspectJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function getText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function getUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const url = new URL(value);
    return `\`${url.host}${url.pathname}${url.search}\``;
  } catch {
    return `\`${value.trim()}\``;
  }
}

/**
 * @param {string} key
 * @returns {string}
 */
function formatLabel(key) {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function formatScalar(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * @param {string} text
 * @param {string} prefix
 * @returns {string}
 */
function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function formatSearchResultEntry(entry) {
  const title = getText(entry.title) ?? getText(entry.name) ?? getText(entry.heading);
  const url = getUrl(entry.url) ?? getUrl(entry.link);
  const snippet = getText(entry.snippet)
    ?? getText(entry.description)
    ?? getText(entry.summary)
    ?? getText(entry.text)
    ?? getText(entry.excerpt);

  /** @type {string[]} */
  const lines = [];
  if (title) {
    lines.push(`*${title}*`);
  }
  if (url) {
    lines.push(url);
  }
  if (snippet) {
    lines.push(snippet);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatWebSearchInspectOutput(text) {
  const parsed = parseInspectJson(text);
  const results = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.results)
      ? parsed.results
      : null;
  if (!results) {
    return text;
  }
  const sections = results
    .filter(isRecord)
    .map(formatSearchResultEntry)
    .filter((section) => typeof section === "string" && section.length > 0);
  return sections.length > 0 ? sections.join("\n\n") : formatGenericStructuredInspectOutput(text);
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatOpenLinkInspectOutput(text) {
  const parsed = parseInspectJson(text);
  if (!isRecord(parsed)) {
    return text;
  }
  return formatSearchResultEntry(parsed) ?? formatGenericStructuredInspectOutput(text);
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function formatFindMatchEntry(entry) {
  return getText(entry.text)
    ?? getText(entry.snippet)
    ?? getText(entry.content)
    ?? getText(entry.quote)
    ?? getText(entry.excerpt);
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatFindOnPageInspectOutput(text) {
  const parsed = parseInspectJson(text);
  const matches = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.matches)
      ? parsed.matches
      : null;
  if (!matches) {
    return text;
  }
  const lines = matches
    .map((entry) => isRecord(entry) ? formatFindMatchEntry(entry) : getText(entry))
    .filter((line) => typeof line === "string" && line.length > 0);
  return lines.length > 0 ? lines.join("\n\n") : formatGenericStructuredInspectOutput(text);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatStructuredValue(value) {
  if (Array.isArray(value)) {
    const sections = value
      .map((entry) => formatStructuredValue(entry))
      .filter((section) => section.length > 0);
    return sections.join("\n\n");
  }
  if (isRecord(value)) {
    /** @type {string[]} */
    const lines = [];
    for (const [key, entryValue] of Object.entries(value)) {
      const scalar = formatScalar(entryValue);
      if (scalar != null) {
        lines.push(`${formatLabel(key)}: ${scalar}`);
        continue;
      }
      if (Array.isArray(entryValue) || isRecord(entryValue)) {
        const nested = formatStructuredValue(entryValue);
        if (nested) {
          lines.push(`${formatLabel(key)}:\n${indent(nested, "  ")}`);
        }
      }
    }
    return lines.join("\n");
  }
  const scalar = formatScalar(value);
  return scalar ?? "";
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatGenericStructuredInspectOutput(text) {
  const parsed = parseInspectJson(text);
  if (parsed == null) {
    return text;
  }
  const formatted = formatStructuredValue(parsed);
  return formatted || text;
}

/**
 * @param {string} text
 * @param {ToolInspectMode} inspectMode
 * @returns {string}
 */
export function formatStructuredInspectOutput(text, inspectMode) {
  switch (inspectMode) {
    case "web_search":
      return formatWebSearchInspectOutput(text);
    case "open_link":
      return formatOpenLinkInspectOutput(text);
    case "find_on_page":
      return formatFindOnPageInspectOutput(text);
    case "plain":
    default:
      return formatGenericStructuredInspectOutput(text);
  }
}

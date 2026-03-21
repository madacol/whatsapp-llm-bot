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
 * @returns {number | null}
 */
function getNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
 * @param {number} value
 * @returns {string}
 */
function formatSignedNumber(value) {
  return `${value > 0 ? "+" : ""}${value}`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatSignedPercent(value) {
  return `${value > 0 ? "+" : ""}${value}%`;
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
 * @returns {unknown[] | null}
 */
function asResultArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  const candidates = ["results", "data", "items", "quotes", "forecasts", "games", "schedule", "standings"];
  for (const key of candidates) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function formatFinanceEntry(entry) {
  const ticker = getText(entry.ticker) ?? getText(entry.symbol) ?? getText(entry.name);
  const price = getNumber(entry.price) ?? getNumber(entry.last) ?? getNumber(entry.last_price) ?? getNumber(entry.close);
  const currency = getText(entry.currency);
  const change = getNumber(entry.change) ?? getNumber(entry.delta) ?? getNumber(entry.change_amount);
  const changePercent = getNumber(entry.change_percent) ?? getNumber(entry.percent_change) ?? getNumber(entry.change_pct);
  const market = getText(entry.market) ?? getText(entry.exchange);

  /** @type {string[]} */
  const lines = [];
  if (ticker) {
    lines.push(`*${ticker}*`);
  }
  if (price != null) {
    lines.push(`Price: ${price}${currency ? ` ${currency}` : ""}`);
  }
  if (change != null || changePercent != null) {
    const parts = [];
    if (change != null) {
      parts.push(formatSignedNumber(change));
    }
    if (changePercent != null) {
      parts.push(`(${formatSignedPercent(changePercent)})`);
    }
    lines.push(`Change: ${parts.join(" ")}`);
  }
  if (market) {
    lines.push(`Market: ${market}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatFinanceInspectOutput(text) {
  const parsed = parseInspectJson(text);
  const entries = asResultArray(parsed);
  if (!entries) {
    return formatGenericStructuredInspectOutput(text);
  }
  const sections = entries
    .filter(isRecord)
    .map(formatFinanceEntry)
    .filter((section) => typeof section === "string" && section.length > 0);
  return sections.length > 0 ? sections.join("\n\n") : formatGenericStructuredInspectOutput(text);
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function formatWeatherEntry(entry) {
  const location = getText(entry.location) ?? getText(entry.name) ?? getText(entry.city);
  const condition = getText(entry.condition) ?? getText(entry.summary) ?? getText(entry.description) ?? getText(entry.weather);
  const temperature = getNumber(entry.temperature) ?? getNumber(entry.temp) ?? getNumber(entry.current_temperature);
  const high = getNumber(entry.high) ?? getNumber(entry.temp_max);
  const low = getNumber(entry.low) ?? getNumber(entry.temp_min);
  const unit = getText(entry.temperature_unit) ?? getText(entry.unit) ?? getText(entry.temp_unit);

  /** @type {string[]} */
  const lines = [];
  if (location) {
    lines.push(`*${location}*`);
  }
  if (condition) {
    lines.push(`Condition: ${condition}`);
  }
  if (temperature != null) {
    lines.push(`Temperature: ${temperature}${unit ? ` ${unit}` : ""}`);
  }
  if (high != null || low != null) {
    const range = [low, high]
      .filter((value) => value != null)
      .join("-");
    lines.push(`Range: ${range}${unit ? ` ${unit}` : ""}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatWeatherInspectOutput(text) {
  const parsed = parseInspectJson(text);
  const entries = asResultArray(parsed);
  if (!entries) {
    return formatGenericStructuredInspectOutput(text);
  }
  const sections = entries
    .filter(isRecord)
    .map(formatWeatherEntry)
    .filter((section) => typeof section === "string" && section.length > 0);
  return sections.length > 0 ? sections.join("\n\n") : formatGenericStructuredInspectOutput(text);
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function formatTimeEntry(entry) {
  const offset = getText(entry.utc_offset) ?? getText(entry.offset) ?? getText(entry.timezone);
  const localTime = getText(entry.local_time) ?? getText(entry.time) ?? getText(entry.datetime);
  const zone = getText(entry.timezone_name) ?? getText(entry.zone);

  /** @type {string[]} */
  const lines = [];
  if (offset) {
    lines.push(`*${offset.startsWith("UTC") ? offset : `UTC${offset}`}*`);
  }
  if (localTime) {
    lines.push(`Local Time: ${localTime}`);
  }
  if (zone) {
    lines.push(`Zone: ${zone}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatTimeInspectOutput(text) {
  const parsed = parseInspectJson(text);
  const entries = asResultArray(parsed) ?? (isRecord(parsed) ? [parsed] : null);
  if (!entries) {
    return formatGenericStructuredInspectOutput(text);
  }
  const sections = entries
    .filter(isRecord)
    .map(formatTimeEntry)
    .filter((section) => typeof section === "string" && section.length > 0);
  return sections.length > 0 ? sections.join("\n\n") : formatGenericStructuredInspectOutput(text);
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function formatSportsScheduleEntry(entry) {
  const away = getText(entry.away_team) ?? getText(entry.away) ?? getText(entry.visitor);
  const home = getText(entry.home_team) ?? getText(entry.home);
  const matchup = away && home
    ? `${away} at ${home}`
    : getText(entry.matchup) ?? getText(entry.title) ?? getText(entry.game);
  const start = getText(entry.start_time) ?? getText(entry.date) ?? getText(entry.time);
  const status = getText(entry.status);
  const score = getText(entry.score);

  /** @type {string[]} */
  const parts = [];
  if (matchup) {
    parts.push(matchup);
  }
  if (start) {
    parts.push(start);
  }
  if (status) {
    parts.push(status);
  }
  if (score) {
    parts.push(score);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string | null}
 */
function formatSportsStandingsEntry(entry) {
  const rank = getNumber(entry.rank) ?? getNumber(entry.position);
  const team = getText(entry.team) ?? getText(entry.name);
  const record = getText(entry.record)
    ?? (
      getNumber(entry.wins) != null && getNumber(entry.losses) != null
        ? `${getNumber(entry.wins)}-${getNumber(entry.losses)}`
        : null
    );
  if (!team && rank == null && !record) {
    return null;
  }
  const prefix = rank != null ? `${rank}. ` : "";
  return `${prefix}${team ?? "Team"}${record ? ` (${record})` : ""}`;
}

/**
 * @param {string} text
 * @param {"schedule" | "standings"} mode
 * @returns {string}
 */
function formatSportsInspectOutput(text, mode) {
  const parsed = parseInspectJson(text);
  const entries = asResultArray(parsed);
  if (!entries) {
    return formatGenericStructuredInspectOutput(text);
  }
  const sections = entries
    .filter(isRecord)
    .map((entry) => mode === "schedule" ? formatSportsScheduleEntry(entry) : formatSportsStandingsEntry(entry))
    .filter((section) => typeof section === "string" && section.length > 0);
  return sections.length > 0 ? sections.join("\n") : formatGenericStructuredInspectOutput(text);
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
 * @param {import("./tool-presentation-model.js").ToolInspectMode} inspectMode
 * @returns {string}
 */
export function formatStructuredInspectOutput(text, inspectMode) {
  switch (inspectMode) {
    case "web_search":
    case "image_search":
      return formatWebSearchInspectOutput(text);
    case "open_link":
      return formatOpenLinkInspectOutput(text);
    case "find_on_page":
      return formatFindOnPageInspectOutput(text);
    case "finance":
      return formatFinanceInspectOutput(text);
    case "weather":
      return formatWeatherInspectOutput(text);
    case "time":
      return formatTimeInspectOutput(text);
    case "sports_schedule":
      return formatSportsInspectOutput(text, "schedule");
    case "sports_standings":
      return formatSportsInspectOutput(text, "standings");
    case "plain":
    default:
      return formatGenericStructuredInspectOutput(text);
  }
}

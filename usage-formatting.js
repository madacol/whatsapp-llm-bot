/**
 * @param {number} numerator
 * @param {number} denominator
 * @returns {string | null}
 */
function formatPercent(numerator, denominator) {
  if (denominator <= 0) {
    return null;
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/**
 * @param {UsageEvent} event
 * @returns {string}
 */
export function formatUsageEventText(event) {
  const { tokens } = event;
  const uncached = Math.max(0, tokens.prompt - tokens.cached);
  const parts = [
    `prompt=${tokens.prompt}`,
    `cached=${tokens.cached}`,
    `uncached=${uncached}`,
    `completion=${tokens.completion}`,
  ];

  if (typeof tokens.reasoning === "number") {
    parts.push(`reasoning=${tokens.reasoning}`);
  }
  if (typeof tokens.total === "number") {
    parts.push(`total=${tokens.total}`);
  }

  const cachePercent = formatPercent(tokens.cached, tokens.prompt);
  if (cachePercent) {
    parts.push(`cache=${cachePercent}`);
  }

  if (typeof tokens.total === "number" && typeof tokens.contextWindow === "number") {
    const contextPercent = formatPercent(tokens.total, tokens.contextWindow);
    if (contextPercent) {
      parts.push(`ctx=${contextPercent}`);
    }
    parts.push(`remaining=${Math.max(0, tokens.contextWindow - tokens.total)}`);
  }

  return `Cost: ${event.cost} | ${parts.join(" ")}`;
}

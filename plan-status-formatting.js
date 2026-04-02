/**
 * Shared helpers for plan status normalization and display formatting.
 */

/**
 * @typedef {"completed" | "in_progress" | "pending" | "unknown"} PlanEntryStatus
 */

/**
 * @typedef {"x" | "~" | " " | "-"} PlanStatusMarker
 */

/**
 * @param {unknown} status
 * @returns {PlanEntryStatus}
 */
export function normalizePlanEntryStatus(status) {
  if (status === "completed") {
    return "completed";
  }
  if (status === "in_progress" || status === "inProgress") {
    return "in_progress";
  }
  if (status === "pending") {
    return "pending";
  }
  return "unknown";
}

/**
 * @param {PlanEntryStatus} status
 * @returns {PlanStatusMarker}
 */
export function getPlanStatusMarker(status) {
  switch (status) {
    case "completed":
      return "x";
    case "in_progress":
      return "~";
    case "pending":
      return " ";
    default:
      return "-";
  }
}

/**
 * @param {PlanEntryStatus} status
 * @returns {string}
 */
export function formatPlanStatusToken(status) {
  return `[${getPlanStatusMarker(status)}]`;
}

/**
 * @param {string} marker
 * @returns {PlanStatusMarker}
 */
export function normalizePlanStatusMarker(marker) {
  if (marker === "x" || marker === "X") {
    return "x";
  }
  if (marker === "~") {
    return "~";
  }
  if (marker === " ") {
    return " ";
  }
  return "-";
}

/**
 * @param {PlanStatusMarker} marker
 * @returns {string}
 */
export function formatPlanStatusSymbol(marker) {
  switch (marker) {
    case "x":
      return "✅";
    case "~":
      return "⏳";
    case " ":
      return "☐";
    default:
      return "•";
  }
}

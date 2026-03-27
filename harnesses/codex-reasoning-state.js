/**
 * Stateful accumulator for semantic reasoning snapshots. This lets the
 * dispatcher merge transport snapshots, deltas, and raw metadata into one
 * stable hook payload.
 */

/**
 * @typedef {{
 *   itemId?: string,
 *   status: "started" | "updated" | "completed",
 *   summarySnapshot?: string[],
 *   contentSnapshot?: string[],
 *   summaryDelta?: { index: number, text: string },
 *   contentDelta?: { index: number, text: string },
 *   hasEncryptedContent?: boolean,
 * }} CodexReasoningUpdate
 */

/**
 * @typedef {{
 *   itemId?: string,
 *   status: "started" | "updated" | "completed",
 *   summaryParts: string[],
 *   contentParts: string[],
 *   text?: string,
 *   hasEncryptedContent?: boolean,
 * }} CodexReasoningSnapshot
 */

/**
 * @typedef {{
 *   summaryParts: string[],
 *   contentParts: string[],
 *   hasEncryptedContent: boolean,
 * }} ReasoningEntry
 */

/**
 * @returns {{
 *   apply: (update: CodexReasoningUpdate) => CodexReasoningSnapshot,
 * }}
 */
export function createCodexReasoningState() {
  /** @type {Map<string, ReasoningEntry>} */
  const entries = new Map();
  /** @type {string | null} */
  let latestItemId = null;

  /**
   * @param {CodexReasoningUpdate} update
   * @returns {ReasoningEntry}
   */
  function resolveEntry(update) {
    const itemId = typeof update.itemId === "string" && update.itemId.length > 0
      ? update.itemId
      : latestItemId;
    const key = itemId ?? "__anonymous__";
    if (itemId) {
      latestItemId = itemId;
    }
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        summaryParts: [],
        contentParts: [],
        hasEncryptedContent: false,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  /**
   * @param {string[]} parts
   * @param {{ index: number, text: string }} delta
   * @returns {void}
   */
  function applyDelta(parts, delta) {
    while (parts.length <= delta.index) {
      parts.push("");
    }
    parts[delta.index] = `${parts[delta.index]}${delta.text}`;
  }

  return {
    apply(update) {
      const entry = resolveEntry(update);

      if (Array.isArray(update.summarySnapshot)) {
        entry.summaryParts = [...update.summarySnapshot];
      }
      if (Array.isArray(update.contentSnapshot)) {
        entry.contentParts = [...update.contentSnapshot];
      }
      if (update.summaryDelta) {
        applyDelta(entry.summaryParts, update.summaryDelta);
      }
      if (update.contentDelta) {
        applyDelta(entry.contentParts, update.contentDelta);
      }
      if (update.hasEncryptedContent) {
        entry.hasEncryptedContent = true;
      }

      const contentText = entry.contentParts.filter((part) => part.length > 0).join("\n").trim();
      const summaryText = entry.summaryParts.filter((part) => part.length > 0).join("\n").trim();

      return {
        ...(typeof update.itemId === "string" && update.itemId.length > 0 ? { itemId: update.itemId } : latestItemId ? { itemId: latestItemId } : {}),
        status: update.status,
        summaryParts: [...entry.summaryParts],
        contentParts: [...entry.contentParts],
        ...(contentText ? { text: contentText } : summaryText ? { text: summaryText } : {}),
        ...(entry.hasEncryptedContent ? { hasEncryptedContent: true } : {}),
      };
    },
  };
}

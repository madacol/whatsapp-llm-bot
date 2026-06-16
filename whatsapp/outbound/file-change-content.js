import { buildContextualUnifiedDiff } from "../../code-image-renderer.js";
import { langFromPath } from "../tool-presenter.js";
import { shortenPath } from "../tool-presentation-model.js";

const SNAPSHOT_DIFF_LINES_PER_BATCH = 1000;

/**
 * @param {string | undefined} summary
 * @param {string} rawPath
 * @param {string} displayPath
 * @param {"add" | "delete" | "update" | undefined} kind
 * @returns {string | undefined}
 */
function cleanFileChangeSummary(summary, rawPath, displayPath, kind) {
  if (!summary) {
    return undefined;
  }

  const shortenedSummary = summary.split(rawPath).join(displayPath);
  const genericSummaries = new Set([
    "ACP file change",
    "ACP file delete",
    "ACP file write",
    "Editing files",
  ]);
  if (genericSummaries.has(shortenedSummary)) {
    return undefined;
  }
  const redundantForms = new Set([
    rawPath,
    displayPath,
    ...(kind ? [`${rawPath} (${kind})`, `${displayPath} (${kind})`] : []),
  ]);

  return redundantForms.has(shortenedSummary) ? undefined : shortenedSummary;
}

/**
 * @param {FileChangeEvent} event
 * @param {"add" | "delete" | "update" | undefined} displayKind
 * @returns {string}
 */
function getFileChangeTitle(event, displayKind) {
  if (event.stage === "proposed") {
    return "*Proposed File Change*";
  }
  if (event.stage === "denied") {
    return "*Denied File Change*";
  }
  if (event.stage === "failed") {
    return "*Failed File Change*";
  }
  if (event.source === "snapshot") {
    return "Snapshot";
  }
  if (displayKind === "add") {
    return "Add";
  }
  if (displayKind === "delete") {
    return "Delete";
  }
  return "Update";
}

/**
 * @param {string} title
 * @param {string} displayPath
 * @returns {string}
 */
function formatFileChangeCaptionLine(title, displayPath) {
  const displayTitle = title.startsWith("*") ? title : `*${title}*`;
  return `${displayTitle}  \`${displayPath}\``;
}

/**
 * @param {FileChangeEvent} event
 * @returns {"add" | "delete" | "update" | undefined}
 */
function inferDisplayedFileChangeKind(event) {
  const diffKind = inferFileChangeKindFromDiff(event.diff);
  if (diffKind === "add" || diffKind === "delete") {
    return diffKind;
  }

  if (event.changeKind === "add" && typeof event.newText === "string") {
    if (typeof event.oldText === "string" && event.oldText.length > 0) {
      return "update";
    }
    return "add";
  }

  if (typeof event.oldText === "string" && typeof event.newText === "string") {
    if (event.oldText !== event.newText) {
      if (event.oldText.length === 0 && event.newText.length > 0 && event.changeKind === "add") {
        return "add";
      }
      return "update";
    }
  } else if (typeof event.oldText === "string") {
    return "delete";
  } else if (typeof event.newText === "string") {
    return "add";
  }

  return diffKind ?? event.changeKind;
}

/**
 * Render displayed additions as source code instead of a diff.
 * @param {FileChangeEvent} event
 * @param {"add" | "delete" | "update" | undefined} displayKind
 * @returns {boolean}
 */
function shouldRenderFileChangeAsCode(event, displayKind) {
  if (displayKind !== "add" || typeof event.newText !== "string") {
    return false;
  }
  return true;
}

/**
 * @param {string | undefined} diffText
 * @returns {"add" | "delete" | "update" | undefined}
 */
function inferFileChangeKindFromDiff(diffText) {
  if (!diffText) {
    return undefined;
  }

  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- ")) {
      if (line.includes("/dev/null")) {
        return "add";
      }
      continue;
    }
    if (line.startsWith("+++ ") && line.includes("/dev/null")) {
      return "delete";
    }
  }

  return undefined;
}

/**
 * Keep hunk headers visible, but drop file header lines from rendered diffs.
 * @param {string | undefined} diffText
 * @returns {string | undefined}
 */
function stripUnifiedDiffFileHeaders(diffText) {
  if (!diffText) {
    return undefined;
  }

  const lines = diffText.split("\n");
  const filtered = lines.filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
  return filtered.join("\n");
}

/**
 * @param {FileChangeEvent} event
 * @returns {string | undefined}
 */
export function buildSnapshotFileChangeDiffText(event) {
  if (event.diff) {
    return stripUnifiedDiffFileHeaders(event.diff);
  }
  if (typeof event.oldText === "string" || typeof event.newText === "string") {
    return buildContextualUnifiedDiff(event.oldText ?? "", event.newText ?? "");
  }
  return undefined;
}

/**
 * @param {string} diffText
 * @returns {string[]}
 */
export function splitSnapshotDiffText(diffText) {
  const lines = diffText.split("\n");
  if (lines.length <= SNAPSHOT_DIFF_LINES_PER_BATCH) {
    return [diffText];
  }

  /** @type {string[]} */
  const batches = [];
  for (let index = 0; index < lines.length; index += SNAPSHOT_DIFF_LINES_PER_BATCH) {
    batches.push(lines.slice(index, index + SNAPSHOT_DIFF_LINES_PER_BATCH).join("\n"));
  }
  return batches;
}

/**
 * @param {string} diffText
 * @returns {number}
 */
export function countDiffLines(diffText) {
  return diffText === "" ? 0 : diffText.split("\n").length;
}

/**
 * @param {FileChangeEvent} event
 * @returns {SendContent}
 */
export function renderFileChangeContent(event) {
  const displayPath = shortenPath(event.path, event.cwd ?? null);
  const displayKind = inferDisplayedFileChangeKind(event);
  const cleanedSummary = cleanFileChangeSummary(event.summary, event.path, displayPath, displayKind);
  const title = getFileChangeTitle(event, displayKind);
  const captionLines = [formatFileChangeCaptionLine(title, displayPath)];
  if (cleanedSummary) {
    captionLines.push(cleanedSummary);
  }

  if (shouldRenderFileChangeAsCode(event, displayKind)) {
    const newText = event.newText;
    if (typeof newText !== "string") {
      return `Changed file: \`${displayPath}\``;
    }
    return [{
      type: "code",
      code: newText,
      language: langFromPath(event.path) || "text",
      caption: captionLines.join("\n"),
    }];
  }

  if (event.diff) {
    return [{
      type: "diff",
      oldStr: event.oldText ?? "",
      newStr: event.newText ?? "",
      diffText: stripUnifiedDiffFileHeaders(event.diff),
      language: langFromPath(event.path) || "text",
      caption: captionLines.join("\n"),
    }];
  }

  if (typeof event.oldText === "string" || typeof event.newText === "string") {
    return [{
      type: "diff",
      oldStr: "",
      newStr: "",
      diffText: buildContextualUnifiedDiff(event.oldText ?? "", event.newText ?? ""),
      language: langFromPath(event.path) || "text",
      caption: captionLines.join("\n"),
    }];
  }

  return captionLines.join("\n");
}

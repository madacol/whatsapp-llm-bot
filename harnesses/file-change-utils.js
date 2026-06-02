import { createTwoFilesPatch } from "diff";

/**
 * @param {unknown} value
 * @returns {value is "add" | "delete" | "update"}
 */
export function isFileChangeKind(value) {
  return value === "add" || value === "delete" || value === "update";
}

/**
 * @param {string | undefined} diffText
 * @returns {"add" | "delete" | "update" | undefined}
 */
export function inferFileChangeKindFromUnifiedDiff(diffText) {
  if (!diffText) {
    return undefined;
  }

  let sawHunk = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("@@")) {
      sawHunk = true;
      continue;
    }
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

  return sawHunk ? "update" : undefined;
}

/**
 * @param {string} filePath
 * @param {string | undefined} oldText
 * @param {string | undefined} newText
 * @returns {string | undefined}
 */
export function buildUnifiedFileDiff(filePath, oldText, newText) {
  if (oldText === newText) {
    return undefined;
  }
  if (oldText === undefined && newText === undefined) {
    return undefined;
  }

  const oldLabel = oldText === undefined ? "/dev/null" : `a/${filePath}`;
  const newLabel = newText === undefined ? "/dev/null" : `b/${filePath}`;
  const patch = createTwoFilesPatch(oldLabel, newLabel, oldText ?? "", newText ?? "", "", "", {
    context: 3,
  });
  const lines = patch
    .split("\n")
    .filter((line) => !line.startsWith("Index: ") && !line.startsWith("==="));
  const diff = lines.join("\n").trimEnd();
  return diff.length > 0 ? diff : undefined;
}

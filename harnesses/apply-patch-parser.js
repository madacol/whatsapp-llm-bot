/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} rawInput
 * @returns {string | null}
 */
export function extractApplyPatchText(rawInput) {
  if (typeof rawInput === "string") {
    return rawInput.includes("*** Begin Patch") ? rawInput : null;
  }
  if (!isRecord(rawInput)) {
    return null;
  }
  for (const key of ["patch", "input", "content", "text", "cmd", "command"]) {
    const value = rawInput[key];
    if (typeof value === "string" && value.includes("*** Begin Patch")) {
      return value;
    }
  }
  return null;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * @param {unknown} rawInput
 * @returns {string[]}
 */
export function extractApplyPatchTargetPaths(rawInput) {
  const patchText = extractApplyPatchText(rawInput);
  if (!patchText) {
    return [];
  }
  /** @type {string[]} */
  const paths = [];
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("*** Update File: ")) {
      paths.push(line.slice("*** Update File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      paths.push(line.slice("*** Add File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      paths.push(line.slice("*** Delete File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      paths.push(line.slice("*** Move to: ".length).trim());
    }
  }
  return unique(paths);
}

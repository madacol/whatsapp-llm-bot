import path from "node:path";

/**
 * App-server protocol shaping for Codex runs.
 *
 * This module owns the wire-level translation between internal harness config
 * and the JSON-RPC payloads expected by `codex app-server`.
 */

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {Record<string, unknown> | undefined}
 */
export function buildCodexAppServerSandboxPolicy(runConfig) {
  const mode = runConfig?.sandboxMode ?? null;
  const workdir = typeof runConfig?.workdir === "string" ? runConfig.workdir : null;
  switch (mode) {
    case "read-only":
      return { type: "readOnly" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
      return workdir
        ? {
          type: "workspaceWrite",
          writableRoots: [workdir, ...(runConfig?.additionalDirectories ?? [])],
          networkAccess: true,
        }
        : { type: "workspaceWrite", networkAccess: true };
    default:
      return undefined;
  }
}

/**
 * @param {HarnessRunConfig["approvalPolicy"] | undefined} approvalPolicy
 * @returns {string | undefined}
 */
export function mapCodexAppServerApprovalPolicy(approvalPolicy) {
  switch (approvalPolicy) {
    case "never":
      return "never";
    case "on-request":
      return "on-request";
    case "untrusted":
      return "unlessTrusted";
    default:
      return undefined;
  }
}

/**
 * Build the structured approval response expected by the app server.
 * @param {boolean} allowed
 * @returns {{ decision: "accept" | "cancel" }}
 */
function buildApprovalDecision(allowed) {
  return { decision: allowed ? "accept" : "cancel" };
}

/**
 * @param {Record<string, unknown>} params
 * @returns {string | null}
 */
function extractFileChangeItemId(params) {
  if (typeof params.itemId === "string") {
    return params.itemId;
  }
  const nestedItem = params.item && typeof params.item === "object"
    ? /** @type {Record<string, unknown>} */ (params.item)
    : null;
  if (typeof nestedItem?.id === "string") {
    return nestedItem.id;
  }
  return null;
}

/**
 * @param {string} filePath
 * @param {string | null} workdir
 * @returns {boolean}
 */
function isOutsideWorkdir(filePath, workdir) {
  if (!workdir || !path.isAbsolute(filePath)) {
    return false;
  }
  const resolvedWorkdir = path.resolve(workdir);
  const resolvedPath = path.resolve(filePath);
  return resolvedPath !== resolvedWorkdir
    && !resolvedPath.startsWith(`${resolvedWorkdir}${path.sep}`);
}

/**
 * @param {string} filePath
 * @param {string | null} workdir
 * @returns {string}
 */
function toPolicyPath(filePath, workdir) {
  if (!workdir) {
    return filePath;
  }
  const resolvedWorkdir = path.resolve(workdir);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath === resolvedWorkdir) {
    return ".";
  }
  if (resolvedPath.startsWith(`${resolvedWorkdir}${path.sep}`)) {
    return path.relative(resolvedWorkdir, resolvedPath);
  }
  return filePath;
}

/**
 * @param {{
 *   path: string,
 *   kind?: "add" | "delete" | "update",
 * }[]} changes
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {boolean}
 */
function shouldPromptForFileChanges(changes, runConfig) {
  const workdir = typeof runConfig?.workdir === "string" ? runConfig.workdir : null;
  const sensitiveNames = new Set([
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "tsconfig.json",
    "jsconfig.json",
    ".env",
    ".env.local",
  ]);

  return changes.some((change) => {
    if (change.kind === "delete") {
      return true;
    }
    if (isOutsideWorkdir(change.path, workdir)) {
      return true;
    }
    const policyPath = toPolicyPath(change.path, workdir);
    if (sensitiveNames.has(path.basename(policyPath))) {
      return true;
    }
    return policyPath.startsWith("harnesses/")
      || policyPath.startsWith("conversation/")
      || policyPath.startsWith("whatsapp/outbound/");
  });
}

/**
 * @param {Record<string, unknown>} message
 * @param {Pick<Required<AgentIOHooks>, "onAskUser"> & Pick<AgentIOHooks, "onFileChange">} hooks
 * @param {{
 *   fileChangeTracker?: {
 *     get: (itemId: string) => {
 *       itemId: string,
 *       changes: Array<{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" }>,
 *       decision: "accept" | "cancel" | null,
 *     } | null,
 *     markDecision: (itemId: string, decision: "accept" | "cancel") => void,
 *   },
 *   runConfig?: HarnessRunConfig,
 * }} [options]
 * @returns {Promise<unknown>}
 */
export async function handleCodexAppServerRequest(message, hooks, options = {}) {
  const method = typeof message.method === "string" ? message.method : null;
  const params = message.params && typeof message.params === "object"
    ? /** @type {Record<string, unknown>} */ (message.params)
    : {};
  const emitFileChange = hooks.onFileChange ?? (async () => {});
  if (!method) {
    return {};
  }

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "this command";
    const choice = await hooks.onAskUser(`Allow *command execution*?`, ["✅ Allow", "❌ Deny"], undefined, [command]);
    return buildApprovalDecision(choice === "✅ Allow");
  }

  if (method === "item/fileChange/requestApproval") {
    const itemId = extractFileChangeItemId(params);
    const trackedChange = itemId ? options.fileChangeTracker?.get(itemId) ?? null : null;
    if (trackedChange && trackedChange.changes.length > 0) {
      const shouldPrompt = shouldPromptForFileChanges(trackedChange.changes, options.runConfig);
      if (!shouldPrompt) {
        options.fileChangeTracker?.markDecision(trackedChange.itemId, "accept");
        return buildApprovalDecision(true);
      }
      for (const change of trackedChange.changes) {
        if (!shouldEmitProposedFileChange(change)) {
          continue;
        }
        await emitFileChange({
          ...change,
          itemId: trackedChange.itemId,
          stage: "proposed",
        });
      }
      const details = trackedChange.changes.map((change) => change.path);
      const choice = await hooks.onAskUser("Allow *file changes*?", ["✅ Allow", "❌ Deny"], undefined, details);
      const allowed = choice === "✅ Allow";
      options.fileChangeTracker?.markDecision(trackedChange.itemId, allowed ? "accept" : "cancel");
      if (!allowed) {
        for (const change of trackedChange.changes) {
          await emitFileChange({
            ...change,
            itemId: trackedChange.itemId,
            stage: "denied",
          });
        }
      }
      return buildApprovalDecision(allowed);
    }

    const choice = await hooks.onAskUser("Allow *file changes*?", ["✅ Allow", "❌ Deny"]);
    return buildApprovalDecision(choice === "✅ Allow");
  }

  if (method === "tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    /** @type {Record<string, string>} */
    const answers = {};
    for (const question of questions) {
      if (!question || typeof question !== "object") {
        continue;
      }
      const record = /** @type {Record<string, unknown>} */ (question);
      const prompt = typeof record.question === "string" ? record.question : "Choose an option:";
      const options = Array.isArray(record.options)
        ? record.options
          .map((option) => option && typeof option === "object" && typeof /** @type {Record<string, unknown>} */ (option).label === "string"
            ? /** @type {Record<string, unknown>} */ (option).label
            : null)
          .filter((label) => typeof label === "string")
        : [];
      const answer = await hooks.onAskUser(prompt, options.length > 0 ? options : ["OK"]);
      answers[prompt] = answer || options[0] || "OK";
    }
    return { answers };
  }

  return {};
}

/**
 * Only show a proposed file-change message when the proposal already carries
 * renderable diff content. Summary-only proposals add noise without helping
 * the approval decision.
 * @param {{ diff?: string }} change
 * @returns {boolean}
 */
function shouldEmitProposedFileChange(change) {
  return typeof change.diff === "string" && change.diff.length > 0;
}

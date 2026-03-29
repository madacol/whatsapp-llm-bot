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
 * @param {Record<string, unknown>} message
 * @param {Pick<Required<AgentIOHooks>, "onAskUser">} hooks
 * @returns {Promise<unknown>}
 */
export async function handleCodexAppServerRequest(message, hooks) {
  const method = typeof message.method === "string" ? message.method : null;
  const params = message.params && typeof message.params === "object"
    ? /** @type {Record<string, unknown>} */ (message.params)
    : {};
  if (!method) {
    return {};
  }

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "this command";
    const choice = await hooks.onAskUser(`Allow *command execution*?`, ["✅ Allow", "❌ Deny"], undefined, [command]);
    return buildApprovalDecision(choice === "✅ Allow");
  }

  if (method === "item/fileChange/requestApproval") {
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

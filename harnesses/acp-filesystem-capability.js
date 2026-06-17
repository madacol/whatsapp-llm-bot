import fs from "node:fs/promises";
import path from "node:path";
import { buildUnifiedFileDiff } from "./file-change-utils.js";
import { getSandboxEscapeRequest } from "./sandbox-approval.js";
import { requestSandboxEscapeApproval } from "./sandbox-approval-coordinator.js";
import { requestProtectedPathApproval } from "./protected-paths.js";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function paramsRecord(value) {
  return isRecord(value) ? value : {};
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {string | null | undefined} fallbackCwd
 * @returns {string}
 */
function resolveRequestCwd(runConfig, fallbackCwd) {
  if (typeof fallbackCwd === "string" && fallbackCwd.trim()) {
    return path.resolve(fallbackCwd);
  }
  if (typeof runConfig?.workdir === "string" && runConfig.workdir.trim()) {
    return path.resolve(runConfig.workdir);
  }
  return process.cwd();
}

/**
 * @param {{
 *   toolName: string,
 *   input: Record<string, unknown>,
 *   runConfig?: HarnessRunConfig,
 *   cwd: string,
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 * }} input
 * @returns {Promise<void>}
 */
async function assertSandboxAccess(input) {
  const request = getSandboxEscapeRequest(input.toolName, input.input, {
    workdir: input.runConfig?.workdir ?? input.cwd,
    sandboxMode: input.runConfig?.sandboxMode ?? "workspace-write",
    additionalWritableRoots: input.runConfig?.additionalDirectories ?? null,
  });
  if (!request) {
    return;
  }
  const allowed = await requestSandboxEscapeApproval(request, input.hooks.onAskUser);
  if (!allowed) {
    throw new Error(`User denied sandbox escape for ${input.toolName}.`);
  }
}

/**
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   runConfig?: HarnessRunConfig,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => Promise<void>,
 *   approvedProtectedPaths?: Set<string>,
 * }} options
 */
export function createAcpFilesystemCapability(options) {
  return {
    readTextFile,
    writeTextFile,
  };

  /**
   * @param {Record<string, unknown>} message
   * @returns {Promise<{ content: string }>}
   */
  async function readTextFile(message) {
    const params = paramsRecord(message.params);
    if (typeof params.path !== "string" || !path.isAbsolute(params.path)) {
      throw new Error("ACP fs/read_text_file requires an absolute path.");
    }
    const cwd = resolveRequestCwd(options.runConfig, null);
    await assertSandboxAccess({
      toolName: "read_file",
      input: { path: params.path },
      runConfig: options.runConfig,
      cwd,
      hooks: options.hooks,
    });
    const content = await fs.readFile(params.path, "utf8");
    const line = typeof params.line === "number" && Number.isFinite(params.line) ? Math.max(1, Math.floor(params.line)) : null;
    const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(0, Math.floor(params.limit)) : null;
    if (!line && !limit) {
      return { content };
    }
    const lines = content.split(/\r?\n/);
    const start = line ? line - 1 : 0;
    const selected = limit ? lines.slice(start, start + limit) : lines.slice(start);
    return { content: selected.join("\n") };
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {Promise<Record<string, never>>}
   */
  async function writeTextFile(message) {
    const params = paramsRecord(message.params);
    if (typeof params.path !== "string" || !path.isAbsolute(params.path)) {
      throw new Error("ACP fs/write_text_file requires an absolute path.");
    }
    if (typeof params.content !== "string") {
      throw new Error("ACP fs/write_text_file requires string content.");
    }
    const cwd = resolveRequestCwd(options.runConfig, null);
    await assertSandboxAccess({
      toolName: "write_file",
      input: { path: params.path },
      runConfig: options.runConfig,
      cwd,
      hooks: options.hooks,
    });
    const protectedApproval = await requestProtectedPathApproval({
      runConfig: options.runConfig,
      filePath: params.path,
      action: "ACP file write",
      hooks: options.hooks,
    });
    if (!protectedApproval.allowed) {
      throw new Error(`User denied protected path change for ${protectedApproval.match.relativePath}.`);
    }
    if (protectedApproval.match.protected) {
      options.approvedProtectedPaths?.add(protectedApproval.match.resolvedPath);
    }
    if (options.runConfig?.sandboxMode === "read-only") {
      const choice = await options.hooks.onAskUser("Allow *file write*?", ["✅ Allow", "❌ Deny"], undefined, [params.path]);
      if (choice === "❌ Deny" || !choice) {
        throw new Error("User denied file write.");
      }
    }
    let oldText;
    try {
      oldText = await fs.readFile(params.path, "utf8");
    } catch {
      oldText = undefined;
    }
    await fs.mkdir(path.dirname(params.path), { recursive: true });
    await fs.writeFile(params.path, params.content, "utf8");
    const diff = buildUnifiedFileDiff(params.path, oldText, params.content);
    await options.emitRuntimeEvent({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: params.path,
        summary: "ACP file write",
        kind: oldText === undefined ? "add" : "update",
        source: "tool",
        ...(diff ? { diff } : {}),
        ...(oldText !== undefined ? { oldText } : {}),
        newText: params.content,
      },
      diagnosticRaw: { message },
    });
    return {};
  }
}

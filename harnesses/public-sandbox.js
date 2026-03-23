import { getSandboxEscapeRequest } from "./sandbox-approval.js";
import { confirmSandboxEscape } from "./sandbox-approval-coordinator.js";

/**
 * Confirm a harness-style sandbox escape request when one is required.
 * Returns `true` when no sandbox escape is needed or the user allows it.
 * @param {{
 *   toolName: string,
 *   input: Record<string, unknown>,
 *   confirm: (message: string) => Promise<boolean>,
 *   workdir?: string | null,
 *   sandboxMode?: HarnessRunConfig["sandboxMode"] | null,
 *   additionalWritableRoots?: string[] | null,
 * }} input
 * @returns {Promise<boolean>}
 */
export async function confirmHarnessSandboxEscape(input) {
  const request = getSandboxEscapeRequest(input.toolName, input.input, {
    workdir: input.workdir ?? null,
    sandboxMode: input.sandboxMode ?? null,
    additionalWritableRoots: input.additionalWritableRoots ?? null,
  });
  if (!request) {
    return true;
  }
  return confirmSandboxEscape(request, input.confirm);
}

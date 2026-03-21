import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendSandboxWritableRoot,
  confirmSandboxEscape,
  requestSandboxEscapeApproval,
  resolveSandboxApprovalDirectory,
} from "../harnesses/sandbox-approval-coordinator.js";

const SAMPLE_REQUEST = {
  toolName: "run_bash",
  kind: "command",
  summary: "Run a shell command that targets `../shared` outside the workspace `/repo/project`.",
  command: "mkdir -p ../shared",
  target: "../shared",
  resolvedTarget: "/repo/shared",
  workdir: "/repo/project",
};

describe("requestSandboxEscapeApproval", () => {
  it("returns true when the user allows the sandbox escape", async () => {
    const approved = await requestSandboxEscapeApproval(SAMPLE_REQUEST, async (question, options) => {
      assert.match(question, /Sandbox escape request/);
      assert.deepEqual(options, ["✅ Allow", "❌ Deny"]);
      return "✅ Allow";
    });

    assert.equal(approved, true);
  });

  it("returns false when the user denies the sandbox escape", async () => {
    const approved = await requestSandboxEscapeApproval(SAMPLE_REQUEST, async () => "❌ Deny");
    assert.equal(approved, false);
  });
});

describe("confirmSandboxEscape", () => {
  it("formats the existing sandbox escape message for confirm-based callers", async () => {
    /** @type {string[]} */
    const prompts = [];

    const approved = await confirmSandboxEscape(SAMPLE_REQUEST, async (message) => {
      prompts.push(message);
      return true;
    });

    assert.equal(approved, true);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Sandbox escape request/);
  });
});

describe("appendSandboxWritableRoot", () => {
  it("adds a newly approved writable root without dropping existing ones", () => {
    assert.deepEqual(appendSandboxWritableRoot({
      workdir: "/repo/project",
      sandboxMode: "workspace-write",
      additionalDirectories: ["/tmp"],
    }, "/repo/shared"), {
      workdir: "/repo/project",
      sandboxMode: "workspace-write",
      additionalDirectories: ["/tmp", "/repo/shared"],
    });
  });

  it("does not duplicate an existing writable root", () => {
    assert.deepEqual(appendSandboxWritableRoot({
      additionalDirectories: ["/repo/shared"],
    }, "/repo/shared"), {
      additionalDirectories: ["/repo/shared"],
    });
  });
});

describe("resolveSandboxApprovalDirectory", () => {
  it("keeps directory targets as directories", () => {
    assert.equal(resolveSandboxApprovalDirectory(SAMPLE_REQUEST), "/repo/shared");
  });

  it("uses the parent directory for file targets", () => {
    assert.equal(resolveSandboxApprovalDirectory({
      toolName: "write_file",
      kind: "path",
      summary: "Access `/repo/shared/out.txt` outside the workspace `/repo/project`.",
      target: "../shared/out.txt",
      resolvedTarget: "/repo/shared/out.txt",
      workdir: "/repo/project",
    }), "/repo/shared");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSandboxEscapeConfirmMessage,
  getSandboxEscapeRequest,
} from "../harnesses/sandbox-approval.js";

describe("getSandboxEscapeRequest", () => {
  it("returns null for file access inside the workspace", () => {
    const request = getSandboxEscapeRequest("read_file", {
      file_path: "/repo/src/index.js",
    }, {
      workdir: "/repo",
      sandboxMode: "workspace-write",
    });

    assert.equal(request, null);
  });

  it("flags file access outside the workspace", () => {
    const request = getSandboxEscapeRequest("write_file", {
      file_path: "/tmp/out.txt",
    }, {
      workdir: "/repo",
      sandboxMode: "workspace-write",
    });

    assert.deepEqual(request, {
      toolName: "write_file",
      kind: "path",
      summary: "Access `/tmp/out.txt` outside the workspace `/repo`.",
      target: "/tmp/out.txt",
      workdir: "/repo",
    });
  });

  it("flags bash commands that traverse outside the workspace", () => {
    const request = getSandboxEscapeRequest("run_bash", {
      command: "cd ../.. && pwd",
    }, {
      workdir: "/repo/project",
      sandboxMode: "workspace-write",
    });

    assert.deepEqual(request, {
      toolName: "run_bash",
      kind: "command",
      summary: "Run a shell command that targets `../..` outside the workspace `/repo/project`.",
      command: "cd ../.. && pwd",
      target: "../..",
      workdir: "/repo/project",
    });
  });

  it("does not flag paths when full access is enabled", () => {
    const request = getSandboxEscapeRequest("edit_file", {
      file_path: "/tmp/out.txt",
    }, {
      workdir: "/repo",
      sandboxMode: "danger-full-access",
    });

    assert.equal(request, null);
  });
});

describe("formatSandboxEscapeConfirmMessage", () => {
  it("formats a readable confirmation prompt", () => {
    const message = formatSandboxEscapeConfirmMessage({
      toolName: "run_bash",
      kind: "command",
      summary: "Run a shell command that targets `/tmp` outside the workspace `/repo`.",
      command: "ls /tmp",
      target: "/tmp",
      workdir: "/repo",
    });

    assert.equal(message, [
      "⚠️ *Sandbox escape request*",
      "",
      "`run_bash` wants to leave the workspace boundary.",
      "",
      "Run a shell command that targets `/tmp` outside the workspace `/repo`.",
      "",
      "```bash",
      "ls /tmp",
      "```",
      "",
      "React 👍 to allow or 👎 to deny.",
    ].join("\n"));
  });
});

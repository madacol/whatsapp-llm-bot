import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findEscapedShellTarget } from "../harnesses/shell-boundary-detector.js";

describe("findEscapedShellTarget", () => {
  it("returns null for commands that stay inside the workspace", () => {
    assert.equal(
      findEscapedShellTarget("cd src && ls ../project/file.txt", "/repo/project"),
      null,
    );
  });

  it("flags parent-directory traversal in cd commands", () => {
    assert.equal(
      findEscapedShellTarget("cd ../.. && pwd", "/repo/project"),
      "../..",
    );
  });

  it("flags absolute paths outside the workspace", () => {
    assert.equal(
      findEscapedShellTarget("ls /tmp", "/repo/project"),
      "/tmp",
    );
  });

  it("strips quotes before checking escaped cd targets", () => {
    assert.equal(
      findEscapedShellTarget("cd '../outside space' && pwd", "/repo/project"),
      "../outside space",
    );
  });

  it("does not split backslash-escaped spaces in workspace paths", () => {
    assert.equal(
      findEscapedShellTarget(
        "cd /home/mada/chat-workspaces/Get\\ Bookmarklets--120363427701541991@g.us && pnpm run build:vite",
        "/home/mada/chat-workspaces/Get Bookmarklets--120363427701541991@g.us",
      ),
      null,
    );
  });

  it("treats home-directory targets as outside the workspace", () => {
    assert.equal(
      findEscapedShellTarget("cat ~/notes.txt", "/repo/project"),
      "~/notes.txt",
    );
  });
});

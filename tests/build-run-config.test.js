import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRunConfig } from "../conversation/build-run-config.js";

describe("buildRunConfig", () => {
  it("defaults sandbox mode to workspace-write", () => {
    const config = buildRunConfig("chat-1", undefined);

    assert.equal(config.sandboxMode, "workspace-write");
    assert.equal(typeof config.workdir, "string");
  });
});

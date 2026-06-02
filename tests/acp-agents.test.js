import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_ACP_AGENT_DEFINITIONS, createAcpAgentDriver } from "../harnesses/acp-agents.js";

describe("ACP agent drivers", () => {
  it("points the built-in Pi adapter at the local pinned pi binary", () => {
    const pi = BUILT_IN_ACP_AGENT_DEFINITIONS.find((definition) => definition.name === "pi");
    assert.ok(pi);
    assert.equal(pi.command, "pi-acp");
    assert.match(pi.env?.PI_ACP_PI_COMMAND ?? "", /node_modules\/\.bin\/pi(?:\.cmd)?$/);

    const driver = createAcpAgentDriver(pi);
    assert.deepEqual(driver.defaultConfig?.().env, pi.env);
  });
});

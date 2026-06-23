import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BUILT_IN_ACP_AGENT_DEFINITIONS, createAcpAgentDriver } from "../harnesses/acp-agents.js";

describe("ACP agent drivers", () => {
  it("ships ACP runtime executables as production dependencies", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const dependencies = packageJson.dependencies ?? {};
    const devDependencies = packageJson.devDependencies ?? {};
    for (const packageName of [
      "@agentclientprotocol/claude-agent-acp",
      "@agentclientprotocol/codex-acp",
      "@earendil-works/pi-coding-agent",
      "pi-acp",
    ]) {
      assert.equal(typeof dependencies[packageName], "string", `${packageName} must be installed in production`);
      assert.equal(devDependencies[packageName], undefined, `${packageName} is used by runtime harnesses, not tests only`);
    }
  });

  it("enables Codex app-server logs in the built-in Codex adapter", () => {
    const codex = BUILT_IN_ACP_AGENT_DEFINITIONS.find((definition) => definition.name === "codex");
    assert.ok(codex);
    assert.equal(codex.command, "codex-acp");
    assert.match(codex.env?.APP_SERVER_LOGS ?? "", /logs\/codex-acp$/);

    const driver = createAcpAgentDriver(codex);
    assert.deepEqual(driver.defaultConfig?.().env, codex.env);
  });

  it("points the built-in Pi adapter at the local pinned pi binary", () => {
    const pi = BUILT_IN_ACP_AGENT_DEFINITIONS.find((definition) => definition.name === "pi");
    assert.ok(pi);
    assert.equal(pi.command, "pi-acp");
    assert.match(pi.env?.PI_ACP_PI_COMMAND ?? "", /node_modules\/\.bin\/pi(?:\.cmd)?$/);

    const driver = createAcpAgentDriver(pi);
    assert.deepEqual(driver.defaultConfig?.().env, pi.env);
  });
});

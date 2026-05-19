import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHarnessInstanceConfig } from "../harness-config.js";

describe("getHarnessInstanceConfig", () => {
  it("routes canonical active instances by instance id and reads the driver from the envelope", () => {
    const resolved = getHarnessInstanceConfig({
      activeHarnessInstanceId: "codex_work",
      harnessInstances: {
        codex_work: {
          driver: "codex",
          displayName: "Codex Work",
          config: {
            model: "gpt-5.4",
            sandboxMode: "read-only",
          },
        },
      },
    }, "native");

    assert.deepEqual(resolved, {
      driver: "codex",
      instanceId: "codex_work",
      displayName: "Codex Work",
      config: {
        model: "gpt-5.4",
        sandboxMode: "read-only",
      },
    });
  });

  it("uses the driver kind as the default instance id for legacy scoped config", () => {
    const resolved = getHarnessInstanceConfig({
      codex: {
        model: "gpt-5.4",
      },
    }, "codex");

    assert.deepEqual(resolved, {
      driver: "codex",
      instanceId: "codex",
      config: {
        model: "gpt-5.4",
      },
    });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAcpConnectionFailureLifecycle } from "../harnesses/acp-client-connection-lifecycle.js";

describe("ACP client connection failure lifecycle", () => {
  it("rejects pending requests and ends notifications when child stdin fails", async () => {
    /** @type {any[][]} */
    const warnings = [];
    let endedNotifications = 0;
    let killed = false;
    const lifecycle = createAcpConnectionFailureLifecycle({
      command: "node",
      resolvedCommand: "/usr/bin/node",
      cwd: "/repo",
      getPid: () => 1234,
      endNotifications: () => {
        endedNotifications += 1;
      },
      kill: () => {
        killed = true;
      },
      logger: {
        warn(...args) {
          warnings.push(args);
        },
      },
    });

    const rejected = new Promise((resolve) => {
      lifecycle.addPendingRequest(1, {
        method: "initialize",
        resolve: () => {},
        reject: resolve,
      });
    });
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    const failure = lifecycle.handleStdinError(error);

    assert.equal(await rejected, failure);
    assert.equal(endedNotifications, 1);
    assert.equal(killed, true);
    assert.match(
      failure.message,
      /ACP connection write failed.*command=node.*resolved=\/usr\/bin\/node.*cwd=\/repo.*code=EPIPE.*pending=initialize#1.*write EPIPE/,
    );
    assert.deepEqual(warnings, [[
      "ACP child stdin failed.",
      {
        command: "node",
        resolvedCommand: "/usr/bin/node",
        cwd: "/repo",
        code: "EPIPE",
        message: "write EPIPE",
        pendingRequests: ["initialize#1"],
      },
    ]]);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createProcessDiagnosticSnapshot,
  formatProcessDiagnosticSnapshot,
} from "../process-diagnostics.js";

describe("process diagnostics", () => {
  it("formats DB cache size", () => {
    const snapshot = createProcessDiagnosticSnapshot({
      dbCacheSize: 12,
      dbCachePaths: ["/chat/a/pgdata", "/chat/b/pgdata"],
      pid: 123,
      uptime: () => 45.3,
    });

    assert.equal(
      formatProcessDiagnosticSnapshot(snapshot),
      "pid=123 uptime=45s db_cache_size=12 paths=/chat/a/pgdata,/chat/b/pgdata",
    );
  });

  it("does not expose a periodic process diagnostics logger", async () => {
    const diagnostics = await import("../process-diagnostics.js");

    assert.equal("startProcessDiagnostics" in diagnostics, false);
  });
});

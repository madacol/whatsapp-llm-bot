import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createProcessDiagnosticSnapshot,
  formatProcessDiagnosticSnapshot,
  parseCgroupMemoryEvents,
} from "../process-diagnostics.js";

describe("process diagnostics", () => {
  it("parses cgroup memory events", () => {
    assert.deepEqual(parseCgroupMemoryEvents("low 0\noom_kill 35\nbad nope\n"), {
      low: 0,
      oom_kill: 35,
    });
  });

  it("formats DB cache size and OOM counter", () => {
    const snapshot = createProcessDiagnosticSnapshot({
      dbCacheSize: 12,
      dbCachePaths: ["/chat/a/pgdata", "/chat/b/pgdata"],
      pid: 123,
      uptime: () => 45.3,
      readFileSync: () => "low 0\noom_kill 35\n",
    });

    assert.equal(
      formatProcessDiagnosticSnapshot(snapshot),
      "pid=123 uptime=45s db_cache_size=12 cgroup_oom_kill=35 paths=/chat/a/pgdata,/chat/b/pgdata",
    );
  });
});

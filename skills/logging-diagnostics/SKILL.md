---
name: logging-diagnostics
description: Manage diagnostic logging with minimal context: find relevant logs, inspect status, enable or disable narrow logging, add runtime toggles when missing, and clean up after debugging.
---

# Logging Diagnostics

Use this skill when debugging a failure, checking whether logging is enabled, changing log levels, adding a missing diagnostic log, or cleaning up generated logs.

Minimal workflow:

- Check disk, current logging status, and the newest relevant log files first.
- Enable only the narrowest diagnostic needed, preferably at runtime.
- Reproduce or inspect the issue.
- Disable the diagnostic immediately after collecting enough evidence.
- Summarize only the useful findings and remove bulky generated logs when safe.

Runtime tools in this repo:

```bash
node "$(git rev-parse --show-toplevel)/scripts/diagnostics-logging.js" status
node "$(git rev-parse --show-toplevel)/scripts/diagnostics-logging.js" acp on
node "$(git rev-parse --show-toplevel)/scripts/diagnostics-logging.js" raw on
node "$(git rev-parse --show-toplevel)/scripts/diagnostics-logging.js" level debug
node "$(git rev-parse --show-toplevel)/scripts/diagnostics-logging.js" all off
```

If a needed diagnostic does not have a runtime toggle:

- Add a small explicit toggle instead of relying only on environment variables.
- Keep the default off if the log can grow quickly or contain sensitive data.
- Log structured records with timestamps and enough identifiers to correlate the event.
- Add focused tests for default-off, enabled, disabled, and runtime-change behavior.

Fixture capture logs:

- Treat fixture captures as raw diagnostic material for debugging and later manual test-fixture promotion.
- Keep fixture capture default-off, runtime-bounded, and scoped to explicit seams.
- If large raw values are capped, write a `fixtureCapture.meta` record in the capture file before event records.
- The meta record must clearly define the truncation marker, currently `__fixtureCaptureTruncated`, and state that capped values are replaced by metadata plus a preview.
- Capped values should be obvious objects, not strings that look complete. Include type, original size, hash, and preview fields where available.

Rules:

- Keep context small; read recent logs, not whole files.
- Treat logs as sensitive.
- Do not leave verbose diagnostics enabled after the investigation.
- Prefer structured logs and runtime toggles over broad permanent logging.

---
name: show-architecture-report
description: Publish architecture review HTML reports for this repository.
---

# Show Architecture Report

1. Write the report to `architecture-review-site/reviews/<YYYYMMDD-HHMM>-<short-slug>.html`.
2. Include `<meta name="viewport" content="width=device-width, initial-scale=1" />`.
3. Add a top entry in `architecture-review-site/index.html` linking to the new report; keep existing links.
4. Reply with the index URL and direct report URL:

- Index: `https://private-host-redacted`
- Report: `https://private-host-redacted/reviews/<filename>.html`

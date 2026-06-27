---
name: show-architecture-report
description: Publish architecture review HTML reports for this repository.
---

# Show Architecture Report

1. Write the report to `architecture-review-site/reviews/<YYYYMMDD-HHMM>-<short-slug>.html`.
2. Include `<meta name="viewport" content="width=device-width, initial-scale=1" />`.
3. Add a top entry in `architecture-review-site/index.html` linking to the new report; keep existing links.
4. Do not run the Caddy site-manager deploy command for normal report publication. The architecture review site is already deployed as a static folder, so adding the HTML file and index entry is sufficient.
5. Reply with the index URL and direct report URL:

- Index: `https://architecture-review.ts.babyjarvis.com`
- Report: `https://architecture-review.ts.babyjarvis.com/reviews/<filename>.html`

Only run network validation when the user explicitly asks for it.

# Maintenance Scripts

This folder contains operational scripts for inspecting and maintaining local app data.

## `detect-empty-db-clusters.js`

Read-only scanner for `pgdata/` that classifies DB cluster roots as:

- `empty`: no rows in any user table
- `non-empty`: at least one user table has rows
- `error`: the DB could not be opened or scanned

Typical workflow:

1. Run the script and review `DELETE`, `KEEP`, and `ERROR` lines.
2. If needed, rerun with `--progress`.
3. Use `--paths-only` to produce a plain list of empty DB roots.
4. Delete those folders manually only after review.

Examples:

```bash
node maintenance/detect-empty-db-clusters.js
node maintenance/detect-empty-db-clusters.js --paths-only
node maintenance/detect-empty-db-clusters.js --json
```

For the full CLI reference, use:

```bash
node maintenance/detect-empty-db-clusters.js --help
```

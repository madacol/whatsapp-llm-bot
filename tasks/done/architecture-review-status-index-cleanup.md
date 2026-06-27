# Clean Up Architecture Review Status Index

## Subject

Update the architecture review site index so report statuses match the current repository evidence.

## Source

Created from the user's request to convert refactor candidates 1, 2, and 3 into pending handoff tasks.

This is candidate 3 from the prior recommendation:

- "Architecture review status index cleanup"
- The immediate stale entry is the command/intake report, which still appears current/open even though it was implemented and committed.

## Current Evidence

- `architecture-review-site/index.html` says `20260627-1037-command-and-intake-seams.html` is `Current/open` with "No acceptance, rejection, or implementation evidence yet".
- Commit `c823933 Deepen command and intake architecture` implemented that report's four candidates:
  - Command Orchestration;
  - HTTP API Transport turn intake;
  - Chat Settings interaction;
  - Channel identity migration.
- `tasks/done/command-intake-architecture.md` records the completed work and verification.
- Earlier user instruction asked to keep architecture report publication minimal: for the static review site, add HTML/index entries and provide URLs; do not redeploy unless explicitly asked.

## Goal

Make the architecture review index a reliable current-status map:

- mark command/intake as done;
- preserve links to existing reports;
- note evidence paths or commit hashes where useful;
- identify any remaining stale "current/open", "midway/current", "done top rec", or superseded labels that no longer match repo evidence.

## Non-Goals

- Do not rewrite the full visual design unless needed.
- Do not publish a new review report.
- Do not run network validation unless explicitly asked.
- Do not redeploy the static site; the folder is already deployed.

## Suggested First Pass

1. Read `architecture-review-site/index.html`.
2. Read relevant done task files under `tasks/done/`.
3. Check recent commits for the status evidence, especially:
   - `c823933 Deepen command and intake architecture`
   - `3d10165 Handle ACP stdin failures without crashing`
4. Update the index labels and status notes.
5. If the Agent Run Activity report remains midway/current, keep that status and link it conceptually to the pending Agent Run Activity task.

## Acceptance Criteria

- The command/intake report no longer appears current/open.
- Status notes cite durable repo evidence such as task files and/or commit hashes.
- The index remains static HTML and keeps all existing report links.
- Docs-only verification is sufficient; no code tests required.

## Completion Notes

- Updated `architecture-review-site/index.html` so the command/intake report is marked done.
- Added durable evidence to status notes: done task files, ADRs, docs, tests, and implementation commit hashes.
- Preserved the static HTML index and all existing report links.
- Kept Agent Run Activity as midway/current and linked the remaining reasoning/subagent reconciliation pressure to `tasks/agent-run-activity-reasoning-subagent-output.md`.
- Recorded ACP connection-failure lifecycle cleanup as separate pending work rather than folding it into the completed ACP request-channel report.

## Verification

- Docs-only change; code verification intentionally skipped per task instructions.

## Status

Done.

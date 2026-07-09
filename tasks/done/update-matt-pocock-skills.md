# Update Matt Pocock Skills

## Brief

Update or install the Matt Pocock "Skills For Real Engineers" skill set for this workspace.

## Evidence

- User asked via audio transcript: "Can you please update the skills for Matt Hancock?"
- User corrected the name to "poccock", then confirmed the relevant trail was the GitHub search for `site:github.com/mattpocock "skills"`.
- User clarified via audio transcript on 2026-07-08: local skills are slightly modified versions of the originals and must not be removed; preserve them as backups, install the repository versions, then compare local backups against upstream so the user can choose per difference.
- Source repo verified as `https://github.com/mattpocock/skills`, described as "Skills for Real Engineers. Straight from my .claude directory."
- Official quickstart uses `npx skills@latest add mattpocock/skills`; `skills` CLI docs expose `skills update`.

## Constraints

- Use `pnpm` rather than `npx` in this repo.
- Execute the `skills` CLI pinned to `skills@1.5.15`, not `latest`.
- Package review: npm package `skills@1.5.15` points to `vercel-labs/skills`, has one dependency (`yaml`), Node engine `>=18`, and integrity `sha512-qOjkxQ+Bbua6UWx71XSbkEpAFQpBLvOFc26PDMHkT7BSnwud1/CyyyWyF2HElHyt51GN32GQ1ZDPrGhsNG47GA==`.
- Socket.dev analysis could not be fetched because the site/API returned a Cloudflare browser challenge.

## Preservation

- Workspace `skills/` backup: `tasks/evidence/update-matt-pocock-skills/backup-20260708-local-skills/`.
- Project agent skills backup: `tasks/evidence/update-matt-pocock-skills/backup-20260708-agent-skills/`.
- Global Codex skill backup for upstream-overlapping local variants: `tasks/evidence/update-matt-pocock-skills/backup-20260708-global-codex-skills/`.
- Comparison report: `tasks/evidence/update-matt-pocock-skills/comparison.md`.

## Current Status

- Initial broad project install was corrected: repo-local spillover folders such as `.adal/`, `.aider-desk/`, `.augment/`, root `skills/` upstream duplicates, `skills-lock.json`, and mistaken `.agents/skills` Matt Pocock copies were removed.
- User clarified the install target is the user-level folder, not this repo, and selected only a subset.
- Installed selected skills into `/home/mada/.agents/skills`: `code-review`, `grill-me`, `grill-with-docs`, `handoff`, `implement`, `improve-codebase-architecture`, `to-spec`, `wayfinder`, and custom local-file-only `to-tickets`.
- Installed dependency skills discovered by reading selected skill references: `grilling`, `domain-modeling`, `codebase-design`, `prototype`, `setup-matt-pocock-skills`, and `tdd`.
- Existing user-level selected skills were not clobbered during the copy; prior user-level `.agents/skills` content was backed up at `/tmp/user-agents-skills-backup-20260709/`.

## Completion Notes

- Final user-level skill set verified with `find /home/mada/.agents/skills -maxdepth 2 -type f -name SKILL.md`.
- Repo-level `.agents/skills` verified back to its original project skills: `generate-image`, `generate-video`, and `send-path`.
- Repo root `skills/` verified back to local repo skills: `logging-diagnostics`, `send-artifacts`, `send-files`, `show-architecture-report`, and `test-correctly`.
- No code tests were run; this was a skill file install/cleanup task.

## Acceptance

- Existing installed skills are updated, or the Matt Pocock skill set is installed if no tracked install exists.
- Pre-existing local skill variants are preserved before installer changes.
- Differences between preserved local variants and repository versions are summarized for user choice.
- Installed skill paths are verified.
- This task is archived with completion notes.

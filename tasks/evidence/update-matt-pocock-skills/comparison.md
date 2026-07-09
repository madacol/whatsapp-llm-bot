# Matt Pocock Skills Comparison

Date: 2026-07-08

## Installed Upstream

Command used:

```bash
pnpm dlx skills@1.5.15 add mattpocock/skills --all --full-depth --copy
```

Result:

- Installed 38 upstream skills from `mattpocock/skills`.
- Copied project skill files into `skills/` and `.agents/skills/`.
- Because `--all` means all skills and all detected agent targets, the CLI also created agent-specific skill directories such as `.aider-desk/`, `.augment/`, `.continue/`, `.windsurf/`, and others.
- Verification command `pnpm dlx skills@1.5.15 list --json` reports the upstream skills as project-installed.

## Preserved Backups

- Workspace `skills/`: `tasks/evidence/update-matt-pocock-skills/backup-20260708-local-skills/`
- Project agent skills: `tasks/evidence/update-matt-pocock-skills/backup-20260708-agent-skills/`
- Global Codex upstream-overlapping skills: `tasks/evidence/update-matt-pocock-skills/backup-20260708-global-codex-skills/`

## Workspace Skill Backup

The pre-existing workspace skills did not overlap the upstream Matt Pocock skill names:

- `logging-diagnostics`
- `send-files`
- `show-architecture-report`
- `test-correctly`

They remain in `skills/`, and the installed upstream skills were added beside them.

## Project Agent Skill Backup

The pre-existing `.agents/skills` project skills did not overlap the upstream Matt Pocock skill names:

- `generate-image`
- `generate-video`

They remain in `.agents/skills/`, and the installed upstream skills were added beside them.

## Global Codex Skill Comparison

These local global Codex skills had upstream Matt Pocock counterparts and were compared against the newly installed upstream copies in `skills/`.

### No Differences

- `domain-modeling`
- `grill-with-docs`

### Differences To Choose

#### `grill-me`

Local backup:

- Contains the full interview instructions directly.
- Tells the agent to ask one question at a time.
- Tells the agent to explore the codebase instead of asking when exploration can answer a question.

Upstream installed copy:

- Is a thin command wrapper: `Run a /grilling session.`
- Adds `disable-model-invocation: true`.
- Uses a shorter description.

Decision: choose local if `grill-me` should stay self-contained; choose upstream if it should simply route to `grilling`.

#### `grilling`

Local backup:

- Says to explore the codebase instead of asking when a question can be answered that way.

Upstream installed copy:

- Narrows that rule: facts should be looked up, but decisions must be put to the user.
- Adds an explicit rule not to enact the plan until shared understanding is confirmed.
- Slightly changes the description wording.

Decision: upstream is more explicit about separating facts from decisions; local is shorter.

#### `handoff`

Local backup:

- Says not to duplicate content already captured in `PRDs, plans, ADRs, issues, commits, diffs`.

Upstream installed copy:

- Adds `disable-model-invocation: true`.
- Changes `PRDs` to broader `specs`.

Decision: upstream is a small metadata/wording update unless `PRDs` is intentionally preferred.

#### `improve-codebase-architecture`

Local backup:

- Embeds the architecture glossary directly in `SKILL.md`.
- Includes extra reference files: `DEEPENING.md`, `INTERFACE-DESIGN.md`, and `LANGUAGE.md`.
- Reads `CONTEXT.md`, `docs/glossary.md`, `docs/architecture/constraints.md`, relevant area docs such as `docs/transports/*.md`, and ADRs.
- Uses `skills/show-architecture-report/SKILL.md` when present to publish the report.
- Otherwise writes the report to a temp HTML file.
- During the follow-up conversation, updates repo-specific docs such as `docs/glossary.md`, area docs, and architecture constraints.

Upstream installed copy:

- Adds `disable-model-invocation: true`.
- Delegates architecture vocabulary to `/codebase-design` instead of local reference files.
- Removes `DEEPENING.md`, `INTERFACE-DESIGN.md`, and `LANGUAGE.md` from this skill.
- Reads `CONTEXT.md` and area ADRs first, with less repo-specific doc discovery.
- Always writes the report to an OS temp HTML file and opens it locally.
- Uses `/grilling`, `/domain-modeling`, and `/codebase-design` for follow-up work.

Decision: local is more tailored to this repo's report publishing and doc layout; upstream is more modular and command-oriented.

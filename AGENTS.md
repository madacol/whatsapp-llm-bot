# Rules

- Use JSDoc types and precise narrowing; avoid weak casts.
- Keep subsystem seams small, semantic, and explicit.
- When a request is vague or ambiguous, suggest concrete options or ask for clarification instead of assuming.
- Do not bypass seams, add special cases, or cut corners without confirming.
- When external payload shape matters, inspect a real payload before designing around it.
- Use the `manage-tasks` skill for durable task tracking. This repo's task index is `tasks/todo.md`; task files live under `tasks/`; completed task files move to `tasks/done/` with a concise entry in `tasks/done/done.md`.
- When creating or updating task files, preserve the triggering evidence: include the user's exact or near-exact request text in a dedicated section, explicitly reference any attached media or quoted message that motivated the task, and then keep inferred context in a separate section.
- For docs-only or instruction-only changes, skip code verification and commit.

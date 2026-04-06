---
name: refactor
description: Identify refactoring opportunities in the codebase and propose improvements with clear context and options
args: "[optional focus area or file path]"
---

# /refactor — Identify and propose refactoring opportunities

Scan the codebase (or a specific area) for refactoring opportunities, then present each one clearly for the user to decide.

## Behavior

1. Look for any refactor that is worth doing
2. Let's go step by step and for each refactor found:
   1. Explain clearly the context and concern — if needed, include code snippets with file paths and line numbers so the user can understand the full picture
   2. If there are multiple valid approaches, present options and let the user decide
3. Make a subagent work on them in the background while you keep asking for other refactors
4. **Parallelize when possible**: If multiple approved changes are independent, work on them in parallel.

## Examples

```
/refactor                           # scan entire codebase
/refactor actions/                  # focus on the actions directory
/refactor type safety in database   # focus on a specific concern
/refactor index.js                  # focus on a single file
```

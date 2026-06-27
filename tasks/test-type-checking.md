# Test Type Checking

## Subject

Investigate whether this repo should type-check tests, and what scope would be practical.

## Context

The production `pnpm type-check` config currently excludes `tests/`. During the vertical scenario runner work, a narrow test type-check attempt pulled in legacy test helpers and surfaced unrelated test typing debt. The user asked to pause changes in this area and track the question as a todo.

## Questions

- Why are tests excluded from the current type-check config?
- Which test files are reusable infrastructure and would benefit from type-checking first?
- Can a narrow type-check target stay scoped to new reusable helper files while legacy helper debt is investigated separately?
- What cleanup would be required before broader test type-checking is useful?

## Status

Todo.

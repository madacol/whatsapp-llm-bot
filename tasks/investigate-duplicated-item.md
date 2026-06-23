# Investigate Duplicated Item

## Context

- User side note on 2026-06-23: "add todo: investigate why it is duplicated".
- The duplicated item was not explicitly named in that message.
- Recent nearby context included ACP command resolution, runtime logs, task bookkeeping, and duplicated-looking skill listings / message traces from prior work.

## Investigation

- Clarify which item is duplicated before changing behavior.
- Check whether the duplication is cosmetic presentation, duplicated configuration, duplicated task/doc state, duplicated runtime output, or duplicated source registration.
- Prefer removing duplicate source-of-truth entries over adding filtering or downstream suppression.

## Acceptance

- Identify the duplicated item and its source.
- Remove or consolidate the duplication at the owning layer.
- Archive this detail file under `tasks/done/` with the fix summary when complete.

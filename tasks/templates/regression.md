# Regression Task

## User-Visible Failure

What action failed, what should have happened, and what happened instead.

## Desired Outcome

The exact behavior that must be true when this is fixed. Include visible output, durable state, cleanup, acknowledgements, or settlement conditions when relevant.

## Real Evidence Inspected

Captured input, logs, state, persisted rows, screenshots, traces, commits, versions, or other facts used before choosing a fix.

## Highest Seam Reproduction

The broadest practical test/replay that exercises the same behavior path the user cares about.

## Red Proof

Command, test, or replay that failed before production edits, with the relevant failure reason.

## Fix

The production change and why it addresses the proven failure.

## Green Proof

Command, test, or replay that passed after the fix at the same proof seam.

## Support Tests

Narrower tests that help cover edge cases or logic, if any.

## Live/Deploy Proof

Running version, process, deployment, migration, queue/journal, or other live-state verification when applicable.

## Remaining Risk

What is still not proven, intentionally skipped, or dependent on external state.

# Regression Task

## User-Visible Failure

What action failed, what should have happened, and what happened instead.

## Desired Outcome

The exact behavior that must be true when this is fixed. Include visible output, durable state, cleanup, acknowledgements, or settlement conditions when relevant.

## Real Evidence Inspected

Captured input, logs, state, persisted rows, screenshots, traces, commits, versions, or other facts used before choosing a fix.

## Vertical Reproduction

A test/replay that starts at the real entry point and follows the behavior to the desired outcome. Note if it is temporary diagnostic scaffolding.

## Failing Seam

Where the vertical reproduction stops or proves the problem is located.

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

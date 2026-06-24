# Regression

## Outcome

User-visible failure and exact desired result, including acknowledgement, durable state, or cleanup if relevant.

## Evidence

Real input, logs, persisted state, trace, fixture, version, or other facts inspected before the fix. If a prior fix failed, include the latest evidence that invalidated it.

## Vertical Red Proof

Test/replay from the real entry point toward the desired outcome. Note whether it is temporary diagnostic scaffolding.

## Failing Seam

Where the vertical proof localizes the problem.

## Fix

Production change and why it addresses the proven failure.

## Green/Live Proof

Same vertical path passing after the fix; running/deployed version and settled durable/async state when applicable.

## Remaining Risk

What is still not proven or was intentionally skipped.

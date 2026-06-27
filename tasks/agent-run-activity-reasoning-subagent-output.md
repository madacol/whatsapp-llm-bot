# Deepen Agent Run Activity Reasoning/Subagent Output

## Subject

Refactor Agent Run Activity reasoning and subagent output so reconciliation happens behind one deeper module before WhatsApp Presentation renders it.

## Source

Created from the user's request to convert refactor candidates 1, 2, and 3 into pending handoff tasks.

This is candidate 1 from the prior recommendation:

- "Agent Run Activity reasoning/subagent output"
- The architecture index still marks "Deepen Agent Run Activity output" as `Midway/current`.
- The existing pending task `investigate-repeated-thoughts.md` is related but narrower; it tracks a symptom where LLM thought/reasoning text sometimes repeats.

## Current Evidence

- `architecture-review-site/index.html` describes `20260625-0459-agent-run-activity-output.html` as midway/current: output ports and `diagnosticRaw` cleanup are in place, but reasoning/subagent reconciliation pressure remains current.
- Recent tests around `buildAgentIoHooks` and runtime dispatch already prove some reasoning deduplication behavior, but the code still has enough pressure that repeated thought/reasoning output has its own pending investigation.
- The likely owner area includes:
  - `harnesses/harness-runtime-events.js`
  - `harnesses/harness-runtime-event-dispatcher.js`
  - `harnesses/harness-agent-io-hooks.js`
  - `whatsapp/outbound/*` presentation modules that consume runtime events
  - tests covering reasoning, subagent messages, and ACP runtime event rendering

## Goal

Concentrate reasoning snapshot/delta reconciliation, subagent message normalization, and final inspect text ownership behind Agent Run Activity so downstream presentation receives stable semantic facts.

## Non-Goals

- Do not add WhatsApp-specific reasoning heuristics to presentation as a quick fix.
- Do not re-open the already-completed output-port split unless the current code forces it.
- Do not delete existing repeated-reasoning tests without proving the user-valued behavior they protect.

## Suggested First Pass

1. Read `architecture-review-site/reviews/20260625-0459-agent-run-activity-output.html`.
2. Read `tasks/investigate-repeated-thoughts.md`.
3. Trace current reasoning/subagent event flow from ACP provider payload to Agent Run Activity to WhatsApp Presentation.
4. Identify the smallest deepened module that can own reasoning/subagent reconciliation without widening the presentation interface.
5. Prove any behavior change red first, then green.

## Acceptance Criteria

- Reasoning/subagent reconciliation has one clear owner seam.
- WhatsApp Presentation receives normalized semantic runtime facts rather than provider-shaped reasoning/subagent fragments.
- Existing reasoning/subagent vertical tests remain green.
- The repeated-reasoning investigation is either resolved or updated with evidence explaining what remains.
- `pnpm type-check` and relevant ACP/runtime/presentation tests pass.

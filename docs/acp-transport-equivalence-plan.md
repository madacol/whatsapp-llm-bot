# ACP Transport Equivalence Plan

## Goal

Migrate the harness layer to ACP without requiring provider-specific behavior in
the app-facing transport path. The important compatibility target is not whether
Codex, Claude, Pi, or another agent emits the same internal events as before.
The target is that the same user-visible WhatsApp transport outcomes are
produced for the same user workflows.

In other words: ACP providers may differ internally, but the semantic outbound
events and rendered WhatsApp messages should remain equivalent to master for the
behaviors users depend on.

## Non-Goals

- Do not preserve provider-specific internal event shapes.
- Do not reimplement Codex/Pi/Claude private protocols under ACP.
- Do not reject otherwise usable ACP agents at startup only because they lack
  optional extension capabilities such as fork or steer.
- Do not make subagent semantics broader until ACP standardizes a shape beyond
  the current metadata convention.
- Do not make ACP processes long-lived across turns unless a real current agent
  requires it.

## Equivalence Contract

For each supported workflow, compare the final app-facing output, not the raw
provider event stream.

Equivalent means:

- The same `OutboundEvent` kinds are produced.
- User-visible message ordering is materially the same.
- Assistant replies, subagent replies, tool progress, command output, plans,
  file changes, usage, and errors are not silently dropped.
- File changes reach the transport as file-change output with enough data to
  render the same useful WhatsApp message: summary, kind, path, and diff or
  before/after text when available.
- File changes preserve their transport classification:
  - added files are sent as adds
  - deleted files are sent as deletes
  - updated files are sent as updates/diffs
  - diffs are still sent/rendered as diffs
  - add/delete/update regressions are failures even if the ACP provider reached
    the correct final filesystem state
- ACP chunking differences do not alter the final WhatsApp experience beyond
  acceptable streaming granularity.

## WhatsApp Presentation Policy

ACP/harness code should forward canonical runtime events to the transport. It
must not decide chat visibility for generic provider lifecycle events by
formatting them into plain content messages before the WhatsApp boundary.

Existing Codex-equivalent event categories keep the master presentation:

- assistant output renders as an LLM message
- reasoning renders as the existing thinking placeholder with inspect detail
- tool calls, shell commands, and file reads render as the existing full tool
  cards or compact tool status depending on chat visibility settings
- file changes render through the existing file-change card/diff path
- plans render through the existing plan message
- subagent output renders through the existing subagent message path
- usage renders as a final turn usage message instead of arbitrary lifecycle
  spam
- errors that correspond to existing tool/runtime failures remain visible error
  messages

ACP-native events that do not map to an existing Codex presentation are still
sent to WhatsApp as `runtime_event` outbound events. The WhatsApp presentation
layer decides how to display them:

- generic session, turn, request, user-input, item, extension, model-reroute,
  and warning events are folded into one editable ACP status message per chat
- the status message keeps only the latest visible entries in the chat bubble
  and stores the full event detail in inspect text
- `turn.completed` and `session.stopped` close the current ACP status so the
  next turn starts a fresh status message
- `runtime.error` renders as a standalone error message

This keeps the transport fully informed while preventing every provider-native
event from becoming an independent WhatsApp message.

## Test Strategy

### 1. Build Transport-Level Golden Scenarios

Create integration fixtures that exercise the user-visible workflows currently
covered by master:

- assistant final response
- streaming/chunked assistant response
- reasoning/thinking visibility
- tool started/updated/completed
- shell command started/completed/failed
- file read progress
- file add/update/delete with diff rendering
- file write through client fs service
- direct file write detected by fallback
- plan update
- usage update
- subagent response
- permission request and resolution
- request denial/error path
- fork/back session controls
- mode/model/config updates

Each scenario should assert the semantic outbound events or rendered send
instructions that reach the WhatsApp transport boundary.

### 2. Use One Start-To-End Boundary Per Workflow

Preferred test boundary:

`conversation runner -> harness adapter -> runtime event dispatcher -> AgentIOHooks -> OutboundEvent -> WhatsApp send-content renderer`

This catches regressions that unit tests on `acp-events` or `acp-runner` cannot
see.

### 3. Keep Lower-Level ACP Tests Focused

Lower-level ACP tests should prove protocol mapping only:

- ACP `agent_message_chunk` becomes `content.delta`
- ACP `tool_call_update` merges prior tool state
- ACP diff blocks become file-change runtime events
- ACP `fs/write_text_file` emits file-change runtime events
- ACP permission requests emit `request.opened` and `request.resolved`
- unknown ACP extension traffic is surfaced, not discarded

They should not be the only proof of user-facing compatibility.

## Required High-Level Changes

### 1. Add Transport Equivalence Integration Tests

Create tests that run the same canonical scenarios through the ACP harness and
assert the WhatsApp-facing output.

This is the main missing proof. The existing ACP tests prove event mapping and
adapter behavior, but not every final transport message shape.

### 2. Normalize File-Change Output At The Runtime Boundary

Keep provider-specific internals out of the transport path, but ensure every ACP
file-change source normalizes to the same runtime/output contract.

Current ACP sources:

- diff blocks in ACP tool content
- ACP `fs/write_text_file`
- workdir snapshot fallback

Needed behavior:

- produce `file-change.completed`
- include path and kind
- include old/new text or diff when available
- avoid duplicate file-change messages when multiple ACP sources report the same
  path
- preserve enough information for WhatsApp diff/code rendering

### 3. Add Golden Coverage For ACP File-Change Variants

Create end-to-end tests for:

- ACP diff block update
- ACP client fs write add
- ACP client fs write update
- direct write detected by snapshot
- delete detected by snapshot
- no duplicate output when diff/fs and snapshot both see the same file
- provider-reported file add for a path that existed at run start, corrected to
  update before transport rendering

These tests should assert final outbound/file-rendering behavior, not just
runtime events.

The file-change golden tests must assert the transport-facing classification:

- an added file reaches the transport as `kind: "add"` and renders as an added
  file/code block
- a deleted file reaches the transport as `kind: "delete"` and renders as a
  delete
- an updated file reaches the transport as `kind: "update"` and renders as a
  diff when diff/old-new text is available
- a provider-supplied diff remains a diff at the WhatsApp send boundary
- snapshot fallback must not misclassify an overwrite as an add
- snapshot fallback must not misclassify a delete as an update

Regression examples that must fail tests:

- update displayed as add
- add displayed as update
- delete displayed as update
- diff downgraded to plain text
- duplicate file-change messages for one actual change
- missing file-change message when the transport previously showed one

### 4. Implement Generic ACP Config UI Later, Not Provider Commands

Move toward ACP `configOptions` as the native source of config truth.

Plan:

- cache `configOptions` per active session or provider instance
- add `/config`
- render select/boolean/string options generically
- call `session/set_config_option`
- keep `/model` and `/mode` as aliases over ACP config categories
- keep client-owned security/session commands separate

Security/session commands that remain client-owned:

- `/clear`
- `/resume`
- `/fork`
- `/back`
- `/stop`
- sandbox/approval policy enforcement

Unknown slash commands should be passed through to the agent where possible
instead of being treated as app-owned commands.

### 5. Add Generic ACP User Input Handling

Permission requests are handled now. Generic elicitation/user-input should be
implemented after confirming the exact ACP RFD payload shape used by supported
adapters.

Expected runtime flow:

- ACP request arrives
- emit `user-input.requested`
- WhatsApp asks the user
- store pending request ID
- user response resolves via `respondToUserInput`
- emit `user-input.resolved`
- return ACP response to the agent

### 6. Add ACP Extension Router

Unknown extension notifications are currently surfaced, and unknown extension
requests get a generic empty response.

Improve this with an explicit extension router:

- per-agent extension request handlers
- per-agent extension notification handlers
- default unsupported-method response for unknown requests
- logging for unknown notifications

This keeps the core ACP path generic while allowing official adapters to expose
their required extension methods.

## Done Criteria

The migration is done when:

- ACP-backed Codex, Claude, Pi, and one synthetic custom ACP agent pass the same
  transport-level integration scenarios.
- File-change workflows produce equivalent WhatsApp-facing output to master.
- Subagent responses remain visually differentiated from normal assistant
  responses.
- Permission prompts and denials behave the same at the chat boundary.
- `/fork` and `/back` keep session behavior equivalent to master.
- Generic `/config` handles ACP config options without provider-specific command
  branches for model/mode/reasoning.
- Unknown slash commands can reach the agent unless reserved by the client.
- `pnpm type-check`, focused ACP tests, and full `pnpm test` pass.

## Current Status

Implemented on `acp-migration`:

- ACP runtime model with `content.delta` and item lifecycle events.
- Tool-call state merge for partial ACP updates.
- ACP permission request lifecycle events.
- Adapter-level `respondToRequest`, `respondToUserInput`, `hasSession`, and
  `stopAll`.
- Generic ACP `mode` plumbing.
- ACP file-change sources for diff blocks, `fs/write_text_file`, and snapshot
  fallback.
- ACP extension notifications/requests are surfaced as runtime events.
- ACP diff-only blocks preserve unified diffs and infer add/update/delete from
  diff headers.
- ACP client fs writes and snapshot fallback now attach unified diffs when
  before/after text is available.
- ACP provider file-change events are reconciled against the run-start
  workspace snapshot before they enter the transport stream, so official
  adapters that report an existing-file overwrite as an add are corrected to an
  update with old text and a diff.
- ACP provider file-change events that include old/new text but omit the unified
  diff are enriched with a generated diff before transport rendering.
- ACP adapter mode emits canonical runtime events without also dispatching those
  events directly to chat hooks, preventing duplicate transport messages.
- Transport-level ACP file-change tests cover fs add, fs update, snapshot delete,
  misreported existing-file add corrected to update, diff-only add, diff-only
  update, and diff-only delete, and assert the actual WhatsApp send output
  classification.
- Transport-level ACP runtime tests cover assistant, subagent, plan, tool,
  file-change, usage, terminal command, permission, and elicitation/user-input
  output through the WhatsApp boundary.
- Generic ACP user-input handling is bridged through `user-input.requested` and
  `user-input.resolved`, with direct request-id resolution available to adapter
  callers.
- Generic ACP `/config` support lists and sets provider `configOptions`;
  `/model` and run config model/mode/reasoning values are applied through
  `session/set_config_option` where the provider exposes matching options.
- ACP extension traffic is routed through an explicit request/notification
  router. Known handlers can be registered per agent, unknown notifications are
  surfaced as runtime events, and unknown requests return JSON-RPC
  method-not-found errors.
- Unknown slash commands that are not handled by the client or harness continue
  through the normal agent path.
- Real adapter initialize/session smokes pass for the built-in Codex, Claude,
  and Pi ACP agents. A real Codex prompt smoke also passes.

Remaining follow-up:

- Keep adding real-provider prompt smoke coverage as supported adapters expose
  stable non-interactive prompt behavior for more scenarios.

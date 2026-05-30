# ACP / WhatsApp Presentation Boundary Refactor

## Intent

Make `whatsapp/` the presentation boundary for ACP progress.

The app should pass ACP runtime facts into WhatsApp with as little interpretation as possible. WhatsApp should decide how those facts are displayed, including labels, icons, compaction, truncation, captions, and edit behavior.

## Boundary Rule

Outside `whatsapp/` decides what happened.

Inside `whatsapp/` decides how it looks in WhatsApp.

## Smallest Desired Seam

For ACP progress, the boundary should receive only:

- `OutboundEvent` with `kind: "runtime_event"`
- `event: HarnessRuntimeEvent`

Example command event entering WhatsApp:

```js
{
  kind: "runtime_event",
  event: {
    type: "command.started",
    provider: "acp",
    command: {
      command: "pnpm type-check",
      status: "started"
    },
    raw: { /* original ACP/runtime payload */ }
  }
}
```

Example file-change event entering WhatsApp:

```js
{
  kind: "runtime_event",
  event: {
    type: "file-change.completed",
    provider: "acp",
    change: {
      path: ".../src/app.js",
      kind: "update",
      source: "snapshot",
      diff: "..."
    },
    raw: { /* original ACP/runtime payload */ }
  }
}
```

## WhatsApp Responsibilities

`whatsapp/` should decide:

- whether a command is labeled `Shell`, `Command`, or something else
- whether `source: "snapshot"` renders as `Snapshot`
- whether `source: "tool"` renders as `Add`, `Update`, or `Delete`
- which icon to show: `🔧`, `✅`, `❌`, etc.
- whether progress is compacted into one editable message
- how compacted progress is ordered, truncated, and inspected
- whether a runtime event edits an existing message or sends a new one
- how file names are styled
- how diff captions are written
- which ACP runtime noise is suppressed

## Non-WhatsApp Responsibilities

Code outside `whatsapp/` should still:

- produce truthful ACP runtime events
- normalize provider payloads enough to have stable event shapes
- preserve raw payloads under `raw`
- apply product-level visibility policy only when it is not WhatsApp-specific
- manage conversation lifecycle and final assistant responses

Code outside `whatsapp/` should not:

- build WhatsApp Markdown
- choose WhatsApp labels like `Shell`, `Snapshot`, `Update`
- attach WhatsApp icons
- construct compact WhatsApp text
- decide bold vs backtick formatting
- decide image/diff captions

## Current Problems To Remove

- `conversation/codex-hook-display.js` turns command events into tool-call presentations before WhatsApp.
- `tool-presentation-model.js` creates WhatsApp-facing command summaries like `*Shell*  \`cmd\``.
- `conversation/compact-tool-activity.js` builds compact WhatsApp progress text outside `whatsapp/`.
- File changes are closer to the desired model, but should still enter WhatsApp as ACP runtime events where practical.

## Refactor Phases

### 1. Preserve raw ACP runtime events to WhatsApp

Route ACP runtime progress through:

```js
{ kind: "runtime_event", event: HarnessRuntimeEvent }
```

Do not convert command/file/tool progress to WhatsApp presentation events before the boundary.

### 2. Move command rendering into WhatsApp

`whatsapp/` should render:

- command started
- command completed
- command failed
- command inspect output
- multiline command formatting
- compact command rows

No command label or Markdown should be created outside `whatsapp/`.

### 3. Move compact progress rendering into WhatsApp

Move compact progress state and rendering into `whatsapp/`.

Conversation code can still indicate that tool details are compacted as product policy, but WhatsApp should own the message shape, icons, visible text, truncation, and edit behavior.

### 4. Move file-change presentation fully into WhatsApp

Keep `source: "tool" | "snapshot"` as semantic metadata.

Render labels like `Snapshot`, `Add`, `Update`, and `Delete` only inside `whatsapp/`.

### 5. Delete obsolete presentation helpers outside WhatsApp

After the boundary is clean, remove or shrink helpers that only existed to pre-render WhatsApp text outside the boundary.

Likely targets:

- command presentation helpers in `tool-presentation-model.js`
- compact WhatsApp text formatting in `conversation/compact-tool-activity.js`
- WhatsApp-specific tests outside `whatsapp/`

## Verification

Each phase should include vertical tests that start before the boundary and assert what `whatsapp/` receives or renders.

Key test slices:

- ACP `command.started` enters WhatsApp as a runtime event and renders command progress there.
- ACP `command.completed` edits/updates progress from inside WhatsApp.
- ACP file-change with `source: "snapshot"` renders as `Snapshot` inside WhatsApp.
- ACP file-change with `source: "tool"` renders as `Add`, `Update`, or `Delete` inside WhatsApp.
- Compact progress is rendered inside WhatsApp, not as prebuilt text from `conversation/`.

## Target In One Line

ACP progress should cross into `whatsapp/` as raw runtime facts; WhatsApp should own every presentation decision.

# Workspace / Project Refactor Plan

## Intent

Massively simplify how workspaces work.

New target behavior:

- every new group chat should automatically be recognized as a workspace
- every workspace should automatically belong to a project
- if a group has no project yet, one should be created automatically
- if a group has no workspace yet, one should be created automatically
- joining a new group should therefore create both a project and a workspace
- every existing individual group should effectively become a project with a single workspace
- `!new` should no longer mean "create the first workspace surface"
- `!new` should mean "create an additional workspace for this already-existing workspace/project"
- only when `!new` is used should the WhatsApp presentation upgrade from a single flat group to a community

Terminology shift:

- replace the semantic idea of `repo` with `project` where appropriate
- a project may or may not have a Git repo associated with it
- a workspace always belongs to a project

## Current Direction

Keep the high-level principle:

- workspace first
- presentation later

Meaning:

- the app/domain should still think in terms of project/workspace identity and lifecycle
- WhatsApp should still own presentation topology
- WhatsApp decides whether a workspace/project is shown as:
  - a single flat group
  - a community with a `main` group and additional subgroup workspaces

## WhatsApp Scope

For now, only care about WhatsApp groups.

Individual chats:

- are not important right now
- can be handled lazily
- it is acceptable to explicitly refuse unsupported features in 1:1 chats for now

## Desired Model

### App / Domain

The app/domain should own:

- project identity
- workspace identity
- automatic project creation for a newly seen group
- automatic workspace creation for a newly seen group
- workspace lifecycle
- project/workspace folder assignment
- Git initialization when needed

The app should no longer depend on chat binding setup as a prerequisite for workspace existence.

### WhatsApp

WhatsApp should own:

- presentation topology
- whether a project is still represented by a single flat group
- whether a project has upgraded to a community
- the `main` designation as a presentation concept
- all WhatsApp chat ids / community ids
- rename/link/create subgroup operations

## Simplified Behavioral Rules

### First time the bot sees a group

- create or resolve a project for that group
- create or resolve a workspace for that group
- assign a folder to that workspace
- if the project does not have a Git repo yet, that is acceptable

### When a feature needs Git and the folder is not a repo

- initialize Git at that point
- do the minimum setup needed for the workflow

### When `!new` is run inside an existing workspace group

- create another workspace under the same project
- if the project currently has only the original flat group presentation:
  - upgrade the project to a WhatsApp community
  - adopt the original existing group as `main`
  - link that existing group into the community
  - create the new workspace directly as a subgroup
- if the project is already a community:
  - create the new workspace directly as another subgroup

## Structural Consequences

### Bindings

Current explicit binding concepts are probably no longer the right center of gravity.

Direction:

- remove or heavily reduce the current binding machinery
- stop treating only specially bound groups as workspaces
- treat every group as a workspace-bearing chat by default

### Existing data

Migration can be pragmatic.

- easy migration is preferable to perfect migration
- some data loss is acceptable
- preserving every old edge case is not important

### Project / Workspace mapping

Each random group should map to:

- one project
- one workspace inside that project

That is the default base state before any explicit expansion with `!new`.

## Key Open Refactor Areas

### 1. Domain model rename

Likely rename `repo` concepts toward `project` across:

- store schema
- services
- router/control code
- presenter boundary

Possibly keep some lower-level Git-specific naming where it is truly about Git.

### 2. Automatic chat adoption

Need a new adoption flow so that when a group is first encountered:

- it resolves or creates a project
- it resolves or creates a workspace
- it assigns storage / folder state

This should happen automatically instead of depending on manual binding.

### 3. Workspace folder provisioning

Need a consistent rule for:

- where each workspace folder lives
- when the folder is created
- when Git is initialized
- how a project-level Git repo relates to workspace folders

### 4. WhatsApp topology trigger

Need to move the upgrade trigger to:

- default state: one flat group that is already a workspace
- upgrade only when `!new` creates a second workspace

### 5. Service boundaries

Need a cleaner boundary between:

- project/workspace adoption and lifecycle
- folder/Git provisioning
- WhatsApp topology/presentation

Likely introduce a dedicated adoption/binding-resolution service for incoming chats.

## Non-goals For Now

- proper support for 1:1 chats
- perfect backwards-compatible migration
- preserving all current binding semantics

## Restated Target In One Line

Every WhatsApp group should automatically become a workspace inside an automatically assigned project; communities should only appear when `!new` creates a second workspace for that project.

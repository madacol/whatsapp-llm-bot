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

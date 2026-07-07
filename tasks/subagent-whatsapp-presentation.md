# Improve WhatsApp Presentation For Subagent Activity

## Status

Todo.

## Subject

Improve how subagent activity is presented in WhatsApp so it is readable, identifiable, and visually distinct from normal tool-call progress.

## Request

> add to tasks: we need to improve the subagent WhatsApp presentation. we need to find (or make up) a subagent name or human-readable-identifier, and also change its format to differentiate from the tool name, I suggest using inline code block

Media: `/home/mada/whatsapp-llm-bot/.media/7a5679a40d902d694a9aae880030cffd094d32e6e66f192fdae03d3cbbfedc2a.jpg`

## Evidence

The referenced WhatsApp screenshot shows the `Baby Jarvis - tmp` group chat where subagent research work appears as repeated wrench-prefixed messages. Each message starts with raw prompt text such as "Research task only; do not edit files and do not commit" and then shows actions like finding `Microphone`, opening Chrome/Apple docs, or searching for PWA-related queries.

The screenshot is the motivating example because those messages look like generic tool calls, do not show a useful subagent name or human-readable identifier, and make the subagent/tool distinction hard to scan in WhatsApp.

The presentation problem is not just message length. The renderer is probably treating subagent activity like ordinary tool progress, using the tool/action label as the main visible identity. The fix should make the subagent identity explicit and visually separate from the action.

## Scope

- Inspect the real subagent event payload before choosing fields.
- Prefer an existing human-facing subagent name when available, such as a nickname returned by the subagent runtime.
- If no usable name exists, synthesize a stable readable identifier from available data, such as role plus a short agent id.
- Change the WhatsApp rendering so the subagent identifier is visibly separate from the operation/tool label.
- Use inline code formatting for the subagent identifier if it renders cleanly in WhatsApp.
- Avoid dumping the full original subagent prompt as the leading bold text.
- Keep enough action detail to understand what the subagent is doing, for example search/open/read/research status.

## Non-Goals

- Do not hide all subagent progress.
- Do not change the subagent execution model.
- Do not merge this with generic tool-call rendering unless the event model proves they share the same presentation seam.

## Acceptance Criteria

- A subagent update in WhatsApp includes a readable subagent identifier, for example a nickname or stable synthesized label.
- The identifier is formatted differently from the tool/action label, preferably with inline code formatting.
- The first line is concise and does not begin with the full raw subagent instruction.
- Tool-call progress and subagent progress are visually distinguishable in WhatsApp.
- Tests or fixtures cover at least one named subagent and one fallback synthesized identifier.

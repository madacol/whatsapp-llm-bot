# Thinking Message Coalescing

Status: Todo

## Context

Separate internal thinking/progress traces are being stitched into one visible WhatsApp message. This is distinct from the older quoted-thinking inspect regression in [quoted-thinking-inspect-regression.md](quoted-thinking-inspect-regression.md).

## Examples

Audio note: [9295db3e206e550e5f98017427a057a342f07121f773a5ea2f73f6159bfb0315.ogg](../.media/9295db3e206e550e5f98017427a057a342f07121f773a5ea2f73f6159bfb0315.ogg)

Observed symptom: multiple separate thinking/progress traces were visible as one coalesced message.

```text
🤖 *Thought*

**Updating AGENTS instructions**
...
Thinking...**Clarifying instructions for modifications**
...
Thinking...**Preparing for a new commit**
...
**Updating AGENTS instructions**
...
```

Audio note: [3112ca3c2ef7b2bc559a5a3530d654ead5a910e90ffc6bd3be69d9c604e190ef.ogg](../.media/3112ca3c2ef7b2bc559a5a3530d654ead5a910e90ffc6bd3be69d9c604e190ef.ogg)

Observed symptom: another quoted trace shows multiple internal thinking sections stitched into one visible message with repeated content.

```text
🤖 *Thought*

**Addressing user requests**
...
Thinking...**Updating tests based on user feedback**
...
Thinking...**Deciding on test modifications**
...
**Addressing user requests**
...
```

## Notes

- Do not solve this by merging it into the quoted-thinking inspect regression; that is a separate older issue.
- The fix should preserve separate thinking/update events as separate presentation states.
- The visible output should not concatenate multiple internal traces into one message.

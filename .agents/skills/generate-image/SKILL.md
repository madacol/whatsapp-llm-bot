---
name: generate-image
description: Generate a new image or edit existing images and return the result to the chat.
---

# generate-image

Use this skill when the user needs an image artifact returned to the chat.

Run this command to enqueue image generation:

```bash
node "$(git rev-parse --show-toplevel)/scripts/enqueue-action-request.js" generate-image --prompt "<prompt>" [--image-path "<canonical-media-path>"]
```

Rules:

- Repeat `--image-path` once per source image when editing existing media.
- Use the canonical media paths already present in the request when the user wants edits.
- Keep the prompt specific about subject, style, framing, and output intent.
- Do not emit extra wrapper formats after enqueuing the request.

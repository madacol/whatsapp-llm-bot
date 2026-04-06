---
name: generate-video
description: Generate a video artifact and return it to the chat.
---

# generate-video

Use this skill when the user needs a generated video artifact returned to the chat.

Run this command to enqueue video generation:

```bash
node "$(git rev-parse --show-toplevel)/scripts/enqueue-action-request.js" generate-video --prompt "<prompt>" [--image-path "<canonical-media-path>"] [--aspect-ratio "16:9"] [--duration-seconds "5"] [--negative-prompt "<text>"]
```

Rules:

- Use `--image-path` only for image-to-video requests.
- Include `--aspect-ratio`, `--duration-seconds`, and `--negative-prompt` only when they matter.
- Use the canonical media path from the request when the user supplied a reference image.
- Do not emit extra wrapper formats after enqueuing the request.

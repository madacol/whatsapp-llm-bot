---
name: send-path
description: Return a generated file or folder to the chat by path.
---

# send-path

Use this skill when you need to send a generated artifact back to the chat.

Run this command exactly once for the final artifact you want to send:

```bash
node "$(git rev-parse --show-toplevel)/scripts/enqueue-action-request.js" send-path --path "<relative-or-absolute-path>"
```

Rules:

- Prefer workspace-relative paths when possible.
- Use the final on-disk artifact path, not a description of the file.
- Directories are allowed and will be zipped before sending.
- Do not emit extra wrapper formats after enqueuing the request.

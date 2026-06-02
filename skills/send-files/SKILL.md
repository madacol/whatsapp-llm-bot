---
name: send-files
description: Use when you need to send local files, media, or directories to the chat.
---

# send-files

Use this skill when you need to send one or more local files to the chat, such as documents, images, videos, audio clips, or directories.

Include one fenced `attachment` block in the message where each file should be sent:

~~~md
```attachment
path: relative/or/absolute/path.ext
caption: Optional caption
```
~~~

Rules:

- `path` is required.
- Prefer workspace-relative paths when possible.
- `caption` is optional.
- Put any explanatory text outside the attachment block.
- Use multiple attachment blocks when sending multiple items.

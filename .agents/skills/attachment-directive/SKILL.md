---
name: attachment-directive
description: Use when the final response should attach or return local files, media, or directories to the chat.
---

# attachment-directive

Use this skill when the final response should send one or more local artifacts to the chat, such as files, images, videos, audio clips, or directories.

Write one fenced `attachment` block for each item:

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

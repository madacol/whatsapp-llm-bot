# Whatsapp LLM Bot

A whatsapp bot that uses LLMs to generate messages.

Available commands:
- `!new <name>`: creates another workspace chat for the current project
- `!list`: lists the active workspaces in the current project
- `!status`: shows the current workspace status
- `!diff`: shows the current workspace diff
- `!archive`: archives the current workspace chat
- `!archive <name>`: archives another workspace in the current project

If no command is given, the AI will handle the response.

## Getting Started

1. Prerequisites

    ```bash
    sudo apt install qrencode ffmpeg python3-venv # python3-venv is only necessary for Debian/Ubuntu systems
    ```

2. Clone this repo and run `index.js`

    ```bash
    pnpm install
    export OPENAI_API_KEY=<your-openai-api-key>
    pnpm start
    ```

3. Restart `index.js`

## HTTP API Transport

An optional HTTP API transport lets non-WhatsApp clients submit text turns to the same bot runtime and receive raw structured outbound events.

It is disabled by default. Set `API_TRANSPORT_TOKEN` to enable it:

```bash
API_TRANSPORT_TOKEN=<shared bearer token>
API_TRANSPORT_HOST=127.0.0.1
API_TRANSPORT_PORT=3200
```

See [docs/api-transport.md](docs/api-transport.md) for endpoints, payloads, idempotency, `wait=true`, status lookup, and event streaming.

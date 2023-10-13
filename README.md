# Whatsapp LLM Bot

A whatsapp bot that uses `llm` to generate messages, and `yt-dlp` to download videos/audios and re-upload them into the chat.

Available commands:
- `!video <link>`: downloads the video and re-uploads it into the chat
- `!audio <link>`: downloads the audio and re-uploads it into the chat
- `!new`: starts a new conversation with the bot

If no command is given, the bot will respond using `llm`.

## Getting Started

1. Prerequisites

    ```bash
    sudo apt install qrencode ffmpeg python3-venv # python3-venv is only necessary for Debian/Ubuntu systems
    ```

2. Clone this repo and run `index.js`

    ```bash
    export OPENAI_API_KEY=<your-openai-api-key>
    node index.js
    ```

3. While you scan the QR code for authentication, install these:

    ```bash
    pip3 install pipx
    pipx install yt-dlp
    ```

4. Restart `index.js`

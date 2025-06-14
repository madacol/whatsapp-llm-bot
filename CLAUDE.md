# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is a WhatsApp bot that integrates with LLMs to provide conversational AI and media downloading capabilities. The bot is built around a single-file Node.js application with the following key components:

### Core Structure
- **Main file**: `index.js` - Contains all bot logic, database operations, and command handling
- **Configuration**: `config.js` - Loads environment variables for API keys, model settings, and admin configuration
- **Database**: PGlite database (`./pgdata`) with two tables:
  - `chats` - Tracks chat IDs and their enabled/disabled status
  - `messages` - Stores conversation history for context
- **Actions system**: Modular action files in `actions/` directory:
  - `runJavascript.js` - JavaScript code execution with sandboxing
  - `newConversation.js` - Clear chat history
  - `enableChat.js` / `disableChat.js` - Admin chat controls

### Key Architecture Patterns
- **WhatsApp Integration**: Uses `@whiskeysockets/baileys` library with multi-file auth state storage
- **LLM Integration**: OpenAI-compatible API client (supports custom base URLs) with function calling
- **Database**: PGlite (PostgreSQL in WebAssembly) for modern SQL support with persistence
- **JavaScript Execution**: Secure VM-based sandboxing for running user-provided JavaScript code
- **Media Processing**: Spawns `yt-dlp` and `ffmpeg` processes for video/audio downloading and conversion
- **Permission System**: Admin-only commands controlled by `MASTER_ID` environment variable
- **Chat Management**: Per-chat enable/disable system to control bot responses

### Command System
The bot uses two types of commands:
1. **Bang commands** (`!command`) - Direct user commands that bypass LLM
2. **Function calls** - LLM can invoke the same functions via OpenAI function calling

Functions are defined in the `ACTIONS` array and automatically indexed for both command and function call access.

### Response Logic
- Only responds in enabled chats (tracked in database)
- In group chats: responds when mentioned or quoted
- In private chats: responds to all messages
- Conversation history maintained per chat with 20-message context window

## Common Development Commands

### Running the Bot
```bash
npm run dev
# or
node index.js
```

### Environment Setup
Required environment variables (create `.env` file):
```bash
LLM_API_KEY=your-openai-api-key
MASTER_ID=your-whatsapp-user-id
MODEL=gpt-4  # or other model
BASE_URL=https://api.openai.com/v1  # optional, for custom endpoints
SYSTEM_PROMPT="custom prompt"  # optional
```

### Prerequisites Installation
```bash
sudo apt install qrencode ffmpeg python3-venv
pip3 install pipx
pipx install yt-dlp
```

### Database Management
The PGlite database is automatically created on first run in the `./pgdata/root` directory. This provides full PostgreSQL compatibility in a lightweight package.

### Authentication Storage
Baileys stores authentication state in the `./auth_info_baileys` directory using multi-file auth state for better reliability and session persistence.

## Bot Commands (for testing)
- `!js <code>` - Execute JavaScript code with database access and context
- `!video <url>` - Download and share video
- `!audio <url>` - Download and share audio  
- `!new` - Clear conversation history
- `!info` - Show chat information
- `!enable [chatId]` - Enable bot in chat (admin only)
- `!disable [chatId]` - Disable bot in chat (admin only)

### JavaScript Execution Examples
```javascript
// Simple calculation
!js ({log}) => { log("Calculating..."); return 2 + 2; }

// Database query
!js async ({db}) => {
  const messages = await db.sql("SELECT COUNT(*) as count FROM messages");
  return `Total messages: ${messages[0].count}`;
}

// Send message and return result
!js async ({sendMessage, chatId}) => {
  await sendMessage("Hello from JavaScript!");
  return `Sent message to ${chatId}`;
}
```

## Additional Files
- `tts.mjs` - Experimental Google Cloud Speech-to-Text integration (not integrated with main bot)
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is a bot that integrates an LLM into conversational platforms like Whatsapp.

### Core Structure
- **Main file**: `index.js` - Main bot logic and message handling
- **WhatsApp adapter**: `whatsapp-adapter.js` - WhatsApp connection and message adaptation layer
- **Database layer**: `store.js` - Database operations (getChat, addMessage, getMessages, createChat, closeDb)
- **Database connection**: `db.js` - Database connection management
- **Actions framework**: `actions.js` - Action loading and execution system
- **Utilities**: `utils.js` - Utility functions (like shortenToolId)
- **Configuration**: `config.js` - Loads environment variables for API keys, model settings, and admin configuration
- **Database**: PGlite database (`./pgdata/root`) with two tables:
  - `chats` - Tracks chat IDs, enabled/disabled status, and custom system prompts
  - `messages` - Stores conversation history for context
- **Actions system**: Modular action files in `actions/` directory:
  - `runJavascript.js` - JavaScript code execution
  - `newConversation.js` - Clear chat history
  - `enableChat.js` / `disableChat.js` - Master chat controls
  - `getSystemPrompt.js` / `setSystemPrompt.js` - System prompt management (admin)
  - `showInfo.js` - Display chat information

### Key Architecture Patterns
- **WhatsApp Integration**: Uses `@whiskeysockets/baileys` library with multi-file auth state storage
- **LLM Integration**: OpenAI-compatible API client (supports custom base URLs) with function calling
- **Database**: PGlite (PostgreSQL in WebAssembly) for modern SQL support with persistence
- **JavaScript Execution**: Uses `Function()` constructor to execute user code with full access to action context
- **Permission System**: Two-tier system with master and admin permissions
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
- Conversation history maintained per chat with 50-message context window

### Permission System
The bot has two permission levels:
- **`requireRoot`**: Requires sender ID to be in comma-separated `MASTER_ID` environment variable
  - Used for: enable/disable chat commands
- **`requireAdmin`**: Requires user to be admin/superadmin in group chats, or any user in private chats
  - Used for: get/set system prompt commands

## Common Development Commands

### Running the Bot
```bash
npm run dev
```

### Type checking
```bash
npm run type-check
```

### Environment Setup
Required environment variables (create `.env` file):
```bash
LLM_API_KEY=your-openai-api-key
MASTER_ID=whatsapp-id-1,whatsapp-id-2  # Comma-separated list of master user IDs
MODEL=model-name  # Model to use (e.g., gpt-4, claude-3-5-sonnet-20241022)
BASE_URL=https://api.openai.com/v1  # optional, for custom endpoints
SYSTEM_PROMPT="custom prompt"  # optional
```

### Prerequisites Installation
```bash
sudo apt install qrencode
```

### Database Management
The PGlite database is automatically created on first run in the `./pgdata/root` directory. This provides full PostgreSQL compatibility in a lightweight package.

### Authentication Storage
Baileys stores authentication state in the `./auth_info_baileys` directory using multi-file auth state for better reliability and session persistence.

## Bot Commands (for testing)
- `!js <code>` - Execute JavaScript code with database access and context
- `!new` - Clear conversation history
- `!info` - Show chat information
- `!enable [chatId]` - Enable bot in chat (requires MASTER_ID)
- `!disable [chatId]` - Disable bot in chat (requires MASTER_ID)
- `!get-prompt` - Get current system prompt for this chat (requires admin)
- `!set-prompt <prompt>` - Set custom system prompt for this chat (requires admin)

### JavaScript Execution Examples
```javascript
// Simple calculation
!js ({log}) => { log("Calculating..."); return 2 + 2; }

// Database query (using rootDb for access to chats/messages tables)
!js async ({rootDb}) => {
  const {rows: messages} = await rootDb.sql`SELECT COUNT(*) as count FROM messages`;
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

## Memories
- do not run the app

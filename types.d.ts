type PGlite = import("@electric-sql/pglite").PGlite;

// Baileys types
type BaileysMessage = import("@whiskeysockets/baileys").WAMessage;
type BaileysSocket = import("@whiskeysockets/baileys").WASocket;

type TextContentBlock = {
  type: "text";
  text: string;
};
type ImageContentBlock = {
  type: "image";
  encoding: "base64";
  mime_type: string;
  data: string;
  alt?: string;
};
type VideoContentBlock = {
  type: "video";
  encoding: "base64";
  mime_type?: string;
  data: string;
  alt?: string;
};
type AudioContentBlock = {
  type: "audio";
  encoding: "base64";
  mime_type?: string;
  data: string;
};
type QuoteContentBlock = {
  type: "quote";
  quotedSenderId?: string;
  content: IncomingContentBlock[];
};
type ToolCallContentBlock = {
  type: "tool";
  tool_id: string;
  name: string;
  arguments: string;
};

type IncomingContentBlock =
  TextContentBlock
  | ImageContentBlock
  | VideoContentBlock
  | AudioContentBlock
  | QuoteContentBlock;

type MediaRegistry = Map<number, IncomingContentBlock>;

type ContentBlock = IncomingContentBlock | ToolCallContentBlock;

  type UserMessage = {
    role: "user";
    content: IncomingContentBlock[];
  };

  type AssistantMessage = {
    role: "assistant";
    content: (TextContentBlock | ToolCallContentBlock)[];
  };

  type ToolMessage = {
    role: "tool";
    tool_id: string;
    content: (TextContentBlock | ImageContentBlock | VideoContentBlock | AudioContentBlock)[];
  };

  type Message = UserMessage | AssistantMessage | ToolMessage;

// WhatsApp Service Types
type ConfirmHooks = {
  onSent?: (msgKey: { id: string; remoteJid: string }) => Promise<void>;
  onResolved?: (msgKey: { id: string; remoteJid: string }, confirmed: boolean) => Promise<void>;
};

type IncomingContext = {
  // Message data
  chatId: string;
  senderIds: string[];
  senderName: string;
  content: IncomingContentBlock[];
  isGroup: boolean;
  timestamp: Date;
  /** The sender ID of a quoted/replied-to message, if present (without @s.whatsapp.net suffix). */
  quotedSenderId?: string;

  // High-level actions scoped to this message
  getAdminStatus: () => Promise<"admin" | "superadmin" | null>;
  sendMessage: (text: string) => Promise<void>;
  replyToMessage: (text: string) => Promise<void>;
  reactToMessage: (emoji: string) => Promise<void>;
  sendPoll: (name: string, options: string[], selectableCount?: number) => Promise<void>;
  sendImage: (image: Buffer, caption?: string) => Promise<void>;
  sendVideo: (video: Buffer, caption?: string) => Promise<void>;
  confirm: (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
  sendPresenceUpdate: (presence: "composing" | "paused") => Promise<void>;

  // Bot info
  selfIds: string[];
  selfName: string;
};

// Unified context for message handling
type Context = {
  chatId: string;
  senderIds: string[];
  content: IncomingContentBlock[];
  isDebug: boolean;
  getIsAdmin: () => Promise<boolean>;
  sendMessage: (header: string, message?: string) => Promise<void>;
  reply: (header: string, message?: string) => Promise<void>;
  reactToMessage: (emoji: string) => Promise<void>;
  sendPoll: (name: string, options: string[], selectableCount?: number) => Promise<void>;
  sendImage: (image: Buffer, caption?: string) => Promise<void>;
  sendVideo: (video: Buffer, caption?: string) => Promise<void>;
  confirm: (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
};

/* Actions */

// Context passed to actions (pre-built functions with headers baked in)
type ActionContext = {
  chatId: string;
  senderIds: string[];
  content: IncomingContentBlock[];
  getIsAdmin: () => Promise<boolean>;
  db: PGlite;
  sessionDb: PGlite;
  getActions: () => Promise<Action[]>;
  log: (...args: any[]) => Promise<string>;
  sendMessage: (message: string) => Promise<void>; // Header already baked in
  reply: (message: string) => Promise<void>; // Header already baked in
  reactToMessage: (emoji: string) => Promise<void>;
  sendPoll: (name: string, options: string[], selectableCount?: number) => Promise<void>;
  sendImage: (image: Buffer, caption?: string) => Promise<void>;
  sendVideo: (video: Buffer, caption?: string) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
  resolveModel: (role: string) => string;
};

// Define permission flags
type PermissionFlags = {
  autoExecute?: boolean;
  autoContinue?: boolean;
  silent?: boolean;
  requireAdmin?: boolean;
  requireMaster?: boolean;
  useChatDb?: boolean;
  useRootDb?: boolean;
  useLlm?: boolean;
};

// Opaque handle — only llm.js knows the concrete type (OpenAI client)
type LlmClient = { readonly __brand: "LlmClient" };

// Normalized LLM chat response (replaces OpenAI ChatCompletion)
type LlmChatResponse = {
  content: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cost?: number;
  };
};

// Replaces OpenAI ChatCompletionTool
type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Action['parameters'] };
};

type CallLlmOptions = { model?: string };
type CallLlmPrompt = string | ContentBlock[];

type CallLlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[] | null;
  tool_calls?: Array<{id: string, type: "function", function: {name: string, arguments: string}}>;
  tool_call_id?: string;
};

type CallLlmChatOptions = CallLlmOptions & {
  messages: CallLlmMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none";
};

type CallLlm = {
  (prompt: CallLlmPrompt, options?: CallLlmOptions): Promise<string | null>;
  (options: CallLlmChatOptions): Promise<LlmChatResponse>;
};

// Build action context types dynamically based on permissions
type ExtendedActionContext<P extends PermissionFlags> = ActionContext
  & (P["useRootDb"] extends true ? { rootDb: PGlite } : {})
  & (P["useChatDb"] extends true ? { chatDb: PGlite } : {})
  & (P["useLlm"] extends true ? { callLlm: CallLlm; llmClient: LlmClient } : {});

type ToolContentBlock = TextContentBlock | ImageContentBlock | VideoContentBlock | AudioContentBlock;

type HtmlContent = { __brand: "html"; html: string; title?: string };

/** The payload types that an action can produce. */
type ActionResultValue = string | {} | HtmlContent | ToolContentBlock[];

/**
 * Unified action return type. Actions that need to override autoContinue set the field;
 * otherwise it inherits from the action's permissions.
 * For backward compat, action_fn may still return a bare ActionResultValue;
 * executeAction normalizes it into this shape.
 */
type ActionResult = {
  result: ActionResultValue;
  autoContinue?: boolean;
};

type Action<P extends PermissionFlags = PermissionFlags> = {
  name: string;
  command?: string; // Optional command for direct execution
  description: string;
  /** Detailed usage instructions injected into the system prompt only after the action is first called in a turn. */
  instructions?: string;
  scope?: "chat" | "global";
  optIn?: true; // When true, action is only available in chats that explicitly enable it
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  }; // a JSON-Schema for the action_fn's parameters
  permissions: P;
  action_fn: (
    context: ExtendedActionContext<P>,
    params: any,
  ) => Promise<ActionResult | ActionResultValue> | ActionResult | ActionResultValue;
  /** Returns a short display string appended after the action name in compact mode. */
  formatToolCall?: (params: Record<string, any>) => string;
  /** Returns the prompt string used by this action. Swappable for testing/optimization. */
  prompt?: (...args: any[]) => string;
};

type AppAction = Action & {
  fileName: string;
  app_name: string;
};

type App = {
  app_name: string;
  name: string;
  description: string;
  actions: AppAction[];
  setup_fn: (() => Promise<any>)[];
};

function defineAction<P extends PermissionFlags>(action: Action<P>): Action<P> {
  return action;
}

declare function html(content: string, title?: string): HtmlContent;
declare function isHtmlContent(value: unknown): value is HtmlContent;

/* Test callback types — used by _tests.js and _test-prompts.js */

/** Full action context with all permission extensions enabled. */
type FullActionContext = ActionContext & { rootDb: PGlite; chatDb: PGlite; callLlm: CallLlm; llmClient: LlmClient };

/** action_fn as seen by tests — accepts partial context (duck typing). */
type TestActionFn = (
  context: Partial<FullActionContext>,
  params: Record<string, string | number | boolean | null>,
) => Promise<string> | string;

/** Standard _tests.js callback: receives action_fn only. */
type ActionTestFn = (action_fn: TestActionFn) => Promise<void>;

/** Standard _tests.js callback: receives action_fn + db. */
type ActionDbTestFn = (action_fn: TestActionFn, db: PGlite) => Promise<void>;

/** Prompt test callback: receives callLlm + readFixture + prompt. */
type PromptTestFn = (
  callLlm: CallLlm,
  readFixture: (name: string) => Promise<Buffer>,
  prompt: (...args: string[]) => string,
) => Promise<void>;

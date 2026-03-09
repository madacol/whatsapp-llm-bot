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
type CodeContentBlock = {
  type: "code";
  language?: string;
  code: string;
  caption?: string;
};

type DiffContentBlock = {
  type: "diff";
  language?: string;
  oldStr: string;
  newStr: string;
  caption?: string;
};

/**
 * OpenAI SDK doesn't include video_url in ChatCompletionContentPart.
 * This fills the gap so we avoid `@type {*}` escape hatches.
 */
type VideoUrlContentPart = {
  type: "video_url";
  video_url: { url: string };
};
type MarkdownContentBlock = {
  type: "markdown";
  text: string;
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
    content: ToolContentBlock[];
  };

  type Message = UserMessage | AssistantMessage | ToolMessage;

  type SystemMessage = {
    role: "system";
    content: string;
  };

  type ChatMessage = SystemMessage | Message;

type MessageSource = "llm" | "tool-call" | "tool-result" | "error" | "warning" | "usage" | "memory";

// WhatsApp Service Types

/** Edits a previously sent text message in-place. */
type MessageEditor = (newText: string) => Promise<void>;

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
  getIsAdmin: () => Promise<boolean>;
  reactToMessage: (emoji: string) => Promise<void>;
  sendPoll: (name: string, options: string[], selectableCount?: number) => Promise<void>;
  send: (source: MessageSource, content: SendContent) => Promise<MessageEditor | undefined>;
  reply: (source: MessageSource, content: SendContent) => Promise<MessageEditor | undefined>;
  confirm: (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
  sendPresenceUpdate: (presence: "composing" | "paused") => Promise<void>;

  // Bot info
  selfIds: string[];
  selfName: string;
};

// Unified context for message handling
type ExecuteActionContext = {
  chatId: string;
  senderIds: string[];
  content: IncomingContentBlock[];
  getIsAdmin: () => Promise<boolean>;
  send: (source: MessageSource, content: SendContent) => Promise<MessageEditor | undefined>;
  reply: (source: MessageSource, content: SendContent) => Promise<MessageEditor | undefined>;
  reactToMessage: (emoji: string) => Promise<void>;
  sendPoll: (name: string, options: string[], selectableCount?: number) => Promise<void>;
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
  send: (message: SendContent) => Promise<void>; // Header already baked in
  reply: (message: SendContent) => Promise<void>; // Header already baked in
  reactToMessage: (emoji: string) => Promise<void>;
  sendPoll: (name: string, options: string[], selectableCount?: number) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
  resolveModel: (role: string) => string;
  agentDepth?: number;
  toolCallId?: string | null;
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

type CallLlmChatOptions = CallLlmOptions & {
  messages: ChatMessage[];
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

type ToolContentBlock = TextContentBlock | ImageContentBlock | VideoContentBlock | AudioContentBlock | CodeContentBlock | DiffContentBlock | MarkdownContentBlock;

type SendContent = string | ToolContentBlock | ToolContentBlock[];

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

/* Agent types */

type AgentIOHooks = {
  onLlmResponse?: (text: string) => Promise<void>;
  /** Present a structured question to the user and wait for their response. Returns the chosen option text. */
  onAskUser?: (question: string, options: string[], preamble?: string) => Promise<string>;
  onToolCall?: (toolCall: LlmChatResponse['toolCalls'][0], formatToolCall?: (params: Record<string, any>) => string) => Promise<MessageEditor | void>;
  onToolResult?: (blocks: ToolContentBlock[], toolName: string, permissions: PermissionFlags) => Promise<void>;
  onToolError?: (error: string) => Promise<void>;
  onContinuePrompt?: () => Promise<boolean>;
  onDepthLimit?: () => Promise<boolean>;
  onUsage?: (cost: string, tokens: { prompt: number; completion: number; cached: number }) => Promise<void>;
};

type AgentResult = {
  response: ToolContentBlock[];
  messages: Message[];
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number; cost: number };
};

type AgentDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  allowedActions?: string[];
  maxDepth?: number;
  instructions?: string;
  harness?: string;
};

type AppAgent = AgentDefinition & { fileName: string };

/* Harness types */

type AgentHarnessParams = {
  session: Session;
  llmConfig: LlmConfig;
  messages: Message[];
  mediaRegistry: MediaRegistry;
  hooks?: AgentIOHooks;
  maxDepth?: number;
  agentDepth?: number;
  cwd?: string;
};

type AgentHarness = {
  processLlmResponse: (params: AgentHarnessParams) => Promise<AgentResult>;
  /** Inject a follow-up user message into an active query for this chat. Returns true if injected. */
  injectMessage?: (chatId: string, text: string) => boolean;
  /** Cancel the active query for this chat. Returns true if cancelled. */
  cancel?: (chatId: string) => boolean;
};

/* processLlmResponse types */

type ExecuteActionOptions = {
  toolCallId?: string | null;
  actionResolver?: (name: string) => Promise<AppAction | null>;
  llmClient?: LlmClient;
  updateToolMessage?: (chatId: string, toolCallId: string, messageData: ToolMessage) => Promise<import("./store.js").MessageRow | null>;
  agentDepth?: number;
};

type Session = {
  chatId: string;
  senderIds: string[];
  context: ExecuteActionContext;
  addMessage: import("./store.js").Store['addMessage'];
  updateToolMessage: import("./store.js").Store['updateToolMessage'];
  /** Current SDK session ID for claude-agent-sdk harness session resumption. */
  sdkSessionId?: string | null;
  /** Persist the SDK session ID for future resumption. */
  updateSdkSessionId?: import("./store.js").Store['updateSdkSessionId'];
};

type LlmConfig = {
  llmClient: LlmClient;
  chatModel: string;
  systemPrompt: string;
  actions: Action[];
  executeActionFn: (actionName: string, context: ExecuteActionContext, params: {}, options?: ExecuteActionOptions) => Promise<{result: ActionResultValue, permissions: Action['permissions']}>;
  actionResolver: (name: string) => Promise<AppAction | null>;
  actionLlmClient: LlmClient;
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

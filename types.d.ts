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
  /** Delivery quality hint. "hd" asks the adapter to send with full
   *  dual-upload so the receiver's client shows the HD badge. */
  quality?: "standard" | "hd";
  /**
   * Serializable HD download ref. Set when HD child arrives.
   * - `null` means "HD is expected but hasn't arrived yet"
   * - `undefined` (absent) means "no HD version exists"
   * - `{ ... }` means "HD ref available, can download"
   */
  _hdRef?: { url?: string; directPath?: string; mediaKey: string; mimetype?: string } | null;
  /** Parent SD message ID used to match later HD child upgrades. */
  _hdParentMessageId?: string;
  /** Runtime-only deferred promise for HD version. Not serialized. */
  getHd?: Promise<ImageContentBlock | null>;
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

/** Callback invoked when a reaction is added to a message. */
type ReactionCallback = (emoji: string, senderId: string) => void;

/** Handle to a sent message, providing lifecycle control (edit, reaction subscription). */
type MessageHandle = {
  readonly keyId: string | undefined;
  readonly isImage: boolean;
  edit: (text: string) => Promise<void>;
  onReaction: (callback: ReactionCallback) => () => void;
};

/** An option for `select()`: either a plain string or an object with id and label. */
type SelectOption = string | { id: string; label: string };

type SelectConfig = {
  /** Timeout in ms (default: 5 minutes). */
  timeout?: number;
  /** Delete the poll message after the user selects a non-cancel option. */
  deleteOnSelect?: boolean;
  /** Option IDs treated as cancellation — poll is reacted with ❌ instead of deleted/cleared. */
  cancelIds?: string[];
  /** If set, the option with this id gets a ✅ prefix to highlight the current value. */
  currentId?: string;
};

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
  select: (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
  send: (source: MessageSource, content: SendContent) => Promise<MessageHandle | undefined>;
  reply: (source: MessageSource, content: SendContent) => Promise<MessageHandle | undefined>;
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
  send: (source: MessageSource, content: SendContent) => Promise<MessageHandle | undefined>;
  reply: (source: MessageSource, content: SendContent) => Promise<MessageHandle | undefined>;
  reactToMessage: (emoji: string) => Promise<void>;
  select: (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
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
  select: (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
  confirm: (message: string) => Promise<boolean>;
  resolveModel: (role: string) => string;
  agentDepth?: number;
  toolCallId?: string | null;
};

// Define permission flags
type PermissionFlags = {
  autoExecute?: boolean;
  autoContinue?: boolean;
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
  /** Signal that the bot is working (e.g. WhatsApp "composing" presence). Fire-and-forget. */
  onComposing?: () => Promise<void>;
  onLlmResponse?: (text: string) => Promise<void>;
  /** Present a structured question to the user and wait for their response. Returns the chosen option text. */
  onAskUser?: (question: string, options: string[], preamble?: string, descriptions?: string[]) => Promise<string>;
  onToolCall?: (toolCall: LlmChatResponse['toolCalls'][0], formatToolCall?: (params: Record<string, any>) => string, context?: { oldContent?: string }) => Promise<MessageHandle | void>;
  onToolResult?: (blocks: ToolContentBlock[], toolName: string, permissions: PermissionFlags) => Promise<void>;
  onToolError?: (error: string) => Promise<void>;
  onContinuePrompt?: () => Promise<boolean>;
  onDepthLimit?: () => Promise<boolean>;
  onUsage?: (cost: string, tokens: { prompt: number; completion: number; cached: number }) => Promise<void>;
};

type HarnessSessionRef = {
  id: string;
  kind: "native" | "claude-sdk" | "codex";
};

type HarnessCapabilities = {
  supportsResume: boolean;
  supportsCancel: boolean;
  supportsLiveInput: boolean;
  supportsApprovals: boolean;
  supportsWorkdir: boolean;
  supportsSandboxConfig: boolean;
  supportsModelSelection: boolean;
  supportsReasoningEffort: boolean;
  supportsSessionFork: boolean;
};

type HarnessUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
};

type AgentResult = {
  response: ToolContentBlock[];
  messages: Message[];
  usage: HarnessUsage;
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

type HarnessRunConfig = {
  workdir?: string | null;
  model?: string | null;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | null;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never' | null;
};

type HarnessSessionHistoryEntry = {
  id: string;
  kind: HarnessSessionRef["kind"];
  cleared_at: string;
};

type AgentHarnessParams = {
  session: Session;
  llmConfig: LlmConfig;
  messages: Message[];
  mediaRegistry: MediaRegistry;
  hooks?: AgentIOHooks;
  maxDepth?: number;
  agentDepth?: number;
  /** @deprecated Use runConfig.workdir instead. */
  cwd?: string;
  /** @deprecated Use runConfig.model instead. */
  sdkModel?: string;
  /** @deprecated Use runConfig.reasoningEffort instead. */
  sdkEffort?: 'low' | 'medium' | 'high' | 'max';
  runConfig?: HarnessRunConfig;
};

type HarnessCommandContext = {
  chatId: string;
  chatInfo?: import("./store.js").ChatRow;
  context: ExecuteActionContext;
  command: string;
};

type AgentHarness = {
  getName: () => string;
  getCapabilities: () => HarnessCapabilities;
  run: (params: AgentHarnessParams) => Promise<AgentResult>;
  handleCommand: (input: HarnessCommandContext) => Promise<boolean>;
  /** Inject a follow-up user message into an active query for this chat. Returns true if injected. */
  injectMessage?: (chatId: string | HarnessSessionRef, text: string) => boolean | Promise<boolean>;
  /** Cancel the active query for this chat. Returns true if cancelled. */
  cancel?: (chatId: string | HarnessSessionRef) => boolean | Promise<boolean>;
  /** Wait for all active queries to finish. Returns chat IDs that were waited on. */
  waitForIdle?: () => Promise<string[]>;
};

/**
 * SDK BetaMessage.usage extended with cache fields from the Anthropic API.
 * The SDK's type definition doesn't include these, but the API returns them.
 */
type SdkUsageWithCache = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/* processLlmResponse types */

type ExecuteActionOptions = {
  toolCallId?: string | null;
  actionResolver?: (name: string) => Promise<AppAction | null>;
  llmClient?: LlmClient;
  agentDepth?: number;
};

type Session = {
  chatId: string;
  senderIds: string[];
  context: ExecuteActionContext;
  addMessage: import("./store.js").Store['addMessage'];
  updateToolMessage: import("./store.js").Store['updateToolMessage'];
  harnessSession?: HarnessSessionRef | null;
  saveHarnessSession?: import("./store.js").Store['saveHarnessSession'];
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
type ActionParamValue = string | number | boolean | null | IncomingContentBlock | IncomingContentBlock[];

/** action_fn as seen by tests — accepts partial context (duck typing). */
type TestActionFn = (
  context: Partial<FullActionContext>,
  params: Record<string, ActionParamValue>,
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

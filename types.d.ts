type PGlite = import("@electric-sql/pglite").PGlite;

// Baileys types
type BaileysMessage = import("@whiskeysockets/baileys").WAMessage;
type BaileysSocket = import("@whiskeysockets/baileys").WASocket;

type TextContentBlock = {
  type: "text";
  text: string;
};

type StoredMediaFields = {
  path: string;
  sha256?: string;
};

type InlineMediaFields = {
  encoding: "base64";
  data: string;
};

type ImageContentBlock = {
  type: "image";
  mime_type: string;
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
} & (StoredMediaFields | InlineMediaFields);
type VideoContentBlock = {
  type: "video";
  mime_type?: string;
  alt?: string;
} & (StoredMediaFields | InlineMediaFields);
type AudioContentBlock = {
  type: "audio";
  mime_type?: string;
} & (StoredMediaFields | InlineMediaFields);
type FileContentBlock = {
  type: "file";
  mime_type?: string;
  file_name?: string;
  caption?: string;
} & (StoredMediaFields | InlineMediaFields);
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
  diffText?: string;
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
  | FileContentBlock
  | QuoteContentBlock;

type MediaRegistry = Map<string, IncomingContentBlock>;

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

type MessageSource = "llm" | "tool-call" | "tool-result" | "error" | "warning" | "usage" | "memory" | "plain";

// WhatsApp Service Types

/** Callback invoked when a reaction is added to a message. */
type ReactionCallback = (emoji: string, senderId: string) => void;

type ToolFlowStep = {
  id: string;
  presentation: import("./tool-presentation-model.js").ToolPresentation;
  output?: string;
};

type ToolFlowState = {
  title: string;
  steps: ToolFlowStep[];
};

type ContentEvent = {
  kind: "content";
  source: MessageSource;
  content: SendContent;
};

type ToolCallEvent = {
  kind: "tool_call";
  presentation: import("./tool-presentation-model.js").ToolPresentation;
};

type ToolActivityEvent = {
  kind: "tool_activity";
  activity: import("./tool-presentation-model.js").ToolActivitySummary;
};

type PlanEvent = {
  kind: "plan";
  presentation: import("./plan-presentation.js").PlanPresentation;
};

type FileChangeEvent = {
  kind: "file_change";
  path: string;
  summary?: string;
  diff?: string;
  changeKind?: "add" | "delete" | "update";
  oldText?: string;
  newText?: string;
  cwd?: string | null;
};

type UsageEvent = {
  kind: "usage";
  cost: string;
  tokens: {
    prompt: number;
    completion: number;
    cached: number;
  };
};

type OutboundEvent =
  | ContentEvent
  | ToolCallEvent
  | ToolActivityEvent
  | PlanEvent
  | FileChangeEvent
  | UsageEvent;

type MessageHandleUpdate =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; presentation: import("./tool-presentation-model.js").ToolPresentation }
  | { kind: "tool_flow"; state: ToolFlowState };

type MessageInspectState =
  | { kind: "tool"; presentation: import("./tool-presentation-model.js").ToolPresentation; output?: string }
  | { kind: "tool_flow"; state: ToolFlowState }
  | { kind: "text"; text: string; persistOnInspect?: boolean }
  | { kind: "reasoning"; summary: string; text: string };

/** Handle to a sent message, providing semantic lifecycle control. */
type MessageHandle = {
  readonly keyId: string | undefined;
  readonly isImage: boolean;
  update: (update: MessageHandleUpdate) => Promise<void>;
  setInspect: (inspect: MessageInspectState | null) => void;
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

type SelectManyConfig = {
  /** Timeout in ms (default: 5 minutes). */
  timeout?: number;
  /** Delete the poll message after the user selects a non-cancel option. */
  deleteOnSelect?: boolean;
  /** Option IDs treated as cancellation — poll is reacted with ❌ instead of deleted/cleared. */
  cancelIds?: string[];
  /** If set, options with these ids get a ✅ prefix to highlight current values. */
  currentIds?: string[];
};

type SelectManyResult =
  | { kind: "selected"; ids: string[] }
  | { kind: "unchanged" }
  | { kind: "cancelled" };

type ConfirmHooks = {
  onSent?: (msgKey: { id: string; remoteJid: string }) => Promise<void>;
  onResolved?: (msgKey: { id: string; remoteJid: string }, confirmed: boolean) => Promise<void>;
};

type TurnIO = {
  send: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  reply: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  select: (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
  selectMany?: (question: string, options: SelectOption[], config?: SelectManyConfig) => Promise<SelectManyResult>;
  confirm: (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
  react: (emoji: string) => Promise<void>;
  startPresence: (ttlMs: number) => Promise<void>;
  keepPresenceAlive: (ttlMs?: number) => Promise<void>;
  endPresence: () => Promise<void>;
  getIsAdmin: () => Promise<boolean>;
};

type WorkspaceStatus = "ready" | "busy" | "conflicted" | "archived";
type WhatsAppProjectTopologyKind = "groups" | "community";
type WhatsAppWorkspacePresentationRole = "workspace" | "main";

type ProjectRow = {
  project_id: string;
  name: string;
  root_path: string;
  default_base_branch: string;
  control_chat_id: string | null;
  timestamp: string;
};

type WorkspaceRow = {
  workspace_id: string;
  project_id: string;
  name: string;
  branch: string;
  base_branch: string;
  worktree_path: string;
  status: WorkspaceStatus;
  last_test_status: "not_run" | "passed" | "failed";
  last_commit_oid: string | null;
  conflicted_files: string[];
  archived_at: string | null;
  timestamp: string;
};

type ChatBindingKind = "project" | "workspace";

type ChatBindingRow = {
  chat_id: string;
  binding_kind: ChatBindingKind;
  project_id: string | null;
  workspace_id: string | null;
  timestamp: string;
};

type WhatsAppProjectPresentationCacheRow = {
  project_id: string;
  cached_topology_kind: WhatsAppProjectTopologyKind;
  cached_community_chat_id: string | null;
  cached_main_workspace_id: string | null;
  timestamp: string;
};

type WhatsAppProjectPresentationCacheView = {
  projectId: string;
  topologyKind: WhatsAppProjectTopologyKind;
  communityChatId: string | null;
  mainWorkspaceId: string | null;
  timestamp: string;
};

type WhatsAppWorkspacePresentationRow = {
  workspace_id: string;
  project_id: string;
  workspace_chat_id: string;
  workspace_chat_subject: string;
  role: WhatsAppWorkspacePresentationRole;
  linked_community_chat_id: string | null;
  timestamp: string;
};

type ResolvedChatBinding =
  | { kind: "unbound" }
  | { kind: "project"; project: ProjectRow }
  | { kind: "workspace"; project: ProjectRow; workspace: WorkspaceRow };

type TurnFacts = {
  isGroup: boolean;
  addressedToBot: boolean;
  repliedToBot: boolean;
  quotedSenderId?: string;
};

type ChatTransport = {
  start: (onTurn: (turn: ChatTurn) => Promise<void>) => Promise<void>;
  stop: () => Promise<void>;
  sendText: (chatId: string, text: string) => Promise<void>;
  sendEvent?: (chatId: string, event: OutboundEvent) => Promise<MessageHandle | undefined>;
  createGroup?: (subject: string, participants: string[]) => Promise<{ chatId: string, subject: string }>;
  createCommunity?: (subject: string, description: string) => Promise<{ chatId: string, subject: string }>;
  createCommunityGroup?: (
    subject: string,
    participants: string[],
    parentCommunityChatId: string,
  ) => Promise<{ chatId: string, subject: string }>;
  getGroupLinkedParent?: (chatId: string) => Promise<string | null>;
  linkExistingGroupToCommunity?: (chatId: string, communityChatId: string) => Promise<void>;
  promoteParticipants?: (chatId: string, participants: string[]) => Promise<void>;
  renameGroup?: (chatId: string, subject: string) => Promise<void>;
  setAnnouncementOnly?: (chatId: string, enabled: boolean) => Promise<void>;
};

type WorkspacePresentationPort = {
  ensureWorkspaceVisible: (input: {
    projectId: string;
    workspaceId: string;
    workspaceName: string;
    sourceChatName?: string;
    sourceChatId?: string;
    requesterJids: string[];
  }) => Promise<{ surfaceId: string; surfaceName: string }>;
  presentWorkspaceBootstrap: (input: {
    workspaceId: string;
    statusText: string;
  }) => Promise<void>;
  presentSeedPrompt: (input: {
    workspaceId: string;
    promptText: string;
  }) => Promise<void>;
  getWorkspaceSurface: (input: {
    workspaceId: string;
  }) => Promise<{ surfaceId: string; surfaceName: string }>;
  sendWorkspaceEvent: (input: {
    workspaceId: string;
    event: OutboundEvent;
  }) => Promise<MessageHandle | undefined>;
  archiveWorkspaceSurface: (input: {
    workspaceId: string;
  }) => Promise<void>;
};

type ChatTurn = {
  chatId: string;
  senderIds: string[];
  senderJids?: string[];
  senderName: string;
  chatName?: string;
  content: IncomingContentBlock[];
  timestamp: Date;
  facts: TurnFacts;
  io: TurnIO;
};

// Unified context for message handling
type ExecuteActionContext = {
  chatId: string;
  chatName?: string;
  senderIds: string[];
  senderJids?: string[];
  content: IncomingContentBlock[];
  getIsAdmin: () => Promise<boolean>;
  send: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  reply: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  reactToMessage: (emoji: string) => Promise<void>;
  select: (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
  selectMany?: (question: string, options: SelectOption[], config?: SelectManyConfig) => Promise<SelectManyResult>;
  confirm: (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
};

/* Actions */

// Context passed to actions (pre-built functions with headers baked in)
type ActionContext = {
  chatId: string;
  senderIds: string[];
  content: IncomingContentBlock[];
  workdir?: string | null;
  getIsAdmin: () => Promise<boolean>;
  db: PGlite;
  sessionDb: PGlite;
  getActions: () => Promise<Action[]>;
  log: (...args: any[]) => Promise<string>;
  send: (message: SendContent) => Promise<void>; // Header already baked in
  reply: (message: SendContent) => Promise<void>; // Header already baked in
  reactToMessage: (emoji: string) => Promise<void>;
  select: (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
  selectMany?: (question: string, options: SelectOption[], config?: SelectManyConfig) => Promise<SelectManyResult>;
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

type ToolContentBlock = TextContentBlock | ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock | CodeContentBlock | DiffContentBlock | MarkdownContentBlock;

type SendContent = string | ToolContentBlock | ToolContentBlock[];

type HtmlContent = { __brand: "html"; html: string; title?: string };

type SharedSkill = {
  name: string;
  description?: string;
  instructions: string;
};

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
  /** Optional shared skill metadata for non-native harness exposure. */
  sharedSkill?: SharedSkill;
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

type ToolDescriptor = {
  name: string;
  description: string;
  instructions?: string;
  sharedSkill?: SharedSkill;
  scope?: "chat" | "global";
  parameters: Action["parameters"];
  permissions: PermissionFlags;
  formatToolCall?: (params: Record<string, any>) => string;
};

/* Agent types */

type AgentIOHooks = {
  /** Signal that the bot is working (e.g. WhatsApp "composing" presence). Fire-and-forget. */
  onComposing?: () => Promise<void>;
  /** Signal that the bot stopped working (e.g. WhatsApp "paused" presence). Fire-and-forget. */
  onPaused?: () => Promise<void>;
  onReasoning?: (event: {
    status: "started" | "updated" | "completed",
    itemId?: string,
    summaryParts: string[],
    contentParts: string[],
    text?: string,
    hasEncryptedContent?: boolean,
  }) => Promise<void>;
  onLlmResponse?: (text: string) => Promise<void>;
  /** Present a structured question to the user and wait for their response. Returns the chosen option text. */
  onAskUser?: (question: string, options: string[], preamble?: string, descriptions?: string[]) => Promise<string>;
  onToolCall?: (toolCall: LlmChatResponse['toolCalls'][0], formatToolCall?: (params: Record<string, any>) => string, context?: { oldContent?: string }) => Promise<MessageHandle | void>;
  onToolResult?: (blocks: ToolContentBlock[], toolName: string, permissions: PermissionFlags) => Promise<void>;
  onToolError?: (error: string) => Promise<void>;
  onCommand?: (event: { command: string, status: "started" | "completed" | "failed", output?: string }) => Promise<MessageHandle | void>;
  onPlan?: (presentation: import("./plan-presentation.js").PlanPresentation) => Promise<void>;
  onFileRead?: (event: { command: string, paths: string[] }) => Promise<void>;
  onFileChange?: (event: {
    path: string,
    summary?: string,
    diff?: string,
    kind?: "add" | "delete" | "update",
    oldText?: string,
    newText?: string,
  }) => Promise<void>;
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
  additionalDirectories?: string[] | null;
};

type HarnessSessionHistoryEntry = {
  id: string;
  kind: HarnessSessionRef["kind"];
  cleared_at: string;
  title: string | null;
};

type HarnessForkStackEntry = {
  id: string;
  kind: HarnessSessionRef["kind"];
  label: string | null;
};

type AgentHarnessParams = {
  session: Session;
  llmConfig: LlmConfig;
  messages: Message[];
  mediaRegistry: MediaRegistry;
  hooks?: AgentIOHooks;
  maxDepth?: number;
  agentDepth?: number;
  runConfig?: HarnessRunConfig;
};

type HarnessCommandContext = {
  chatId: string;
  chatInfo?: import("./store.js").ChatRow;
  context: ExecuteActionContext;
  command: string;
  sessionControl?: {
    archive: import("./store.js").Store['archiveHarnessSession'];
    getHistory: import("./store.js").Store['getHarnessSessionHistory'];
    restore: import("./store.js").Store['restoreHarnessSession'];
  };
  sessionForkControl?: {
    save: import("./store.js").Store['saveHarnessSession'];
    push: import("./store.js").Store['pushHarnessForkStack'];
    pop: import("./store.js").Store['popHarnessForkStack'];
  };
};

type SlashCommandDescriptor = {
  name: string;
  description: string;
};

type AgentHarness = {
  getName: () => string;
  getCapabilities: () => HarnessCapabilities;
  run: (params: AgentHarnessParams) => Promise<AgentResult>;
  handleCommand: (input: HarnessCommandContext) => Promise<boolean>;
  listSlashCommands: () => SlashCommandDescriptor[];
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
  workdir?: string | null;
  sandboxMode?: HarnessRunConfig["sandboxMode"] | null;
};

type ExecuteToolOptions = {
  toolCallId?: string | null;
  agentDepth?: number;
  workdir?: string | null;
  sandboxMode?: HarnessRunConfig["sandboxMode"] | null;
};

type ToolRuntime = {
  listTools: () => ToolDescriptor[];
  getTool: (name: string) => Promise<ToolDescriptor | null>;
  executeTool: (
    toolName: string,
    context: ExecuteActionContext,
    params: {},
    options?: ExecuteToolOptions,
  ) => Promise<{ result: ActionResultValue, permissions: PermissionFlags }>;
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
  externalInstructions: string;
  mediaToTextModels?: { image?: string; audio?: string; video?: string; general?: string };
  toolRuntime: ToolRuntime;
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

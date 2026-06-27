declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export class StatementSync {
    all(...values: unknown[]): Record<string, unknown>[];
    run(...values: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  }
}

type ChatDb = import("./sqlite-db.js").SqliteDb;

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
    senderName?: string;
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

type ToolActivityTitle =
  | "Read"
  | "Search"
  | "List"
  | "Plan"
  | "Web"
  | "Web search"
  | "Open"
  | "Find"
  | "Run Command"
  | "Start Agent"
  | "Message Agent"
  | "Wait For Agent"
  | "Resume Agent"
  | "Close Agent"
  | "Run Parallel"
  | "stdin";

type ToolActivitySummary = {
  title: ToolActivityTitle;
  lines: string[];
};

type ToolInspectMode =
  | "bash"
  | "read"
  | "grep"
  | "glob"
  | "plain"
  | "web_search"
  | "open_link"
  | "find_on_page";

type ToolFlowDescriptor = {
  groupKey: string;
  groupTitle: string;
  detail: string;
};

type ToolActivityPresentation = {
  kind: "activity";
  toolName: string;
  summary: string;
  activity: ToolActivitySummary;
  inspectMode: ToolInspectMode;
  flow?: ToolFlowDescriptor;
};

type BashToolPresentation = {
  kind: "bash";
  toolName: string;
  summary: string;
  command: string;
  inspectMode: ToolInspectMode;
};

type FileToolPresentation = {
  kind: "file";
  toolName: "Edit" | "Write";
  summary: string;
  filePath: string;
  oldString?: string;
  newString?: string;
  content?: string;
  oldContent?: string;
  startLine?: number;
};

type GenericToolPresentation = {
  kind: "generic";
  toolName: string;
  summary: string;
  description?: string;
  args: Record<string, unknown>;
};

type ToolPresentation =
  | ToolActivityPresentation
  | import("./plan-presentation.js").PlanPresentation
  | BashToolPresentation
  | FileToolPresentation
  | GenericToolPresentation;

type ToolFlowStep = {
  id: string;
  presentation: ToolPresentation;
  output?: string;
};

type ToolFlowState = {
  title: string;
  steps: ToolFlowStep[];
};

type AppMessageEvent = {
  kind: "app_message";
  role: "plain" | "tool_result" | "error" | "memory";
  content: SendContent;
  replyToTriggeringMessage?: boolean;
};

type AssistantOutputEvent = {
  kind: "assistant_output";
  content: SendContent;
  cwd?: string | null;
  stream?: {
    id: string;
    status: "partial" | "final";
  };
};

type AgentToolResultEvent = {
  kind: "agent_tool_result";
  content: SendContent;
  cwd?: string | null;
};

type ToolCallEvent = {
  kind: "tool_call";
  toolCall: LlmChatResponse["toolCalls"][0];
  cwd?: string | null;
  displaySummary?: string;
  context?: {
    oldContent?: string;
    startLine?: number;
  };
};

type ToolActivityEvent = {
  kind: "tool_activity";
  activity: ToolActivitySummary;
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
  source?: "tool" | "snapshot";
  itemId?: string;
  stage?: "proposed" | "denied" | "applied" | "failed";
  oldText?: string;
  newText?: string;
  cwd?: string | null;
};

type UsageEvent = {
  kind: "usage";
  cost: string;
  tokens: UsageTokens;
};

type SubagentMessageEvent = {
  kind: "subagent_message";
  text: string;
  threadId?: string;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
};

type RuntimeEventOutboundEvent = {
  kind: "runtime_event";
  event: import("./harnesses/harness-runtime-events.js").HarnessRuntimeEvent;
  cwd?: string | null;
};

type UsageTokens = {
  prompt: number;
  completion: number;
  cached: number;
  total?: number;
  reasoning?: number;
  contextWindow?: number;
};

type OutboundEvent =
  | AppMessageEvent
  | AssistantOutputEvent
  | AgentToolResultEvent
  | ToolCallEvent
  | ToolActivityEvent
  | PlanEvent
  | FileChangeEvent
  | SubagentMessageEvent
  | RuntimeEventOutboundEvent
  | UsageEvent;

type OutboundEventSink = {
  send: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  reply: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
};

type AppOutputPort = {
  replyWithToolResult: (content: SendContent) => Promise<MessageHandle | undefined>;
  replyWithError: (message: string) => Promise<MessageHandle | undefined>;
  replyWithPlain: (
    content: SendContent,
    options?: { replyToTriggeringMessage?: boolean },
  ) => Promise<MessageHandle | undefined>;
  sendPlain: (content: SendContent) => Promise<MessageHandle | undefined>;
  sendMemory: (content: SendContent) => Promise<MessageHandle | undefined>;
  replyWithFileChange: (change: Omit<FileChangeEvent, "kind">) => Promise<MessageHandle | undefined>;
};

type AgentRunOutputPort = {
  sendRuntimeEvent: (
    event: import("./harnesses/harness-runtime-events.js").HarnessRuntimeEvent,
    options?: { cwd?: string | null },
  ) => Promise<MessageHandle | undefined>;
  sendToolCall: (
    toolCall: LlmChatResponse["toolCalls"][0],
    options?: {
      cwd?: string | null;
      displaySummary?: string;
      context?: ToolCallEvent["context"];
    },
  ) => Promise<MessageHandle | undefined>;
  replyWithAssistantOutput: (
    content: SendContent,
    options?: {
      cwd?: string | null;
      stream?: AssistantOutputEvent["stream"];
    },
  ) => Promise<MessageHandle | undefined>;
  replyWithThinking: () => Promise<MessageHandle | undefined>;
  replyWithSubagentMessage: (input: {
    text: string;
    threadId?: string;
    parentThreadId?: string;
    agentNickname?: string;
    agentRole?: string;
  }) => Promise<MessageHandle | undefined>;
  sendToolResult: (
    content: SendContent,
    options?: { cwd?: string | null },
  ) => Promise<MessageHandle | undefined>;
  sendError: (message: string) => Promise<MessageHandle | undefined>;
  replyWithError: (message: string) => Promise<MessageHandle | undefined>;
  replyWithPlan: (presentation: import("./plan-presentation.js").PlanPresentation) => Promise<MessageHandle | undefined>;
  sendUsage: (cost: string, tokens: UsageTokens) => Promise<MessageHandle | undefined>;
};

type MessageHandleUpdate =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; presentation: ToolPresentation }
  | { kind: "tool_flow"; state: ToolFlowState };

type MessageInspectState =
  | { kind: "tool"; presentation: ToolPresentation; output?: string }
  | { kind: "tool_flow"; state: ToolFlowState }
  | { kind: "text"; text: string }
  | { kind: "reasoning"; summary: string; text: string };

/** Handle to a sent message, providing semantic lifecycle control. */
type MessageHandle = {
  readonly transportHandleId?: string;
  readonly messageKey?: import("@whiskeysockets/baileys").WAMessageKey;
  readonly deliveryStatus?: "sent" | "queued";
  readonly queueId?: number;
  waitUntilSent?: (options?: { timeoutMs?: number }) => Promise<MessageHandle | undefined>;
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

type ChannelInputIO = {
  send: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  reply: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  select: (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
  selectMany?: (question: string, options: SelectOption[], config?: SelectManyConfig) => Promise<SelectManyResult>;
  confirm: (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
  react: (emoji: string) => Promise<void>;
  getIsAdmin: () => Promise<boolean>;
  prepareMediaRegistry?: (input: {
    chatId: string;
    messages: Message[];
    mediaRegistry: MediaRegistry;
  }) => void | Promise<void>;
};
/** @deprecated Use ChannelInputIO for new app-owned input seams. */
type TurnIO = ChannelInputIO;

type WorkspaceStatus = "ready" | "busy" | "conflicted" | "archived";
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

type ChannelInputFacts = {
  isGroup: boolean;
  addressedToBot: boolean;
  repliedToBot: boolean;
  quotedSenderId?: string;
  quotedSenderJid?: string;
  quotedSenderName?: string;
};
/** @deprecated Use ChannelInputFacts for new app-owned input seams. */
type TurnFacts = ChannelInputFacts;

type ChatTransport = {
  start: (onInput: (input: ChannelInput) => Promise<void>) => Promise<void>;
  stop: () => Promise<void>;
  sendText: (chatId: string, text: string) => Promise<void>;
  sendEvent?: (chatId: string, event: OutboundEvent) => Promise<MessageHandle | undefined>;
  editMessage?: (input: { transportHandleId: string; text: string }) => Promise<void>;
  createGroup?: (subject: string, participants: string[]) => Promise<{ chatId: string, subject: string }>;
  createCommunity?: (subject: string, description: string) => Promise<{ chatId: string, subject: string }>;
  createCommunityGroup?: (
    subject: string,
    participants: string[],
    parentCommunityChatId: string,
  ) => Promise<{ chatId: string, subject: string }>;
  getGroupLinkedParent?: (chatId: string) => Promise<string | null>;
  getGroupParticipants?: (chatId: string) => Promise<string[]>;
  linkExistingGroupToCommunity?: (chatId: string, communityChatId: string) => Promise<void>;
  promoteParticipants?: (chatId: string, participants: string[]) => Promise<void>;
  renameGroup?: (chatId: string, subject: string) => Promise<void>;
  setAnnouncementOnly?: (chatId: string, enabled: boolean) => Promise<void>;
};

type WorkspacePresentationPort = {
  ensureWorkspaceVisible: (input: {
    projectId: string;
    projectName: string;
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

type ChannelInput = {
  channelId?: string;
  chatId: string;
  senderIds: string[];
  senderJids?: string[];
  senderName: string;
  chatName?: string;
  content: IncomingContentBlock[];
  timestamp: Date;
  facts: ChannelInputFacts;
  io: ChannelInputIO;
};
/** @deprecated Use ChannelInput for new app-owned input seams. */
type ChatTurn = ChannelInput;

// Unified context for message handling
type ExecuteActionContext = {
  channelId?: string;
  chatId: string;
  chatName?: string;
  senderIds: string[];
  senderJids?: string[];
  senderName?: string;
  quotedSenderId?: string;
  quotedSenderJid?: string;
  quotedSenderName?: string;
  content: IncomingContentBlock[];
  getIsAdmin: () => Promise<boolean>;
  send: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  reply: (event: OutboundEvent) => Promise<MessageHandle | undefined>;
  reactToMessage: (emoji: string) => Promise<void>;
  select: (question: string, options: SelectOption[], config?: SelectConfig) => Promise<string>;
  selectMany?: (question: string, options: SelectOption[], config?: SelectManyConfig) => Promise<SelectManyResult>;
  confirm: (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
  prepareMediaRegistry?: (input: {
    chatId: string;
    messages: Message[];
    mediaRegistry: MediaRegistry;
  }) => void | Promise<void>;
};

/* Tools and commands */

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
  function: { name: string; description: string; parameters: CommandParametersSchema };
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

type ToolContentBlock = TextContentBlock | ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock | CodeContentBlock | DiffContentBlock | MarkdownContentBlock;

type SendContent = string | ToolContentBlock | ToolContentBlock[];

type HtmlContent = { __brand: "html"; html: string; title?: string };

type SharedSkill = {
  name: string;
  description?: string;
  instructions: string;
};

type CommandParametersSchema = {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
};

/** The payload types that a tool or command can produce. */
type ToolResultValue = string | {} | HtmlContent | ToolContentBlock[];

type ToolDescriptor = {
  name: string;
  description: string;
  instructions?: string;
  sharedSkill?: SharedSkill;
  scope?: "chat" | "global";
  parameters: CommandParametersSchema;
  permissions: PermissionFlags;
  formatToolCall?: (params: Record<string, any>) => string;
};

/* Agent types */

type AgentIOHooks = {
  onReasoning?: (event: {
    status: "started" | "updated" | "completed",
    itemId?: string,
    summaryParts: string[],
    contentParts: string[],
    text?: string,
    hasEncryptedContent?: boolean,
  }) => Promise<void>;
  onLlmResponse?: (text: string, metadata?: LlmResponseMetadata) => Promise<void>;
  /** Present a structured question to the user and wait for their response. Returns the chosen option text. */
  onAskUser?: (question: string, options: string[], preamble?: string, descriptions?: string[]) => Promise<string>;
  onToolCall?: (toolCall: LlmChatResponse['toolCalls'][0], formatToolCall?: (params: Record<string, any>) => string, context?: { oldContent?: string, startLine?: number }) => Promise<MessageHandle | void>;
  onToolComplete?: (toolCall: LlmChatResponse['toolCalls'][0]) => Promise<void>;
  onToolResult?: (blocks: ToolContentBlock[], toolName: string, permissions: PermissionFlags) => Promise<void>;
  onToolError?: (error: string) => Promise<void>;
  onPlan?: (presentation: import("./plan-presentation.js").PlanPresentation) => Promise<void>;
  onFileChange?: (event: {
    path: string,
    summary?: string,
    diff?: string,
    kind?: "add" | "delete" | "update",
    source?: "tool" | "snapshot",
    itemId?: string,
    stage?: "proposed" | "denied" | "applied" | "failed",
    oldText?: string,
    newText?: string,
  }) => Promise<void>;
  onContinuePrompt?: () => Promise<boolean>;
  onDepthLimit?: () => Promise<boolean>;
  onUsage?: (cost: string, tokens: UsageTokens) => Promise<void>;
  onRuntimeEvent?: (event: import("./harnesses/harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>;
};

type LlmResponseMetadata = {
  source?: "llm" | "subagent";
  streamId?: string;
  streamStatus?: "partial" | "final";
  threadId?: string;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
};

type HarnessSessionRef = {
  id: string;
  kind: string;
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
  sessionModelSwitch?: "in-session" | "unsupported";
  supportsRollback?: boolean;
  supportsUserInputRequests?: boolean;
};

type AcpAgentDefinition = {
  name: string;
  displayName?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  docsUrl?: string;
  statusUrl?: string;
  supportsInstances?: boolean;
  sessionKind?: HarnessSessionRef["kind"];
};

type HarnessUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens?: number;
  reasoningTokens?: number;
  contextWindow?: number;
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
  maxDepth?: number;
  instructions?: string;
  harness?: string;
};

type AppAgent = AgentDefinition & { fileName: string };

/* Harness types */

type HarnessRunConfig = {
  workdir?: string | null;
  harnessInstanceId?: string | null;
  model?: string | null;
  mode?: string | null;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | null;
  approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent' | null;
  additionalDirectories?: string[] | null;
  protectedPaths?: string[] | null;
  ignoredFileChangePaths?: string[] | null;
  configValues?: Record<string, string | boolean | null>;
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

type HarnessRuntimeSession = {
  chatId: string;
  harnessName: string;
  instanceId: string;
  continuationKey: string;
  status: "starting" | "ready" | "running" | "stopped" | "error";
  workdir?: string | null;
  model?: string | null;
  resumeCursor?: string | null;
  capabilities?: HarnessCapabilities;
};

type HarnessTurnInput = {
  chatId: string;
  turnId?: string;
  input?: string;
  messages?: Message[];
  attachments?: IncomingContentBlock[];
  externalInstructions?: string;
  resumeCursor?: string | null;
  runConfig?: HarnessRunConfig;
  hooks?: AgentIOHooks;
};

type HarnessAdapterCreateInput = {
  name: string;
  instanceId: string;
  continuationKey: string;
};

type HarnessAdapter = {
  startSession: (input: {
    chatId: string;
    runConfig?: HarnessRunConfig;
    resumeCursor?: string | null;
  }) => Promise<HarnessRuntimeSession>;
  sendTurn: (input: HarnessTurnInput) => Promise<AgentResult>;
  interruptTurn: (input: { chatId: string }) => Promise<boolean>;
  respondToRequest: (requestId: string, response: unknown) => Promise<boolean>;
  respondToUserInput: (requestId: string, response: unknown) => Promise<boolean>;
  injectMessage: (chatId: string | HarnessSessionRef, text: string) => Promise<boolean>;
  stopSession: (chatId: string | HarnessSessionRef) => Promise<boolean>;
  hasSession: (chatId: string | HarnessSessionRef) => boolean;
  stopAll: () => Promise<void>;
  listSessions: () => HarnessRuntimeSession[];
  rollbackThread: (sessionId: string, numTurns: number) => Promise<unknown | null>;
  streamEvents: AsyncIterable<{ type: string; provider: string } & Record<string, unknown>>;
  subscribeEvents?: (handler: (event: { type: string; provider: string } & Record<string, unknown>) => void | Promise<void>) => () => void;
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
    clearRuntime?: (chatId: string) => Promise<boolean> | boolean;
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
  /** List active chat/session IDs without waiting. */
  listActiveSessions?: () => string[];
  /** Wait for all active queries to finish. Returns chat IDs that were waited on. */
  waitForIdle?: () => Promise<string[]>;
  /** Required for chat-visible provider turns; missing adapters make the driver unavailable. */
  createAdapter?: (input: HarnessAdapterCreateInput) => HarnessAdapter;
  /** Optional lifecycle cleanup for instance-owned resources. */
  dispose?: () => void | Promise<void>;
  /** Optional provider-backed text generation helpers. */
  textGeneration?: {
    generateSessionTitle?: (input: {
      transcript: string;
      messages: Message[];
      chatInfo?: import("./store.js").ChatRow;
    }) => string | null | { title?: string | null } | Promise<string | null | { title?: string | null }>;
  };
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

/* Harness turn support types */

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
  ) => Promise<{ result: ToolResultValue, permissions: PermissionFlags, afterResponse?: (input?: { handle?: MessageHandle }) => void | Promise<void> }>;
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

declare function html(content: string, title?: string): HtmlContent;
declare function isHtmlContent(value: unknown): value is HtmlContent;

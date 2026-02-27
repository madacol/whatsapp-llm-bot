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
  confirm: (message: string) => Promise<boolean>;

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
  confirm: (message: string) => Promise<boolean>;
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
  tools?: import("openai").default.Chat.Completions.ChatCompletionTool[];
  tool_choice?: "auto" | "none";
};

type CallLlm = {
  (prompt: CallLlmPrompt, options?: CallLlmOptions): Promise<string | null>;
  (options: CallLlmChatOptions): Promise<import("openai").default.Chat.Completions.ChatCompletion>;
};

// Build action context types dynamically based on permissions
type ExtendedActionContext<P extends PermissionFlags> = ActionContext
  & (P["useRootDb"] extends true ? { rootDb: PGlite } : {})
  & (P["useChatDb"] extends true ? { chatDb: PGlite } : {})
  & (P["useLlm"] extends true ? { callLlm: CallLlm; llmClient: import("openai").default } : {});

type ToolContentBlock = TextContentBlock | ImageContentBlock | VideoContentBlock | AudioContentBlock;

type HtmlContent = { __brand: "html"; html: string; title?: string };

type ActionResult = string | {} | HtmlContent;

type ActionSignal = {
  result: ActionResult | ToolContentBlock[];
  autoContinue: boolean;
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
  ) => Promise<ActionResult> | ActionResult;
  test_functions: Array<
    (
      action_fn: (context: any, params: any) => Promise<any> | any,
      db: PGlite,
    ) => Promise<void>
  >;
  /** Returns the prompt string used by this action. Swappable for testing/optimization. */
  prompt?: (...args: any[]) => string;
  /** Optional prompt tests — run only via `npm run test:prompts`, never in `npm test`. */
  test_prompts?: Array<
    (callLlm: CallLlm, readFixture: (name: string) => Promise<Buffer>, prompt: (...args: any[]) => string) => Promise<void>
  >;
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

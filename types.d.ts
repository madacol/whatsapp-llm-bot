type PGlite = import("@electric-sql/pglite").PGlite;

// Baileys types
type BaileysMessage = import("@whiskeysockets/baileys").proto.IWebMessageInfo;
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
  mime_type: string;
  data: string;
  alt?: string;
};
type QuoteContentBlock = {
  type: "quote";
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
    content: (TextContentBlock | ImageContentBlock | VideoContentBlock)[];
  };

  type Message = UserMessage | AssistantMessage | ToolMessage;

/* Actions */

// WhatsApp Service Types
type IncomingContext = {
  // Message data
  chatId: string;
  senderId: string;
  senderName: string;
  content: IncomingContentBlock[];
  isGroup: boolean;
  timestamp: Date;

  // High-level actions scoped to this message
  getAdminStatus: () => Promise<"admin" | "superadmin" | null>;
  sendMessage: (text: string) => Promise<void>;
  replyToMessage: (text: string) => Promise<void>;

  // Bot info
  selfId: string;
  selfName: string;

  // Raw mention data
  mentions: string[];
};

// Unified context for message handling
type Context = {
  chatId: string;
  senderId: string;
  content: IncomingContentBlock[];
  getIsAdmin: () => Promise<boolean>;
  sendMessage: (header: string, message: string) => Promise<void>;
  reply: (header: string, message: string) => Promise<void>;
};

// Context passed to actions (pre-built functions with headers baked in)
type ActionContext = {
  chatId: string;
  senderId: string;
  content: IncomingContentBlock[];
  getIsAdmin: () => Promise<boolean>;
  sessionDb: PGlite;
  getActions: () => Promise<Action[]>;
  log: (...args: any[]) => Promise<string>;
  sendMessage: (message: string) => Promise<void>; // Header already baked in
  reply: (message: string) => Promise<void>; // Header already baked in
};

// Define permission flags
type PermissionFlags = {
  autoExecute?: boolean;
  autoContinue?: boolean;
  requireAdmin?: boolean;
  requireRoot?: boolean;
  useChatDb?: boolean;
  useRootDb?: boolean;
  useFileSystem?: boolean;
};

// Build action context types dynamically based on permissions
type ExtendedActionContext<P extends PermissionFlags> = ActionContext &
  (P["useRootDb"] extends true ? { rootDb: PGlite } : {}) &
  (P["useChatDb"] extends true ? { chatDb: PGlite } : {});
// & (P['useFileSystem'] extends true ? {directoryHandle: FileSystemDirectoryHandle} : {});

type ActionResult = string | {} | HTMLElement;

type Action<P extends PermissionFlags = PermissionFlags> = {
  name: string;
  command?: string; // Optional command for direct execution
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  }; // a JSON-Schema for the action_fn's parameters
  permissions?: P;
  action_fn: (
    context: ExtendedActionContext<P>,
    params: any,
  ) => Promise<ActionResult> | ActionResult;
  test_functions?: Array<
    (
      context: ExtendedActionContext<P>,
      params: any,
    ) => Promise<boolean> | boolean
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

type PGlite = import('@electric-sql/pglite').PGlite;
type WhatsAppMessage = import("whatsapp-web.js").Message
type WhatsAppChat = import("whatsapp-web.js").Chat;

type TextContentBlock = { type: 'text', text: string, element?: HTMLDivElement }
type ToolContentBlock = { type: 'tool', id: string, name: string, input_string: string, input?: {}, element: HTMLDivElement }
type ImageContentBlock = { type: 'image', source: { type: 'base64', media_type: string, data: string } }
type ToolResultContentBlock = { type: 'tool_result', tool_use_id: string, content: (string | ContentBlock[]), is_error?: boolean }
type ContentBlock = TextContentBlock | ToolContentBlock | ImageContentBlock | ToolResultContentBlock

type Message = {role: string, content: ContentBlock[]}

/* Actions */

type MessageContext = {
    senderId: string;
    content: ContentBlock[] | string;
    isAdmin: boolean;
    reply: (message: string) => any;
}

type ChatContext = {
    chatId: string;
    sendMessage: (message: string) => any;
}

type BaseContext = {
    log: (...args: any[]) => void;
    sessionDb: PGlite;
    getActions: () => Promise<Action[]>;
    chat: ChatContext;
    message: MessageContext;
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

// Build context types dynamically based on permissions
type Context<P extends PermissionFlags> =
    BaseContext
    & (P['useRootDb'] extends true ? {rootDb: PGlite} : {})
    & (P['useChatDb'] extends true ? {chatDb: PGlite} : {})
    // & (P['useFileSystem'] extends true ? {directoryHandle: FileSystemDirectoryHandle} : {});

type ActionResult = string | {} | HTMLElement

type Action<P extends PermissionFlags = PermissionFlags> = {
    name: string;
    command?: string; // Optional command for direct execution
    description: string;
    parameters: {type: 'object', properties: Record<string, any>, required?: string[]}; // a JSON-Schema for the action_fn's parameters
    permissions?: P;
    action_fn: (context: Context<P>, params: any) => Promise<ActionResult> | ActionResult;
    test_functions?: Array<(context: Context<P>,params: any) => Promise<boolean> | boolean>;
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
    setup_fn: (()=>Promise<any>)[];
}

function defineAction<P extends PermissionFlags>(action: Action<P>): Action<P> {
    return action;
}

// Types matching Baby Jarvis patterns for WhatsApp bot

/* Actions */

type BaseContext = {
    log: (...args: any[]) => void;
    sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;
    chatId: string;
    sendMessage: import("whatsapp-web.js").Chat['sendMessage'];
}

// Define permission flags
type PermissionFlags = {
    autoExecute?: boolean;
    autoContinue?: boolean;
    requireAdmin?: boolean;
    usePersistentDb?: boolean;
    useFileSystem?: boolean;
    // Add more permissions as needed
};

// Build context types dynamically based on permissions
type Context<P extends PermissionFlags = PermissionFlags> =
    BaseContext
    & (P['usePersistentDb'] extends true ? {db: import('@electric-sql/pglite').PGlite} : {})
    & (P['useFileSystem'] extends true ? {directoryHandle: FileSystemDirectoryHandle} : {});

type ActionResult = string | {}

type Action<P extends PermissionFlags = PermissionFlags> = {
    name: string; // The name of the action
    command?: string; // Optional command for direct execution
    description: string; // Description of what the action does
    parameters: {type: 'object', properties: Record<string, any>, required?: string[]}; // a JSON-Schema for the action_fn's parameters
    permissions?: P;
    action_fn: (context: Context<P>, params: any) => Promise<ActionResult> | ActionResult;
    test_functions?: Array<(context: Context<P>,params: any) => Promise<boolean> | boolean>;
};

// AppAction with the same generic permission structure
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

type WhatsAppMessage = import("whatsapp-web.js").Message
type WhatsAppChat = import("whatsapp-web.js").Chat;
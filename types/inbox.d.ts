// Data shapes shared by the main process, the preload bridge and the window.
// This is a global declaration file (no imports/exports) so the renderer,
// which is a classic browser script, can use the types too: refer to them as
// Inbox.Thread, Inbox.Api, ...

declare namespace Inbox {
  // ---------- accounts ----------

  interface Address {
    name: string;
    address: string;
  }

  interface ServerConfig {
    host: string;
    port: number;
    secure: boolean;
  }

  type ProviderId = 'gmail' | 'yahoo' | 'icloud' | 'outlook' | 'custom';

  interface Provider {
    label: string;
    imap: ServerConfig;
    smtp: ServerConfig;
    // Store a copy of sent mail in Sent ourselves (the server doesn't).
    appendSent: boolean;
    help: string;
    helpText: string;
  }

  // An account as the window sees it (never includes the password).
  interface PublicAccount {
    id: string;
    provider: ProviderId;
    email: string;
    label: string;
    senderName: string;
    color: string;
    user?: string;
    imap?: ServerConfig;
    smtp?: ServerConfig;
    // false: no alerts (and no taskbar count) for this account.
    notify?: boolean;
    // One of the sample accounts shown until a real one is connected.
    demo?: boolean;
  }

  // The add/edit account form.
  interface AccountForm {
    id?: string;
    provider: string;
    email: string;
    pass?: string;
    label: string;
    senderName: string;
    color: string;
    user: string;
    imap: ServerConfig;
    smtp: ServerConfig;
  }

  // ---------- settings ----------

  interface Settings {
    theme: 'system' | 'light' | 'dark';
    density: 'default' | 'comfortable' | 'compact';
    inboxType: InboxType;
    sectionSize: 5 | 10 | 25 | 50;
    hideEmptySection: boolean;
    readingPane: 'none' | 'right' | 'below';
    threading: boolean;
    notifications: boolean;
    unreadBadge: boolean;
    senderPhotos: boolean;
    runInBackground: boolean;
    startWithWindows: boolean;
    trackOpens: boolean;
  }

  type InboxType = 'default' | 'important' | 'unread' | 'starred';

  // ---------- read tracking ----------

  interface TrackingConfig {
    url: string;
    configured: boolean;
  }

  interface TrackStatus {
    opens: number;
    firstOpen: string | null;
    lastOpen: string | null;
    client: string | null;
  }

  // ---------- messages and conversations ----------

  // Folder keys the window navigates by (the server's mailbox names differ per account).
  type FolderKey = 'inbox' | 'starred' | 'sent' | 'drafts' | 'spam' | 'trash' | 'all' | 'archive';

  // The part of a message used for its preview (internal to the main process).
  interface TextPartInfo {
    part: string;
    type: string;
    encoding: string;
    charset: string;
  }

  interface FileChip {
    name: string;
    type: string;
  }

  // One message in a list (no body).
  interface MessageSummary {
    accountId: string;
    // The server's mailbox path ('INBOX', '[Gmail]/Sent Mail', ...).
    folder: string;
    uid: number;
    // Which mailbox role the folder plays ('inbox', 'sent', 'trash', ...).
    role?: string | null;
    from: Address;
    to: Address[];
    subject: string;
    snippet: string;
    snippetDone?: boolean;
    date: string;
    size?: number;
    unread: boolean;
    starred: boolean;
    draft: boolean;
    inInbox?: boolean | null;
    hasAttachments: boolean;
    files: FileChip[];
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    // Gmail conversation and message ids (X-GM-THRID / X-GM-MSGID).
    threadId?: string | null;
    emailId?: string | null;
    // Importance hints: mailing-list / bulk headers, high priority, Gmail's \Important label.
    bulk?: boolean;
    priorityHigh?: boolean;
    gmImportant?: boolean | null;
    important?: boolean;
    // In a conversation: whether the message is from the folder being viewed.
    primary?: boolean;
    track?: TrackStatus | null;
    _text?: TextPartInfo | null;
  }

  // A conversation (one row of a list).
  interface Thread {
    key: string;
    accountId: string;
    folder: string;
    subject: string;
    snippet: string;
    date: string;
    unread: boolean;
    starred: boolean;
    hasAttachments: boolean;
    files: FileChip[];
    roles: string[];
    draft: boolean;
    count: number;
    messages: MessageSummary[];
    important?: boolean;
    track?: TrackStatus | null;
  }

  // "Important first" / "Unread first" / "Starred first": the section on top of the inbox.
  interface Section {
    id: Exclude<InboxType, 'default'>;
    title: string;
    threads: Thread[];
    page: number;
    pageSize: number;
    // null: "of many" (more than was looked at).
    total: number | null;
    hasMore: boolean;
  }

  interface ViewError {
    accountId: string | null;
    message: string;
  }

  interface ViewResult {
    total: number | null;
    hasMore: boolean;
    page?: number;
    pageSize?: number;
    sections: Section[];
    threads: Thread[];
    errors: ViewError[];
    // The key the view is stored under (see viewKeyOf in lib/service.ts).
    viewKey?: string;
    // Served from the local database; an up-to-date copy follows.
    stale?: boolean;
  }

  interface ViewParams {
    folder?: string;
    account?: string;
    page?: number;
    q?: string;
    threading?: boolean;
    inboxType?: InboxType;
    sectionPage?: number;
    sectionSize?: number;
    background?: boolean;
    fresh?: boolean;
  }

  interface EverythingResult {
    complete: boolean;
    threads: Thread[];
    errors: ViewError[];
  }

  interface ViewUpdate {
    key: string;
    data: ViewResult;
  }

  // Identifies one message.
  interface MessageRef {
    accountId: string;
    folder: string;
    uid: number;
  }

  // ---------- an opened message ----------

  interface AttachmentInfo {
    idx: number;
    filename: string;
    contentType: string;
    size: number;
    cid: string | null;
    related: boolean;
    // mailpart:// address the window loads it from.
    url?: string;
    // Shown inside the message (cid: image), not as an attachment.
    inline?: boolean;
  }

  interface FullMessage {
    accountId: string;
    folder: string;
    uid: number;
    subject: string;
    from: Address;
    to: Address[];
    cc: Address[];
    replyTo: Address[];
    date: string;
    html: string;
    plain: boolean;
    text: string;
    messageId: string;
    references: string[];
    attachments: AttachmentInfo[];
    starred?: boolean;
  }

  // ---------- actions ----------

  type Action = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'spam' | 'inbox' | 'trash' | 'important' | 'unimportant';

  interface ActionItem extends MessageRef {
    messageId?: string | null;
    // The sender, when the choice should apply to everything they send (importance).
    from?: string;
  }

  // Unread counts per account id.
  interface AccountCounts {
    inbox?: number;
    spam?: number;
    drafts?: number;
    error?: string;
  }
  type Counts = Record<string, AccountCounts>;

  // ---------- sending ----------

  interface Quote {
    attribution: string;
    text: string;
  }

  interface OutgoingAttachment {
    filename: string;
    contentType: string;
    data: Uint8Array;
  }

  interface OutgoingMail {
    account: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    text: string;
    quote: Quote | null;
    inReplyTo: string | null;
    references: string[] | null;
    // Forwarding: the message whose attachments go along.
    forward: MessageRef | null;
    attachments: OutgoingAttachment[];
    track: boolean;
  }

  interface SendResult {
    messageId: string;
    html: string;
    text: string;
    sentAt: string;
  }

  // ---------- IPC ----------

  interface AppState {
    demo: boolean;
    accounts: PublicAccount[];
    providers: Record<ProviderId, Provider>;
    settings: Settings;
    tracking: TrackingConfig;
  }

  interface NotifyRequest {
    title: string;
    body: string;
    // The message to open when the notification is clicked.
    ref?: string;
  }

  // Every call the window can make: name -> [argument, result].
  // main.ts implements them, preload.ts exposes them as window.api.
  interface IpcCalls {
    getState: [void, AppState];
    setTracking: [{ url: string; secret: string }, TrackingConfig];
    checkOpens: [void, number];
    avatars: [{ addresses: string[] }, Record<string, string | null>];
    listMessages: [ViewParams, ViewResult];
    listEverything: [{ folder?: string; account?: string; q?: string; threading?: boolean }, EverythingResult];
    getThread: [{ account: string; folder: string; uid: number; background?: boolean }, Thread];
    getMessage: [{ account: string; folder: string; uid: number; markSeen?: boolean }, FullMessage];
    prefetch: [{ items: MessageRef[] }, boolean];
    counts: [{ cached?: boolean } | void, Counts];
    act: [{ action: Action; items: ActionItem[] }, boolean];
    send: [OutgoingMail, SendResult];
    addAccount: [AccountForm, PublicAccount];
    updateAccount: [AccountForm, PublicAccount];
    removeAccount: [{ id: string }, boolean];
    reorderAccounts: [{ ids: string[] }, boolean];
    setAccountNotify: [{ id: string; notify: boolean }, boolean];
    setSettings: [Partial<Settings>, Settings];
    saveAttachment: [{ account: string; folder: string; uid: number; idx: number }, string | null];
    openExternal: [string, void];
    notify: [NotifyRequest, boolean];
    testNotification: [void, boolean];
    setBadge: [{ count: number; image?: string | null }, boolean];
  }

  type IpcName = keyof IpcCalls;
  type IpcArg<K extends IpcName> = IpcCalls[K][0];
  type IpcResult<K extends IpcName> = IpcCalls[K][1];

  // What every IPC handler resolves to (unwrapped by preload.ts).
  type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: string };

  // Messages the main process sends the window.
  interface ApiEvents {
    onOpenMessage(cb: (ref: string) => void): void;
    onMailto(cb: (url: string) => void): void;
    onCheckMail(cb: () => void): void;
    onViewUpdated(cb: (update: ViewUpdate) => void): void;
    onMailChanged(cb: (accountId: string) => void): void;
    onTrackingUpdated(cb: () => void): void;
  }

  // window.api, as exposed by preload.ts.
  type Api = { [K in IpcName]: (arg: IpcArg<K>) => Promise<IpcResult<K>> } & ApiEvents & { platform: string };
}

// Types used only inside the main process (the shared ones are in
// types/inbox.d.ts, as the global namespace Inbox).

// An account with its password (decrypted), as the mail backends use it.
export interface Account extends Inbox.PublicAccount {
  pass: string;
  user?: string;
  imap: Inbox.ServerConfig;
  smtp: Inbox.ServerConfig;
}

// The sample accounts have no servers or password.
export type AnyAccount = Account | DemoAccount;
export interface DemoAccount extends Inbox.PublicAccount {
  demo: true;
}

export interface ListResult {
  total: number;
  messages: Inbox.MessageSummary[];
}

export interface FlagChanges {
  seen?: boolean;
  flagged?: boolean;
}

// An attachment with its content (for saving, serving and forwarding).
export interface AttachmentContent {
  filename?: string;
  contentType: string;
  content: Buffer;
}

// What a backend sends.
export interface OutgoingMessage {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  attachments?: AttachmentContent[];
}

export type MoveTarget = 'archive' | 'spam' | 'inbox' | 'trash';

// A mail backend: lib/imap.ts for real accounts, lib/demo.ts for the sample ones.
export interface Backend<A extends Inbox.PublicAccount = Account> {
  warmUp(account: A): Promise<unknown>;
  list(account: A, folderKey: string, count: number): Promise<ListResult>;
  listFiltered(account: A, filter: string, count: number): Promise<ListResult>;
  search(account: A, query: string, count: number): Promise<ListResult>;
  related(account: A, folderKey: string | null, items: Inbox.MessageSummary[]): Promise<Inbox.MessageSummary[]>;
  threadCandidates(
    account: A,
    folder: string,
    uid: number
  ): Promise<{ target: Inbox.MessageSummary; candidates: Inbox.MessageSummary[] }>;
  fillSnippets(account: A, items: Inbox.MessageSummary[]): Promise<void>;
  get(account: A, folder: string, uid: number, opts?: { markSeen?: boolean }): Promise<Inbox.FullMessage>;
  prefetch(account: A, folder: string, uids: number[]): Promise<void>;
  attachment(account: A, folder: string, uid: number, idx: number): Promise<AttachmentContent | undefined>;
  forwardAttachments(account: A, folder: string, uid: number): Promise<AttachmentContent[]>;
  setFlags(account: A, folder: string, uids: number[], changes: FlagChanges): Promise<void>;
  setImportant(account: A, folder: string, uids: number[], important: boolean): Promise<unknown>;
  move(account: A, folder: string, uids: number[], target: MoveTarget): Promise<unknown>;
  remove(account: A, folder: string, uids: number[]): Promise<unknown>;
  counts(account: A): Promise<Inbox.AccountCounts>;
  send(account: A, mail: OutgoingMessage): Promise<string>;
  friendlyError(err: unknown, account?: A): string;
}

// A failed call carries whatever the library attached (code, responseText, ...).
export interface MailError extends Error {
  code?: string;
  responseCode?: number;
  responseText?: string;
  authenticationFailed?: boolean;
  status?: number;
}

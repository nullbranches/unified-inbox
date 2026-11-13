// IMAP/SMTP backend, built like Gmail's own clients: a local mirror of each
// mailbox (kept in ./cache.js, on disk) that is brought up to date
// incrementally, so the network is only asked "what changed?".
//
// Each account has up to three connections:
//   fg    - what the user is doing (opening mail, actions)
//   bg    - syncing, previews and prefetching
//   watch - sits in IDLE on the Inbox so new mail is pushed instantly
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, FetchOptions, FetchQueryObject, MailboxObject, MessageStructureObject, SearchObject, StatusObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { PROVIDERS } from './providers';
import * as cache from './cache';
import type { Account, AttachmentContent, FlagChanges, ListResult, MailError, MoveTarget, OutgoingMessage } from './types';

type Lane = 'fg' | 'bg' | 'watch';
type Folders = Record<string, string>; // role ('inbox', 'sent', ...) -> mailbox path

// A logged-in connection.
interface Entry {
  client: ImapFlow;
  folders: Folders;
  gmail: boolean;
  lastUsed: number;
}

// What a mailbox mirror remembers (see syncMirror).
interface MirrorRow extends Flags {
  uid: number;
}
interface Mirror {
  validity: string;
  uidNext: number;
  exists: number;
  modseq: string;
  window: number;
  rows: MirrorRow[];
}

// (as read from the server; flagsOf always fills them in, pickFlags may pass on
// a null from a mirror row stored by an older build)
interface Flags {
  unread: boolean;
  starred: boolean;
  draft: boolean;
  inInbox: boolean;
  gmImportant: boolean | null;
}

type Summary = Inbox.MessageSummary;
// The parts of a summary that never change for a UID (no flags).
type StaticSummary = Omit<Summary, keyof Flags>;

// A connection, or one still logging in.
type Slot = Partial<Entry> & { connecting?: Promise<Entry> };

// host, port -> proxy URL or null (see setProxyResolver).
type ProxyResolver = (host: string, port: number) => Promise<string | null>;

// See allMailWindow / storedThread.
interface AllMailWindow {
  min: number;
  top: number;
  uids: Set<number>;
  byThread: Map<string, MirrorRow[]>;
}
interface StoredThread {
  uids: number[];
  upTo: number;
}

// The mailbox selected on a connection (code that calls this holds its lock).
const selected = (client: ImapFlow) => client.mailbox as MailboxObject;

const SPECIAL_USE: Record<string, string> = {
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'spam',
  '\\Trash': 'trash',
  '\\All': 'all',
  '\\Archive': 'archive',
  '\\Flagged': 'starred',
};

// How many recent messages of Inbox/Sent (or Gmail's All Mail) are mirrored
// for finding the other messages of a conversation.
const RELATED_WINDOW = 300;
const KEEPALIVE_MS = 4 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 60 * 1000;

const clients = new Map<string, Slot>(); // `${account id}:${lane}` -> { client, folders, gmail, lastUsed } | { connecting }

// Code run inside inLane('bg', fn) uses the background connection.
const laneStore = new AsyncLocalStorage<Lane>();
export const inLane = <T>(lane: Lane, fn: () => T): T => laneStore.run(lane, fn);
const currentLane = (): Lane => laneStore.getStore() || 'fg';

export function friendlyError(error: unknown, account?: { imap?: { host?: string } }): string {
  const err = error as MailError | null | undefined;
  if (!err) return 'Unknown error';
  if (err.authenticationFailed || err.responseCode === 535 || /auth/i.test(err.code || '')) {
    return 'Login failed. Check the email address and app password.';
  }
  if (err.code === 'ENOTFOUND') return `Can't find the mail server (${account?.imap?.host}).`;
  if (err.code === 'ECONNREFUSED') return 'The mail server refused the connection. Check host and port.';
  if (TIMEOUT_CODES.has(err.code)) {
    return 'Timed out connecting to the mail server. If you use a VPN, make sure it tunnels this app too, not only your browser.';
  }
  if (err.code === 'EACCES') {
    return 'The connection was blocked on this computer (firewall or VPN app filter). Allow Unified Inbox to access the internet.';
  }
  if (err.code === 'NoConnection' || err.code === 'ECONNRESET' || err.code === 'EPIPE' || /unexpected close|socket/i.test(err.message || '')) {
    return "Lost the connection to the mail server. Check your internet or VPN connection; the app will keep retrying.";
  }
  return err.responseText || err.message || String(err);
}

// The proxy Windows is set to use for a server ('http://…' / 'socks5://…'),
// or null to connect directly. VPN apps such as Astrill's OpenWeb mode only
// route traffic that goes through the system proxy. Set by main.js.
let proxyResolver: ProxyResolver = async () => null;
export function setProxyResolver(fn: ProxyResolver): void {
  proxyResolver = fn;
}
async function proxyFor(server: Inbox.ServerConfig): Promise<string | null> {
  try {
    return (await proxyResolver(server.host, server.port)) || null;
  } catch {
    return null;
  }
}

function newClient(account: Account, lane: Lane = 'fg', proxy: string | null = null): ImapFlow {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.user || account.email, pass: account.pass },
    ...(proxy ? { proxy } : {}),
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    // An idling connection must break IDLE before every command (two extra
    // round trips). Only the watch connection idles (right away); the others stay ready.
    disableAutoIdle: lane !== 'watch',
    ...(lane === 'watch' ? { autoIdleDelay: 500 } : {}),
  });
  // Without a listener, a dropped socket would crash the process.
  client.on('error', () => {});
  return client;
}

async function resolveFolders(client: ImapFlow): Promise<Folders> {
  const folders: Folders = { inbox: 'INBOX' };
  for (const box of await client.list()) {
    const key = box.specialUse && SPECIAL_USE[box.specialUse];
    if (key && !folders[key]) folders[key] = box.path;
  }
  return folders;
}

const folderCache = new Map<string, Folders>(); // account id -> folders, shared by all connections

const TIMEOUT_CODES = new Set<string | undefined>(['ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT']);

const isLoginError = (err: MailError | undefined) => err?.authenticationFailed || /auth/i.test(err?.code || '');

// A VPN often drops a single connection attempt; try once more before giving
// up. Through the system proxy first; if that fails, directly.
async function connect(account: Account): Promise<Entry> {
  const proxy = await proxyFor(account.imap);
  try {
    return await connectOnce(account, proxy);
  } catch (err) {
    const e = err as MailError | undefined;
    if (isLoginError(e) || (!proxy && !TIMEOUT_CODES.has(e?.code ?? ''))) throw err;
    return connectOnce(account, null);
  }
}

async function connectOnce(account: Account, proxy: string | null): Promise<Entry> {
  const lane = currentLane();
  const key = `${account.id}:${lane}`;
  const existing = clients.get(key);
  if (existing?.client?.usable) return existing as Entry;
  if (existing?.connecting) return existing.connecting;

  const client = newClient(account, lane, proxy);
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  client.on('close', () => {
    clearInterval(keepAlive);
    if (clients.get(key)?.client === client) clients.delete(key);
  });
  const connecting = (async () => {
    await client.connect();
    // The folder list is remembered on disk; refresh it in the background.
    if (!folderCache.has(account.id)) {
      const saved = cache.get<Folders>('folders', account.id);
      if (saved) {
        folderCache.set(account.id, saved);
        // Later, so it doesn't hold up the first screen on this connection.
        setTimeout(() => {
          if (!client.usable) return;
          resolveFolders(client)
            .then((fresh) => {
              Object.assign(folderCache.get(account.id)!, fresh);
              cache.put('folders', account.id, fresh);
            })
            .catch(() => {});
        }, 30 * 1000);
      } else {
        const fresh = await resolveFolders(client);
        folderCache.set(account.id, fresh);
        cache.put('folders', account.id, fresh);
      }
    }
    const entry: Entry = {
      client,
      folders: folderCache.get(account.id)!,
      gmail: client.capabilities.has('X-GM-EXT-1'),
      lastUsed: Date.now(),
    };
    // Without auto-IDLE, a cheap NOOP keeps quiet connections from timing out.
    if (lane !== 'watch') {
      keepAlive = setInterval(() => {
        if (client.usable && Date.now() - entry.lastUsed > KEEPALIVE_MS) {
          entry.lastUsed = Date.now();
          client.noop().catch(() => {});
        }
      }, 60 * 1000);
    }
    clients.set(key, entry);
    return entry;
  })();
  clients.set(key, { connecting });
  try {
    return await connecting;
  } catch (err) {
    clients.delete(key);
    client.close();
    throw err;
  }
}

// Logs in ahead of time so the first screen doesn't wait for it.
export function warmUp(account: Account) {
  return Promise.allSettled([connect(account), inLane('bg', () => connect(account))]);
}

export function disconnect(accountId: string): void {
  folderCache.delete(accountId);
  watchers.delete(accountId);
  for (const lane of ['fg', 'bg', 'watch'] as Lane[]) {
    const entry = clients.get(`${accountId}:${lane}`);
    clients.delete(`${accountId}:${lane}`);
    entry?.client?.logout().catch(() => {});
  }
}

// Runs fn with a connected client, reconnecting once if the connection went stale.
async function withClient<T>(account: Account, fn: (entry: Entry) => T | Promise<T>): Promise<T> {
  let entry = await connect(account);
  entry.lastUsed = Date.now();
  try {
    return await fn(entry);
  } catch (err) {
    if (entry.client.usable) throw err;
    clients.delete(`${account.id}:${currentLane()}`);
    entry = await connect(account);
    return fn(entry);
  }
}

async function withMailbox<T>(account: Account, path: string, fn: (entry: Entry) => T | Promise<T>): Promise<T> {
  return withClient(account, async (entry) => {
    const lock = await entry.client.getMailboxLock(path);
    try {
      return await fn(entry);
    } finally {
      lock.release();
    }
  });
}

// A connection that has had a mailbox open for a while may not know about mail
// that arrived since (servers such as Gmail only announce new messages when
// asked), so a message that was only just delivered, such as the reply you just
// sent, can look missing. Before treating something as missing, refresh what
// the connection sees. Stage 0 asks the server for updates (NOOP), stage 1
// selects the mailbox again, stage 2 waits a moment (the server may still be
// indexing the message) and selects it again.
async function refreshSelection(client: ImapFlow, path: string, stage: number): Promise<void> {
  if (stage === 0) return client.noop();
  if (stage >= 2) await new Promise((resolve) => setTimeout(resolve, 800));
  await client.mailboxOpen(path);
}

// fetchOne for a UID, refreshing the connection's view of the mailbox until the
// message shows up (the lock for `path` must be held).
async function fetchOneRefreshing(
  client: ImapFlow,
  path: string,
  uid: number,
  query: FetchQueryObject,
  found: (msg: FetchMessageObject | false | undefined) => boolean = (msg) => !!msg
): Promise<FetchMessageObject | false | undefined> {
  for (let stage = -1; stage <= 2; stage++) {
    if (stage >= 0) await refreshSelection(client, path, stage);
    const msg = await client.fetchOne(String(uid), query, { uid: true });
    if (found(msg)) return msg;
  }
  return false;
}

// Which mailbox role a path plays for this account ("inbox", "trash", ...).
function roleOf(entry: Entry, path: string): string | null {
  if (path === 'INBOX') return 'inbox';
  for (const [role, p] of Object.entries(entry.folders)) if (p === path && role !== 'inbox') return role;
  return null;
}

function withRoles(entry: Entry, messages: Summary[]): Summary[] {
  for (const m of messages) m.role = m.inInbox ? 'inbox' : roleOf(entry, m.folder);
  return messages;
}

// ---------- message summaries ----------

function walkParts(node: MessageStructureObject | undefined, out: MessageStructureObject[] = []): MessageStructureObject[] {
  if (!node) return out;
  if (node.childNodes) node.childNodes.forEach((c) => walkParts(c, out));
  else out.push(node);
  return out;
}

function findTextPart(structure: MessageStructureObject | undefined): Inbox.TextPartInfo | null {
  const parts = walkParts(structure).filter((p) => p.disposition !== 'attachment');
  const pick = parts.find((p) => p.type === 'text/plain') || parts.find((p) => p.type === 'text/html');
  if (!pick) return null;
  return {
    part: pick.part || '1',
    type: pick.type,
    encoding: (pick.encoding || '7bit').toLowerCase(),
    charset: pick.parameters?.charset || 'utf-8',
  };
}

// Names and types of the regular (non-inline) attachments, for the chips under list rows.
function attachmentFiles(structure: MessageStructureObject | undefined): Inbox.FileChip[] {
  return walkParts(structure)
    .filter((p) => p.disposition === 'attachment' || (p.dispositionParameters?.filename && p.disposition !== 'inline'))
    .map((p) => ({ name: p.dispositionParameters?.filename || p.parameters?.name || 'attachment', type: p.type }));
}

// Message-ID style identifiers ("<abc@host>"), lowercased, from a header value.
function parseIds(value: unknown): string[] {
  return (String(value || '').match(/<[^<>\s]+>/g) || []).map((s) => s.toLowerCase());
}

// Raw header lines -> { lowercase name: unfolded value }.
function parseHeaders(buf: Buffer | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(buf || '').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// Headers that tell personal mail from bulk mail, for "Important first".
const HEADERS = ['references', 'list-unsubscribe', 'list-id', 'precedence', 'auto-submitted', 'importance', 'x-priority'];

function importanceHints(h: Record<string, string>) {
  return {
    bulk: !!(h['list-unsubscribe'] || h['list-id'] || /bulk|list|junk/i.test(h.precedence || '') ||
      (h['auto-submitted'] && !/^no\b/i.test(h['auto-submitted']))),
    priorityHigh: /high|urgent/i.test(h.importance || '') || /^\s*[12]\b/.test(h['x-priority'] || ''),
  };
}

// The parts of a summary that never change for a given UID (everything but flags).
function staticSummary(account: Account, path: string, msg: FetchMessageObject): StaticSummary {
  const env = msg.envelope || {};
  const files = attachmentFiles(msg.bodyStructure);
  const headers = parseHeaders(msg.headers);
  return {
    ...importanceHints(headers),
    accountId: account.id,
    folder: path,
    uid: msg.uid,
    from: (env.from?.[0] || { name: '', address: '' }) as Inbox.Address,
    to: (env.to || []) as Inbox.Address[],
    subject: env.subject || '',
    snippet: '',
    date: new Date(msg.internalDate || env.date || Date.now()).toISOString(),
    size: msg.size || 0,
    hasAttachments: files.length > 0,
    files,
    messageId: parseIds(env.messageId)[0] || null,
    inReplyTo: parseIds(env.inReplyTo)[0] || null,
    references: parseIds(headers.references),
    threadId: msg.threadId || null,
    emailId: msg.emailId || null,
    _text: findTextPart(msg.bodyStructure),
  };
}

const SUMMARY_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  internalDate: true,
  bodyStructure: true,
  size: true,
  threadId: true,
  headers: HEADERS,
};

// Summaries are stored per mailbox ("account:path:uidvalidity:") in memory,
// backed by the disk cache, so they are downloaded once, ever.
const summaries = new Map<string, StaticSummary | true>(); // (true under uid 0: the mailbox has been read before)
const loadedMailboxes = new Set<string>();

// Stored under "sum2" (summaries now include importance hints, so older
// stored ones are fetched again once).
const SUMMARY_NS = 'sum2';

function summaryStore(account: Account, path: string, validity: string | bigint) {
  const prefix = `${account.id}:${path}:${validity}:`;
  if (!loadedMailboxes.has(prefix)) {
    loadedMailboxes.add(prefix);
    for (const [key, value] of cache.entries<StaticSummary | true>(SUMMARY_NS, prefix)) summaries.set(key, value);
  }
  return {
    has: (uid: number) => summaries.has(prefix + uid),
    get: (uid: number) => summaries.get(prefix + uid) as StaticSummary | undefined,
    set(uid: number, value: StaticSummary | true) {
      summaries.set(prefix + uid, value);
      cache.put(SUMMARY_NS, prefix + uid, value);
    },
  };
}

// Flags (and, on Gmail, labels). gmImportant is Gmail's own importance verdict.
const flagsOf = (r: FetchMessageObject): Flags => ({
  unread: !r.flags?.has('\\Seen'),
  starred: !!r.flags?.has('\\Flagged'),
  draft: !!r.flags?.has('\\Draft'),
  inInbox: !!r.labels?.has('\\Inbox'),
  gmImportant: r.labels ? r.labels.has('\\Important') : null,
});
const FLAG_FIELDS: (keyof Flags)[] = ['unread', 'starred', 'draft', 'inInbox', 'gmImportant'];
const pickFlags = (r: { [K in keyof Flags]?: Flags[K] | null }): Flags => Object.fromEntries(FLAG_FIELDS.map((f) => [f, r[f] ?? null])) as unknown as Flags;

// Summaries for a range (sequence set, or UIDs with byUid). Known messages only
// get their flags fetched; a mailbox we know nothing about is fetched in one go.
// allNew: the range holds only messages we've never seen (fetch everything at once).
async function fetchSummaries(client: ImapFlow, account: Account, path: string, range: string, byUid: boolean, allNew = false): Promise<Summary[]> {
  const known = summaryStore(account, path, selected(client).uidValidity);
  // Gmail labels change with archive/move-to-inbox, so they're fetched with the flags.
  const gmail = client.capabilities.has('X-GM-EXT-1');
  const flagQuery: FetchQueryObject = { uid: true, flags: true, labels: gmail };
  const opts = byUid ? { uid: true } : undefined;
  const flagsOnly = known.has(0) && !allNew;
  const first = await client.fetchAll(range, flagsOnly ? flagQuery : { ...SUMMARY_QUERY, ...flagQuery }, opts);
  const rows: FetchMessageObject[] = [];
  const missing: FetchMessageObject[] = [];
  for (const r of first) {
    if (r.envelope) known.set(r.uid, staticSummary(account, path, r));
    if (known.has(r.uid)) rows.push(r);
    else missing.push(r);
  }
  if (missing.length) {
    for (const msg of await client.fetchAll(missing.map((r) => r.uid).join(','), { ...SUMMARY_QUERY, ...flagQuery }, { uid: true })) {
      known.set(msg.uid, staticSummary(account, path, msg));
      rows.push(msg);
    }
  }
  // Remember that this mailbox has been seen, so later fetches start with flags only.
  if (!known.has(0)) known.set(0, true);
  return rows.map((r) => ({ ...known.get(r.uid)!, ...flagsOf(r) }));
}

async function fetchMatching(entry: Entry, account: Account, path: string, count: number, criteria: SearchObject): Promise<ListResult> {
  const { client } = entry;
  const uids = await client.search(criteria, { uid: true });
  if (!uids) throw new Error('The mail server refused this search.'); // (not the same as no matches)
  if (!uids.length) return { total: 0, messages: [] };
  return { total: uids.length, messages: await fetchSummaries(client, account, path, uids.slice(-count).join(','), true) };
}

// ---------- incremental mailbox sync ----------

// A mirror is the newest `window` messages of a mailbox: UIDs and flags, plus
// the mailbox state (UIDNEXT, message count, HIGHESTMODSEQ) they were read at.
// Bringing it up to date asks the server only what changed since then.
const mirrors = new Map<string, Mirror>();

function loadMirror(key: string): Mirror | undefined {
  if (!mirrors.has(key)) {
    const saved = cache.get<Mirror>('mirror', key);
    if (saved) mirrors.set(key, saved);
  }
  return mirrors.get(key);
}

function saveMirror(key: string, mirror: Mirror): void {
  mirrors.set(key, mirror);
  cache.put('mirror', key, mirror);
}

// Takes messages that are no longer in a mailbox (moved or deleted) out of its
// mirror, so the list stops showing them before the next sync confirms it.
function dropFromMirror(account: Account, path: string, uids: (number | string)[]): void {
  const key = `${account.id}:${path}`;
  const mirror = loadMirror(key);
  if (!mirror) return;
  const gone = new Set(uids.map(Number));
  const rows = mirror.rows.filter((r) => !gone.has(r.uid));
  if (rows.length !== mirror.rows.length) saveMirror(key, { ...mirror, rows });
}

// Phantoms: Gmail sometimes keeps listing and counting a message whose content
// can no longer be fetched and which can't be moved or deleted either. It
// would sit in the list for good, failing to open and coming back after every
// delete. Once a message is found to be one, the app leaves it out. (UIDs are
// never reused within a mailbox's UIDVALIDITY, so this can't hide other mail.)
const MAX_PHANTOMS = 200;
const phantomKey = (account: Account, path: string, validity: string) => `${account.id}:${path}:${validity}`;
function phantoms(account: Account, path: string, validity: string): Set<number> {
  return new Set(cache.get<number[]>('phantom', phantomKey(account, path, validity)) || []);
}
function markPhantoms(account: Account, path: string, uids: (number | string)[]): void {
  const mirror = loadMirror(`${account.id}:${path}`);
  if (!mirror || !uids.length) return;
  const set = phantoms(account, path, mirror.validity);
  uids.forEach((u) => set.add(Number(u)));
  cache.put('phantom', phantomKey(account, path, mirror.validity), [...set].slice(-MAX_PHANTOMS));
  dropFromMirror(account, path, uids);
}

async function syncMirror(account: Account, path: string, count: number): Promise<Mirror> {
  const key = `${account.id}:${path}`;
  const old = loadMirror(key);
  // One round trip tells us whether anything changed at all.
  const status = (await withClient(account, (e) =>
    e.client.status(path, { messages: true, uidNext: true, uidValidity: true, highestModseq: true })) as StatusObject
  );
  const sameMailbox = old && String(status.uidValidity) === old.validity;
  const ghosts = phantoms(account, path, String(status.uidValidity));
  if (
    sameMailbox &&
    old.window >= count &&
    old.rows.length + ghosts.size >= Math.min(count, old.exists) && // (a window emptied by deletions must be refilled)
    status.uidNext === old.uidNext &&
    status.messages === old.exists &&
    status.highestModseq != null &&
    String(status.highestModseq) === old.modseq
  ) {
    return old;
  }

  return withMailbox(account, path, async ({ client }) => {
    let mb = selected(client); // replaced when the mailbox is selected again
    const validity = String(mb.uidValidity);
    // The STATUS above, run while this mailbox is selected, raises mb.uidNext
    // without telling the connection about the new messages themselves. Rows
    // that stop short of UIDNEXT may be missing the newest mail (or the newest
    // UIDs were deleted, e.g. Gmail's draft autosaves): look again after a
    // refresh, since the mirror records UIDNEXT and would skip them for good.
    const reachesTop = (list: { uid: number }[]) => list.some((s) => s.uid >= mb.uidNext - 1);
    // Reads the newest `count` messages from scratch (details already stored
    // are not downloaded again, only their flags).
    const readNewest = async () => {
      const read = async () =>
        mb.exists ? fetchSummaries(client, account, path, `${Math.max(1, mb.exists - count + 1)}:*`, false) : [];
      let list = await read();
      // Fewer than there should be: the connection may not know about the newest mail yet.
      for (let stage = 0; (list.length < Math.min(count, mb.exists) || (mb.exists && !reachesTop(list))) && stage < 2; stage++) {
        await refreshSelection(client, path, stage);
        mb = selected(client);
        list = await read();
      }
      return list;
    };
    let rows: (MirrorRow | Summary)[];
    if (!sameMailbox || old.window < count || !mb.exists) {
      // Nothing usable to build on.
      rows = await readNewest();
    } else {
      const byUid = new Map<number, MirrorRow | Summary>(old.rows.map((r) => [r.uid, r]));
      const minUid = old.rows.length ? Math.min(...old.rows.map((r) => r.uid)) : 1;
      // New messages.
      let added = 0;
      if (mb.uidNext > old.uidNext) {
        const readNew = async () =>
          (await fetchSummaries(client, account, path, `${old.uidNext}:*`, true, true)).filter((s) => s.uid >= old.uidNext);
        let fresh = await readNew();
        // The server says there is new mail but this connection doesn't show it
        // (all of it) yet: refresh what it sees and look again.
        for (let stage = 0; !reachesTop(fresh) && stage < 2; stage++) {
          await refreshSelection(client, path, stage);
          mb = selected(client);
          fresh = await readNew();
        }
        for (const s of fresh) {
          if (!byUid.has(s.uid)) added++;
          byUid.set(s.uid, s);
        }
      }
      // Flag changes: only the ones newer than our modseq (CONDSTORE), else all.
      const gmail = client.capabilities.has('X-GM-EXT-1');
      const flagOpts: FetchOptions = { uid: true };
      if (old.modseq && mb.highestModseq != null) flagOpts.changedSince = BigInt(old.modseq);
      if (!flagOpts.changedSince || String(mb.highestModseq) !== old.modseq) {
        for (const r of await client.fetchAll(`${minUid}:*`, { uid: true, flags: true, labels: gmail }, flagOpts)) {
          const row = byUid.get(r.uid);
          if (row) Object.assign(row, flagsOf(r));
        }
      }
      // Deletions: the count doesn't add up, so ask which UIDs are still there.
      if (mb.exists !== old.exists + added) {
        const present = new Set((await client.search({ uid: `${minUid}:*` }, { uid: true })) || []);
        for (const uid of [...byUid.keys()]) if (!present.has(uid)) byUid.delete(uid);
      }
      rows = [...byUid.values()];
      // Deletions left the window short while the mailbox has older mail that
      // now belongs in it (deleting the newest 100 of 133 leaves 33 that were
      // never mirrored): read the newest messages again.
      if (rows.length + ghosts.size < Math.min(count, mb.exists)) rows = await readNewest();
    }
    rows = rows.filter((r) => !ghosts.has(r.uid));
    rows.sort((a, b) => b.uid - a.uid);
    const mirror = {
      validity,
      uidNext: mb.uidNext,
      exists: mb.exists,
      modseq: mb.highestModseq != null ? String(mb.highestModseq) : '',
      window: count,
      rows: rows.slice(0, count).map((r) => ({ uid: r.uid, ...pickFlags(r) })),
    };
    saveMirror(key, mirror);
    return mirror;
  });
}

const healTried = new Set<string>(); // mirrored messages we already tried to fetch details for

// The newest `count` messages of a mailbox, from the mirror.
async function listPath(account: Account, path: string, count: number): Promise<ListResult> {
  const entry = await connect(account);
  const mirror = await syncMirror(account, path, count);
  const known = summaryStore(account, path, mirror.validity);
  const wanted = mirror.rows.slice(0, count);
  // Self-healing: a mirrored message without stored details is fetched, never
  // silently left out (otherwise the mailbox would look empty although the
  // mirror says it isn't). Tried once per message, in case it's already gone.
  const tag = (uid: number) => `${account.id}:${path}:${mirror.validity}:${uid}`;
  const missing = wanted.filter((r) => !known.has(r.uid) && !healTried.has(tag(r.uid)));
  if (missing.length) {
    missing.forEach((r) => healTried.add(tag(r.uid)));
    await withMailbox(account, path, async ({ client }) => {
      for (let i = 0; i < missing.length; i += 250) {
        const uids = missing.slice(i, i + 250).map((r) => r.uid).join(',');
        await fetchSummaries(client, account, path, uids, true, true);
      }
    });
  }
  const messages = wanted.filter((r) => known.has(r.uid)).map((r) => ({ ...known.get(r.uid)!, ...pickFlags(r) }));
  return { total: mirror.exists, messages: withRoles(entry, messages) };
}

async function listMatching(account: Account, path: string, count: number, criteria: SearchObject): Promise<ListResult> {
  const entry = await connect(account);
  const result = await withMailbox(account, path, (e) => fetchMatching(e, account, path, count, criteria));
  withRoles(entry, result.messages);
  return result;
}

function folderPath(entry: Entry, folderKey: string): string | undefined {
  if (folderKey === 'all') return entry.folders.all || entry.folders.archive;
  return entry.folders[folderKey];
}

export async function list(account: Account, folderKey: string, count: number): Promise<ListResult> {
  const entry = await connect(account);
  // Providers without a Starred folder: look for flagged mail in the inbox.
  if (folderKey === 'starred' && !entry.folders.starred) return listMatching(account, 'INBOX', count, { flagged: true });
  const path = folderPath(entry, folderKey);
  if (!path) return { total: 0, messages: [] };
  return listPath(account, path, count);
}

// Inbox messages matching a filter, for "Unread first" / "Starred first" inboxes.
// Answered from the inbox mirror when it covers enough mail.
export async function listFiltered(account: Account, filter: string, count: number): Promise<ListResult> {
  const inbox = await listPath(account, 'INBOX', Math.max(count, 100));
  const want = (m: Summary) => (filter === 'unread' ? m.unread : m.starred);
  const hits = inbox.messages.filter(want);
  if (inbox.messages.length >= inbox.total) return { total: hits.length, messages: hits.slice(0, count) };
  return listMatching(account, 'INBOX', count, filter === 'unread' ? { seen: false } : { flagged: true });
}

// Searches everywhere, including Trash and Spam (results are tagged with their role).
// "No matches" is only reported when every folder was really searched, and a
// server that stops answering ends in an error instead of a search that never returns.
export async function search(account: Account, query: string, count: number): Promise<ListResult> {
  const entry = await connect(account);
  const f = entry.folders;
  const paths = entry.gmail && f.all ? [f.all, f.trash, f.spam] : ['INBOX', f.sent, f.archive, f.trash, f.spam];
  const criteria: SearchObject = entry.gmail
    ? { gmraw: query }
    : { or: [{ subject: query }, { from: query }, { to: query }, { body: query }] };
  const tooSlow = new Error(`${account.email} took too long to answer this search. Check your connection and try again.`);
  let expired = false;
  const searching = (async () => {
    let total = 0;
    let failure = null;
    const messages = [];
    for (const path of new Set(paths.filter(Boolean))) {
      if (expired) break;
      try {
        const r = await withMailbox(account, path, (e) => {
          if (expired) throw tooSlow; // (withMailbox retrying on a new connection)
          return fetchMatching(e, account, path, count, criteria);
        });
        withRoles(entry, r.messages);
        total += r.total;
        messages.push(...r.messages);
      } catch (err) {
        failure = failure || err;
      }
    }
    if (failure && !messages.length) throw failure;
    return { total, messages };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(tooSlow);
      // The connection is stuck on the search; drop it so it can't hold up anything else.
      clients.get(`${account.id}:${currentLane()}`)?.client?.close();
    }, SEARCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([searching, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- conversations ----------

// Gmail: the messages of these conversations that are older than the mirrored
// All Mail window (the newest RELATED_WINDOW messages). For each conversation
// we remember { uids, upTo }: every member with a UID below upTo is in uids,
// and the members from upTo on are in the window. Each look at a conversation
// adds its members in the window and moves upTo up with it, so a reply stays
// part of its conversation after newer mail has pushed it out of the window.
// When the window has moved past upTo since the last look (a lot of new mail),
// the conversation is searched for again.
// startsNew: conversation ids whose first message is in the window, so there's
// nothing older to search for.
const THREADS_NS = 'thr2'; // ('thr' held plain UID lists that went stale)

// What the mirrored window covers: every message from UID `min` up to `top`,
// and its messages grouped by conversation (only the conversations in `ids`).
function allMailWindow(account: Account, path: string, mirror: Mirror, ids: string[]): AllMailWindow {
  const known = summaryStore(account, path, mirror.validity);
  const min = mirror.rows.length >= mirror.exists ? 0 : mirror.rows.length ? Math.min(...mirror.rows.map((r) => r.uid)) : mirror.uidNext;
  const wanted = new Set(ids);
  const byThread = new Map<string, MirrorRow[]>();
  for (const r of mirror.rows) {
    const id = known.get(r.uid)?.threadId;
    if (!id || !wanted.has(id)) continue;
    if (!byThread.has(id)) byThread.set(id, []);
    byThread.get(id)!.push(r);
  }
  return { min, top: mirror.uidNext, uids: new Set(mirror.rows.map((r) => r.uid)), byThread };
}

// A window that covers nothing (the mirror is missing or out of date).
const NO_WINDOW: AllMailWindow = { min: Infinity, top: 0, uids: new Set(), byThread: new Map() };

// The stored members of a conversation, if they still reach the window.
function storedThread(key: string, id: string, win: AllMailWindow, startsNew: Set<string>): StoredThread | null {
  const saved = cache.get<StoredThread>(THREADS_NS, key);
  if (saved) return saved.upTo >= win.min ? saved : null;
  return startsNew.has(id) && win.min <= win.top ? { uids: [], upTo: win.min } : null;
}

// Brings a conversation's members up to date with the window and stores them,
// with the flags of its messages there (for when they have left it). Returns
// the members below the window. (A member at or above the window's start that
// isn't in it has been deleted.)
function keepThread(account: Account, validity: string, id: string, saved: StoredThread, win: AllMailWindow): number[] {
  const rows = win.byThread.get(id) || [];
  for (const r of rows) {
    const k = `${account.id}:${validity}:${r.uid}`;
    const flags = pickFlags(r);
    if (JSON.stringify(cache.get('oflags', k)) !== JSON.stringify(flags)) cache.put('oflags', k, flags);
  }
  const older = [...new Set(saved.uids)].filter((u) => u < win.min);
  const next: StoredThread = { uids: [...older, ...rows.map((r) => r.uid)].sort((a, b) => a - b), upTo: Math.max(saved.upTo, win.top) };
  const key = `${account.id}:${validity}:${id}`;
  if (JSON.stringify(cache.get(THREADS_NS, key)) !== JSON.stringify(next)) cache.put(THREADS_NS, key, next);
  return older;
}

async function gmailThreads(account: Account, entry: Entry, threadIds: string[], startsNew = new Set<string>()): Promise<Summary[]> {
  const path = entry.folders.all!;
  const ids = [...new Set(threadIds)];
  const mirror = loadMirror(`${account.id}:${path}`);
  // Usually every conversation is known and its older messages are stored:
  // answer without touching the server (their flags are the ones they had
  // when they were last in the window or fetched).
  if (mirror) {
    const win = allMailWindow(account, path, mirror, ids);
    const key = (id: string) => `${account.id}:${mirror.validity}:${id}`;
    const saved = ids.map((id) => [id, storedThread(key(id), id, win, startsNew)] as const);
    if (saved.every(([, s]) => s)) {
      const known = summaryStore(account, path, mirror.validity);
      const outside = new Set(saved.flatMap(([id, s]) => keepThread(account, mirror.validity, id, s!, win)));
      const stored = [...outside].map((u) => ({ summary: known.get(u), flags: cache.get<Flags>('oflags', `${account.id}:${mirror.validity}:${u}`) }));
      if (stored.every((s) => s.summary && s.flags)) return withRoles(entry, stored.map((s) => ({ ...s.summary!, ...s.flags! })));
    }
  }
  return withMailbox(account, path, async ({ client }) => {
    const validity = String(selected(client).uidValidity);
    const win = mirror?.validity === validity ? allMailWindow(account, path, mirror, ids) : NO_WINDOW;
    const thrKey = (id: string) => `${account.id}:${validity}:${id}`;
    const uids = new Set<number>();
    const fetched = new Map<number, Summary>(); // uid -> summary, from this call
    const unknown: string[] = [];
    for (const id of ids) {
      const saved = storedThread(thrKey(id), id, win, startsNew);
      if (saved) keepThread(account, validity, id, saved, win).forEach((u) => uids.add(u));
      else unknown.push(id);
    }
    const upTo = selected(client).uidNext; // a search sees every message below this
    for (let i = 0; i < unknown.length; i += 50) {
      const chunk = unknown.slice(i, i + 50);
      const criteria: SearchObject = chunk.length === 1 ? { threadId: chunk[0] } : { or: chunk.map((threadId) => ({ threadId })) };
      const found = (await client.search(criteria, { uid: true })) || [];
      const members = new Map<string, number[]>(chunk.map((id) => [id, []]));
      if (found.length) {
        for (const s of await fetchSummaries(client, account, path, found.join(','), true)) {
          fetched.set(s.uid, s);
          uids.add(s.uid);
          if (!members.has(s.threadId!)) members.set(s.threadId!, []);
          members.get(s.threadId!)!.push(s.uid);
        }
      }
      for (const [id, list] of members) keepThread(account, validity, id, { uids: list, upTo }, win);
    }
    // Messages in the mirrored window come from the mirror; the rest need their flags.
    const outside = [...uids].filter((u) => !win.uids.has(u));
    const toFetch = outside.filter((u) => !fetched.has(u));
    const out = outside.filter((u) => fetched.has(u)).map((u) => fetched.get(u)!);
    if (toFetch.length) out.push(...(await fetchSummaries(client, account, path, toFetch.join(','), true)));
    for (const m of out) {
      cache.put('oflags', `${account.id}:${validity}:${m.uid}`, pickFlags(m));
    }
    return withRoles(entry, out);
  });
}

// Messages from other folders that may belong to the same conversations as
// `items` (for example your replies in Sent), read from mirrored windows.
export async function related(account: Account, folderKey: string | null, items: Summary[]): Promise<Summary[]> {
  const entry = await connect(account);
  if (entry.gmail && entry.folders.all) {
    const window = (await listPath(account, entry.folders.all, RELATED_WINDOW)).messages;
    const ids = [...new Set(items.map((m) => m.threadId).filter((id): id is string => Boolean(id)))];
    // A conversation starting with a message that isn't a reply has nothing
    // older, as long as that message's All Mail copy is in the window.
    const copyId = (m: Summary) => m.emailId || m.messageId;
    const inWindow = new Set(window.map(copyId).filter(Boolean));
    const startsNew = new Set(
      items.filter((m) => m.threadId && !m.inReplyTo && !m.references?.length && inWindow.has(copyId(m))).map((m) => m.threadId!)
    );
    return [...window, ...(await gmailThreads(account, entry, ids, startsNew))];
  }
  const own = new Set(items.map((m) => m.folder));
  const paths = ['INBOX', entry.folders.sent].filter((p) => p && !own.has(p));
  const out: Summary[] = [];
  for (const path of paths) out.push(...(await listPath(account, path, RELATED_WINDOW)).messages);
  return out;
}

// One message plus the messages that could be in its conversation.
export async function threadCandidates(account: Account, path: string, uid: number): Promise<{ target: Summary; candidates: Summary[] }> {
  const entry = await connect(account);
  let target: Summary | undefined;
  for (let stage = -1; stage <= 2 && !target; stage++) {
    [target] = await withMailbox(account, path, async ({ client }) => {
      if (stage >= 0) await refreshSelection(client, path, stage); // a just-arrived message may be invisible to this connection
      return fetchSummaries(client, account, path, String(uid), true);
    });
  }
  if (!target) {
    dropFromMirror(account, path, [uid]);
    throw Object.assign(new Error('Message not found'), { status: 404 });
  }
  withRoles(entry, [target]);
  if (entry.gmail && entry.folders.all && target.threadId) {
    const window = (await listPath(account, entry.folders.all, RELATED_WINDOW)).messages;
    return { target, candidates: [...window, ...(await gmailThreads(account, entry, [target.threadId]))] };
  }
  const candidates: Summary[] = [];
  for (const p of new Set(['INBOX', entry.folders.sent, path].filter(Boolean))) {
    candidates.push(...(await listPath(account, p, RELATED_WINDOW)).messages);
  }
  return { target, candidates };
}

// ---------- snippets ----------

function decodeQuotedPrintable(buf: Buffer): Buffer {
  const str = buf.toString('latin1').replace(/=\r?\n/g, '');
  return Buffer.from(
    str.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
    'latin1'
  );
}

function decodePart(buf: Buffer, info: Inbox.TextPartInfo, alreadyDecoded: boolean | undefined): string {
  let bytes = buf;
  if (!alreadyDecoded) {
    if (info.encoding === 'base64') {
      const clean = buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
      bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
    } else if (info.encoding === 'quoted-printable') {
      bytes = decodeQuotedPrintable(buf);
    }
  }
  try {
    return new TextDecoder(info.charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", zwnj: '', shy: '' };

function htmlToText(html: string): string {
  return html
    .replace(/^[\s\S]*?<body[^>]*>/i, '')
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?(<\/\1>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Previews skip quoted history, like Gmail: only what the sender wrote new.
// (Never cuts to nothing: a message that is nothing but a quote keeps it.)
const HTML_QUOTE_START = /<(?:div|blockquote)\b[^>]*(?:gmail_quote|yahoo_quoted|moz-cite-prefix|divRplyFwdMsg|appendonsend|type=["']?cite)/i;
// ("On ... wrote:" ends its line; long attributions wrap onto a second line.)
const PLAIN_QUOTE_START = /^[ \t]*(?:On\b[^\n]{0,300}(?:\n[^\n]{0,200})?\bwrote:[ \t]*$|-{2,}\s*Original Message\s*-{2,}|_{10,}|>)/im;

function withoutQuotedHistory(text: string, isHtml: boolean): string {
  const cut = text.search(isHtml ? HTML_QUOTE_START : PLAIN_QUOTE_START);
  if (cut <= 0) return text;
  const head = text.slice(0, cut);
  return (isHtml ? htmlToText(head) : head).trim() ? head : text;
}

function toSnippet(text: string, isHtml: boolean): string {
  const plain = isHtml ? htmlToText(withoutQuotedHistory(text, true)) : withoutQuotedHistory(text, false);
  return plain
    .replace(/[͏​-‍⁠﻿­]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/�+$/, '')
    .trim()
    .slice(0, 200);
}

// Fills in .snippet for the given summaries (all from one account), fetching
// only the first few KB of each message's text part. Previews are stored with
// the summary, so each one is fetched once, ever.
export async function fillSnippets(account: Account, items: Summary[]): Promise<void> {
  const byFolder = new Map<string, Summary[]>();
  for (const item of items) {
    if (!item._text || item.snippet || item.snippetDone) continue;
    if (!byFolder.has(item.folder)) byFolder.set(item.folder, []);
    byFolder.get(item.folder)!.push(item);
  }
  for (const [path, folderItems] of byFolder) {
    await withMailbox(account, path, async ({ client }) => {
      const known = summaryStore(account, path, selected(client).uidValidity);
      // Messages sharing a text part id can be fetched in a single command.
      const byPart = new Map<string, Summary[]>();
      for (const item of folderItems) {
        const k = `${item._text!.part}|${item._text!.type}`;
        if (!byPart.has(k)) byPart.set(k, []);
        byPart.get(k)!.push(item);
      }
      for (const group of byPart.values()) {
        const { part, type } = group[0]._text!;
        const maxLength = type === 'text/html' ? 24000 : 3000;
        const byUid = new Map(group.map((i) => [i.uid, i]));
        const fetched = await client.fetchAll(
          group.map((i) => i.uid).join(','),
          { uid: true, bodyParts: [{ key: part, start: 0, maxLength }] },
          { uid: true }
        );
        for (const msg of fetched) {
          const item = byUid.get(msg.uid);
          const [key, buf] = (msg.bodyParts && [...msg.bodyParts.entries()][0]) || [];
          if (!item || !buf) continue;
          const decoded = decodePart(buf, item._text!, msg.binaryParts?.has(key!));
          item.snippet = toSnippet(decoded, type === 'text/html');
          const stored = known.get(item.uid);
          if (stored) known.set(item.uid, { ...stored, snippet: item.snippet, snippetDone: true });
        }
      }
    });
  }
}

// ---------- full messages ----------

function lru<V>(max: number) {
  const map = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value as V);
      return value;
    },
    set(key: string, value: V): void {
      map.delete(key);
      map.set(key, value as V);
      if (map.size > max) map.delete(map.keys().next().value!);
    },
  };
}
// Parsed messages in memory; raw sources on disk (cache.js).
const parsedCache = lru<Inbox.FullMessage>(200);

const sourceKey = (account: Account, path: string, uid: number) => `${account.id}:${path}:${loadMirror(`${account.id}:${path}`)?.validity || '0'}:${uid}`;

async function getSource(account: Account, path: string, uid: number): Promise<Buffer> {
  const key = sourceKey(account, path, uid);
  const saved = cache.getSource(key);
  if (saved) return saved;
  const source = await withMailbox(account, path, async ({ client }) => {
    const msg = (await fetchOneRefreshing(client, path, uid, { uid: true, source: true }, (m) => !!(m as FetchMessageObject)?.source)) as FetchMessageObject | undefined;
    if (!msg?.source) {
      // Still listed by the server although its content can't be had: a phantom.
      const listed = await client.search({ uid: String(uid) }, { uid: true });
      if ((listed as number[] | undefined)?.includes(Number(uid))) markPhantoms(account, path, [uid]);
      else dropFromMirror(account, path, [uid]);
      throw Object.assign(new Error('Message not found'), { status: 404 });
    }
    return msg.source;
  });
  cache.putSource(key, source);
  return source;
}

function addressList(field: AddressObject | AddressObject[] | undefined): Inbox.Address[] {
  return (field as AddressObject | undefined)?.value?.map((v) => ({ name: v.name, address: v.address as string })) || [];
}

async function parseMessage(account: Account, path: string, uid: number): Promise<Inbox.FullMessage> {
  const key = `${account.id}:${path}:${uid}`;
  const cached = parsedCache.get(key);
  if (cached) return cached;
  // Keep cid: links; the service rewrites them to mailpart:// URLs.
  const parsed = await simpleParser(await getSource(account, path, uid), { skipImageLinks: true });
  const msg: Inbox.FullMessage = {
    accountId: account.id,
    folder: path,
    uid,
    subject: parsed.subject || '',
    from: addressList(parsed.from)[0] || { name: '', address: '' },
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    replyTo: addressList(parsed.replyTo),
    date: (parsed.date || new Date()).toISOString(),
    html: parsed.html || parsed.textAsHtml || '',
    plain: !parsed.html,
    text: parsed.text || '',
    messageId: parsed.messageId || '',
    references: ([] as string[]).concat(parsed.references || []),
    attachments: parsed.attachments.map((a, idx) => ({
      idx,
      filename: a.filename || `attachment-${idx + 1}`,
      contentType: a.contentType,
      size: a.size,
      cid: a.cid || null,
      related: !!a.related,
    })),
  };
  parsedCache.set(key, msg);
  return msg;
}

// Opens a message. Marking it read happens in the background, so the
// message shows as soon as its content is here.
export async function get(account: Account, path: string, uid: number, { markSeen = true } = {}): Promise<Inbox.FullMessage> {
  const msg = await parseMessage(account, path, uid);
  if (markSeen) {
    withMailbox(account, path, ({ client }) => client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })).catch(() => {});
  }
  return { ...msg };
}

// Downloads messages ahead of time (one command per folder) and keeps them on
// disk, like Gmail's offline mail, so opening them needs no network at all.
export async function prefetch(account: Account, path: string, uids: number[]): Promise<void> {
  const missing = uids.filter((uid) => !cache.getSource(sourceKey(account, path, uid)));
  if (!missing.length) return;
  await withMailbox(account, path, async ({ client }) => {
    for (const msg of await client.fetchAll(missing.join(','), { uid: true, source: true }, { uid: true })) {
      if (msg.source) cache.putSource(sourceKey(account, path, msg.uid), msg.source);
    }
  });
}

export async function attachment(account: Account, path: string, uid: number, idx: number): Promise<AttachmentContent | undefined> {
  const parsed = await simpleParser(await getSource(account, path, uid));
  return parsed.attachments[idx];
}

// Regular (non-inline) attachments, for forwarding.
export async function forwardAttachments(account: Account, path: string, uid: number): Promise<AttachmentContent[]> {
  const parsed = await simpleParser(await getSource(account, path, uid));
  return parsed.attachments
    .filter((a) => !a.related)
    .map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content }));
}

// ---------- push: new mail the moment it arrives ----------

const watchers = new Set<string>();

// Keeps a connection idling on the Inbox; the server tells it about new mail,
// deletions and flag changes right away (IMAP IDLE).
export async function watch(account: Account, onChange: (accountId: string) => void): Promise<void> {
  if (watchers.has(account.id)) return;
  watchers.add(account.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(account.id), 150);
  };
  const start = async () => {
    if (!watchers.has(account.id)) return;
    try {
      const { client } = await inLane('watch', () => connect(account));
      client.on('exists', changed);
      client.on('expunge', changed);
      client.on('flags', changed);
      client.once('close', () => setTimeout(start, 10000));
      await client.mailboxOpen('INBOX');
    } catch {
      setTimeout(start, 30000);
    }
  };
  start();
}

// ---------- actions ----------

// "1,2,3,7,9,10" -> "1:3,7,9:10": a whole mailbox's worth of UIDs stays one short command.
function uidSet(uids: (number | string)[]): string {
  const sorted = [...new Set(uids.map(Number))].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}:${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(',');
}

export async function setFlags(account: Account, path: string, uids: number[], { seen, flagged }: FlagChanges): Promise<void> {
  return withMailbox(account, path, async ({ client }) => {
    const range = uidSet(uids);
    if (seen === true) await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
    if (seen === false) await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
    if (flagged === true) await client.messageFlagsAdd(range, ['\\Flagged'], { uid: true });
    if (flagged === false) await client.messageFlagsRemove(range, ['\\Flagged'], { uid: true });
  });
}

// Gmail keeps importance as a label (other providers have none; the app
// remembers the choice itself, see service.js).
export async function setImportant(account: Account, path: string, uids: number[], important: boolean): Promise<unknown> {
  const entry = await connect(account);
  if (!entry.gmail) return;
  return withMailbox(account, path, ({ client }) =>
    important
      ? client.messageFlagsAdd(uidSet(uids), ['\\Important'], { uid: true, useLabels: true })
      : client.messageFlagsRemove(uidSet(uids), ['\\Important'], { uid: true, useLabels: true })
  );
}

async function archiveFolder(account: Account, entry: Entry): Promise<string | undefined> {
  if (entry.gmail) return entry.folders.all;
  if (entry.folders.archive) return entry.folders.archive;
  await entry.client.mailboxCreate('Archive').catch(() => {});
  entry.folders.archive = 'Archive';
  return 'Archive';
}

export async function move(account: Account, path: string, uids: number[], target: MoveTarget): Promise<unknown> {
  const entry = await connect(account);
  if (target === 'archive' && path !== 'INBOX') {
    // Archiving takes a conversation out of the inbox. Gmail copies found
    // through All Mail lose their Inbox label; other folders are left alone.
    if (entry.gmail && path === entry.folders.all) {
      return withMailbox(account, path, ({ client }) =>
        client.messageFlagsRemove(uidSet(uids), ['\\Inbox'], { uid: true, useLabels: true })
      );
    }
    return;
  }
  let dest: string | undefined;
  if (target === 'archive') dest = await archiveFolder(account, entry);
  else if (target === 'inbox') dest = 'INBOX';
  else dest = entry.folders[target];
  if (!dest) throw new Error(`This account has no ${target} folder.`);
  if (dest === path) return;
  await withMailbox(account, path, async ({ client }) => {
    await client.messageMove(uidSet(uids), dest, { uid: true });
    await forgetRemoved(client, account, path, uids);
  });
}

// After moving or deleting messages: out of the list now. Any the server
// still lists are phantoms (they refuse to move) and are left out for good.
async function forgetRemoved(client: ImapFlow, account: Account, path: string, uids: number[]): Promise<void> {
  const still = new Set((await client.search({ uid: uidSet(uids) }, { uid: true }).catch(() => [])) || []);
  const stuck = uids.map(Number).filter((u) => still.has(u));
  dropFromMirror(account, path, uids);
  markPhantoms(account, path, stuck);
}

// Moves to Trash, or deletes for good when already in Trash/Spam.
export async function remove(account: Account, path: string, uids: number[]): Promise<unknown> {
  const entry = await connect(account);
  const { trash, spam } = entry.folders;
  if (trash && path !== trash && path !== spam) return move(account, path, uids, 'trash');
  await withMailbox(account, path, async ({ client }) => {
    await client.messageDelete(uidSet(uids), { uid: true });
    await forgetRemoved(client, account, path, uids);
  });
}

// ---------- counts ----------

export async function counts(account: Account): Promise<Inbox.AccountCounts> {
  const entry = await connect(account);
  const result: Record<string, number> = {};
  const want = { inbox: 'unseen', spam: 'unseen', drafts: 'messages' } as const;
  for (const [key, field] of Object.entries(want)) {
    const path = entry.folders[key];
    if (!path) continue;
    const status = await withClient(account, (e) => e.client.status(path, { [field]: true }));
    result[key] = (status as StatusObject)?.[field] ?? 0;
  }
  return result;
}

// ---------- sending ----------

async function transportFor(account: Account) {
  const proxy = await proxyFor(account.smtp);
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user || account.email, pass: account.pass },
    connectionTimeout: 15000,
    ...(proxy ? { proxy } : {}),
  });
  if (proxy?.startsWith('socks')) transport.set('proxy_socks_module', require('socks'));
  return transport;
}

export async function send(account: Account, mail: OutgoingMessage): Promise<string> {
  const domain = account.email.split('@')[1] || 'localhost';
  const message: Mail.Options & { messageId: string } = {
    from: { name: account.senderName || '', address: account.email },
    to: mail.to,
    cc: mail.cc || undefined,
    bcc: mail.bcc || undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html || undefined,
    inReplyTo: mail.inReplyTo || undefined,
    references: mail.references || undefined,
    attachments: mail.attachments || [],
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    date: new Date(),
  };
  await (await transportFor(account)).sendMail(message);

  const preset = PROVIDERS[account.provider] || PROVIDERS.custom;
  if (preset.appendSent) {
    const entry = await connect(account);
    if (entry.folders.sent) {
      const raw = await new MailComposer(message).compile().build();
      await withClient(account, (e) => e.client.append(entry.folders.sent, raw, ['\\Seen']));
    }
  }
  return message.messageId;
}

// ---------- connection test ----------

export async function test(account: Account): Promise<void> {
  const tryImap = async (proxy: string | null) => {
    const client = newClient(account, 'fg', proxy);
    try {
      await client.connect();
      await client.logout();
    } catch (err) {
      client.close();
      throw err;
    }
  };
  try {
    const proxy = await proxyFor(account.imap);
    await tryImap(proxy).catch((err) => {
      if (!proxy || isLoginError(err)) throw err;
      return tryImap(null);
    });
  } catch (err) {
    throw new Error(`IMAP: ${friendlyError(err, account)}`);
  }
  try {
    await (await transportFor(account)).verify();
  } catch (err) {
    throw new Error(`SMTP: ${friendlyError(err, { imap: account.smtp })}`);
  }
}

// For tests.
export const _test = { fetchOneRefreshing, refreshSelection, toSnippet, uidSet };

// Merges every connected account into one mailbox view. Uses the demo backend
// until the first real account is added.
//
// Views are served Gmail-style from the local database first ("stale while
// revalidate"): a list you've seen before comes back instantly, a background
// sync brings it up to date, and changes are announced through `events`.
import { EventEmitter } from 'events';
import * as store from './store';
import * as cache from './cache';
import * as tracking from './tracking';
import type { TrackRecord } from './tracking';
import * as imap from './imap';
import * as demo from './demo';
import { PROVIDERS, guessProvider } from './providers';
import type { Account, AnyAccount, AttachmentContent, Backend, ListResult } from './types';

type Summary = Inbox.MessageSummary;
type Thread = Inbox.Thread;

// A new message, for the new-mail alert.
export interface NewMailAlert {
  key: string;
  account: string;
  from: string;
  subject: string;
  snippet: string;
}

interface ServiceEvents {
  view: [Inbox.ViewUpdate];
  mail: [string];
  'new-mail': [NewMailAlert[]];
  opened: [TrackRecord[]];
}

// 'view' {key, data} | 'mail' accountId | 'new-mail' [messages] | 'opened' {record, open}
export const events = new EventEmitter<ServiceEvents>();

const PAGE_SIZE = 50;
const EVERYTHING_LIMIT = 1000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function accounts(): AnyAccount[] {
  const real = store.getAccounts();
  return real.length ? real : demo.ACCOUNTS;
}

const backend = (account: AnyAccount): Backend<AnyAccount> => (account.demo ? demo : imap) as Backend<AnyAccount>;

function accountById(id: string): AnyAccount {
  const account = accounts().find((a) => a.id === id);
  if (!account) throw new Error('That account no longer exists.');
  return account;
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return groups;
}

export function getState() {
  const real = store.getAccounts();
  return {
    demo: real.length === 0,
    accounts: accounts().map(store.publicAccount),
    providers: PROVIDERS,
  };
}

// Background work (syncing, counts, prefetch) uses each account's second IMAP connection.
const inBackground = <T>(fn: () => T): T => imap.inLane('bg', fn);

export function initCache(dataDir: string): void {
  cache.init(dataDir);
  tracking.init(dataDir);
}

// ---------- read tracking (like Mailsuite) ----------

// Each tracked message gets .track; a conversation shows the state of the
// last tracked message in it (✓ sent, ✓✓ opened).
function markThread(t: Thread): Thread {
  let last: Inbox.TrackStatus | null = null;
  for (const m of t.messages) {
    m.track = tracking.statusFor(m.messageId);
    if (m.track) last = m.track;
  }
  t.track = last;
  return t;
}

function withTracking(data: Inbox.ViewResult): Inbox.ViewResult {
  for (const t of [...(data.sections || []).flatMap((s) => s.threads), ...(data.threads || [])]) markThread(t);
  return data;
}

// Checks the tracker for opens; announces new ones (for alerts and the ✓✓ marks).
export async function pollTracking(): Promise<number> {
  const opened = await tracking.poll().catch((): TrackRecord[] => []);
  if (opened.length) events.emit('opened', opened);
  return opened.length;
}

export const trackingConfig = () => tracking.publicConfig();
export const setTracking = (config: { url?: string; secret?: string }) => tracking.setConfig(config);

// ---------- outgoing message bodies ----------

const escapeHtml = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
const QUOTE_OPEN =
  '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">';

// Plain-text quoting ("> " per level) as HTML: nested blockquotes, like Gmail.
function quoteToHtml(text: string): string {
  let depth = 0;
  let out = '';
  for (const line of String(text).replace(/\s+$/, '').split(/\r?\n/)) {
    const m = line.match(/^((?:\s*>)*)\s?(.*)$/)!;
    const d = (m[1].match(/>/g) || []).length;
    while (depth < d) {
      out += QUOTE_OPEN;
      depth++;
    }
    while (depth > d) {
      out += '</blockquote>';
      depth--;
    }
    out += `${escapeHtml(m[2])}<br>`;
  }
  return out + '</blockquote>'.repeat(depth);
}

// The text part of a reply: what you wrote, then the original quoted with "> ".
function quotedPlainText(quote: Inbox.Quote): string {
  const lines = String(quote.text)
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map((l) => (l ? `> ${l}` : '>'));
  return `${quote.attribution}\n${lines.join('\n')}`;
}

// The HTML part: your text, then (for replies) the quoted original in the
// structure Gmail uses, so mail apps (this one too) fold it behind "•••".
// The "ui-simple" marker lets this app show it like plain text in dark mode.
function composeHtml(text: string, quote: Inbox.Quote | null): string {
  let html = `<div class="ui-simple" dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
  if (quote) {
    html += `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(quote.attribution)}<br></div>${QUOTE_OPEN}${quoteToHtml(quote.text)}</blockquote></div>`;
  }
  return html;
}

export function flushCache(): void {
  cache.flush();
}

export function warmUp(): void {
  for (const a of accounts()) backend(a).warmUp(a);
}

// New mail is pushed by the server (IMAP IDLE) instead of waiting for a poll.
export function startWatching(): void {
  for (const a of store.getAccounts()) imap.watch(a, onMailPushed);
}

// The server reported a change in an account's Inbox: re-sync the inbox views
// that include it right away (the window gets them as 'view' events), then
// tell the window so it can refresh counts.
async function onMailPushed(accountId: string): Promise<void> {
  const keys = new Set(cache.entries('view', '').map(([key]) => key));
  keys.add(viewKeyOf({})); // the unified inbox, even if it was never opened
  const views = [...keys]
    .map((key) => ({ key, v: JSON.parse(key) as ViewKeyParts }))
    .filter(({ v }) => v[0] === 'inbox' && (v[1] === 'all' || v[1] === accountId))
    // The unified inbox's first page first: it's what's usually on screen.
    .sort((a, b) => Number(b.v[1] === 'all' && b.v[2] === 1) - Number(a.v[1] === 'all' && a.v[2] === 1));
  // One at a time, so the first view isn't slowed down by the others.
  for (const { key, v } of views) {
    const [folder, account, page, q, threading, inboxType, sectionPage, sectionSize] = v;
    await refreshView({ folder, account, page, q, threading, inboxType, sectionPage, sectionSize }, key, { urgent: true }).catch(() => {});
  }
  events.emit('mail', accountId);
}

// ---------- importance (Gmail's "Important first") ----------

// Sender names that are almost always automated (newsletters, notifications, receipts).
const AUTOMATED = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|newsletters?|news|alerts?|updates?|marketing|mailer-daemon|postmaster|bounces?|info|support|hello|team|digest|billing|statements?|orders?|receipts?)([._+-]|$)/i;
// "noreply" anywhere in the name (invitations-noreply@, calendar.no-reply@).
const NO_REPLY = /(^|[._+-])(no[-_.]?reply|do[-_.]?not[-_.]?reply)([._+-]|$)/i;
const isAutomated = (address: string) => {
  const name = address.split('@')[0];
  return AUTOMATED.test(name) || NO_REPLY.test(name);
};

const addressOf = (a: Inbox.Address | undefined) => String(a?.address || '').toLowerCase();

// Your own choice (for the message, then for its sender) always wins. After
// that, mail from automated senders (no-reply@, support@, …) and a message
// that starts a new conversation (not a reply, nothing else in its thread)
// are never important. Otherwise Gmail accounts use Gmail's own verdict (its
// \Important label); for other accounts, ongoing conversations are important
// unless they're bulk mail (mailing lists, newsletters), and high priority
// mail always is.
function markImportance(threads: Thread[]): Thread[] {
  for (const t of threads) {
    for (const m of t.messages) {
      const from = addressOf(m.from);
      const choice = m.messageId ? cache.get<boolean>('imp', `${m.accountId}:${String(m.messageId).toLowerCase()}`) : undefined;
      const startsConversation = t.messages.length === 1 && !m.inReplyTo && !m.references?.length;
      m.important =
        choice ??
        cache.get<boolean | null>('impSender', from) ??
        (isAutomated(from) || startsConversation
          ? false
          : m.gmImportant ?? (!!m.priorityHigh || !m.bulk));
    }
    t.important = t.messages.some((m) => m.important);
  }
  return threads;
}

// ---------- conversations ----------

const keyOf = (m: Inbox.MessageRef) => `${m.accountId}|${m.folder}|${m.uid}`;

// Folders whose rows also pull in replies from other folders (like Sent).
const THREADED = new Set(['inbox', 'starred', 'sent', 'all', 'search']);

// Groups messages into conversations, Gmail style. `primary` are the messages
// of the folder being viewed; `extra` are messages from elsewhere that only
// join a conversation if it already has a primary message. Gmail conversation
// IDs are used when present, otherwise Message-ID / In-Reply-To / References.
function buildThreads(primary: Summary[], extra: Summary[]): Thread[] {
  const all: Summary[] = [];
  const seen = new Map<string, Summary>(); // id -> the copy kept
  for (const [list, isPrimary] of [[primary, true], [extra, false]] as const) {
    for (const m of list) {
      // The same message can show up in two folders (Inbox and All Mail, or a
      // note to yourself in Inbox and Sent); keep the copy from this folder,
      // with the other copy's preview if it has one and this one doesn't yet.
      const ids = [`k:${keyOf(m)}`];
      if (m.emailId) ids.push(`e:${m.accountId}:${m.emailId}`);
      else if (m.messageId) ids.push(`m:${m.accountId}:${m.messageId}`);
      const kept = ids.map((id) => seen.get(id)).find(Boolean);
      if (kept) {
        if (!kept.snippet && m.snippet) kept.snippet = m.snippet;
        continue;
      }
      const copy = { ...m, primary: isPrimary };
      ids.forEach((id) => seen.set(id, copy));
      all.push(copy);
    }
  }

  const parent = new Map<string, string>();
  const root = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const join = (a: string, b: string) => parent.set(root(a), root(b));
  for (const m of all) {
    const node = `k:${keyOf(m)}`;
    root(node);
    if (m.threadId) {
      join(node, `t:${m.accountId}:${m.threadId}`);
    } else {
      for (const id of [m.messageId, m.inReplyTo, ...(m.references || [])]) {
        if (id) join(node, `i:${m.accountId}:${id}`);
      }
    }
  }

  const threads: Thread[] = [];
  for (const members of groupBy(all, (m) => root(`k:${keyOf(m)}`)).values()) {
    const own = members.filter((m) => m.primary);
    if (!own.length) continue;
    members.sort((x, y) => x.date.localeCompare(y.date));
    const anchor = own[own.length - 1];
    const latest = members[members.length - 1];
    threads.push({
      key: keyOf(anchor),
      accountId: anchor.accountId,
      folder: anchor.folder,
      subject: members[0].subject || anchor.subject,
      snippet: latest.snippet,
      date: latest.date,
      unread: members.some((m) => m.unread),
      starred: members.some((m) => m.starred),
      hasAttachments: members.some((m) => m.hasAttachments),
      files: members.flatMap((m) => m.files || []),
      roles: [...new Set(members.map((m) => m.role).filter((r): r is string => Boolean(r)))],
      draft: members.some((m) => m.draft),
      count: members.length,
      messages: members,
    });
  }
  return threads;
}

// With conversation view off, every message is its own row.
function singleThreads(primary: Summary[]): Thread[] {
  return primary.map((m) => buildThreads([m], [])[0]);
}

async function fillThreadSnippets(threads: Thread[], all = false): Promise<void> {
  const items = threads.flatMap((t) => (all ? t.messages : [t.messages[t.messages.length - 1]]));
  await Promise.allSettled(
    [...groupBy(items, (m) => m.accountId)].map(([id, list]) => {
      const a = accountById(id);
      return backend(a).fillSnippets(a, list);
    })
  );
  for (const t of threads) {
    t.snippet = t.messages[t.messages.length - 1].snippet;
    for (const m of t.messages) delete m._text;
  }
}

// ---------- reading ----------

// Fetches and groups one view for every target account. `fetch` returns { total, messages }.
// quick: skip looking in other folders for the rest of each conversation.
async function collect(
  targets: AnyAccount[],
  fetch: (b: Backend<AnyAccount>, a: AnyAccount) => Promise<ListResult>,
  threaded: boolean,
  folderKey: string,
  quick = false
): Promise<Inbox.EverythingResult> {
  const results = await Promise.allSettled(
    targets.map(async (a) => {
      const b = backend(a);
      const primary = await fetch(b, a);
      if (!threaded) return { complete: primary.messages.length >= primary.total, threads: singleThreads(primary.messages) };
      const extra = THREADED.has(folderKey) && !quick ? await b.related(a, folderKey, primary.messages).catch(() => []) : [];
      return { complete: primary.messages.length >= primary.total, threads: buildThreads(primary.messages, extra) };
    })
  );
  let complete = true;
  const threads: Thread[] = [];
  const errors: Inbox.ViewError[] = [];
  results.forEach((r, i) => {
    const a = targets[i];
    if (r.status === 'fulfilled') {
      complete = complete && r.value.complete;
      threads.push(...r.value.threads);
    } else {
      errors.push({ accountId: a.id, message: backend(a).friendlyError(r.reason, a) });
    }
  });
  threads.sort((x, y) => y.date.localeCompare(x.date));
  return { complete, threads, errors };
}

const SECTION_TITLES: Record<string, string> = { unread: 'Unread', starred: 'Starred', important: 'Important' };
const SECTION_SIZES = [5, 10, 25, 50]; // Gmail's "Show up to N items"
const sectionSizeOf = (n: unknown) => (SECTION_SIZES.includes(Number(n)) ? Number(n) : 25);

// sectionPage: the page of the inbox-type section (Important / Unread / Starred), paged on its own like Gmail's.
// sectionSize: how many conversations one page of that section shows.
// [folder or "search", account, page, q, threading, inboxType, sectionPage, sectionSize]
type ViewKeyParts = [string, string, number, string, boolean, Inbox.InboxType, number, number];

const viewKeyOf = ({ folder = 'inbox', account = 'all', page = 1, q = '', threading = true, inboxType = 'default', sectionPage = 1, sectionSize = 25 }: Inbox.ViewParams) =>
  JSON.stringify([q ? 'search' : folder, account, page, q, threading, inboxType, sectionPage, sectionSizeOf(sectionSize)]);

const refreshing = new Map<string, { promise?: Promise<void>; again: boolean }>(); // view key -> { promise, again } for the in-flight background refresh

// A view from the local database if we have one (marked stale, refreshed in
// the background), otherwise fetched now. `fresh` skips the stored copy.
export async function listMessages(params: Inbox.ViewParams = {}): Promise<Inbox.ViewResult> {
  const key = viewKeyOf(params);
  const stored = params.fresh ? null : cache.get<Inbox.ViewResult>('view', key);
  if (stored) {
    // (no need when it was synced moments ago; pushes and polls keep it current)
    if (Date.now() - (computedAt.get(key) || 0) > 10 * 1000) refreshView(params, key);
    return withTracking({ ...stored, viewKey: key, stale: true });
  }
  if (params.fresh || params.background) {
    return params.background ? inBackground(() => computeView(params, key)) : computeView(params, key);
  }
  // Never seen this view: show the rows as soon as the headers are here, then
  // fill in conversations and previews in the background (like Gmail's first load).
  const quick = { ...(await listMessagesNow(params, { quick: true })), viewKey: key, stale: true };
  if (!cache.get('view', key)) cache.put('view', key, quick);
  refreshView(params, key);
  return withTracking(quick);
}

// One background refresh per view at a time. A request that comes in while
// one is running makes it run once more when it finishes, so nothing is
// missed. urgent (pushed new mail): sync right away on the foreground
// connection instead of waiting behind a background sync.
function refreshView(params: Inbox.ViewParams, key: string, { urgent = false } = {}): Promise<unknown> {
  if (urgent) return imap.inLane('fg', () => computeView(params, key)).catch(() => null);
  const running = refreshing.get(key);
  if (running) {
    running.again = true;
    return running.promise!;
  }
  const entry: { promise?: Promise<void>; again: boolean } = { again: false };
  entry.promise = (async () => {
    try {
      do {
        entry.again = false;
        await inBackground(() => computeView(params, key)).catch(() => null);
      } while (entry.again);
    } finally {
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, entry);
  return entry.promise!;
}

const computedAt = new Map<string, number>(); // view key -> when it was last synced
const startedSeq = new Map<string, number>(); // view key -> number of the latest sync started
const storedSeq = new Map<string, number>(); // view key -> number of the sync whose result is stored

async function computeView(params: Inbox.ViewParams, key: string): Promise<Inbox.ViewResult> {
  const seq = (startedSeq.get(key) || 0) + 1;
  startedSeq.set(key, seq);
  const data = withTracking({ ...(await listMessagesNow(params)), viewKey: key });
  // Syncs can overlap (a push during a background sync): never let an older
  // one overwrite a newer result.
  if (seq < (storedSeq.get(key) || 0)) return data;
  storedSeq.set(key, seq);
  computedAt.set(key, Date.now());
  const before = cache.get('view', key);
  cache.put('view', key, data);
  detectNewMail(params, data);
  if (!before || JSON.stringify(before) !== JSON.stringify(data)) events.emit('view', { key, data });
  return data;
}

// ---------- new mail alerts ----------

// Inbox messages already seen this session. The first up-to-date inbox only
// seeds it (no alerts for mail that arrived while the app was closed).
let inboxSeen: Set<string> | null = null;

function detectNewMail(params: Inbox.ViewParams, data: Inbox.ViewResult): void {
  const { folder = 'inbox', account = 'all', page = 1, q = '' } = params;
  if (folder !== 'inbox' || account !== 'all' || page !== 1 || q) return;
  const received = [...(data.sections || []).flatMap((s) => s.threads), ...data.threads].flatMap((t) =>
    t.messages.filter((m) => m.primary)
  );
  if (!inboxSeen) {
    inboxSeen = new Set(received.map(keyOf));
    return;
  }
  const fresh = received.filter(
    (m) => m.unread && !inboxSeen!.has(keyOf(m)) && Date.now() - new Date(m.date).getTime() < 24 * 3600 * 1000
  );
  received.forEach((m) => inboxSeen!.add(keyOf(m)));
  // Accounts with their own notifications switched off stay silent.
  const alerts = fresh.filter((m) => accounts().find((a) => a.id === m.accountId)?.notify !== false);
  if (!alerts.length) return;
  events.emit(
    'new-mail',
    alerts.map((m) => ({
      key: keyOf(m),
      account: accounts().find((a) => a.id === m.accountId)?.label || '',
      from: m.from.name || m.from.address || '',
      subject: m.subject || '(no subject)',
      snippet: m.snippet || '',
    }))
  );
}

// Which views lose a conversation when it's moved: archive leaves the inbox,
// trash/spam leave everything but Trash/Spam, "move to inbox" leaves Trash/Spam.
const LEAVES: Partial<Record<Inbox.Action, string[]>> = {
  archive: ['inbox'],
  trash: ['inbox', 'starred', 'sent', 'all', 'search', 'drafts'],
  spam: ['inbox', 'starred', 'all', 'search'],
  inbox: ['spam', 'trash'],
};

// Applies an action to the stored views right away (like Gmail updating its
// local store), so no view shows the old state while it re-syncs.
function patchViews(action: Inbox.Action, items: Inbox.ActionItem[]): void {
  const keys = new Set(items.map(keyOf));
  for (const [key, view] of cache.entries<Inbox.ViewResult>('view', '')) {
    const folder = JSON.parse(key)[0];
    let changed = false;
    const patch = (threads: Thread[]) =>
      threads.filter((t) => {
        if (!t.messages.some((m) => keys.has(keyOf(m)))) return true;
        changed = true;
        if (LEAVES[action]) return !LEAVES[action]!.includes(folder);
        for (const m of t.messages) {
          if (!keys.has(keyOf(m))) continue;
          if (action === 'read') m.unread = false;
          if (action === 'unread') m.unread = true;
          if (action === 'star') m.starred = true;
          if (action === 'unstar') m.starred = false;
        }
        t.unread = t.messages.some((m) => m.unread);
        t.starred = t.messages.some((m) => m.starred);
        if (action === 'important' || action === 'unimportant') markImportance([t]);
        return true;
      });
    view.threads = patch(view.threads);
    for (const s of view.sections || []) {
      const before = s.threads.length;
      s.threads = patch(s.threads);
      if (s.total != null) s.total -= before - s.threads.length;
    }
    if (changed) {
      cache.put('view', key, view);
      events.emit('view', { key, data: withTracking(view) });
    }
  }
}

// quick: rows only (no other folders, no previews yet), for a first paint.
async function listMessagesNow(
  { folder = 'inbox', account = 'all', page = 1, q = '', threading = true, inboxType = 'default', sectionPage = 1, sectionSize = 25 }: Inbox.ViewParams = {},
  { quick = false } = {}
): Promise<Inbox.ViewResult> {
  const size = sectionSizeOf(sectionSize);
  const targets = account === 'all' ? accounts() : [accountById(account)];
  const folderKey = q ? 'search' : folder;
  // "Unread first" / "Starred first" / "Important first": a section on top,
  // the rest below it, each with its own pages. Unread and starred are asked
  // of the server; importance is judged on the conversations already loaded.
  const sectioned = folder === 'inbox' && !q && SECTION_TITLES[inboxType];
  const sp = sectioned ? sectionPage : 1;
  // Several messages can share one row, so look further back than one page.
  const reach = inboxType === 'important' ? Math.max(page * PAGE_SIZE, (sp + 1) * size) : page * PAGE_SIZE;
  const need = Math.min(reach * 2, 1000);
  const main = collect(targets, (b, a) => (q ? b.search(a, q, need) : b.list(a, folder, need)), threading, folderKey, quick);
  const sectionNeed = Math.min(sp * size * 2, 1000);
  const section =
    sectioned && inboxType !== 'important'
      ? collect(targets, (b, a) => b.listFiltered(a, inboxType, sectionNeed), threading, 'inbox', quick)
      : null;

  const { complete, threads: all, errors } = await main;
  markImportance(all);
  const sections: Inbox.Section[] = [];
  let rest = all;
  if (sectioned) {
    const found = section ? await section : { complete: true, threads: all.filter((t) => t.important) };
    const sectionId = inboxType as Inbox.Section['id'];
    if (section) markImportance(found.threads);
    // Everything else leaves out the whole section, not just the page shown
    // (including section mail older than what the section looked at; the
    // section ids are the conversation fields: t.unread, t.starred, t.important).
    const inSection = new Set(found.threads.flatMap((t) => t.messages.map(keyOf)));
    rest = all.filter((t) => !t[sectionId] && !t.messages.some((m) => inSection.has(keyOf(m))));
    if (page === 1) {
      const n = found.threads.length;
      sections.push({
        id: sectionId,
        title: SECTION_TITLES[inboxType],
        threads: found.threads.slice((sp - 1) * size, sp * size),
        page: sp,
        pageSize: size,
        total: found.complete ? n : null, // null: "of many"
        hasMore: n > sp * size || !found.complete,
      });
    }
  }

  const threads = rest.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // Previews are only fetched for the rows actually shown (stored ones are free).
  if (!quick) await fillThreadSnippets([...sections.flatMap((s) => s.threads), ...threads]);
  else for (const t of [...sections.flatMap((s) => s.threads), ...threads]) for (const m of t.messages) delete m._text;

  return {
    total: complete ? rest.length : null, // null: more than we looked at ("of many")
    hasMore: rest.length > page * PAGE_SIZE || !complete,
    page,
    pageSize: PAGE_SIZE,
    sections,
    threads,
    errors,
  };
}

// Every conversation of a view (looking at its newest 1000 messages), for
// Gmail's "Select all N conversations". No previews: the window only needs to act on them.
export async function listEverything({ folder = 'inbox', account = 'all', q = '', threading = true }: Inbox.IpcArg<'listEverything'> = {}): Promise<Inbox.EverythingResult> {
  const targets = account === 'all' ? accounts() : [accountById(account)];
  const { complete, threads, errors } = await collect(
    targets,
    (b, a) => (q ? b.search(a, q, EVERYTHING_LIMIT) : b.list(a, folder, EVERYTHING_LIMIT)),
    threading,
    q ? 'search' : folder
  );
  markImportance(threads);
  for (const t of threads) for (const m of t.messages) delete m._text;
  return { complete, threads, errors };
}

// Downloads messages ahead of time on the background connection (one command
// per folder) and keeps them on disk, so opening them is instant.
export async function prefetch({ items }: { items: Inbox.MessageRef[] }): Promise<boolean> {
  return inBackground(async () => {
    for (const group of groupBy(items, (i) => `${i.accountId}\n${i.folder}`).values()) {
      const a = accounts().find((x) => x.id === group[0].accountId);
      if (a) await backend(a).prefetch(a, group[0].folder, group.map((i) => Number(i.uid))).catch(() => {});
    }
    return true;
  });
}

// The whole conversation a message belongs to, with previews for every message.
export async function getThread(params: Inbox.IpcArg<'getThread'>): Promise<Thread> {
  return params.background ? inBackground(() => getThreadNow(params)) : getThreadNow(params);
}

async function getThreadNow({ account, folder, uid }: Inbox.IpcArg<'getThread'>): Promise<Thread> {
  const a = accountById(account);
  const { target, candidates } = await backend(a).threadCandidates(a, folder, Number(uid));
  const key = keyOf(target);
  const thread = buildThreads([target], candidates).find((t) => t.messages.some((m) => keyOf(m) === key))!;
  await fillThreadSnippets([thread], true);
  markImportance([thread]);
  return markThread(thread);
}

function partUrl(msg: Inbox.MessageRef, idx: number): string {
  const p = new URLSearchParams({ a: msg.accountId, f: msg.folder, u: String(msg.uid), i: String(idx) });
  return `mailpart://att/?${p}`;
}

export async function getMessage({ account, folder, uid, markSeen = true }: Inbox.IpcArg<'getMessage'>): Promise<Inbox.FullMessage> {
  const a = accountById(account);
  const msg = await backend(a).get(a, folder, Number(uid), { markSeen });
  let html = msg.html || '';
  for (const att of msg.attachments) {
    att.url = partUrl(msg, att.idx);
    if (att.cid && html.includes(`cid:${att.cid}`)) {
      html = html.split(`cid:${att.cid}`).join(att.url);
      att.inline = true;
    }
  }
  // Our own tracking images never load in the app (that would count as an open).
  msg.html = tracking.stripPixels(html);
  msg.attachments = msg.attachments.filter((att) => !att.inline);
  return msg;
}

export async function getAttachment({ account, folder, uid, idx }: { account: string; folder: string; uid: number | string; idx: number | string }): Promise<AttachmentContent> {
  const a = accountById(account);
  const att = await backend(a).attachment(a, folder, Number(uid), Number(idx));
  if (!att) throw new Error('Attachment not found.');
  return att;
}

// Unread counts. { cached: true } answers instantly from the last known counts.
export async function counts(params: Inbox.IpcArg<'counts'> = {}): Promise<Inbox.Counts> {
  if (params?.cached) return cache.get<Inbox.Counts>('counts', 'all') || {};
  const list = accounts();
  const results = await inBackground(() => Promise.allSettled(list.map((a) => backend(a).counts(a))));
  const out: Inbox.Counts = {};
  results.forEach((r, i) => {
    out[list[i].id] = r.status === 'fulfilled' ? r.value : { error: backend(list[i]).friendlyError(r.reason, list[i]) };
  });
  cache.put('counts', 'all', out);
  return out;
}

// ---------- actions ----------

type Run = (b: Backend<AnyAccount>, a: AnyAccount, f: string, uids: number[]) => Promise<unknown>;
const ACTIONS: Record<Inbox.Action, Run> = {
  read: (b, a, f, uids) => b.setFlags(a, f, uids, { seen: true }),
  unread: (b, a, f, uids) => b.setFlags(a, f, uids, { seen: false }),
  star: (b, a, f, uids) => b.setFlags(a, f, uids, { flagged: true }),
  unstar: (b, a, f, uids) => b.setFlags(a, f, uids, { flagged: false }),
  archive: (b, a, f, uids) => b.move(a, f, uids, 'archive'),
  spam: (b, a, f, uids) => b.move(a, f, uids, 'spam'),
  inbox: (b, a, f, uids) => b.move(a, f, uids, 'inbox'),
  trash: (b, a, f, uids) => b.remove(a, f, uids),
  important: (b, a, f, uids) => b.setImportant(a, f, uids, true),
  unimportant: (b, a, f, uids) => b.setImportant(a, f, uids, false),
};

export async function act({ action, items }: Inbox.IpcArg<'act'>): Promise<boolean> {
  const run = ACTIONS[action];
  if (!run) throw new Error(`Unknown action: ${action}`);
  // Your importance choice is remembered here (and also set on Gmail's label).
  // Marking a sender's mail not important does so for everything they send;
  // marking one of theirs important again lifts that.
  if (action === 'important' || action === 'unimportant') {
    const me = new Set(accounts().map((a) => a.email.toLowerCase()));
    for (const i of items) {
      if (i.messageId) cache.put('imp', `${i.accountId}:${String(i.messageId).toLowerCase()}`, action === 'important');
      const from = String(i.from || '').toLowerCase();
      if (from && !me.has(from)) cache.put('impSender', from, action === 'important' ? null : false);
    }
  }
  const groups = groupBy(items, (i) => `${i.accountId}\n${i.folder}`);
  const results = await Promise.allSettled(
    [...groups.values()].map((group) => {
      const a = accountById(group[0].accountId);
      return run(backend(a), a, group[0].folder, group.map((i) => Number(i.uid)));
    })
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) throw new Error((failed[0] as PromiseRejectedResult).reason?.message || 'Action failed');
  patchViews(action, items);
  return true;
}

// ---------- sending ----------

export async function send(mail: Inbox.OutgoingMail): Promise<Inbox.SendResult> {
  const a = accountById(mail.account);
  if (!String(mail.to || '').trim() && !String(mail.cc || '').trim() && !String(mail.bcc || '').trim()) {
    throw new Error('Please specify at least one recipient.');
  }
  const attachments: AttachmentContent[] = (mail.attachments || []).map((f) => ({
    filename: f.filename,
    contentType: f.contentType || 'application/octet-stream',
    content: Buffer.from(f.data),
  }));
  if (mail.forward) {
    const src = accountById(mail.forward.accountId);
    attachments.push(...(await backend(src).forwardAttachments(src, mail.forward.folder, Number(mail.forward.uid))));
  }
  const size = attachments.reduce((n, f) => n + f.content.length, 0);
  if (size > MAX_ATTACHMENT_BYTES) throw new Error('Attachments are larger than 25 MB.');

  // Replies carry the quoted original, kept apart from what you typed (the
  // window shows it behind "•••"), in both the text and the HTML version.
  const text = mail.text || '';
  const quote = mail.quote?.text
    ? { attribution: String(mail.quote.attribution || ''), text: String(mail.quote.text).slice(0, 200000) }
    : null;
  const fullText = quote ? [text.trimEnd(), quotedPlainText(quote)].filter(Boolean).join('\n\n') : text;
  // Read tracking: the HTML version carries the invisible tracking image.
  const pixel = mail.track && tracking.configured() ? tracking.newPixel() : null;
  const html = composeHtml(text, quote);
  const messageId = await backend(a).send(a, {
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject || '',
    text: fullText,
    html: quote || pixel ? html + (pixel ? pixel.html : '') : undefined,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    attachments,
  });
  if (pixel) tracking.record(messageId, { id: pixel.id, accountId: a.id, to: mail.to || mail.cc || mail.bcc, subject: mail.subject || '' });
  // What the window needs to show the message at once, before the server lists
  // it (never includes the tracking image, which would count as an open).
  return { messageId, html, text: fullText, sentAt: new Date().toISOString() };
}

// ---------- accounts ----------

function normalizeServer(server: Partial<Inbox.ServerConfig> | undefined, fallback: Inbox.ServerConfig): Inbox.ServerConfig {
  if (!server?.host) return { ...fallback };
  return { host: String(server.host).trim(), port: Number(server.port) || fallback.port, secure: !!server.secure };
}

function buildAccount(form: Partial<Inbox.AccountForm>) {
  const email = String(form.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  const provider = PROVIDERS[form.provider as Inbox.ProviderId] ? (form.provider as Inbox.ProviderId) : guessProvider(email);
  const preset = PROVIDERS[provider];
  const account: Omit<Account, 'id' | 'pass'> & { pass?: string } = {
    provider,
    email,
    user: String(form.user || '').trim() || email,
    label: String(form.label || '').trim() || email.split('@')[0],
    senderName: String(form.senderName || '').trim(),
    color: /^#[0-9a-f]{6}$/i.test(form.color as string) ? (form.color as string) : '#1a73e8',
    imap: normalizeServer(form.imap, preset.imap),
    smtp: normalizeServer(form.smtp, preset.smtp),
  };
  if (!account.imap.host || !account.smtp.host) throw new Error('Enter the IMAP and SMTP server names.');
  return account;
}

function cleanPassword(pass: string | undefined, provider: string): string {
  const p = String(pass || '');
  // Google shows app passwords in groups of four separated by spaces.
  return provider === 'gmail' ? p.replace(/\s+/g, '') : p;
}

export async function addAccount(form: Inbox.AccountForm) {
  const account = buildAccount(form);
  account.pass = cleanPassword(form.pass, account.provider);
  if (!account.pass) throw new Error('Enter the app password for this account.');
  if (store.getAccounts().some((a) => a.email.toLowerCase() === account.email.toLowerCase())) {
    throw new Error('That account is already connected.');
  }
  await imap.test(account as Account);
  const saved = store.addAccount(account as Omit<Account, 'id'>);
  cache.clearNs('view'); // stored views don't include the new account yet
  inboxSeen = null; // its existing mail isn't "new"
  imap.watch(store.getAccounts().find((a) => a.id === saved.id)!, onMailPushed);
  return store.publicAccount(saved);
}

export async function updateAccount(form: Inbox.AccountForm) {
  const existing = store.getAccounts().find((a) => a.id === form.id);
  if (!existing) throw new Error('That account no longer exists.');
  const next = buildAccount({ ...existing, ...form });
  const pass = form.pass ? cleanPassword(form.pass, next.provider) : existing.pass;
  const credentialsChanged =
    pass !== existing.pass ||
    next.user !== existing.user ||
    JSON.stringify([next.imap, next.smtp]) !== JSON.stringify([existing.imap, existing.smtp]);
  if (credentialsChanged) await imap.test({ ...next, pass } as Account);
  imap.disconnect(existing.id);
  const updated = store.updateAccount(existing.id, { ...next, pass: form.pass ? pass : undefined })!;
  cache.clearNs('view'); // label and color are part of stored views
  inboxSeen = null;
  imap.watch(updated, onMailPushed);
  return store.publicAccount(updated);
}

export function removeAccount({ id }: { id: string }): boolean {
  imap.disconnect(id);
  store.removeAccount(id);
  cache.forgetAccount(id);
  cache.clearNs('view');
  inboxSeen = null;
  return true;
}

// Neither of these touches the connection or the stored views, so they apply instantly.
export function reorderAccounts({ ids }: { ids: string[] }): boolean {
  store.reorderAccounts(ids);
  return true;
}

export function setAccountNotify({ id, notify }: { id: string; notify: boolean }): boolean {
  if (!store.updateAccount(id, { notify: !!notify })) throw new Error('That account no longer exists.');
  return true;
}

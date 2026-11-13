// Merges every connected account into one mailbox view. Uses the demo backend
// until the first real account is added.
//
// Views are served Gmail-style from the local database first ("stale while
// revalidate"): a list you've seen before comes back instantly, a background
// sync brings it up to date, and changes are announced through `events`.
const { EventEmitter } = require('events');
const store = require('./store');
const cache = require('./cache');
const tracking = require('./tracking');
const imap = require('./imap');
const demo = require('./demo');
const { PROVIDERS, guessProvider } = require('./providers');

// 'view' {key, data} | 'mail' accountId | 'new-mail' [messages] | 'opened' {record, open}
const events = new EventEmitter();

const PAGE_SIZE = 50;
const EVERYTHING_LIMIT = 1000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function accounts() {
  const real = store.getAccounts();
  return real.length ? real : demo.ACCOUNTS;
}

const backend = (account) => (account.demo ? demo : imap);

function accountById(id) {
  const account = accounts().find((a) => a.id === id);
  if (!account) throw new Error('That account no longer exists.');
  return account;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function getState() {
  const real = store.getAccounts();
  return {
    demo: real.length === 0,
    accounts: accounts().map(store.publicAccount),
    providers: PROVIDERS,
  };
}

// Background work (syncing, counts, prefetch) uses each account's second IMAP connection.
const inBackground = (fn) => imap.inLane('bg', fn);

function initCache(dataDir) {
  cache.init(dataDir);
  tracking.init(dataDir);
}

// ---------- read tracking (like Mailsuite) ----------

// Each tracked message gets .track; a conversation shows the state of the
// last tracked message in it (✓ sent, ✓✓ opened).
function markThread(t) {
  let last = null;
  for (const m of t.messages) {
    m.track = tracking.statusFor(m.messageId);
    if (m.track) last = m.track;
  }
  t.track = last;
  return t;
}

function withTracking(data) {
  for (const t of [...(data.sections || []).flatMap((s) => s.threads), ...(data.threads || [])]) markThread(t);
  return data;
}

// Checks the tracker for opens; announces new ones (for alerts and the ✓✓ marks).
async function pollTracking() {
  const opened = await tracking.poll().catch(() => []);
  if (opened.length) events.emit('opened', opened);
  return opened.length;
}

const trackingConfig = () => tracking.publicConfig();
const setTracking = (config) => tracking.setConfig(config);

// ---------- outgoing message bodies ----------

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const QUOTE_OPEN =
  '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">';

// Plain-text quoting ("> " per level) as HTML: nested blockquotes, like Gmail.
function quoteToHtml(text) {
  let depth = 0;
  let out = '';
  for (const line of String(text).replace(/\s+$/, '').split(/\r?\n/)) {
    const m = line.match(/^((?:\s*>)*)\s?(.*)$/);
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
function quotedPlainText(quote) {
  const lines = String(quote.text)
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map((l) => (l ? `> ${l}` : '>'));
  return `${quote.attribution}\n${lines.join('\n')}`;
}

// The HTML part: your text, then (for replies) the quoted original in the
// structure Gmail uses, so mail apps (this one too) fold it behind "•••".
// The "ui-simple" marker lets this app show it like plain text in dark mode.
function composeHtml(text, quote) {
  let html = `<div class="ui-simple" dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
  if (quote) {
    html += `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(quote.attribution)}<br></div>${QUOTE_OPEN}${quoteToHtml(quote.text)}</blockquote></div>`;
  }
  return html;
}

function flushCache() {
  cache.flush();
}

function warmUp() {
  for (const a of accounts()) backend(a).warmUp(a);
}

// New mail is pushed by the server (IMAP IDLE) instead of waiting for a poll.
function startWatching() {
  for (const a of store.getAccounts()) imap.watch(a, onMailPushed);
}

// The server reported a change in an account's Inbox: re-sync the inbox views
// that include it right away (the window gets them as 'view' events), then
// tell the window so it can refresh counts.
async function onMailPushed(accountId) {
  const keys = new Set(cache.entries('view', '').map(([key]) => key));
  keys.add(viewKeyOf({})); // the unified inbox, even if it was never opened
  const views = [...keys]
    .map((key) => ({ key, v: JSON.parse(key) }))
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
const isAutomated = (address) => {
  const name = address.split('@')[0];
  return AUTOMATED.test(name) || NO_REPLY.test(name);
};

const addressOf = (a) => String(a?.address || '').toLowerCase();

// Your own choice (for the message, then for its sender) always wins. After
// that, mail from automated senders (no-reply@, support@, …) and a message
// that starts a new conversation (not a reply, nothing else in its thread)
// are never important. Otherwise Gmail accounts use Gmail's own verdict (its
// \Important label); for other accounts, ongoing conversations are important
// unless they're bulk mail (mailing lists, newsletters), and high priority
// mail always is.
function markImportance(threads) {
  for (const t of threads) {
    for (const m of t.messages) {
      const from = addressOf(m.from);
      const choice = m.messageId ? cache.get('imp', `${m.accountId}:${String(m.messageId).toLowerCase()}`) : undefined;
      const startsConversation = t.messages.length === 1 && !m.inReplyTo && !m.references?.length;
      m.important =
        choice ??
        cache.get('impSender', from) ??
        (isAutomated(from) || startsConversation
          ? false
          : m.gmImportant ?? (!!m.priorityHigh || !m.bulk));
    }
    t.important = t.messages.some((m) => m.important);
  }
  return threads;
}

// ---------- conversations ----------

const keyOf = (m) => `${m.accountId}|${m.folder}|${m.uid}`;

// Folders whose rows also pull in replies from other folders (like Sent).
const THREADED = new Set(['inbox', 'starred', 'sent', 'all', 'search']);

// Groups messages into conversations, Gmail style. `primary` are the messages
// of the folder being viewed; `extra` are messages from elsewhere that only
// join a conversation if it already has a primary message. Gmail conversation
// IDs are used when present, otherwise Message-ID / In-Reply-To / References.
function buildThreads(primary, extra) {
  const all = [];
  const seen = new Map(); // id -> the copy kept
  for (const [list, isPrimary] of [[primary, true], [extra, false]]) {
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

  const parent = new Map();
  const root = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const join = (a, b) => parent.set(root(a), root(b));
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

  const threads = [];
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
      roles: [...new Set(members.map((m) => m.role).filter(Boolean))],
      draft: members.some((m) => m.draft),
      count: members.length,
      messages: members,
    });
  }
  return threads;
}

// With conversation view off, every message is its own row.
function singleThreads(primary) {
  return primary.map((m) => buildThreads([m], [])[0]);
}

async function fillThreadSnippets(threads, all = false) {
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
async function collect(targets, fetch, threaded, folderKey, quick = false) {
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
  const threads = [];
  const errors = [];
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

const SECTION_TITLES = { unread: 'Unread', starred: 'Starred', important: 'Important' };
const SECTION_SIZES = [5, 10, 25, 50]; // Gmail's "Show up to N items"
const sectionSizeOf = (n) => (SECTION_SIZES.includes(Number(n)) ? Number(n) : 25);

// sectionPage: the page of the inbox-type section (Important / Unread / Starred), paged on its own like Gmail's.
// sectionSize: how many conversations one page of that section shows.
const viewKeyOf = ({ folder = 'inbox', account = 'all', page = 1, q = '', threading = true, inboxType = 'default', sectionPage = 1, sectionSize = 25 }) =>
  JSON.stringify([q ? 'search' : folder, account, page, q, threading, inboxType, sectionPage, sectionSizeOf(sectionSize)]);

const refreshing = new Map(); // view key -> { promise, again } for the in-flight background refresh

// A view from the local database if we have one (marked stale, refreshed in
// the background), otherwise fetched now. `fresh` skips the stored copy.
async function listMessages(params = {}) {
  const key = viewKeyOf(params);
  const stored = params.fresh ? null : cache.get('view', key);
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
function refreshView(params, key, { urgent = false } = {}) {
  if (urgent) return imap.inLane('fg', () => computeView(params, key)).catch(() => null);
  const running = refreshing.get(key);
  if (running) {
    running.again = true;
    return running.promise;
  }
  const entry = { again: false };
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
  return entry.promise;
}

const computedAt = new Map(); // view key -> when it was last synced
const startedSeq = new Map(); // view key -> number of the latest sync started
const storedSeq = new Map(); // view key -> number of the sync whose result is stored

async function computeView(params, key) {
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
let inboxSeen = null;

function detectNewMail(params, data) {
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
    (m) => m.unread && !inboxSeen.has(keyOf(m)) && Date.now() - new Date(m.date) < 24 * 3600 * 1000
  );
  received.forEach((m) => inboxSeen.add(keyOf(m)));
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
const LEAVES = {
  archive: ['inbox'],
  trash: ['inbox', 'starred', 'sent', 'all', 'search', 'drafts'],
  spam: ['inbox', 'starred', 'all', 'search'],
  inbox: ['spam', 'trash'],
};

// Applies an action to the stored views right away (like Gmail updating its
// local store), so no view shows the old state while it re-syncs.
function patchViews(action, items) {
  const keys = new Set(items.map(keyOf));
  for (const [key, view] of cache.entries('view', '')) {
    const folder = JSON.parse(key)[0];
    let changed = false;
    const patch = (threads) =>
      threads.filter((t) => {
        if (!t.messages.some((m) => keys.has(keyOf(m)))) return true;
        changed = true;
        if (LEAVES[action]) return !LEAVES[action].includes(folder);
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
  { folder = 'inbox', account = 'all', page = 1, q = '', threading = true, inboxType = 'default', sectionPage = 1, sectionSize = 25 } = {},
  { quick = false } = {}
) {
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
  const sections = [];
  let rest = all;
  if (sectioned) {
    const found = section ? await section : { complete: true, threads: all.filter((t) => t.important) };
    if (section) markImportance(found.threads);
    // Everything else leaves out the whole section, not just the page shown
    // (including section mail older than what the section looked at; the
    // section ids are the conversation fields: t.unread, t.starred, t.important).
    const inSection = new Set(found.threads.flatMap((t) => t.messages.map(keyOf)));
    rest = all.filter((t) => !t[inboxType] && !t.messages.some((m) => inSection.has(keyOf(m))));
    if (page === 1) {
      const n = found.threads.length;
      sections.push({
        id: inboxType,
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
async function listEverything({ folder = 'inbox', account = 'all', q = '', threading = true } = {}) {
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
async function prefetch({ items }) {
  return inBackground(async () => {
    for (const group of groupBy(items, (i) => `${i.accountId}\n${i.folder}`).values()) {
      const a = accounts().find((x) => x.id === group[0].accountId);
      if (a) await backend(a).prefetch(a, group[0].folder, group.map((i) => Number(i.uid))).catch(() => {});
    }
    return true;
  });
}

// The whole conversation a message belongs to, with previews for every message.
async function getThread(params) {
  return params.background ? inBackground(() => getThreadNow(params)) : getThreadNow(params);
}

async function getThreadNow({ account, folder, uid }) {
  const a = accountById(account);
  const { target, candidates } = await backend(a).threadCandidates(a, folder, Number(uid));
  const key = keyOf(target);
  const thread = buildThreads([target], candidates).find((t) => t.messages.some((m) => keyOf(m) === key));
  await fillThreadSnippets([thread], true);
  markImportance([thread]);
  return markThread(thread);
}

function partUrl(msg, idx) {
  const p = new URLSearchParams({ a: msg.accountId, f: msg.folder, u: String(msg.uid), i: String(idx) });
  return `mailpart://att/?${p}`;
}

async function getMessage({ account, folder, uid, markSeen = true }) {
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

async function getAttachment({ account, folder, uid, idx }) {
  const a = accountById(account);
  const att = await backend(a).attachment(a, folder, Number(uid), Number(idx));
  if (!att) throw new Error('Attachment not found.');
  return att;
}

// Unread counts. { cached: true } answers instantly from the last known counts.
async function counts(params = {}) {
  if (params.cached) return cache.get('counts', 'all') || {};
  const list = accounts();
  const results = await inBackground(() => Promise.allSettled(list.map((a) => backend(a).counts(a))));
  const out = {};
  results.forEach((r, i) => {
    out[list[i].id] = r.status === 'fulfilled' ? r.value : { error: backend(list[i]).friendlyError(r.reason, list[i]) };
  });
  cache.put('counts', 'all', out);
  return out;
}

// ---------- actions ----------

const ACTIONS = {
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

async function act({ action, items }) {
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
  if (failed.length) throw new Error(failed[0].reason?.message || 'Action failed');
  patchViews(action, items);
  return true;
}

// ---------- sending ----------

async function send(mail) {
  const a = accountById(mail.account);
  if (!String(mail.to || '').trim() && !String(mail.cc || '').trim() && !String(mail.bcc || '').trim()) {
    throw new Error('Please specify at least one recipient.');
  }
  const attachments = (mail.attachments || []).map((f) => ({
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

function normalizeServer(server, fallback) {
  if (!server?.host) return { ...fallback };
  return { host: String(server.host).trim(), port: Number(server.port) || fallback.port, secure: !!server.secure };
}

function buildAccount(form) {
  const email = String(form.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  const provider = PROVIDERS[form.provider] ? form.provider : guessProvider(email);
  const preset = PROVIDERS[provider];
  const account = {
    provider,
    email,
    user: String(form.user || '').trim() || email,
    label: String(form.label || '').trim() || email.split('@')[0],
    senderName: String(form.senderName || '').trim(),
    color: /^#[0-9a-f]{6}$/i.test(form.color) ? form.color : '#1a73e8',
    imap: normalizeServer(form.imap, preset.imap),
    smtp: normalizeServer(form.smtp, preset.smtp),
  };
  if (!account.imap.host || !account.smtp.host) throw new Error('Enter the IMAP and SMTP server names.');
  return account;
}

function cleanPassword(pass, provider) {
  const p = String(pass || '');
  // Google shows app passwords in groups of four separated by spaces.
  return provider === 'gmail' ? p.replace(/\s+/g, '') : p;
}

async function addAccount(form) {
  const account = buildAccount(form);
  account.pass = cleanPassword(form.pass, account.provider);
  if (!account.pass) throw new Error('Enter the app password for this account.');
  if (store.getAccounts().some((a) => a.email.toLowerCase() === account.email.toLowerCase())) {
    throw new Error('That account is already connected.');
  }
  await imap.test(account);
  const saved = store.addAccount(account);
  cache.clearNs('view'); // stored views don't include the new account yet
  inboxSeen = null; // its existing mail isn't "new"
  imap.watch(store.getAccounts().find((a) => a.id === saved.id), onMailPushed);
  return store.publicAccount(saved);
}

async function updateAccount(form) {
  const existing = store.getAccounts().find((a) => a.id === form.id);
  if (!existing) throw new Error('That account no longer exists.');
  const next = buildAccount({ ...existing, ...form });
  const pass = form.pass ? cleanPassword(form.pass, next.provider) : existing.pass;
  const credentialsChanged =
    pass !== existing.pass ||
    next.user !== existing.user ||
    JSON.stringify([next.imap, next.smtp]) !== JSON.stringify([existing.imap, existing.smtp]);
  if (credentialsChanged) await imap.test({ ...next, pass });
  imap.disconnect(existing.id);
  const updated = store.updateAccount(existing.id, { ...next, pass: form.pass ? pass : undefined });
  cache.clearNs('view'); // label and color are part of stored views
  inboxSeen = null;
  imap.watch(updated, onMailPushed);
  return store.publicAccount(updated);
}

function removeAccount({ id }) {
  imap.disconnect(id);
  store.removeAccount(id);
  cache.forgetAccount(id);
  cache.clearNs('view');
  inboxSeen = null;
  return true;
}

// Neither of these touches the connection or the stored views, so they apply instantly.
function reorderAccounts({ ids }) {
  store.reorderAccounts(ids);
  return true;
}

function setAccountNotify({ id, notify }) {
  if (!store.updateAccount(id, { notify: !!notify })) throw new Error('That account no longer exists.');
  return true;
}

module.exports = {
  events,
  initCache,
  flushCache,
  pollTracking,
  trackingConfig,
  setTracking,
  getState,
  warmUp,
  startWatching,
  listMessages,
  listEverything,
  getThread,
  getMessage,
  prefetch,
  getAttachment,
  counts,
  act,
  send,
  addAccount,
  updateAccount,
  removeAccount,
  reorderAccounts,
  setAccountNotify,
};

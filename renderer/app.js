'use strict';

// `api` is the bridge exposed by preload.js (window.api).
const $ =(sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FOLDERS = [
  { key: 'inbox', label: 'Inbox', icon: 'inbox' },
  { key: 'starred', label: 'Starred', icon: 'star' },
  { key: 'sent', label: 'Sent', icon: 'send' },
  { key: 'drafts', label: 'Drafts', icon: 'draft' },
  { key: 'spam', label: 'Spam', icon: 'report', more: true },
  { key: 'trash', label: 'Trash', icon: 'delete', more: true },
  { key: 'all', label: 'All Mail', icon: 'mail', more: true },
];

const EMPTY = {
  inbox: ['inbox', 'Your inbox is empty', 'New mail from all of your accounts shows up here.'],
  starred: ['star', 'No starred messages', 'Stars let you give messages a special status to make them easier to find.'],
  sent: ['send', 'No sent messages', 'Messages you send from any account will appear here.'],
  drafts: ['draft', 'No saved drafts', ''],
  spam: ['report', 'Hooray, no spam here!', ''],
  trash: ['delete', 'Nothing in Trash', ''],
  all: ['mail', 'No mail', ''],
};

// An inbox-type section with nothing in it (on this page).
const SECTION_EMPTY = {
  unread: "Woohoo! You've read all the messages in your inbox.",
  starred: 'No starred messages.',
  important: 'No important messages.',
};

const ACCOUNT_COLORS = ['#1a73e8', '#188038', '#a142f4', '#d93025', '#e8710a', '#f9ab00', '#12b5cb', '#e52592'];
const AVATAR_COLORS = ['#e8710a', '#188038', '#d93025', '#1a73e8', '#9334e6', '#e52592', '#12b5cb', '#5f6368', '#c26401', '#00796b'];
// New Inbox mail is pushed by the server (IMAP IDLE); this is only a fallback
// for changes elsewhere, like other folders or mail read on another device.
const POLL_MS = 2 * 60 * 1000;

const state = {
  accounts: [],
  providers: {},
  demo: false,
  route: { folder: 'inbox', account: 'all', page: 1, spage: 1, q: '', open: null },
  list: null,
  loading: false,
  listReq: 0,
  selected: new Set(),
  lastSelectIdx: -1,
  // "Select all N conversations": every conversation of the view, not just this page.
  bulk: null, // { threads, byKey, complete }
  bulkLoading: false,
  focusKey: null, // keyboard cursor (j/k), tracked by conversation so it survives refreshes
  counts: {},
  thread: null, // the open conversation
  settings: {},
  qsOpen: false,
  collapsedSections: new Set(),
  // Last result per view, shown instantly when you come back to it (then refreshed).
  listCache: new Map(),
  badge: -1,
  compose: null,
  moreOpen: false,
  tracking: { url: '', configured: false }, // read-tracking server (see /tracker)
  lastChecked: 0,
  searchAccount: null, // the account the search bar searches (follows the account being viewed)
  accountBeforeSearch: 'all', // where leaving a search goes back to
};

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- search highlighting ----------

// The words of a search worth highlighting: quoted phrases stay whole, values
// of from:/to:/subject: count, filters like is:unread or has:attachment and
// excluded (-word) terms don't.
const NON_TEXT_OPS = new Set(['is', 'has', 'in', 'label', 'before', 'after', 'older', 'newer', 'older_than', 'newer_than', 'larger', 'smaller', 'size', 'category', 'filename', 'list', 'deliveredto', 'rfc822msgid']);
let hlCache = { q: null, re: null };
function searchRegex(q) {
  if (hlCache.q === q) return hlCache.re;
  const terms = [];
  for (const [, neg, op, phrase, word] of String(q || '').matchAll(/(-?)(?:([a-z_]+):)?(?:"([^"]*)"|([^\s"]+))/gi)) {
    if (neg || (op && NON_TEXT_OPS.has(op.toLowerCase()))) continue;
    const t = (phrase ?? word).replace(/^[({]+|[)}]+$/g, '').trim();
    if (!t || (!phrase && /^(OR|AND)$/.test(t))) continue;
    terms.push(t);
  }
  const uniq = [...new Set(terms.map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
  const re = uniq.length ? new RegExp(uniq.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi') : null;
  hlCache = { q, re };
  return re;
}

// Escaped text with the current search's words marked.
function hl(text) {
  const re = state.route.q ? searchRegex(state.route.q) : null;
  const s = String(text ?? '');
  if (!re) return esc(s);
  let out = '';
  let last = 0;
  for (const m of s.matchAll(re)) {
    out += esc(s.slice(last, m.index)) + `<mark class="hl">${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

// Marks the search's words inside an opened message (its own document).
function highlightDocument(doc, q) {
  const re = q ? searchRegex(q) : null;
  if (!re || !doc?.body) return;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('script,style,noscript,textarea,mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const mark = doc.createElement('mark');
      mark.className = 'ui-hl';
      mark.textContent = m[0];
      frag.append(mark);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

const keyOf = (m) => `${m.accountId}|${m.folder}|${m.uid}`;

function parseKey(key) {
  const parts = key.split('|');
  return { accountId: parts[0], folder: parts.slice(1, -1).join('|'), uid: Number(parts[parts.length - 1]) };
}

const accountById = (id) => state.accounts.find((a) => a.id === id);
const isMe = (address) => state.accounts.some((a) => a.email.toLowerCase() === String(address || '').toLowerCase());

function displayName(addr) {
  if (!addr) return '';
  if (isMe(addr.address)) return 'me';
  return addr.name || addr.address || '';
}

const formatAddress = (x) => (x.name ? `${x.name} <${x.address}>` : x.address);

function colorFor(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initial(addr) {
  const s = String(addr?.name || addr?.address || '?');
  return (s.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
}

function formatListDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: '2-digit', month: 'numeric', day: 'numeric' });
}

function formatFullDate(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function timeAgo(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return '';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(contentType = '', filename = '') {
  const ext = filename.split('.').pop().toLowerCase();
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf' || ext === 'pdf') return 'picture_as_pdf';
  if (contentType === 'text/calendar' || ext === 'ics') return 'calendar_month';
  if (['csv', 'xls', 'xlsx'].includes(ext)) return 'table';
  if (['zip', 'rar', '7z', 'gz'].includes(ext)) return 'folder_zip';
  if (contentType.startsWith('audio/')) return 'audio_file';
  if (contentType.startsWith('video/')) return 'video_file';
  return 'description';
}

function prefixSubject(prefix, subject) {
  const re = new RegExp(`^${prefix.replace(':', '')}:`, 'i');
  return re.test(subject || '') ? subject : `${prefix} ${subject || ''}`.trim();
}

function totals() {
  const t = { inbox: 0, spam: 0, drafts: 0 };
  for (const a of state.accounts) {
    const c = state.counts[a.id];
    if (!c || c.error) continue;
    t.inbox += c.inbox || 0;
    t.spam += c.spam || 0;
    t.drafts += c.drafts || 0;
  }
  return t;
}

function guessProvider(email) {
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  if (['gmail.com', 'googlemail.com'].includes(domain)) return 'gmail';
  if (domain.startsWith('yahoo.') || domain === 'ymail.com') return 'yahoo';
  if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) return 'icloud';
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook';
  return null;
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

// ---------- routing (state lives in the URL hash, like Gmail) ----------

function readRoute() {
  const p = new URLSearchParams(location.hash.slice(1));
  const folder = FOLDERS.some((f) => f.key === p.get('f')) ? p.get('f') : 'inbox';
  return {
    folder,
    account: p.get('a') || 'all',
    page: Math.max(1, Number(p.get('p')) || 1),
    spage: Math.max(1, Number(p.get('sp')) || 1), // page of the Important / Unread / Starred section
    q: p.get('q') || '',
    open: p.get('m') || null,
  };
}

function go(changes) {
  const r = { ...state.route, ...changes };
  // Leaving a search goes back to the account the list was showing before it.
  if (state.route.q && !r.q && !('account' in changes)) r.account = state.accountBeforeSearch;
  // The section's page only lasts while you stay on the same list.
  if (!('spage' in changes) && listKey(r) !== listKey(state.route)) r.spage = 1;
  const p = new URLSearchParams();
  p.set('f', r.folder);
  if (r.account !== 'all') p.set('a', r.account);
  if (r.page > 1) p.set('p', String(r.page));
  if (r.spage > 1) p.set('sp', String(r.spage));
  if (r.q) p.set('q', r.q);
  if (r.open) p.set('m', r.open);
  const hash = `#${p}`;
  if (location.hash === hash) onRoute();
  else location.hash = hash;
}

const listKey = (r) => `${r.folder}|${r.account}|${r.page}|${r.spage}|${r.q}`;
// The section only shows on the inbox's first page, so that's the only place its page counts.
const sectionPageOf = (r) =>
  r.folder === 'inbox' && !r.q && r.page === 1 && state.settings.inboxType !== 'default' ? r.spage : 1;
// Cache key: the view plus the settings that change what it shows.
// The same key the main process stores views under (lib/service.js viewKeyOf).
const cacheKey = (r) =>
  JSON.stringify([r.q ? 'search' : r.folder, r.account, r.page, r.q, state.settings.threading, state.settings.inboxType, sectionPageOf(r), state.settings.sectionSize]);

// The account the search bar will search: the last one viewed or picked, else the first.
function searchAccountId() {
  return (accountById(state.searchAccount || storage('searchAccount')) || state.accounts[0])?.id || 'all';
}

// Picking another account while results are showing searches that account instead.
function pickSearchAccount(id) {
  state.searchAccount = id;
  storage('searchAccount', id);
  renderTopbar();
  const q = $('#search-input').value.trim();
  if (state.route.q && q) go({ q, account: id, page: 1, open: null });
  else $('#search-input').focus();
}

function onRoute() {
  const prev = state.route;
  const next = readRoute();
  if (next.account !== 'all' && !accountById(next.account)) next.account = 'all';
  if (next.account !== 'all' && next.account !== prev.account) state.searchAccount = next.account;
  // A search always covers exactly one account.
  if (next.q && next.account === 'all') next.account = searchAccountId();
  state.route = next;
  $('#search-input').value = next.q;
  $('#search-form').classList.toggle('has-text', !!next.q);

  if (listKey(prev) !== listKey(next) || !state.list) {
    state.selected.clear();
    state.bulk = null;
    state.focusKey = null;
    // Show the last copy of this view right away, then refresh it quietly.
    const cached = state.listCache.get(cacheKey(next));
    state.list = cached || null;
    loadList({ silent: !!cached });
  }
  if (next.open) {
    if (state.thread?.key !== next.open) openThread(next.open);
    else render();
  } else {
    state.thread = null;
    render();
  }
}

// ---------- data loading ----------

// Every row on screen: the inbox-type section (if any) first, then the rest.
const threadsOf = () => [...(state.list?.sections || []).flatMap((s) => s.threads), ...(state.list?.threads || [])];

// The conversation a key belongs to: its row key or the key of any of its messages.
const findThread = (key) =>
  threadsOf().find((t) => t.key === key || t.messages.some((m) => keyOf(m) === key)) || state.bulk?.byKey.get(key);

const isUnifiedInbox = (r) => r.folder === 'inbox' && r.account === 'all' && r.page === 1 && !r.q;

// The main process answers from its local database right away (a "stale"
// copy) and syncs in the background; the up-to-date view then arrives through
// onViewUpdated. fresh: skip the stored copy (the Refresh button).
// background: a refresh nobody is waiting for, on the accounts' second connection.
async function loadList({ silent = false, background = false, fresh = false } = {}) {
  const req = ++state.listReq;
  const r = state.route;
  if (!silent) {
    state.loading = true;
    render();
  }
  try {
    const data = await api.listMessages({
      folder: r.folder,
      account: r.account,
      page: r.page,
      q: r.q,
      threading: state.settings.threading,
      inboxType: state.settings.inboxType,
      sectionPage: sectionPageOf(r),
      sectionSize: state.settings.sectionSize,
      background,
      fresh,
    });
    if (req !== state.listReq) return;
    showList(data);
  } catch (err) {
    if (req !== state.listReq) return;
    if (!state.list) state.list = { total: 0, hasMore: false, sections: [], threads: [], errors: [{ accountId: null, message: err.message }] };
  } finally {
    if (req === state.listReq) state.loading = false;
  }
  render();
}

// Puts a list result on screen (if it's for the current view) and caches it.
function showList(data) {
  state.listCache.set(data.viewKey, data);
  if (data.viewKey !== cacheKey(state.route)) return false;
  state.list = data;
  const keys = new Set(threadsOf().map((t) => t.key));
  for (const k of state.selected) if (!keys.has(k)) state.selected.delete(k);
  if (!data.stale) state.lastChecked = Date.now();
  prefetchTop();
  return true;
}

// Downloads the top conversations in the background (one command per folder)
// and keeps them on disk, like Gmail's offline mail, so they open instantly.
function prefetchTop() {
  const threads = threadsOf();
  const wanted = [
    ...threads.slice(0, 25).flatMap((t) => t.messages),
    ...threads.filter((t) => t.unread).flatMap((t) => t.messages.filter((m) => m.unread)),
    ...threads.map((t) => t.messages[t.messages.length - 1]), // every visible row's newest message
  ];
  const seen = new Set();
  const items = wanted
    .filter((m) => (m.size || 0) < 300 * 1024 && !seen.has(keyOf(m)) && seen.add(keyOf(m)))
    .map(({ accountId, folder, uid }) => ({ accountId, folder, uid }));
  if (items.length) api.prefetch({ items }).catch(() => {});
}

async function refreshCounts() {
  try {
    state.counts = await api.counts();
  } catch {
    /* keep previous counts */
  }
  renderSidebar();
  updateTitle();
  updateBadge();
}

// Gmail-style unread count on the taskbar icon: a red dot with the number.
function updateBadge() {
  // Accounts with notifications turned off don't count toward the taskbar number.
  const count = state.settings.unreadBadge
    ? state.accounts
        .filter((a) => a.notify !== false)
        .reduce((n, a) => n + (state.counts[a.id]?.error ? 0 : state.counts[a.id]?.inbox || 0), 0)
    : 0;
  if (count === state.badge) return;
  state.badge = count;
  let image = null;
  if (count) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#d93025';
    ctx.beginPath();
    ctx.arc(16, 16, 16, 0, Math.PI * 2);
    ctx.fill();
    const text = count > 99 ? '99+' : String(count);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${text.length > 2 ? 13 : text.length > 1 ? 17 : 20}px Roboto, Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 16, 17);
    image = canvas.toDataURL('image/png');
  }
  api.setBadge({ count, image }).catch(() => {});
}

async function reloadState() {
  const s = await api.getState();
  state.accounts = s.accounts;
  state.providers = s.providers;
  state.demo = s.demo;
  state.counts = {};
  state.list = null;
  state.thread = null;
  state.listCache.clear();
  document.body.classList.toggle('demo', s.demo);
  go({ folder: 'inbox', account: 'all', page: 1, q: '', open: null });
  refreshCounts();
}

// ---------- conversation view state ----------

// state.thread = { key, folder, accountId, members, expanded: Set, full: Map, showAll, version, error }
async function openThread(key) {
  const listed = findThread(key);
  const ref = parseKey(key);
  const t = {
    key,
    folder: listed?.folder ?? ref.folder,
    accountId: ref.accountId,
    members: listed ? listed.messages.map((m) => ({ ...m })) : [],
    expanded: new Set(),
    full: new Map(),
    showAll: false,
    version: 0,
    error: null,
  };
  state.thread = t;
  if (t.members.length) prepareThread(t);
  render();
  // Fetch the whole conversation with previews (this is also how a
  // conversation opened from a notification or a link gets loaded). When the
  // list already gave us the messages, this is background work.
  try {
    const fresh = await api.getThread({ account: ref.accountId, folder: ref.folder, uid: ref.uid, background: !!listed });
    if (state.thread === t) mergeThreadMembers(fresh.messages);
  } catch (err) {
    if (state.thread === t && !t.members.length) {
      t.error = err.message;
      render();
    }
  }
}

// Unread messages and the newest one start expanded, as in Gmail.
function prepareThread(t) {
  const last = t.members[t.members.length - 1];
  for (const m of t.members) if (m.unread) t.expanded.add(keyOf(m));
  if (last) t.expanded.add(keyOf(last));
  for (const m of t.members) {
    if (!m.unread) continue;
    const c = state.counts[m.accountId];
    if (c?.inbox && m.folder === 'INBOX') c.inbox--;
  }
  const listed = findThread(t.key);
  if (listed) {
    listed.unread = false;
    listed.messages.forEach((m) => (m.unread = false));
  }
  for (const k of t.expanded) loadFull(k);
}

// The same email is a different message "copy" in each folder (Gmail keeps one
// in Inbox and one in All Mail), so a message is recognised by its Message-ID.
const identity = (m) => (m.messageId ? `${m.accountId}|${m.messageId}` : keyOf(m));

function mergeThreadMembers(freshIn) {
  const t = state.thread;
  // Messages you just sent are shown at once as placeholders ("pending") until
  // the server lists the real ones.
  const oldReal = t.members.filter((m) => !m.pending);
  const old = new Map(oldReal.map((m) => [keyOf(m), m]));
  // A refresh may list a message through another copy than the one already on
  // screen: keep the copy that's open (so nothing reloads or vanishes), and
  // never drop a message the refresh merely failed to list.
  const byIdentity = new Map(oldReal.map((m) => [identity(m), m]));
  const canon = freshIn.map((m) => {
    const o = byIdentity.get(identity(m));
    return o ? { ...m, folder: o.folder, uid: o.uid, role: o.role ?? m.role } : m;
  });
  const listed = new Set(canon.map(identity));
  const kept = oldReal.filter((o) => !listed.has(identity(o)) && !t.gone?.has(identity(o)));
  const fresh = [...canon, ...kept].sort((a, b) => a.date.localeCompare(b.date));
  const freshIds = new Set(fresh.map((m) => m.messageId).filter(Boolean));
  const matched = t.members.filter((m) => m.pending && freshIds.has(m.messageId));
  const waiting = t.members.filter((m) => m.pending && !freshIds.has(m.messageId));
  const changed = fresh.length !== oldReal.length || fresh.some((m) => !old.has(keyOf(m)));
  t.members = [
    ...fresh.map((m) => {
      const k = keyOf(m);
      // A message we just opened is read even if the server snapshot predates it.
      return t.full.get(k)?.data ? { ...m, unread: false, starred: old.get(k)?.starred ?? m.starred } : m;
    }),
    ...waiting,
  ];
  // A placeholder whose real message is now listed hands its content over, so
  // nothing flashes or reloads (a message with attachments is loaded for real).
  const swaps = matched
    .map((p) => ({ p, r: t.members.find((m) => !m.pending && m.messageId === p.messageId) }))
    .filter((x) => x.r);
  for (const { p, r } of swaps) {
    const seeded = t.full.get(keyOf(p));
    if (seeded?.data && !p.hasAttachments) {
      t.full.set(keyOf(r), { data: { ...seeded.data, accountId: r.accountId, folder: r.folder, uid: r.uid } });
    }
    t.expanded.delete(keyOf(p));
    t.expanded.add(keyOf(r));
    t.full.delete(keyOf(p));
  }
  if (!old.size) {
    prepareThread(t);
    t.version++;
    return render();
  }
  const swapped = new Set(swaps.map((s) => s.p.messageId));
  if (swaps.length && fresh.length === oldReal.length + swaps.length && fresh.every((m) => old.has(keyOf(m)) || swapped.has(m.messageId))) {
    // Only the placeholders changed: swap those cards in place.
    for (const { p, r } of swaps) {
      const el = $(`.msg-card[data-mkey="${CSS.escape(keyOf(p))}"]`);
      if (!el) continue;
      el.outerHTML = cardHtml(r);
      const card = $(`.msg-card[data-mkey="${CSS.escape(keyOf(r))}"]`);
      if (card && t.full.get(keyOf(r))?.data) mountCardBody(card);
      else loadFull(keyOf(r));
    }
    return;
  }
  if (changed) {
    for (const m of t.members) if (!old.has(keyOf(m)) && m.unread) t.expanded.add(keyOf(m));
    t.expanded.add(keyOf(t.members[t.members.length - 1]));
    for (const k of t.expanded) loadFull(k);
    t.version++;
    return render();
  }
  // Same messages: previews of collapsed cards may have filled in, and read
  // tracking may have changed (patched in place so open messages don't reload).
  for (const m of t.members) {
    const k = keyOf(m);
    if (!t.expanded.has(k)) {
      renderCard(k);
      continue;
    }
    const card = $(`.msg-card[data-mkey="${CSS.escape(k)}"]`);
    const line = card && $('.track-line', card);
    if (line) line.outerHTML = trackLineHtml(m) || '<div class="track-line" hidden></div>';
    else if (card && m.track) $('.msg-head', card).insertAdjacentHTML('afterend', trackLineHtml(m));
  }
}

// Loads one message's full content; returns a promise that settles when it's there.
function loadFull(mkey, attempt = 1) {
  const t = state.thread;
  if (!t) return Promise.resolve();
  const existing = t.full.get(mkey);
  if (existing?.data || existing?.promise) return existing.promise || Promise.resolve();
  const ref = parseKey(mkey);
  const member = t.members.find((x) => keyOf(x) === mkey);
  const promise = api
    // Only unread messages need the extra "mark as read" round trip.
    .getMessage({ account: ref.accountId, folder: ref.folder, uid: ref.uid, markSeen: member ? member.unread : true })
    .then((data) => {
      t.full.set(mkey, { data });
      if (member) member.unread = false;
    })
    .catch((err) => {
      // A message that has only just arrived can take a moment to be readable:
      // retry quietly (the card keeps saying "Loading…") before showing an error.
      const recent = member && Date.now() - new Date(member.date) < 5 * 60 * 1000;
      if (recent && attempt < 4) {
        t.full.delete(mkey);
        setTimeout(() => {
          if (state.thread === t && t.expanded.has(mkey)) loadFull(mkey, attempt + 1);
        }, 1500 * attempt);
        return;
      }
      t.full.set(mkey, { error: err.message });
    })
    .finally(() => {
      if (state.thread !== t) return;
      renderCard(mkey);
      refreshCountsSoon();
    });
  t.full.set(mkey, { promise });
  renderCard(mkey);
  return promise;
}

let countsTimer;
function refreshCountsSoon() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(refreshCounts, 400);
}

// The newest message of a conversation always stays open, as in Gmail.
const isLastMember = (t, mkey) => keyOf(t.members[t.members.length - 1]) === mkey;

function toggleCard(mkey) {
  const t = state.thread;
  if (!t) return;
  if (t.expanded.has(mkey)) {
    if (isLastMember(t, mkey)) return;
    t.expanded.delete(mkey);
    renderCard(mkey);
  } else {
    t.expanded.add(mkey);
    renderCard(mkey);
    loadFull(mkey);
  }
}

async function refreshOpenThread() {
  const t = state.thread;
  if (!t?.members.length || !state.route.open) return;
  const ref = parseKey(state.route.open);
  try {
    const fresh = await api.getThread({ account: ref.accountId, folder: ref.folder, uid: ref.uid, background: true });
    if (state.thread === t) mergeThreadMembers(fresh.messages);
  } catch {
    /* the message may have moved; keep what we have */
  }
}

// Fallback refresh (new Inbox mail is pushed; Windows alerts for it are raised
// by the main process whenever an up-to-date inbox has new unread mail).
async function poll() {
  await refreshCounts();
  const r = state.route;
  if (!state.loading) await loadList({ silent: true, background: true });
  if (r.open) refreshOpenThread();
  if (!isUnifiedInbox(r)) {
    // Keep the unified inbox (and so new-mail alerts) current from any view.
    api.listMessages({ folder: 'inbox', account: 'all', page: 1, threading: state.settings.threading, background: true, fresh: true }).catch(() => {});
  }
}

// ---------- rendering ----------

function render() {
  renderTopbar();
  renderSidebar();
  renderMain();
  updateTitle();
}

function updateTitle() {
  const r = state.route;
  const label = r.q ? `Search results` : FOLDERS.find((f) => f.key === r.folder)?.label;
  const unread = totals().inbox;
  document.title = `${label}${unread && r.folder === 'inbox' ? ` (${unread})` : ''} - Unified Inbox`;
}

function renderTopbar() {
  const first = state.accounts[0];
  const btn = $('#avatar-btn');
  btn.textContent = first ? initial({ name: first.senderName, address: first.email }) : '?';
  btn.style.background = first?.color || '#0b57d0';
  btn.dataset.av = first?.email || '';
  btn.classList.remove('has-photo');
  btn.style.backgroundImage = '';
  paintAvatars();

  const scope = $('#search-account');
  const target = accountById(searchAccountId());
  scope.hidden = state.accounts.length < 2; // nothing to choose between
  scope.title = `Choose which account to search (now ${target?.email || ''})`;
  scope.innerHTML = `<span class="dot" style="background:${target?.color || '#0b57d0'}"></span><span class="email">${esc(target?.email)}</span><span class="ms">arrow_drop_down</span>`;
}

// ---------- sender photos ----------

const photos = new Map(); // address -> picture (a data: URL), or null when the sender has none
const photoAsked = new Set();
const photoQueue = [];
let photoTimer;

function askPhotos() {
  while (photoQueue.length) {
    const batch = photoQueue.splice(0, 8);
    api
      .avatars({ addresses: batch })
      .then((found) => {
        for (const a of batch) photos.set(a, found?.[a] ?? null);
        paintAvatars();
      })
      .catch(() => batch.forEach((a) => photoAsked.delete(a)));
  }
}

// Puts a sender's own picture (when they have one) over their colored initial. Runs after every
// change to the page, before it is drawn, so a redrawn list never flashes the initials.
function paintAvatars() {
  const on = !!state.settings?.senderPhotos;
  for (const el of document.querySelectorAll('[data-av]')) {
    const address = String(el.dataset.av || '').toLowerCase();
    const url = on ? photos.get(address) : null;
    if (url) {
      if (el.dataset.photo !== url || !el.classList.contains('has-photo')) {
        el.dataset.photo = url;
        el.classList.add('has-photo');
        el.style.backgroundImage = `url("${url}")`;
      }
    } else {
      if (el.classList.contains('has-photo')) {
        el.classList.remove('has-photo');
        el.style.backgroundImage = '';
        delete el.dataset.photo;
      }
      if (on && address && !photos.has(address) && !photoAsked.has(address)) {
        photoAsked.add(address);
        photoQueue.push(address);
        clearTimeout(photoTimer);
        photoTimer = setTimeout(askPhotos, 60);
      }
    }
  }
}

function renderSidebar() {
  const r = state.route;
  const t = totals();
  const countFor = { inbox: t.inbox, spam: t.spam, drafts: t.drafts };
  const folders = FOLDERS.filter((f) => !f.more || state.moreOpen || f.key === r.folder);
  $('#nav-folders').innerHTML =
    folders
      .map((f) => {
        const n = countFor[f.key] || 0;
        const active = !r.q && r.folder === f.key;
        const bold = n && f.key !== 'drafts';
        return `<a class="nav-item ${active ? 'active' : ''} ${bold ? 'has-unread' : ''}" data-folder="${f.key}" title="${f.label}">
          <span class="ms ${active ? 'fill' : ''}">${f.icon}</span><span class="nav-label">${f.label}</span>
          <span class="nav-count">${n ? n.toLocaleString() : ''}</span></a>`;
      })
      .join('') +
    `<a class="nav-item" data-more title="${state.moreOpen ? 'Less' : 'More'}"><span class="ms">${state.moreOpen ? 'expand_less' : 'expand_more'}</span><span class="nav-label">${state.moreOpen ? 'Less' : 'More'}</span></a>`;

  $('#nav-accounts').innerHTML = state.accounts
    .map((a) => {
      const c = state.counts[a.id] || {};
      const unread = c.inbox || 0;
      const active = r.account === a.id;
      return `<a class="nav-item account ${active ? 'active' : ''} ${unread ? 'has-unread' : ''}" data-account="${a.id}" title="${esc(a.label)} · ${esc(a.email)}">
        <span class="ms fill" style="color:${a.color}">label</span><span class="nav-label">${esc(a.label)}</span>
        ${c.error ? `<span class="ms" style="color:var(--danger);font-size:18px" title="${esc(c.error)}">error</span>` : `<span class="nav-count">${unread || ''}</span>`}
        ${a.demo ? '' : accountBellHtml(a)}</a>`;
    })
    .join('');
}

// The bell beside an account in the sidebar: shown on hover, and always while the account is muted.
function accountBellHtml(a) {
  const alertsOn = state.settings.notifications;
  const muted = a.notify === false;
  const title = !alertsOn
    ? 'Desktop notifications are off in Quick settings'
    : muted
      ? 'Notifications are off for this account. Click to turn them on'
      : 'Notifications are on for this account. Click to mute';
  return `<button class="icon-btn sm nav-notify ${alertsOn && muted ? 'off' : ''}" data-notify-account="${a.id}" title="${title}"><span class="ms">${alertsOn && !muted ? 'notifications' : 'notifications_off'}</span></button>`;
}

const splitPane = () => (state.settings.readingPane || 'none') !== 'none';

// The main panel holds the list pane and the reading pane. With "No split"
// only one is visible; the list stays in the page while a conversation is
// open, so going back is instant.
function renderMain() {
  const main = $('#main');
  const mode = state.settings.readingPane || 'none';
  rememberListScroll();
  if (!main.classList.contains(`mode-${mode}`)) {
    main.className = `main mode-${mode}`;
    applyPaneSize();
  }
  const open = !!state.route.open;
  $('#pane-list').classList.toggle('hidden', mode === 'none' && open);
  $('#pane-read').classList.toggle('hidden', mode === 'none' && !open);
  renderListPane();
  renderReadPane();
}

function rememberListScroll() {
  const pane = $('#pane-list');
  const listEl = $('.list', pane);
  if (listEl && !pane.classList.contains('hidden')) state.listScroll = { sig: pane.dataset.sig, top: listEl.scrollTop };
}

function renderListPane() {
  const pane = $('#pane-list');
  if (pane.classList.contains('hidden')) return;
  rememberListScroll();
  const sig = listKey(state.route);
  pane.dataset.sig = sig;
  pane.innerHTML = listViewHtml();
  const listEl = $('.list', pane);
  if (listEl && state.listScroll?.sig === sig) listEl.scrollTop = state.listScroll.top;
  const selectAll = $('#select-all');
  if (selectAll) {
    const threads = threadsOf();
    const n = threads.filter((t) => state.selected.has(t.key)).length;
    selectAll.indeterminate = n > 0 && n < threads.length;
  }
}

function renderReadPane() {
  const pane = $('#pane-read');
  if (!state.route.open) {
    const sig = `empty|${state.settings.readingPane}`;
    if (pane.dataset.sig !== sig) {
      pane.dataset.sig = sig;
      pane.innerHTML = splitPane() ? '<div class="pane-empty"><div><span class="ms">mail</span>No conversation selected</div></div>' : '';
    }
    return;
  }
  const t = state.thread;
  const status = t?.members.length ? 'ready' : t?.error ? 'error' : 'loading';
  const sig = `thread|${state.route.open}|${t?.version ?? 0}|${status}|${state.settings.readingPane}`;
  if (pane.dataset.sig === sig) {
    patchThreadView();
    return;
  }
  pane.dataset.sig = sig;
  pane.innerHTML = threadViewHtml();
  for (const card of $$('.msg-card.expanded', pane)) mountCardBody(card);
}

function toolbarButton(icon, title, attrs) {
  return `<button class="icon-btn" ${attrs} title="${title}"><span class="ms">${icon}</span></button>`;
}

function moveButtons(folder, attr) {
  const b = [];
  if (folder === 'inbox') b.push(toolbarButton('archive', 'Archive', `${attr}="archive"`));
  if (folder === 'spam') b.push(toolbarButton('report_off', 'Not spam', `${attr}="inbox"`));
  else if (folder !== 'drafts' && folder !== 'sent') b.push(toolbarButton('report', 'Report spam', `${attr}="spam"`));
  b.push(toolbarButton(folder === 'trash' ? 'delete_forever' : 'delete', folder === 'trash' ? 'Delete forever' : 'Delete', `${attr}="trash"`));
  if (folder === 'trash' || folder === 'all') b.push(toolbarButton('move_to_inbox', 'Move to Inbox', `${attr}="inbox"`));
  return b.join('');
}

function listViewHtml() {
  const r = state.route;
  const list = state.list;
  const threads = threadsOf();
  const pageSelected = threads.filter((t) => state.selected.has(t.key)).length;
  const allSelected = threads.length > 0 && pageSelected === threads.length;
  const selCount = state.bulk ? state.bulk.threads.length : pageSelected;

  let actions;
  if (selCount) {
    const anyUnread = (state.bulk ? state.bulk.threads : threads.filter((t) => state.selected.has(t.key))).some((t) => t.unread);
    actions =
      moveButtons(r.folder, 'data-act') +
      `<div class="divider"></div>` +
      (anyUnread
        ? toolbarButton('drafts', 'Mark as read', 'data-act="read"')
        : toolbarButton('mark_email_unread', 'Mark as unread', 'data-act="unread"')) +
      toolbarButton('star', 'Add star', 'data-act="star"');
  } else {
    actions = toolbarButton('refresh', 'Refresh', 'data-refresh') + toolbarButton('more_vert', 'More', 'data-menu="list-more"');
  }

  const rest = list?.threads || [];
  // Gmail's "1–50 of 1,234 < >". With sections on screen each one gets its own
  // in its header (attr: which page it turns), so the toolbar shows none.
  const pager = (page, pageSize, shown, total, hasMore, attr) => {
    if (!shown && page <= 1) return '';
    const start = (page - 1) * pageSize + 1;
    const of = total == null ? 'many' : total.toLocaleString();
    return `${shown ? `<span class="range">${start.toLocaleString()}–${(start + shown - 1).toLocaleString()} of ${of}</span>` : ''}
      ${toolbarButton('chevron_left', 'Newer', `${attr}="${page - 1}" ${page <= 1 ? 'disabled' : ''}`)}
      ${toolbarButton('chevron_right', 'Older', `${attr}="${page + 1}" ${hasMore ? '' : 'disabled'}`)}`;
  };
  // "Hide section when empty": an empty section (on its first page) isn't shown at all.
  const sections = (list?.sections || []).filter(
    (s) => !(state.settings.hideEmptySection && !s.threads.length && s.page === 1)
  );
  const restPager = list ? pager(r.page, list.pageSize, rest.length, list.total, list.hasMore, 'data-page') : '';
  const range = sections.length ? '' : restPager;

  const toolbar = `<div class="toolbar">
    <div class="select-wrap">
      <label class="cb-wrap" title="Select"><input type="checkbox" class="cbx" id="select-all" ${allSelected ? 'checked' : ''} ${threads.length ? '' : 'disabled'}></label>
      <button class="icon-btn caret" data-menu="select" title="Select"><span class="ms">arrow_drop_down</span></button>
    </div>
    ${actions}<div class="spacer"></div>${range}
  </div>`;

  let banners = '';
  if (state.demo) {
    banners += `<div class="banner"><span class="ms">info</span><div class="grow">You're looking at demo mail. Connect Gmail, Yahoo, iCloud or any IMAP account to see your real inbox.</div><button class="text-btn" data-add-account>Add account</button></div>`;
  }
  for (const e of list?.errors || []) {
    const a = accountById(e.accountId);
    banners += `<div class="banner error"><span class="ms">error</span><div class="grow">${a ? `<b>${esc(a.label)}</b> (${esc(a.email)}) couldn't be loaded: ` : ''}${esc(e.message)}</div>${a ? `<button class="text-btn" data-edit-account="${a.id}">Fix</button>` : ''}</div>`;
  }


  let body;
  if (!list) {
    body = '';
  } else if (r.q && !threads.length && list.errors?.length) {
    body = ''; // the search failed (see the banner), which doesn't mean nothing matched
  } else if (!threads.length) {
    const [icon, title, sub] = r.q
      ? ['search', `No messages matched your search in ${esc(accountById(r.account)?.email)}`, 'Try different keywords or another account.']
      : EMPTY[r.folder];
    body = `<div class="empty"><span class="ms">${icon}</span><b>${title}</b>${sub}</div>`;
  } else {
    const index = new Map(threads.map((t, i) => [t.key, i]));
    const rows = (list) => list.map((t) => rowHtml(t, index.get(t.key))).join('');
    const head = (id, title, pages) => {
      const collapsed = state.collapsedSections.has(id);
      return `<div class="section-head ${collapsed ? 'collapsed' : ''}" data-section="${id}"><span class="ms">expand_more</span>${title}
        <div class="section-pager">${pages}</div></div>`;
    };
    body = '';
    if (sections.length) {
      for (const s of sections) {
        const options = toolbarButton('more_vert', 'Section options', 'data-menu="section"');
        body += head(s.id, s.title, pager(s.page, s.pageSize, s.threads.length, s.total, s.hasMore, 'data-spage') + options);
        if (state.collapsedSections.has(s.id)) continue;
        body += s.threads.length
          ? rows(s.threads)
          : `<div class="empty" style="padding:24px">${SECTION_EMPTY[s.id]}</div>`;
      }
      body += head('rest', 'Everything else', restPager);
      if (!state.collapsedSections.has('rest')) body += rows(rest);
    } else {
      body = rows(rest);
    }
  }

  const footer = list
    ? `<div class="list-footer"><span>${state.demo ? 'Demo mode' : `${state.accounts.length} account${state.accounts.length === 1 ? '' : 's'} connected`}</span><span>${state.lastChecked ? `Last checked ${new Date(state.lastChecked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span></div>`
    : '';

  return `${state.loading ? '<div class="progress"></div>' : ''}${toolbar}${selectBannerHtml(threads, allSelected)}${banners}<div class="list">${body}${footer}</div>`;
}

// "Carly" from "Carly Smith", "Helen" from "Prof. Helen Okafor", "Peter" from "Kung, Peter".
function shortName(addr) {
  let name = String(addr?.name || '').replace(/^"|"$/g, '').trim();
  if (!name) return String(addr?.address || '').split('@')[0];
  if (name.includes(',')) name = name.split(',')[1].trim() || name;
  const words = name.split(/\s+/);
  return words.find((w, i) => !(w.endsWith('.') && i < words.length - 1)) || words[0];
}

// Gmail's sender column: "Carly, me 9" / "Alice .. Bob, Carol 7" / "To: Bob".
function participantsHtml(t) {
  const r = state.route;
  const first = t.messages[0];
  if (r.folder === 'drafts') return '<span class="draft">Draft</span>';
  if (t.count === 1 && (r.folder === 'sent' || isMe(first.from.address))) {
    return `To: ${hl(first.to.map(displayName).join(', ') || '(no recipients)')}`;
  }
  const people = new Map();
  for (const m of t.messages) {
    const addr = String(m.from.address || '').toLowerCase();
    const p = people.get(addr) || { from: m.from, unread: false };
    p.unread = p.unread || m.unread;
    people.set(addr, p);
  }
  const list = [...people.values()];
  const name = (p) => (isMe(p.from.address) ? 'me' : list.length > 1 ? shortName(p.from) : displayName(p.from) || '(unknown sender)');
  const shown = list.length > 3 ? [list[0], null, ...list.slice(-2)] : list;
  let out = '';
  shown.forEach((p, i) => {
    if (!p) {
      out += ' .. ';
      return;
    }
    if (i > 0 && shown[i - 1]) out += ', ';
    out += `<span class="${p.unread ? 'b' : ''}">${hl(name(p))}</span>`;
  });
  if (t.draft) out += ', <span class="draft">Draft</span>';
  if (t.count > 1) out += ` <span class="row-count">${t.count}</span>`;
  return out;
}

const ROLE_LABELS = { inbox: 'Inbox', trash: 'Trash', spam: 'Spam' };

// Gmail's importance marker (the yellow "›" next to the star).
function importanceButton(important, attr) {
  const title = important ? 'Important. Click to mark as not important.' : 'Click to mark as important.';
  return `<button class="icon-btn imp-btn ${important ? 'on' : ''}" ${attr} title="${title}"><span class="ms">label_important</span></button>`;
}

// ---------- read tracking marks (like Mailsuite) ----------

function trackText(track) {
  if (!track.opens) return 'Sent · not opened yet';
  const times = track.opens === 1 ? 'Opened' : `Opened ${track.opens} times`;
  const app = track.client && track.client !== 'Other' ? ` · ${track.client}` : '';
  return `${times} · last ${formatFullDate(track.lastOpen)}${app}`;
}

// ✓ sent (gray) / ✓✓ opened (green), as on list rows.
function trackMark(track) {
  if (!track) return '';
  const opened = track.opens > 0;
  return `<span class="ms track-mark ${opened ? 'opened' : ''}" title="${esc(trackText(track))}">${opened ? 'done_all' : 'done'}</span>`;
}

// The line under one of your tracked messages in a conversation.
function trackLineHtml(m) {
  if (!m.track) return '';
  const opened = m.track.opens > 0;
  return `<div class="track-line ${opened ? 'opened' : ''}"><span class="ms">${opened ? 'done_all' : 'done'}</span>${esc(trackText(m.track))}</div>`;
}

// Gmail-style attachment pills under a row (Default density).
function filesHtml(t) {
  if (state.settings.density !== 'default' || !t.files?.length) return '';
  const pills = t.files
    .slice(0, 2)
    .map((f) => `<span class="file-pill" title="${esc(f.name)}"><span class="ms">${fileIcon(f.type, f.name)}</span><span>${esc(f.name)}</span></span>`)
    .join('');
  const more = t.files.length > 2 ? `<span class="file-pill more">+${t.files.length - 2}</span>` : '';
  return `<div class="row-files">${pills}${more}</div>`;
}

function rowHtml(t, i) {
  const r = state.route;
  const a = accountById(t.accountId);
  const selected = state.selected.has(t.key);
  const open = splitPane() && r.open && (t.key === r.open || t.messages.some((m) => keyOf(m) === r.open));
  // Where the conversation lives, in search results and All Mail (e.g. "Trash").
  const roleChips = r.q || r.folder === 'all' || r.folder === 'starred'
    ? (t.roles || []).filter((x) => ROLE_LABELS[x]).map((x) => `<span class="chip gray">${ROLE_LABELS[x]}</span>`).join('')
    : '';
  const chip = (r.account === 'all' && a ? `<span class="chip" style="--c:${a.color}">${esc(a.label)}</span>` : '') + roleChips;
  const readToggle = t.unread
    ? toolbarButton('drafts', 'Mark as read', 'data-row-act="read"')
    : toolbarButton('mark_email_unread', 'Mark as unread', 'data-row-act="unread"');
  const rowActions =
    (r.folder === 'inbox' ? toolbarButton('archive', 'Archive', 'data-row-act="archive"') : '') +
    toolbarButton('delete', r.folder === 'trash' ? 'Delete forever' : 'Delete', 'data-row-act="trash"') +
    readToggle;
  const people = [...new Set(t.messages.map((m) => formatAddress(m.from)))].join(', ');
  return `<div class="row ${t.unread ? 'unread' : 'read'} ${selected ? 'selected' : ''} ${open ? 'open' : ''} ${t.key === state.focusKey ? 'focused' : ''}" data-key="${esc(t.key)}" data-idx="${i}">
    <div class="row-ctrl">
      <label class="cb-wrap" title="Select"><input type="checkbox" class="cbx" data-select ${selected ? 'checked' : ''}></label>
      <button class="icon-btn star-btn ${t.starred ? 'on' : ''}" data-star title="${t.starred ? 'Starred' : 'Not starred'}"><span class="ms">star</span></button>
      ${importanceButton(t.important, 'data-imp')}
    </div>
    <div class="row-from" title="${esc(people)}">${trackMark(t.track)}${participantsHtml(t)}</div>
    <div class="row-main">${chip}<span class="row-subject">${hl(t.subject || '(no subject)')}</span>${t.snippet ? `<span class="row-snippet"> - ${hl(t.snippet)}</span>` : ''}</div>
    <div class="row-end">
      ${t.hasAttachments ? '<span class="ms attach" title="Has attachment">attach_file</span>' : ''}
      <span class="row-date" title="${esc(formatFullDate(t.date))}">${esc(formatListDate(t.date))}</span>
      <div class="row-actions">${rowActions}</div>
    </div>
    ${filesHtml(t)}
  </div>`;
}

// ---------- conversation view ----------

function threadToolbarHtml() {
  const r = state.route;
  const threads = threadsOf();
  const idx = threads.indexOf(findThread(r.open));
  const of = state.list?.total == null ? 'many' : state.list.total.toLocaleString();
  const nav =
    idx >= 0
      ? `<span class="range">${((r.page - 1) * (state.list.pageSize || 50) + idx + 1).toLocaleString()} of ${of}</span>
        ${toolbarButton('chevron_left', 'Newer', `data-step="-1" ${idx <= 0 ? 'disabled' : ''}`)}
        ${toolbarButton('chevron_right', 'Older', `data-step="1" ${idx >= threads.length - 1 ? 'disabled' : ''}`)}`
      : '';
  const back = splitPane()
    ? toolbarButton('close', 'Close', 'data-back')
    : toolbarButton('arrow_back', `Back to ${r.q ? 'search results' : FOLDERS.find((f) => f.key === r.folder).label}`, 'data-back');
  return `<div class="toolbar">
    ${back}
    ${moveButtons(r.folder, 'data-msg-act')}
    <div class="divider"></div>
    ${toolbarButton('mark_email_unread', 'Mark as unread', 'data-msg-act="unread"')}
    <div class="spacer"></div>${nav}
  </div>`;
}

function threadViewHtml() {
  const t = state.thread;
  const toolbar = threadToolbarHtml();
  if (t?.error) return `${toolbar}<div class="msg-view"><div class="msg-error"><span class="ms">error</span> ${esc(t.error)}</div></div>`;
  if (!t?.members.length) return `<div class="progress"></div>${toolbar}<div class="msg-view"></div>`;
  const a = accountById(t.accountId);
  const r = state.route;
  // Search results can come from anywhere, so show where the conversation actually is.
  const labels = r.q
    ? [...new Set(t.members.map((m) => ROLE_LABELS[m.role]).filter(Boolean))]
    : [FOLDERS.find((f) => f.key === r.folder)?.label].filter(Boolean);
  const subject = t.members[0].subject || t.members[t.members.length - 1].subject;
  return `${toolbar}<div class="msg-view">
    <div class="msg-subject-row"><h2>${hl(subject || '(no subject)')}</h2>
      ${importanceButton(t.members.some((m) => m.important), 'data-thread-imp')}
      ${labels.map((l) => `<span class="chip gray">${esc(l)}</span>`).join('')}
      ${a ? `<span class="chip" style="--c:${a.color}" title="${esc(a.email)}">${esc(a.label)}</span>` : ''}</div>
    <div class="thread-cards">${cardsHtml(t)}</div>
    <div class="msg-actions thread-actions">${threadActionsHtml()}</div>
  </div>`;
}

// Long conversations hide the middle read messages behind a "N" bubble.
function cardsHtml(t) {
  const n = t.members.length;
  const hidden = new Set();
  if (!t.showAll && n > 4) {
    for (let i = 1; i < n - 2; i++) if (!t.expanded.has(keyOf(t.members[i]))) hidden.add(i);
    if (hidden.size < 2) hidden.clear();
  }
  let out = '';
  let marker = false;
  t.members.forEach((m, i) => {
    if (!hidden.has(i)) {
      out += cardHtml(m);
    } else if (!marker) {
      marker = true;
      out += `<div class="thread-more" data-show-all title="Show ${hidden.size} older messages"><span class="thread-more-count">${hidden.size}</span></div>`;
    }
  });
  return out;
}

function cardHtml(m) {
  const t = state.thread;
  const k = keyOf(m);
  if (!t.expanded.has(k)) {
    // Like Gmail: the full date with "(6 days ago)", and the message's own star.
    const ago = timeAgo(m.date);
    return `<div class="msg-card collapsed ${m.unread ? 'unread' : ''}" data-mkey="${esc(k)}" data-toggle-card>
      <div class="avatar" data-av="${esc(m.from.address)}" style="background:${colorFor(m.from.address)}">${esc(initial(m.from))}</div>
      <div class="card-text">
        <div class="card-from">${esc(m.from.name || m.from.address || '(unknown sender)')}</div>
        <div class="card-snippet">${m.draft ? '<span class="draft">Draft</span> ' : ''}${hl(m.snippet || '')}</div>
      </div>
      <div class="card-date">${trackMark(m.track)}${m.hasAttachments ? '<span class="ms attach">attach_file</span>' : ''}<span class="date" title="${esc(new Date(m.date).toLocaleString())}">${esc(formatFullDate(m.date))}${ago ? `<span class="ago"> (${ago})</span>` : ''}</span>
        <button class="icon-btn star-btn ${m.starred ? 'on' : ''}" data-card-star title="${m.starred ? 'Starred' : 'Not starred'}"><span class="ms">star</span></button></div>
    </div>`;
  }
  const f = t.full.get(k) || {};
  const d = f.data;
  const from = d?.from || m.from;
  const recipients = d ? [...d.to, ...d.cc] : m.to;
  const toText = recipients.length ? recipients.map(displayName).join(', ') : 'undisclosed recipients';
  const date = d?.date || m.date;
  const ago = timeAgo(date);
  const a = accountById(m.accountId);
  const starred = m.starred;
  let body;
  if (d) {
    const prepared = f.body || (f.body = prepareBody(d));
    body = '<iframe title="Message body" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>';
    if (prepared.trimmed) {
      body += `<button class="quote-toggle" data-quote-toggle title="${f.showQuotes ? 'Hide expanded content' : 'Show trimmed content'}"><span class="ms">more_horiz</span></button>`;
    }
  } else if (f.error) {
    body = `<div class="msg-error"><span class="ms">error</span> ${esc(f.error === 'Message not found' ? "This message can't be found on the server (it may have been moved or deleted)." : f.error)} <button class="text-btn" data-card-retry>Try again</button></div>`;
  } else body = '<div class="card-loading">Loading…</div>';
  return `<div class="msg-card expanded" data-mkey="${esc(k)}">
    <div class="msg-head" ${isLastMember(t, k) ? '' : 'data-toggle-card'}>
      <div class="avatar" data-av="${esc(from.address)}" style="background:${colorFor(from.address)}">${esc(initial(from))}</div>
      <div>
        <div class="msg-from"><b>${esc(from.name || from.address)}</b> ${from.name ? `<span class="msg-addr">&lt;${esc(from.address)}&gt;</span>` : ''}</div>
        <div class="msg-to" data-toggle-details><span class="to-text">to ${esc(toText)}</span><span class="ms">arrow_drop_down</span></div>
      </div>
      <div class="msg-meta">
        <span class="date" title="${esc(new Date(date).toLocaleString())}">${esc(formatFullDate(date))}${ago ? `<span class="ago"> (${ago})</span>` : ''}</span>
        <button class="icon-btn star-btn ${starred ? 'on' : ''}" data-card-star title="${starred ? 'Starred' : 'Not starred'}"><span class="ms">star</span></button>
        ${toolbarButton('reply', 'Reply', 'data-reply')}
        ${toolbarButton('more_vert', 'More', 'data-menu="message"')}
      </div>
      <div class="msg-details" hidden><table>
        <tr><td>from:</td><td>${esc(formatAddress(from))}</td></tr>
        <tr><td>to:</td><td>${esc((d?.to || m.to).map(formatAddress).join(', ') || '—')}</td></tr>
        ${d?.cc.length ? `<tr><td>cc:</td><td>${esc(d.cc.map(formatAddress).join(', '))}</td></tr>` : ''}
        <tr><td>date:</td><td>${esc(new Date(date).toLocaleString())}</td></tr>
        <tr><td>subject:</td><td>${esc(d?.subject ?? m.subject)}</td></tr>
        ${a ? `<tr><td>account:</td><td>${esc(a.label)} · ${esc(a.email)}</td></tr>` : ''}
      </table></div>
    </div>
    ${trackLineHtml(m)}
    <div class="msg-body">${body}</div>
    ${d ? attachmentsHtml(d) : ''}
  </div>`;
}

// ---------- quoted history ("•••") ----------

// Where mail apps put the quoted earlier messages of a reply.
const QUOTE_SELECTORS = [
  'div.gmail_quote', // Gmail
  'blockquote.gmail_quote',
  '.yahoo_quoted', // Yahoo
  'div[id^="yahoo_quoted"]',
  'blockquote[type="cite"]', // Apple Mail, Thunderbird
  '.moz-cite-prefix', // Thunderbird's "On ... wrote:" line
].join(',');
// Outlook starts the quoted part with one of these; it and everything after it is history.
const OUTLOOK_QUOTE_START = ['#divRplyFwdMsg', '#appendonsend', 'div[id*="divRplyFwdMsg"]'];

const isForwarded = (subject) => /^\s*(fwd?|fw)\s*:/i.test(subject || '');

// True when nothing but whitespace follows `el` inside `root`.
function nothingAfter(el, root) {
  for (let node = el; node && node !== root; node = node.parentNode) {
    for (let s = node.nextSibling; s; s = s.nextSibling) {
      if (s.textContent.trim() || (s.nodeType === 1 && s.querySelector('img'))) return false;
    }
  }
  return true;
}

// Marks quoted history in an HTML email with data-ui-quote so it starts hidden.
function trimHtmlQuotes(html, subject) {
  if (!html || isForwarded(subject)) return { html, trimmed: false };
  const doc = new DOMParser().parseFromString(html, 'text/html'); // inert: no scripts, no loads
  const marked = [];
  const mark = (el) => {
    if (!el || el.closest('[data-ui-quote]')) return;
    el.setAttribute('data-ui-quote', '');
    marked.push(el);
  };
  for (const el of doc.querySelectorAll(QUOTE_SELECTORS)) {
    if (!/^-{4,}\s*Forwarded message/i.test(el.textContent.trim())) mark(el);
  }
  for (const sel of OUTLOOK_QUOTE_START) {
    const start = doc.querySelector(sel);
    if (!start) continue;
    if (start.previousElementSibling?.tagName === 'HR') mark(start.previousElementSibling);
    for (let el = start; el; el = el.nextElementSibling) mark(el);
  }
  // Other apps: a plain <blockquote> at the very end of the message.
  if (!marked.length) {
    const last = [...doc.body.querySelectorAll('blockquote')].filter((b) => !b.parentElement.closest('blockquote')).pop();
    if (last && nothingAfter(last, doc.body)) mark(last);
  }
  // The "On ..., X wrote:" line right before a quote.
  for (const el of [...marked]) {
    const prev = el.previousElementSibling;
    const text = prev?.textContent.trim() || '';
    if (prev && text.length < 400 && /wrote:$/i.test(text)) mark(prev);
  }
  if (!marked.length) return { html, trimmed: false };
  // Never hide the whole message.
  const visible = doc.body.cloneNode(true);
  visible.querySelectorAll('[data-ui-quote]').forEach((el) => el.remove());
  if (!visible.textContent.trim() && !visible.querySelector('img')) return { html, trimmed: false };
  return { html: doc.documentElement.outerHTML, trimmed: true };
}

function plainToHtml(text) {
  const linked = esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`);
  return linked
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// Plain-text replies: a trailing block of "> " lines (plus its "On ... wrote:" line).
function trimPlainQuotes(text, subject) {
  if (isForwarded(subject)) return null;
  const lines = String(text || '').replace(/\s+$/, '').split(/\r?\n/);
  const first = lines.findIndex((l) => /^\s*>/.test(l));
  if (first <= 0) return null;
  // Only trim if the quote runs to the end (inline replies stay as they are).
  if (lines.slice(first).some((l) => l.trim() && !/^\s*>/.test(l))) return null;
  let start = first;
  let i = first - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i >= 0 && /wrote:\s*$/i.test(lines[i])) {
    start = i;
    // Some apps wrap the attribution onto two lines.
    if (i > 0 && /^\s*On\s/i.test(lines[i - 1]) && !/^\s*On\s/i.test(lines[i])) start = i - 1;
  }
  const visible = lines.slice(0, start).join('\n').replace(/\s+$/, '');
  if (!visible.trim()) return null;
  return `${plainToHtml(visible)}<div data-ui-quote>${plainToHtml(lines.slice(start).join('\n'))}</div>`;
}

function prepareBody(d) {
  if (d.plain) {
    const html = trimPlainQuotes(d.text, d.subject);
    if (html) return { html, trimmed: true };
  }
  return trimHtmlQuotes(d.html, d.subject);
}

function attachmentsHtml(m) {
  if (!m.attachments.length) return '';
  return `<div class="attachments"><div class="attachments-head">${m.attachments.length === 1 ? 'One attachment' : `${m.attachments.length} attachments`}</div>
    <div class="att-grid">${m.attachments
      .map((att) => {
        const icon = fileIcon(att.contentType, att.filename);
        const preview = att.contentType?.startsWith('image/') ? `<img src="${esc(att.url)}" alt="">` : `<span class="ms">${icon}</span>`;
        return `<div class="att-card" data-att="${att.idx}" title="Download ${esc(att.filename)} (${formatSize(att.size || 0)})">
          <div class="att-preview">${preview}</div><div class="att-dl"><span class="ms">download</span></div>
          <div class="att-name"><span class="ms">${icon}</span><span>${esc(att.filename)}</span></div></div>`;
      })
      .join('')}</div></div>`;
}

function threadActionsHtml() {
  const t = state.thread;
  const last = t.members[t.members.length - 1];
  const d = t.full.get(keyOf(last))?.data;
  const recipients = d ? [...d.to, ...d.cc] : last.to;
  const others = new Set(recipients.filter((x) => !isMe(x.address)).map((x) => x.address.toLowerCase()));
  if (!isMe(last.from.address)) others.add(String(last.from.address).toLowerCase());
  return `<button class="pill" data-reply><span class="ms">reply</span>Reply</button>
    ${others.size > 1 ? '<button class="pill" data-reply-all><span class="ms">reply_all</span>Reply all</button>' : ''}
    <button class="pill" data-forward><span class="ms">forward</span>Forward</button>`;
}

// Re-renders one message card in place (other cards keep their loaded iframes).
function renderCard(mkey) {
  const t = state.thread;
  const el = $(`.msg-card[data-mkey="${CSS.escape(mkey)}"]`);
  const m = t?.members.find((x) => keyOf(x) === mkey);
  if (!el || !m) return;
  el.outerHTML = cardHtml(m);
  const card = $(`.msg-card[data-mkey="${CSS.escape(mkey)}"]`);
  if (card.classList.contains('expanded')) mountCardBody(card);
  if (m === t.members[t.members.length - 1]) $('.thread-actions').innerHTML = threadActionsHtml();
}

// Email HTML is rendered in a sandboxed iframe: no scripts, links open in
// the default browser.
function mountCardBody(card) {
  const iframe = $('.msg-body iframe', card);
  const f = state.thread?.full.get(card.dataset.mkey);
  const data = f?.data;
  if (!iframe || !data) return;
  const prepared = f.body || (f.body = prepareBody(data));
  // Dark mode: plain-text mail gets light text; designed HTML mail keeps its
  // own colors on a white sheet so it stays readable.
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  // Messages this app wrote itself (marked "ui-simple") are plain text in HTML clothes.
  const simple = data.plain || /\bui-simple\b/.test(data.html || '');
  const sheet = dark && !simple;
  $('.msg-body', card).classList.toggle('sheet', sheet);
  const theme = dark && simple
    ? 'body{color:#e3e3e3}a{color:#a8c7fa}blockquote{border-color:#5f6368}'
    : sheet
      ? 'body{padding:12px}'
      : '';
  const csp = "default-src 'none'; img-src https: http: data: mailpart:; style-src 'unsafe-inline' https: http:; font-src https: http: data:; media-src https: http: mailpart:";
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">
    <style>html,body{margin:0;padding:0}html{overflow-y:hidden}
    body{display:flow-root;font:14px/1.5 Arial,Helvetica,sans-serif;color:#222;overflow-wrap:break-word}
    img{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex}
    [data-ui-quote]{display:none!important}body.ui-show-quotes [data-ui-quote]{display:revert!important}
    mark.ui-hl{background:#fde293;color:#202124;border-radius:2px}${theme}</style>
    </head><body class="${f.showQuotes ? 'ui-show-quotes' : ''}">${prepared.html || ''}</body></html>`;
  iframe.addEventListener('load', () => {
    const doc = iframe.contentDocument;
    if (!doc?.body) return;
    highlightDocument(doc, state.route.q);
    // Size the frame to the content (measured on the body so it can also shrink
    // when quoted text is hidden again).
    const fit = () => {
      const bottom = doc.body.getBoundingClientRect().bottom + parseFloat(getComputedStyle(doc.body).marginBottom || 0);
      iframe.style.height = `${Math.ceil(Math.max(bottom, doc.body.scrollHeight))}px`;
    };
    fit();
    new ResizeObserver(fit).observe(doc.body);
    $$('img', doc).forEach((img) => img.addEventListener('load', fit));
  });
}

function patchThreadView() {
  const tb = $('#pane-read .toolbar');
  if (tb) tb.outerHTML = threadToolbarHtml();
}

// ---------- actions ----------

const ACTION_TEXT = {
  archive: 'archived',
  trash: 'moved to Trash',
  spam: 'marked as spam',
  inbox: 'moved to Inbox',
  read: 'marked as read',
  unread: 'marked as unread',
};

// A conversation by key: the open one (with every message loaded), or a list row.
function threadByKey(key) {
  const t = state.thread;
  if (t && (t.key === key || t.members.some((m) => keyOf(m) === key)) && t.members.length) {
    // (a message you just sent isn't on the server's list yet: nothing to act on)
    return { key: t.key, folder: t.folder, messages: t.members.filter((m) => !m.pending) };
  }
  return findThread(key);
}

// Which messages of a conversation an action touches, following Gmail.
function itemsFor(action, t) {
  const ms = t.messages;
  const theirs = ms.filter((m) => !isMe(m.from.address));
  let pick;
  switch (action) {
    case 'archive': // the backend only takes inbox copies out of the inbox
    case 'trash':
      pick = ms;
      break;
    case 'spam':
      pick = theirs.length ? theirs : ms;
      break;
    case 'inbox':
      pick = ms.filter((m) => m.folder === t.folder);
      break;
    case 'read':
      pick = ms.filter((m) => m.unread);
      break;
    case 'unread':
      pick = [(theirs.length ? theirs : ms)[(theirs.length ? theirs : ms).length - 1]];
      break;
    case 'star':
      pick = [ms[ms.length - 1]];
      break;
    case 'unstar':
      pick = ms.filter((m) => m.starred);
      break;
    case 'important':
    case 'unimportant':
      pick = ms;
      break;
    default:
      pick = [];
  }
  // A conversation with a single other sender (a notification, a newsletter)
  // teaches the app about that sender; group conversations don't.
  const senders = new Set(theirs.map((m) => m.from.address.toLowerCase()));
  const learn = (action === 'important' || action === 'unimportant') && senders.size === 1;
  return pick.map((m) => ({
    accountId: m.accountId,
    folder: m.folder,
    uid: m.uid,
    messageId: m.messageId,
    ...(learn ? { from: m.from?.address } : {}),
  }));
}

// Updates read/star state everywhere a message is shown, before the server confirms.
function applyLocal(action, items) {
  const keys = new Set(items.map(keyOf));
  for (const ms of [...threadsOf().map((t) => t.messages), ...(state.bulk?.threads.map((t) => t.messages) || []), state.thread?.members || []]) {
    for (const m of ms) {
      if (!keys.has(keyOf(m))) continue;
      if (action === 'read') m.unread = false;
      if (action === 'unread') m.unread = true;
      if (action === 'star') m.starred = true;
      if (action === 'unstar') m.starred = false;
      if (action === 'important') m.important = true;
      if (action === 'unimportant') m.important = false;
    }
  }
  for (const d of state.thread?.full.values() || []) {
    if (d.data && keys.has(keyOf(d.data))) {
      if (action === 'star') d.data.starred = true;
      if (action === 'unstar') d.data.starred = false;
    }
  }
  for (const t of [...threadsOf(), ...(state.bulk?.threads || [])]) {
    t.unread = t.messages.some((m) => m.unread);
    t.starred = t.messages.some((m) => m.starred);
    t.important = t.messages.some((m) => m.important);
  }
}

async function doAction(action, keys) {
  const threads = keys.map(threadByKey).filter(Boolean);
  if (!threads.length) return;
  const r = state.route;
  const everything = !!state.bulk && keys.length === state.bulk.threads.length; // "all N conversations" is selected
  const allLoaded = state.bulk?.complete !== false;
  // Deleting for good (Trash, and Spam, where Delete also removes the message from the server) and
  // clearing out a whole view are asked about first.
  const forever = action === 'trash' && (r.folder === 'trash' || r.folder === 'spam') && !r.q;
  if (forever || (everything && action === 'trash')) {
    const n = threads.length;
    const what = n === 1 ? 'This conversation' : `${n.toLocaleString()} conversations`;
    const ok = forever
      ? await confirmDialog('Delete forever?', `${what} will be deleted permanently. This can't be undone.`, 'Delete forever', true)
      : await confirmDialog(`Move ${n.toLocaleString()} conversations to Trash?`, `Everything selected in ${folderLabel()} will be moved to Trash. You can still get it back from there.`, 'Move to Trash', true);
    if (!ok) return;
  }
  const items = threads.flatMap((t) => itemsFor(action, t));
  const moving = ['archive', 'trash', 'spam', 'inbox'].includes(action);
  const rowKeys = new Set(threads.map((t) => t.key));
  if (moving) state.bulk = null;
  if (moving && state.list) {
    const gone = new Set(threads.map((x) => findThread(x.key)).filter(Boolean));
    const keep = (t) => !gone.has(t) && !rowKeys.has(t.key);
    const before = state.list.threads.length;
    state.list.threads = state.list.threads.filter(keep);
    for (const s of state.list.sections || []) {
      const shown = s.threads.length;
      s.threads = s.threads.filter(keep);
      if (s.total != null) s.total -= shown - s.threads.length;
    }
    if (state.list.total != null) state.list.total -= before - state.list.threads.length;
    rowKeys.forEach((k) => state.selected.delete(k));
  } else {
    applyLocal(action, items);
  }

  const openAffected = r.open && threads.some((t) => t === threadByKey(r.open) || t.key === state.thread?.key);
  if (openAffected && (moving || action === 'unread')) go({ open: null });
  else render();

  try {
    if (items.length) await api.act({ action, items });
    if (ACTION_TEXT[action]) {
      const what = threads.length === 1 ? 'Conversation' : `${threads.length} conversations`;
      const text = action === 'trash' && r.folder === 'trash' ? 'deleted forever' : ACTION_TEXT[action];
      // (a view longer than 1000 messages is handled newest first, so a second round may be needed)
      const rest = everything && !allLoaded ? ' There are more; select all again to continue.' : '';
      snack(`${what} ${text}.${rest}`);
    }
  } catch (err) {
    snack(err.message);
    loadList({ silent: true });
  }
  refreshCounts();
  if (moving) loadList({ silent: true });
  // Importance can move a conversation in or out of the "Important" section.
  if (action === 'important' || action === 'unimportant') loadList({ silent: true, fresh: true });
}

// Star or unstar one message inside the open conversation.
async function toggleMessageStar(mkey) {
  const t = state.thread;
  const m = t?.members.find((x) => keyOf(x) === mkey);
  if (!m) return;
  if (m.pending) return snack('This message is still being delivered.');
  const action = m.starred ? 'unstar' : 'star';
  const items = [{ accountId: m.accountId, folder: m.folder, uid: m.uid }];
  applyLocal(action, items);
  renderCard(mkey);
  try {
    await api.act({ action, items });
  } catch (err) {
    snack(err.message);
  }
}

const selectedKeys = () => (state.bulk ? state.bulk.threads.map((t) => t.key) : threadsOf().map((t) => t.key).filter((k) => state.selected.has(k)));

// Keys an action applies to: the open conversation, else the selection, else the keyboard cursor.
function targetKeys() {
  if (state.route.open) return [state.route.open];
  const sel = selectedKeys();
  if (sel.length) return sel;
  return threadsOf().some((t) => t.key === state.focusKey) ? [state.focusKey] : [];
}

function toggleImportant(key) {
  const t = threadByKey(key);
  if (!t) return;
  doAction(t.messages.some((m) => m.important) ? 'unimportant' : 'important', [key]);
}

function toggleStar(key) {
  const t = threadByKey(key);
  if (!t) return;
  doAction(t.messages.some((m) => m.starred) ? 'unstar' : 'star', [key]);
}

function stepMessage(delta) {
  const threads = threadsOf();
  const idx = threads.indexOf(findThread(state.route.open));
  const next = threads[idx + delta];
  if (idx >= 0 && next) go({ open: next.key });
}

function selectWhere(pred) {
  state.selected.clear();
  state.bulk = null;
  for (const t of threadsOf()) if (pred(t)) state.selected.add(t.key);
  render();
}

// Gmail's "Select all N conversations in Inbox": loads the rest of the view and selects all of it.
async function selectEverything() {
  const r = state.route;
  const view = listKey(r);
  state.bulkLoading = true;
  render();
  try {
    const all = await api.listEverything({ folder: r.folder, account: r.account, q: r.q, threading: state.settings.threading });
    if (listKey(state.route) !== view) return;
    // (newest first, as in the list; rows already ticked stay ticked)
    state.bulk = { threads: all.threads, byKey: new Map(all.threads.map((t) => [t.key, t])), complete: all.complete };
  } catch (err) {
    snack(err.message);
  } finally {
    state.bulkLoading = false;
  }
  render();
}

const folderLabel = () => (state.route.q ? 'search results' : FOLDERS.find((f) => f.key === state.route.folder)?.label || 'this view');

// The strip under the toolbar once every row on the page is ticked.
function selectBannerHtml(threads, allSelected) {
  const list = state.list;
  if (state.bulk) {
    const n = state.bulk.threads.length;
    const more = state.bulk.complete ? '' : ' (the newest ones; more remain)';
    return `<div class="select-banner">All ${n.toLocaleString()} conversations in ${esc(folderLabel())} are selected${more}. <button class="text-btn" data-clear-selection>Clear selection</button></div>`;
  }
  if (!allSelected || !list?.hasMore) return '';
  const total = list.total == null ? 'all' : `all ${list.total.toLocaleString()}`;
  return `<div class="select-banner">All ${threadsOf().length} conversations on this page are selected. ${
    state.bulkLoading
      ? '<span class="grow">Selecting…</span>'
      : `<button class="text-btn" data-select-everything>Select ${total} conversations in ${esc(folderLabel())}</button>`
  }</div>`;
}

// ---------- compose ----------

function defaultFrom() {
  return state.route.account !== 'all' ? state.route.account : state.accounts[0]?.id;
}

// ---------- recipients (chips) ----------

// "Name <a@b.com>, c@d.com" -> [{ name, address }], respecting quotes and <...>.
function splitAddresses(text) {
  const parts = [];
  let cur = '';
  let inQuote = false;
  let inAngle = false;
  for (const ch of String(text || '')) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '<') inAngle = true;
    else if (!inQuote && ch === '>') inAngle = false;
    if ((ch === ',' || ch === ';') && !inQuote && !inAngle) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean).map(parseAddress);
}

function parseAddress(token) {
  const m = token.match(/^(.*?)<([^<>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() };
  return { name: '', address: token.replace(/^<|>$/g, '').trim() };
}

const looksLikeAddress = (a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.address);
const toAddressList = (v) => (Array.isArray(v) ? v : splitAddresses(v)).filter((a) => a?.address);
const RCPT_FIELDS = ['to', 'cc', 'bcc'];

function renderChips(field) {
  const c = state.compose;
  const el = $(`.compose .rcpt-box[data-field="${field}"] .rcpt-chips`);
  if (!c || !el) return;
  el.innerHTML = c.chips[field]
    .map(
      (a, i) => `<span class="rcpt-chip" title="${esc(formatAddress(a))}"><span class="rcpt-name">${esc(a.name || a.address)}</span>
        <button class="rcpt-x" data-c-chip-remove="${field}:${i}" tabindex="-1" title="Remove"><span class="ms">close</span></button></span>`
    )
    .join('');
}

// Turns typed text into chips. final: also the part after the last separator
// (on Enter, Tab and when leaving the field); text that isn't an address stays typed.
function commitRecipients(field, final = true) {
  const c = state.compose;
  const input = $(`.compose [name=${field}]`);
  if (!c || !input || !input.value.trim()) return;
  let complete = input.value;
  let rest = '';
  if (!final) {
    const i = Math.max(complete.lastIndexOf(','), complete.lastIndexOf(';'));
    if (i < 0) return;
    rest = complete.slice(i + 1);
    complete = complete.slice(0, i + 1);
  }
  const entries = splitAddresses(complete);
  for (const a of entries.filter(looksLikeAddress)) {
    if (!c.chips[field].some((x) => x.address.toLowerCase() === a.address.toLowerCase())) c.chips[field].push(a);
  }
  const bad = entries.filter((a) => !looksLikeAddress(a)).map(formatAddress);
  input.value = [...bad, rest.trim()].filter(Boolean).join(', ');
  renderChips(field);
}

function composeHasContent() {
  const root = $('.compose');
  const c = state.compose;
  if (!root || !c) return false;
  return (
    RCPT_FIELDS.some((f) => c.chips[f].length || root.querySelector(`[name=${f}]`).value.trim()) ||
    root.querySelector('[name=subject]').value.trim() !== '' ||
    root.querySelector('textarea').value.trim() !== '' ||
    c.files.length > 0
  );
}

function openCompose(opts = {}) {
  if (state.compose && composeHasContent()) {
    $('.compose').classList.remove('min');
    snack('Finish or discard the message you are writing first.');
    return;
  }
  state.compose = {
    from: opts.from || defaultFrom(),
    chips: { to: toAddressList(opts.to || []), cc: toAddressList(opts.cc || []), bcc: toAddressList(opts.bcc || []) },
    subject: opts.subject || '',
    body: opts.body || '',
    // The original message of a reply, kept apart from what you type: shown
    // behind "•••", and sent quoted underneath your text.
    quote: opts.quote || null,
    inReplyTo: opts.inReplyTo || null,
    references: opts.references || null,
    forward: opts.forward || null,
    forwardFiles: opts.forwardFiles || [],
    files: [],
    // Read tracking, on by default once a tracker is set up (like Mailsuite).
    track: state.tracking.configured && state.settings.trackOpens,
  };
  renderCompose();
}

function renderCompose() {
  const c = state.compose;
  const root = $('#compose-root');
  if (!c) {
    root.innerHTML = '';
    return;
  }
  const showCc = !!(c.chips.cc.length || c.chips.bcc.length);
  const rcpt = (field, label, extra = '', hidden = false) => `<div class="cfield rcpt ${hidden ? 'hidden' : ''}"><label>${label}</label>
    <div class="rcpt-box" data-field="${field}"><span class="rcpt-chips"></span><input name="${field}" spellcheck="false" autocomplete="off"></div>${extra}</div>`;
  root.innerHTML = `<div class="compose">
    <div class="compose-head" data-c-toggle>
      <span class="title">${esc(c.subject || 'New Message')}</span>
      <button class="icon-btn" data-c-min title="Minimize"><span class="ms">minimize</span></button>
      <button class="icon-btn" data-c-max title="Full screen"><span class="ms">open_in_full</span></button>
      <button class="icon-btn" data-c-close title="Save & close"><span class="ms">close</span></button>
    </div>
    <div class="compose-body">
      ${state.accounts.length > 1 ? `<div class="cfield"><label>From</label><select name="from">${state.accounts
        .map((a) => `<option value="${a.id}" ${a.id === c.from ? 'selected' : ''}>${esc(a.senderName ? `${a.senderName} <${a.email}>` : a.email)} · ${esc(a.label)}</option>`)
        .join('')}</select></div>` : `<input type="hidden" name="from" value="${esc(c.from)}">`}
      ${rcpt('to', 'To', showCc ? '' : '<button class="text-btn" data-c-cc>Cc Bcc</button>')}
      ${rcpt('cc', 'Cc', '', !showCc)}
      ${rcpt('bcc', 'Bcc', '', !showCc)}
      <div class="cfield"><input name="subject" placeholder="Subject" value="${esc(c.subject)}"></div>
      <div class="compose-scroll" data-c-scroll>
        <textarea spellcheck="true"></textarea>
        ${c.quote ? `<div class="compose-quote"><button class="quote-toggle" data-c-quote title="Show trimmed content"><span class="ms">more_horiz</span></button>
          <div class="compose-quote-body" hidden><div class="q-attr">${esc(c.quote.attribution)}</div><div class="q-text">${esc(c.quote.text)}</div></div></div>` : ''}
      </div>
      <div class="compose-files"></div>
      <div class="compose-foot">
        <button class="send-btn" data-c-send title="Send (Ctrl+Enter)">Send</button>
        <button class="icon-btn" data-c-attach title="Attach files"><span class="ms">attach_file</span></button>
        <input type="file" multiple hidden data-c-file>
        ${trackToggleHtml(c)}
        <div class="spacer"></div>
        <button class="icon-btn" data-c-discard title="Discard draft"><span class="ms">delete</span></button>
      </div>
    </div>
  </div>`;
  renderComposeFiles();
  RCPT_FIELDS.forEach(renderChips);
  const body = $('.compose textarea');
  // Set via .value: HTML parsing would drop a leading newline inside <textarea>.
  body.value = c.body;
  if (!c.chips.to.length) $('.compose [name=to]').focus();
  else {
    body.focus();
    body.setSelectionRange(0, 0);
  }
}

function trackToggleHtml(c) {
  const title = !state.tracking.configured
    ? 'Read tracking: set up a tracker to see when your emails are opened'
    : c.track
      ? 'Read tracking on: you’ll see ✓✓ when this email is opened'
      : 'Read tracking off for this email';
  return `<button class="track-toggle ${c.track ? 'on' : ''}" data-c-track title="${title}"><span class="ms">done_all</span>Track</button>`;
}

function renderComposeFiles() {
  const c = state.compose;
  const el = $('.compose-files');
  if (!el) return;
  el.innerHTML =
    c.forwardFiles
      .map((f) => `<span class="file-chip" title="From the original message"><span class="ms" style="font-size:16px">${fileIcon(f.contentType, f.filename)}</span><span class="name">${esc(f.filename)}</span><span class="size">(${formatSize(f.size || 0)})</span></span>`)
      .join('') +
    c.files
      .map((f, i) => `<span class="file-chip"><span class="name">${esc(f.filename)}</span><span class="size">(${formatSize(f.data.byteLength)})</span><button class="icon-btn" data-c-remove-file="${i}" title="Remove"><span class="ms">close</span></button></span>`)
      .join('');
}

async function addComposeFiles(files) {
  const c = state.compose;
  if (!c || !files.length) return;
  const read = await Promise.allSettled(
    files.map(async (file) => ({ filename: file.name, contentType: file.type, data: new Uint8Array(await file.arrayBuffer()) })),
  );
  if (state.compose !== c) return;
  const ok = read.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  c.files.push(...ok);
  $('.compose')?.classList.remove('min');
  renderComposeFiles();
  // A folder (or an unreadable file) can't be attached.
  const failed = files.length - ok.length;
  if (failed) snack(failed === 1 ? `Couldn't attach "${files[read.findIndex((r) => r.status === 'rejected')].name}".` : `Couldn't attach ${failed} of the files.`);
  const total = c.files.reduce((n, f) => n + f.data.byteLength, 0);
  if (total > 25 * 1024 * 1024) snack(`Attachments are ${formatSize(total)}; the limit is 25 MB.`);
}

function closeCompose() {
  state.compose = null;
  renderCompose();
  // A message that failed to send while you were writing this one is waiting.
  if (unsent.length) snack(`A message couldn't be sent and is waiting for you.`, { persist: true, action: { label: 'Open', run: openUnsent } });
}

// Shows a message you just sent in the open conversation right away (the
// server can take a few seconds to list it); the real message then replaces it.
let pendingSeq = 0;
function addPendingMessage(mail, result, c) {
  const t = state.thread;
  const acct = accountById(mail.account);
  if (!t || !acct || !c.inReplyTo || !t.members.some((m) => m.messageId === c.inReplyTo)) return;
  const pending = {
    accountId: acct.id,
    folder: 'pending',
    uid: -(++pendingSeq),
    from: { name: acct.senderName, address: acct.email },
    to: c.chips.to,
    subject: mail.subject,
    snippet: mail.text.replace(/\s+/g, ' ').trim().slice(0, 200),
    date: result.sentAt,
    unread: false,
    starred: false,
    draft: false,
    hasAttachments: mail.attachments.length > 0,
    files: [],
    messageId: result.messageId,
    inReplyTo: c.inReplyTo,
    references: c.references || [],
    primary: true,
    role: 'sent',
    pending: true,
    track: null,
  };
  const k = keyOf(pending);
  t.members.push(pending);
  t.full.set(k, {
    data: {
      accountId: pending.accountId, folder: pending.folder, uid: pending.uid, subject: pending.subject,
      from: pending.from, to: c.chips.to, cc: c.chips.cc, replyTo: [], date: pending.date,
      html: result.html, plain: false, text: result.text, messageId: pending.messageId,
      references: pending.references, attachments: [],
    },
  });
  t.expanded.add(k);
  const cards = $('#pane-read .thread-cards');
  if (!cards) return;
  cards.insertAdjacentHTML('beforeend', cardHtml(pending));
  mountCardBody(cards.lastElementChild);
  const actions = $('#pane-read .thread-actions');
  if (actions) actions.innerHTML = threadActionsHtml();
  const view = $('#pane-read .msg-view');
  if (view) view.scrollTop = view.scrollHeight;
}

// Servers take a moment to list a message you just sent: look again a few
// times, until the open conversation has the real message.
function refreshAfterSend(attempt = 0) {
  const delays = [1500, 4000, 8000, 14000];
  setTimeout(async () => {
    await Promise.allSettled([loadList({ silent: true, fresh: true }), refreshOpenThread()]);
    const waiting = !!state.thread?.members.some((m) => m.pending);
    if (attempt + 1 < delays.length && (waiting || attempt < 1)) refreshAfterSend(attempt + 1);
  }, delays[attempt]);
}

async function sendCompose() {
  const root = $('.compose');
  const c = state.compose;
  const val = (n) => root.querySelector(`[name=${n}]`).value.trim();
  RCPT_FIELDS.forEach((f) => commitRecipients(f, true));
  const leftover = RCPT_FIELDS.find((f) => val(f));
  if (leftover) {
    snack(`"${val(leftover)}" isn't a valid email address.`);
    root.querySelector(`[name=${leftover}]`).focus();
    return;
  }
  const list = (f) => c.chips[f].map(formatAddress).join(', ');
  const mail = {
    account: val('from'),
    to: list('to'),
    cc: list('cc'),
    bcc: list('bcc'),
    subject: val('subject'),
    text: root.querySelector('textarea').value,
    quote: c.quote,
    inReplyTo: c.inReplyTo,
    references: c.references,
    forward: c.forward,
    attachments: c.files.map((f) => ({ filename: f.filename, contentType: f.contentType, data: f.data })),
    track: c.track,
  };
  if (!mail.to && !mail.cc && !mail.bcc) {
    snack('Please specify at least one recipient.');
    root.querySelector('[name=to]').focus();
    return;
  }
  if (!mail.subject && !mail.text.trim() && !(await confirmDialog('Send without a subject?', 'Send this message without a subject or text in the body?', 'Send'))) {
    return;
  }
  if (state.compose !== c) return; // (closed while the dialog was up)
  // The message goes out on its own: the window closes at once, so you can
  // write the next one while this one is still sending. If sending fails, the
  // draft comes back as it was.
  Object.assign(c, { from: mail.account, subject: mail.subject, body: mail.text });
  closeCompose();
  sendsInFlight++;
  snack(sendsInFlight > 1 ? `Sending ${sendsInFlight} messages…` : 'Sending…', { persist: true });
  try {
    const result = await api.send(mail);
    sendsInFlight--;
    snack(sendsInFlight ? `Message sent. Sending ${sendsInFlight} more…` : 'Message sent.', { persist: sendsInFlight > 0 });
    addPendingMessage(mail, result, c);
    refreshAfterSend();
  } catch (err) {
    sendsInFlight--;
    restoreUnsent(c, `Couldn't send "${mail.subject || '(no subject)'}": ${err.message}`);
  }
}

let sendsInFlight = 0;
const unsent = []; // messages that failed to send while another draft was open

// Brings back a message that failed to send, so it can be fixed and sent again.
function restoreUnsent(c, message) {
  if (!state.compose || !composeHasContent()) {
    state.compose = c;
    renderCompose();
    snack(message);
    return;
  }
  // You're writing another message: keep this one until that one is done.
  unsent.push(c);
  snack(message, { action: { label: 'Open', run: openUnsent } });
}

function openUnsent() {
  if (!unsent.length) return;
  if (state.compose && composeHasContent()) {
    $('.compose').classList.remove('min');
    snack('Finish or discard the message you are writing first.', { action: { label: 'Open', run: openUnsent } });
    return;
  }
  state.compose = unsent.shift();
  renderCompose();
}

// Reply / reply all / forward for one message of the open conversation
// (the newest one when mkey is omitted).
async function startReply(mode, mkey) {
  const t = state.thread;
  if (!t?.members.length) return;
  mkey = mkey || keyOf(t.members[t.members.length - 1]);
  await loadFull(mkey);
  const m = t.full.get(mkey)?.data;
  if (!m) return snack("Couldn't load that message.");
  const quoteDate = new Date(m.date);
  const when = `${quoteDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} at ${quoteDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (mode === 'forward') {
    const header = [
      '---------- Forwarded message ---------',
      `From: ${formatAddress(m.from)}`,
      `Date: ${when}`,
      `Subject: ${m.subject}`,
      `To: ${m.to.map(formatAddress).join(', ')}`,
      ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(', ')}`] : []),
    ].join('\n');
    openCompose({
      from: m.accountId,
      subject: prefixSubject('Fwd:', m.subject),
      body: `\n\n${header}\n\n${m.text}`,
      forward: m.attachments.length ? { accountId: m.accountId, folder: m.folder, uid: m.uid } : null,
      forwardFiles: m.attachments,
    });
    return;
  }
  // "Sent by me" means by the account replying: mail from another of your own
  // accounts (e.g. work to personal) is answered like anyone else's.
  const replying = accountById(m.accountId);
  const fromMe = !!replying && String(m.from.address).toLowerCase() === replying.email.toLowerCase();
  const to = fromMe ? m.to : m.replyTo.length ? m.replyTo : [m.from];
  let cc = [];
  if (mode === 'all') {
    const seen = new Set(to.map((x) => x.address.toLowerCase()));
    cc = [...m.to, ...m.cc].filter((x) => {
      const addr = x.address?.toLowerCase();
      if (!addr || isMe(addr) || seen.has(addr)) return false;
      seen.add(addr);
      return true;
    });
  }
  openCompose({
    from: m.accountId,
    to,
    cc,
    subject: prefixSubject('Re:', m.subject),
    // The original goes behind "•••" (not into the text box) and is sent
    // quoted underneath your reply, as Gmail does.
    quote: m.text.trim() ? { attribution: `On ${when} ${formatAddress(m.from)} wrote:`, text: m.text.trimEnd() } : null,
    inReplyTo: m.messageId || null,
    references: [...m.references, m.messageId].filter(Boolean),
  });
}

// ---------- menus, popovers, dialogs ----------

function closePopover() {
  $('#popover-root').innerHTML = '';
}

function openMenu(anchor, items) {
  closePopover();
  const rect = anchor.getBoundingClientRect();
  const root = $('#popover-root');
  // Items: { label, run, icon?, checked?, disabled? }, '-' for a divider, { heading } for a group title.
  // When any item has `checked`, every row keeps room for the check mark, like Gmail's menus.
  const checks = items.some((it) => it.checked !== undefined);
  root.innerHTML = `<div class="menu ${checks ? 'checks' : ''}">${items
    .map((it, i) => {
      if (it === '-') return '<div class="menu-sep"></div>';
      if (it.heading) return `<div class="menu-heading">${esc(it.heading)}</div>`;
      const lead = checks ? `<span class="ms menu-check">${it.checked ? 'check' : ''}</span>` : it.icon ? `<span class="ms">${it.icon}</span>` : '';
      return `<button data-mi="${i}" ${it.disabled ? 'disabled' : ''}>${lead}${esc(it.label)}</button>`;
    })
    .join('')}</div>`;
  const menu = root.firstElementChild;
  const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
  const top = rect.bottom + menu.offsetHeight > window.innerHeight - 8 ? rect.top - menu.offsetHeight : rect.bottom;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mi]');
    if (!btn || btn.disabled) return;
    closePopover();
    items[Number(btn.dataset.mi)].run();
  });
}

function openAccountMenu() {
  closePopover();
  const anchor = $('#avatar-btn').getBoundingClientRect();
  const first = state.accounts[0];
  const firstName = (first?.senderName || first?.email || 'there').split(/[\s@]/)[0];
  const n = state.accounts.length;
  $('#popover-root').innerHTML = `<div class="account-menu" style="right:${Math.max(8, window.innerWidth - anchor.right - 8)}px">
    <div class="am-title">${state.demo ? 'Demo mode · sample accounts' : `Connected to ${n} account${n === 1 ? '' : 's'}`}</div>
    <div class="avatar" data-av="${esc(first?.email || '')}" style="background:${first?.color || '#0b57d0'}">${esc(initial({ name: first?.senderName, address: first?.email }))}</div>
    <div class="am-hi">Hi, ${esc(firstName)}!</div>
    <button class="am-manage" data-am-manage>Manage your accounts</button>
    <div class="am-list">
      <div class="am-item" data-am-account="all">
        <div class="avatar" style="background:#0b57d0"><span class="ms" style="font-size:18px">all_inbox</span></div>
        <div class="am-text"><div class="am-name">All inboxes</div><div class="am-email">Every account in one place</div></div>
        <div class="am-count">${totals().inbox || ''}</div></div>
      ${state.accounts
        .map((a) => `<div class="am-item" data-am-account="${a.id}">
          <div class="avatar" data-av="${esc(a.email)}" style="background:${a.color}">${esc(initial({ name: a.senderName || a.label, address: a.email }))}</div>
<div class="am-text"><div class="am-name">${esc(a.label)}</div><div class="am-email">${esc(a.email)}</div></div>
          <button class="icon-btn am-copy" data-am-copy="${esc(a.email)}" title="Copy email address"><span class="ms">content_copy</span></button>
          <div class="am-count">${state.counts[a.id]?.inbox || ''}</div></div>`)
        .join('')}
      <div class="am-item" data-am-add>
        <div class="avatar" style="background:#fff;color:#444746;box-shadow:inset 0 0 0 1px #c4c7c5"><span class="ms" style="font-size:18px">person_add</span></div>
        <div class="am-text"><div class="am-name">Add another account</div></div></div>
    </div>
  </div>`;
}

function showModal(html, { small = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${small ? 'small' : ''}">${html}</div></div>`;
  const backdrop = root.firstElementChild;
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal();
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });
  return backdrop.firstElementChild;
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}

const modalOpen = () => !!$('#modal-root').firstElementChild;

function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const modal = showModal(
      `<div class="modal-head"><h2>${esc(title)}</h2></div>
      <div class="modal-body">${esc(text)}</div>
      <div class="modal-foot"><button class="btn plain" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button></div>`,
      { small: true }
    );
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    modal.querySelector('[data-yes]').addEventListener('click', () => done(true));
    modal.querySelector('[data-no]').addEventListener('click', () => done(false));
    modal.parentElement.addEventListener('mousedown', (e) => e.target === modal.parentElement && resolve(false));
    modal.querySelector('[data-yes]').focus();
  });
}

let snackTimer;
let snackAction = null;
async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    snack(done);
  } catch {
    snack("Couldn't copy. Try again.");
  }
}

function snack(text, { persist = false, action = null } = {}) {
  const el = $('#snackbar');
  snackAction = action;
  el.innerHTML = `<span class="grow">${esc(text)}</span>${action ? `<button class="text-btn" data-snack-action style="color:#a8c7fa">${esc(action.label)}</button>` : ''}<button class="icon-btn sm" data-snack-close title="Dismiss" style="color:#f2f2f2"><span class="ms">close</span></button>`;
  el.classList.add('show');
  clearTimeout(snackTimer);
  if (!persist) snackTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

function openShortcuts() {
  const keys = [
    ['c', 'Compose'], ['/', 'Search'], ['j / k', 'Older / newer'], ['o or Enter', 'Open'],
    ['u', 'Back to list'], ['x', 'Select'], ['s', 'Star'], ['e', 'Archive'],
    ['#', 'Delete'], ['!', 'Report spam'], ['r', 'Reply'], ['a', 'Reply all'],
    ['f', 'Forward'], ['Shift + i', 'Mark as read'], ['Shift + u', 'Mark as unread'], ['g then i', 'Go to Inbox'],
    ['g then s', 'Go to Starred'], ['g then t', 'Go to Sent'], ['g then d', 'Go to Drafts'], ['Ctrl + Enter', 'Send (in compose)'],
    ['+', 'Mark as important'], ['-', 'Mark as not important'],
  ];
  showModal(`<div class="modal-head"><h2>Keyboard shortcuts</h2><button class="icon-btn" data-close><span class="ms">close</span></button></div>
    <div class="modal-body"><div class="shortcuts">${keys.map(([k, d]) => `<div><span>${d}</span><kbd>${k}</kbd></div>`).join('')}</div></div>
    <div class="modal-foot"><button class="btn plain" data-close>Close</button></div>`);
}

// ---------- quick settings (gear icon, like Gmail's) ----------

const QS_CHOICES = {
  theme: ['Theme', [['system', 'System default', 'brightness_auto'], ['light', 'Light', 'light_mode'], ['dark', 'Dark', 'dark_mode']]],
  density: ['Density', [['default', 'Default', 'density_large'], ['comfortable', 'Comfortable', 'density_medium'], ['compact', 'Compact', 'density_small']]],
  inboxType: ['Inbox type', [['default', 'Default', 'inbox'], ['important', 'Important first', 'label_important'], ['unread', 'Unread first', 'mark_email_unread'], ['starred', 'Starred first', 'star']]],
  readingPane: ['Reading pane', [['none', 'No split', 'view_agenda'], ['right', 'Right of inbox', 'vertical_split'], ['below', 'Below inbox', 'horizontal_split']]],
};

const QS_TOGGLES = [
  ['threading', 'Conversation view', 'Group replies into one row'],
  ['notifications', 'Desktop notifications', 'Windows alerts when new mail arrives'],
  ['unreadBadge', 'Unread count on the taskbar', ''],
  ['senderPhotos', 'Sender photos', 'Looks up profile pictures on Gravatar (sends a hash of each address)'],
  ['runInBackground', 'Keep running in the tray', 'Closing the window keeps checking mail'],
  ['startWithWindows', 'Start with Windows', 'Starts in the tray when you sign in'],
];

function renderQuickSettings() {
  const s = state.settings;
  $('#qs').classList.toggle('open', state.qsOpen);
  $('#settings-btn').classList.toggle('on', state.qsOpen);
  if (!state.qsOpen) return;
  const choices = Object.entries(QS_CHOICES)
    .map(([key, [title, options]]) => `<div class="qs-section"><h3>${title}</h3>${options
      .map(([value, label, icon]) => `<label class="qs-option">
        <input type="radio" name="qs-${key}" data-setting="${key}" value="${value}" ${s[key] === value ? 'checked' : ''}>
        <span class="grow">${label}</span><span class="qs-thumb"><span class="ms">${icon}</span></span></label>`)
      .join('')}</div>`)
    .join('');
  const toggles = QS_TOGGLES.map(([key, label, sub]) => `<label class="qs-toggle">
      <span class="grow">${label}${sub ? `<span class="sub">${sub}</span>` : ''}</span>
      <input type="checkbox" class="switch" data-setting="${key}" ${s[key] ? 'checked' : ''}></label>`).join('');
  $('#qs-inner').innerHTML = `<div class="qs-head"><h2>Quick settings</h2>
      <button class="icon-btn" data-qs-close title="Close"><span class="ms">close</span></button></div>
    <button class="qs-btn" data-qs-accounts>Manage accounts</button>
    ${choices}
    <div class="qs-section"><h3>Mail</h3>${toggles}
      <button class="qs-link" data-qs-test>Send a test notification</button></div>
    <div class="qs-section"><h3>Read tracking</h3>
      <div class="qs-status">${state.tracking.configured
        ? `<span class="ms ok">check_circle</span>Connected to ${esc(new URL(state.tracking.url).host)}`
        : '<span class="ms">info</span>See when people open your emails (✓✓), like Mailsuite.'}</div>
      <label class="qs-toggle"><span class="grow">Track new emails<span class="sub">Turn it off for a single email in the compose window</span></span>
        <input type="checkbox" class="switch" data-setting="trackOpens" ${s.trackOpens ? 'checked' : ''} ${state.tracking.configured ? '' : 'disabled'}></label>
      <button class="qs-link" data-qs-tracker>${state.tracking.configured ? 'Change tracker' : 'Set up tracker'}</button></div>`;
}

function openTrackerSetup() {
  const t = state.tracking;
  const modal = showModal(`<div class="modal-head"><h2>Read tracking</h2><button class="icon-btn" data-close><span class="ms">close</span></button></div>
    <form class="modal-body form" id="tracker-form" autocomplete="off">
      <div class="note">Like Mailsuite, emails you send with <b>Track</b> on carry an invisible image from your tracker
        server. When the recipient opens the email and their mail app loads images, you'll see a green ✓✓ and get an alert.
        The tracker must be reachable from the internet. The <b>tracker</b> folder of this project has a free
        Cloudflare version and setup steps.</div>
      <div class="field"><label>Tracker address</label><input type="text" name="url" value="${esc(t.url)}" placeholder="https://unified-inbox-tracker.you.workers.dev"></div>
      <div class="field"><label>Secret</label><input type="password" name="secret" placeholder="${t.configured ? 'Leave blank to keep the current secret' : 'The TRACKER_SECRET you chose'}"></div>
      <div class="form-error" hidden></div>
    </form>
    <div class="modal-foot">${t.configured ? '<button class="btn plain" data-tracker-off>Turn off</button>' : ''}
      <button class="btn plain" data-close>Cancel</button><button class="btn primary" data-tracker-save>Save</button></div>`);
  const form = modal.querySelector('#tracker-form');
  const errorBox = form.querySelector('.form-error');
  const save = async (config) => {
    const btn = modal.querySelector('[data-tracker-save]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Checking…';
    errorBox.hidden = true;
    try {
      state.tracking = await api.setTracking(config);
      closeModal();
      snack(state.tracking.configured ? 'Read tracking is on.' : 'Read tracking is off.');
      renderQuickSettings();
      if (state.compose) {
        state.compose.track = state.tracking.configured && state.settings.trackOpens;
        const toggle = $('.compose [data-c-track]');
        if (toggle) toggle.outerHTML = trackToggleHtml(state.compose);
      }
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  };
  modal.querySelector('[data-tracker-save]').addEventListener('click', () =>
    save({ url: form.elements.url.value.trim(), secret: form.elements.secret.value })
  );
  modal.querySelector('[data-tracker-off]')?.addEventListener('click', () => save({ url: '', secret: '' }));
  form.addEventListener('submit', (e) => e.preventDefault());
  form.elements.url.focus();
}

async function changeSetting(key, value) {
  const prev = state.settings;
  state.settings = { ...prev, [key]: value };
  applySettings(prev);
  try {
    state.settings = await api.setSettings({ [key]: value });
  } catch (err) {
    snack(err.message);
  }
}

// Applies settings to the page; `prev` (when given) is used to reload only what changed.
function applySettings(prev) {
  const s = state.settings;
  document.body.classList.remove('density-default', 'density-comfortable', 'density-compact');
  document.body.classList.add(`density-${s.density}`);
  if (prev && (prev.threading !== s.threading || prev.inboxType !== s.inboxType || prev.sectionSize !== s.sectionSize)) {
    state.listCache.clear();
    state.list = null;
    // A different section (or page size) starts on its first page.
    if ((prev.inboxType !== s.inboxType || prev.sectionSize !== s.sectionSize) && state.route.spage > 1) go({ spage: 1 });
    else loadList();
  }
  if (prev && prev.unreadBadge !== s.unreadBadge) {
    state.badge = -1;
    updateBadge();
  }
  render();
  paintAvatars();
}

// ---------- account management ----------

// Drag a row to change the account order; it's saved when the row is dropped.
function bindAccountDrag(list) {
  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('[data-acct]');
    if (!row || e.button !== 0 || e.target.closest('button, label')) return;
    const startY = e.clientY;
    const grab = startY - row.getBoundingClientRect().top;
    let dragging = false;
    row.setPointerCapture(e.pointerId);
    const mid = (el) => el.offsetTop + el.offsetHeight / 2;
    // Slides a neighbour to the other side of the dragged row. The neighbour is
    // what moves in the DOM: moving the row itself would drop the pointer capture.
    const pass = (sib, side) => {
      const from = sib.offsetTop;
      row[side](sib);
      sib.animate({ transform: [`translateY(${from - sib.offsetTop}px)`, 'none'] }, { duration: 120, easing: 'ease-out' });
    };
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
        row.classList.add('dragging');
        document.body.classList.add('resizing', 'resize-grab');
      }
      const top = Math.min(Math.max(ev.clientY - grab - list.getBoundingClientRect().top, 0), list.offsetHeight - row.offsetHeight);
      const bottom = top + row.offsetHeight;
      // Swap when the row's leading edge crosses the middle of a neighbour.
      while (row.nextElementSibling && bottom > mid(row.nextElementSibling)) pass(row.nextElementSibling, 'before');
      while (row.previousElementSibling && top < mid(row.previousElementSibling)) pass(row.previousElementSibling, 'after');
      row.style.transform = `translateY(${top - row.offsetTop}px)`;
    };
    const up = () => {
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', up);
      row.removeEventListener('pointercancel', up);
      if (!dragging) return;
      row.classList.remove('dragging');
      row.style.transform = '';
      document.body.classList.remove('resizing', 'resize-grab');
      const ids = $$('[data-acct]', list).map((r) => r.dataset.acct);
      if (ids.join() === state.accounts.map((a) => a.id).join()) return;
      state.accounts = ids.map(accountById);
      render();
      paintAvatars();
      api.reorderAccounts({ ids }).catch((err) => snack(err.message));
    };
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', up);
    row.addEventListener('pointercancel', up);
  });
}

async function toggleAccountNotify(a) {
  if (!state.settings.notifications) return snack('Desktop notifications are off. Turn them on in Quick settings.');
  a.notify = a.notify === false;
  renderSidebar();
  updateBadge();
  try {
    await api.setAccountNotify({ id: a.id, notify: a.notify });
    snack(`Notifications ${a.notify ? 'on' : 'off'} for ${a.label}.`);
  } catch (err) {
    a.notify = !a.notify;
    renderSidebar();
    updateBadge();
    snack(err.message);
  }
}

function openAccountsModal() {
  const canDrag = !state.demo && state.accounts.length > 1;
  const rows = state.accounts
    .map((a) => {
      const provider = state.providers[a.provider]?.label || 'IMAP';
      const err = state.counts[a.id]?.error;
      return `<div class="acct-row" ${canDrag ? `data-acct="${a.id}"` : ''}>
        ${canDrag ? '<span class="ms acct-grip" title="Drag to reorder">drag_indicator</span>' : ''}
        <div class="avatar" data-av="${esc(a.email)}" style="background:${a.color}">${esc(initial({ name: a.senderName || a.label, address: a.email }))}</div>
        <div class="grow"><div class="name">${esc(a.label)}</div><div class="sub">${esc(a.email)} · ${esc(provider)}</div>
          ${err ? `<div class="sub" style="color:var(--danger)">${esc(err)}</div>` : ''}</div>
        ${a.demo ? '<span class="chip gray">Demo</span>' : `<button class="icon-btn" data-edit="${a.id}" title="Edit"><span class="ms">edit</span></button>
        <button class="icon-btn" data-remove="${a.id}" title="Remove"><span class="ms">delete</span></button>`}
      </div>`;
    })
    .join('');
  const modal = showModal(`<div class="modal-head"><h2>Your accounts</h2><button class="icon-btn" data-close><span class="ms">close</span></button></div>
    <div class="modal-body">
      ${state.demo ? '<div class="note">These are sample accounts so you can try the app. They disappear as soon as you connect your first real account.</div>' : ''}
      <div class="acct-list">${rows}</div>
    </div>
    <div class="modal-foot"><button class="btn primary" data-add><span class="ms">add</span>Add account</button></div>`);
  bindAccountDrag(modal.querySelector('.acct-list'));
  modal.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) openAccountForm();
    const edit = e.target.closest('[data-edit]');
    if (edit) openAccountForm(accountById(edit.dataset.edit));
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const a = accountById(remove.dataset.remove);
      const ok = await confirmDialog(`Remove ${a.label}?`, `${a.email} will be removed from Unified Inbox. Your mail stays on the server.`, 'Remove', true);
      if (!ok) return openAccountsModal();
      try {
        await api.removeAccount({ id: a.id });
        snack(`${a.email} removed.`);
        await reloadState();
      } catch (err) {
        snack(err.message);
      }
      openAccountsModal();
    }
  });
}

function openAccountForm(account) {
  if (account?.demo) account = null;
  const editing = !!account;
  const providers = state.providers;
  const usedColors = new Set(state.accounts.filter((a) => !a.demo).map((a) => a.color));
  const f = account || {
    provider: 'gmail',
    email: '',
    label: '',
    senderName: '',
    color: ACCOUNT_COLORS.find((c) => !usedColors.has(c)) || ACCOUNT_COLORS[0],
    imap: { ...providers.gmail.imap },
    smtp: { ...providers.gmail.smtp },
    user: '',
  };
  let providerTouched = editing;
  let color = f.color;

  const modal = showModal(`<div class="modal-head"><h2>${editing ? 'Edit account' : 'Add an email account'}</h2><button class="icon-btn" data-close><span class="ms">close</span></button></div>
    <form class="modal-body form" id="acct-form" autocomplete="off">
      <div class="field"><label>Email provider</label><select name="provider">${Object.entries(providers)
        .map(([k, p]) => `<option value="${k}" ${k === f.provider ? 'selected' : ''}>${esc(p.label)}</option>`)
        .join('')}</select></div>
      <div class="field"><label>Email address</label><input type="email" name="email" value="${esc(f.email)}" placeholder="you@example.com" required></div>
      <div class="field"><label>App password</label><input type="password" name="pass" placeholder="${editing ? 'Leave blank to keep the current password' : ''}" ${editing ? '' : 'required'}>
        <div class="hint" id="pw-hint"></div></div>
      <div class="row2">
        <div class="field"><label>Label</label><input type="text" name="label" value="${esc(f.label)}" placeholder="e.g. Work"></div>
        <div class="field"><label>Your name</label><input type="text" name="senderName" value="${esc(f.senderName)}" placeholder="Shown to people you email"></div>
      </div>
      <div class="field"><label>Color</label><div class="swatches">${ACCOUNT_COLORS.map((c) => `<button type="button" class="swatch ${c === color ? 'on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div></div>
      <details class="advanced" ${f.provider === 'custom' ? 'open' : ''}><summary>Server settings</summary>
        <div class="form">
          <div class="row3"><div class="field"><label>IMAP server</label><input type="text" name="imapHost" value="${esc(f.imap.host)}"></div>
            <div class="field"><label>Port</label><input type="number" name="imapPort" value="${f.imap.port}"></div>
            <div class="field check"><input type="checkbox" id="imapSecure" name="imapSecure" ${f.imap.secure ? 'checked' : ''}><label for="imapSecure">SSL/TLS</label></div></div>
          <div class="row3"><div class="field"><label>SMTP server</label><input type="text" name="smtpHost" value="${esc(f.smtp.host)}"></div>
            <div class="field"><label>Port</label><input type="number" name="smtpPort" value="${f.smtp.port}"></div>
            <div class="field check"><input type="checkbox" id="smtpSecure" name="smtpSecure" ${f.smtp.secure ? 'checked' : ''}><label for="smtpSecure">SSL/TLS</label></div></div>
          <div class="field"><label>Username (if different from the email address)</label><input type="text" name="user" value="${esc(f.user && f.user !== f.email ? f.user : '')}"></div>
        </div>
      </details>
      <div class="form-error" hidden></div>
    </form>
    <div class="modal-foot"><button class="btn plain" data-close>Cancel</button><button class="btn primary" data-submit>${editing ? 'Save' : 'Connect'}</button></div>`);

  const form = modal.querySelector('#acct-form');
  const el = (n) => form.elements[n];
  const errorBox = form.querySelector('.form-error');

  function applyProvider(key, fillServers) {
    const p = providers[key];
    form.querySelector('#pw-hint').innerHTML = `${esc(p.helpText)}${p.help ? ` <a data-link="${esc(p.help)}">Open ${esc(p.label)} security settings</a>` : ''}`;
    if (fillServers) {
      el('imapHost').value = p.imap.host;
      el('imapPort').value = p.imap.port;
      el('imapSecure').checked = p.imap.secure;
      el('smtpHost').value = p.smtp.host;
      el('smtpPort').value = p.smtp.port;
      el('smtpSecure').checked = p.smtp.secure;
    }
    if (key === 'custom') form.querySelector('details').open = true;
  }
  applyProvider(f.provider, false);

  el('provider').addEventListener('change', () => {
    providerTouched = true;
    applyProvider(el('provider').value, true);
  });
  el('email').addEventListener('input', () => {
    if (providerTouched) return;
    const guess = guessProvider(el('email').value) || 'custom';
    if (el('provider').value !== guess && el('email').value.includes('@')) {
      el('provider').value = guess;
      applyProvider(guess, true);
    }
  });
  modal.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) {
      color = sw.dataset.color;
      $$('.swatch', modal).forEach((s) => s.classList.toggle('on', s === sw));
    }
    const link = e.target.closest('[data-link]');
    if (link) api.openExternal(link.dataset.link);
  });

  async function submit() {
    errorBox.hidden = true;
    const payload = {
      provider: el('provider').value,
      email: el('email').value.trim(),
      pass: el('pass').value,
      label: el('label').value.trim(),
      senderName: el('senderName').value.trim(),
      color,
      user: el('user').value.trim(),
      imap: { host: el('imapHost').value.trim(), port: Number(el('imapPort').value), secure: el('imapSecure').checked },
      smtp: { host: el('smtpHost').value.trim(), port: Number(el('smtpPort').value), secure: el('smtpSecure').checked },
    };
    if (editing) payload.id = account.id;
    const btn = modal.querySelector('[data-submit]');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${editing ? 'Saving…' : 'Connecting…'}`;
    try {
      const saved = editing ? await api.updateAccount(payload) : await api.addAccount(payload);
      closeModal();
      snack(editing ? 'Account updated.' : `Connected ${saved.email}.`);
      await reloadState();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      btn.disabled = false;
      btn.textContent = editing ? 'Save' : 'Connect';
    }
  }
  modal.querySelector('[data-submit]').addEventListener('click', submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  (editing ? el('pass') : el('email')).focus();
}

// ---------- sidebar and pane sizes ----------

function setSidebarCollapsed(collapsed) {
  $('#sidebar').classList.toggle('collapsed', collapsed);
  $('#sidebar').classList.remove('peek');
  $('#menu-btn').title = collapsed ? 'Expand menu' : 'Collapse menu';
  storage('sidebarCollapsed', collapsed ? '1' : '0');
}

// Saved size of the list pane for the current reading-pane mode, in pixels.
function applyPaneSize() {
  const mode = state.settings.readingPane;
  const saved = mode === 'right' ? storage('listPaneWidth') : mode === 'below' ? storage('listPaneHeight') : null;
  $('#pane-list').style.flexBasis = saved ? `${saved}px` : '';
}

// Drag the bar between the list and the reading pane; double-click resets it.
function bindPaneResizer() {
  const handle = $('#pane-resizer');
  handle.addEventListener('pointerdown', (e) => {
    const mode = state.settings.readingPane;
    if (mode === 'none' || e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing', mode === 'right' ? 'resize-col' : 'resize-row');
    const main = $('#main').getBoundingClientRect();
    const list = $('#pane-list');
    const move = (ev) => {
      const size =
        mode === 'right'
          ? Math.min(Math.max(ev.clientX - main.left, 300), main.width - 320)
          : Math.min(Math.max(ev.clientY - main.top, 160), main.height - 160);
      list.style.flexBasis = `${Math.round(size)}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing', 'resize-col', 'resize-row');
      storage(mode === 'right' ? 'listPaneWidth' : 'listPaneHeight', String(parseInt(list.style.flexBasis, 10)));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    storage(state.settings.readingPane === 'right' ? 'listPaneWidth' : 'listPaneHeight', '');
    applyPaneSize();
  });
}

// ---------- events ----------

function bindEvents() {
  window.addEventListener('hashchange', onRoute);

  $('#menu-btn').addEventListener('click', () => setSidebarCollapsed(!$('#sidebar').classList.contains('collapsed')));
  // Collapsed sidebar: hovering slides the full menu out over the content (like Gmail).
  let peekTimer;
  $('#sidebar-panel').addEventListener('mouseenter', () => {
    if (!$('#sidebar').classList.contains('collapsed')) return;
    peekTimer = setTimeout(() => $('#sidebar').classList.add('peek'), 250);
  });
  $('#sidebar-panel').addEventListener('mouseleave', () => {
    clearTimeout(peekTimer);
    $('#sidebar').classList.remove('peek');
  });
  bindPaneResizer();
  $('#compose-btn').addEventListener('click', () => openCompose());
  $('#settings-btn').addEventListener('click', () => {
    state.qsOpen = !state.qsOpen;
    renderQuickSettings();
  });
  $('#qs-inner').addEventListener('click', (e) => {
    if (e.target.closest('[data-qs-close]')) {
      state.qsOpen = false;
      renderQuickSettings();
    }
    if (e.target.closest('[data-qs-accounts]')) openAccountsModal();
    if (e.target.closest('[data-qs-tracker]')) openTrackerSetup();
    if (e.target.closest('[data-qs-test]')) {
      api.testNotification()
        .then((ok) => snack(ok ? 'Test notification sent. Check the bottom-right of your screen.' : 'Notifications are not supported on this system.'))
        .catch((err) => snack(err.message));
    }
  });
  $('#qs-inner').addEventListener('change', (e) => {
    const input = e.target.closest('[data-setting]');
    if (!input) return;
    changeSetting(input.dataset.setting, input.type === 'checkbox' ? input.checked : input.value);
  });
  $('#help-btn').addEventListener('click', openShortcuts);
  // Email bodies are themed when they're drawn, so redraw them when the theme flips.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!state.thread) return;
    state.thread.version++;
    renderReadPane();
  });
  api.onCheckMail(() => poll());
  // A background sync finished: show the up-to-date view if it's on screen.
  // An up-to-date unified inbox is also checked for new mail (notifications),
  // whichever view is open.
  api.onViewUpdated(({ data }) => {
    if (showList(data)) render();
  });
  // Someone opened a tracked email: refresh the ✓/✓✓ marks.
  api.onTrackingUpdated(() => {
    loadList({ silent: true });
    refreshOpenThread();
  });
  // The server pushed a change to an Inbox (new mail, read elsewhere, deleted);
  // the main process has already re-synced the inbox views by now.
  api.onMailChanged(() => refreshCounts());
  $('#refresh-top').addEventListener('click', () => {
    poll();
    snack('Checking for new mail…');
  });
  $('#add-account-btn').addEventListener('click', () => openAccountForm());
  $('#avatar-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('.account-menu')) closePopover();
    else openAccountMenu();
  });

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim();
    if (q && !state.route.q) state.accountBeforeSearch = state.route.account;
    go({ q, page: 1, open: null, ...(q ? { account: searchAccountId() } : {}) });
    $('#search-input').blur();
  });
  $('#search-account').addEventListener('click', (e) => {
    if ($('#popover-root .menu')) return closePopover();
    const current = searchAccountId();
    openMenu(e.currentTarget, [
      { heading: 'Search in' },
      ...state.accounts.map((a) => ({ label: a.email, checked: a.id === current, run: () => pickSearchAccount(a.id) })),
    ]);
  });
  $('#search-input').addEventListener('input', () => {
    $('#search-form').classList.toggle('has-text', !!$('#search-input').value);
  });
  $('#search-clear').addEventListener('click', () => {
    $('#search-input').value = '';
    $('#search-form').classList.remove('has-text');
    if (state.route.q) go({ q: '', page: 1, open: null });
  });

  $('#sidebar').addEventListener('click', (e) => {
    const bell = e.target.closest('[data-notify-account]');
    if (bell) {
      e.preventDefault();
      e.stopPropagation();
      return toggleAccountNotify(accountById(bell.dataset.notifyAccount));
    }
    const folder = e.target.closest('[data-folder]');
    if (folder) return go({ folder: folder.dataset.folder, page: 1, q: '', open: null });
    if (e.target.closest('[data-more]')) {
      state.moreOpen = !state.moreOpen;
      return renderSidebar();
    }
    const acc = e.target.closest('[data-account]');
    if (acc) {
      const id = acc.dataset.account;
      // Switching accounts keeps the folder you're in (Spam stays Spam).
      go({ account: id, page: 1, q: '', open: null });
    }
  });

  const main = $('#main');
  main.addEventListener('click', (e) => {
    const t = e.target;
    const btn = (sel) => t.closest(sel);
    let b;

    // Checkboxes: the click has already toggled .checked; shift-click selects a range.
    if (t.id === 'select-all') return selectWhere(() => t.checked);
    if (btn('[data-select-everything]')) return selectEverything();
    if (btn('[data-clear-selection]')) return selectWhere(() => false);
    if (t.matches('[data-select]')) {
      state.bulk = null;
      const row = t.closest('.row');
      const idx = Number(row.dataset.idx);
      const threads = threadsOf();
      if (e.shiftKey && state.lastSelectIdx >= 0) {
        const [lo, hi] = [Math.min(idx, state.lastSelectIdx), Math.max(idx, state.lastSelectIdx)];
        for (let i = lo; i <= hi; i++) t.checked ? state.selected.add(threads[i].key) : state.selected.delete(threads[i].key);
      } else if (t.checked) {
        state.selected.add(row.dataset.key);
      } else {
        state.selected.delete(row.dataset.key);
      }
      state.lastSelectIdx = idx;
      return render();
    }

    if ((b = btn('[data-page]'))) return b.disabled ? undefined : go({ page: Number(b.dataset.page), open: null });
    if ((b = btn('[data-spage]'))) return b.disabled ? undefined : go({ spage: Number(b.dataset.spage), open: null });
    if ((b = btn('[data-menu]'))) return openContextMenu(b);
    if (btn('.section-pager')) return; // the range text in a section header doesn't fold it
    if ((b = btn('[data-section]'))) {
      const id = b.dataset.section;
      state.collapsedSections.has(id) ? state.collapsedSections.delete(id) : state.collapsedSections.add(id);
      return renderListPane();
    }
    if (btn('[data-refresh]')) return loadList({ fresh: true }).then(refreshCounts);
    if ((b = btn('[data-act]'))) return doAction(b.dataset.act, selectedKeys());
    if (btn('[data-add-account]')) return openAccountForm();
    if ((b = btn('[data-edit-account]'))) return openAccountForm(accountById(b.dataset.editAccount));

    // conversation view; card-level buttons act on their own message
    const mkey = btn('.msg-card')?.dataset.mkey;
    if (btn('[data-back]')) return go({ open: null });
    if ((b = btn('[data-step]')) && !b.disabled) return stepMessage(Number(b.dataset.step));
    if ((b = btn('[data-msg-act]'))) return doAction(b.dataset.msgAct, [state.route.open]);
    if (btn('[data-show-all]')) {
      state.thread.showAll = true;
      state.thread.version++;
      return render();
    }
    if ((b = btn('[data-quote-toggle]'))) {
      const f = state.thread?.full.get(mkey);
      if (!f) return;
      f.showQuotes = !f.showQuotes;
      $('.msg-body iframe', btn('.msg-card')).contentDocument?.body.classList.toggle('ui-show-quotes', f.showQuotes);
      b.title = f.showQuotes ? 'Hide expanded content' : 'Show trimmed content';
      return;
    }
    if (btn('[data-card-retry]')) {
      state.thread?.full.delete(mkey);
      return loadFull(mkey);
    }
    if (btn('[data-card-star]')) return toggleMessageStar(mkey);
    if ((b = btn('[data-thread-imp]'))) {
      const on = !b.classList.contains('on');
      b.outerHTML = importanceButton(on, 'data-thread-imp');
      return doAction(on ? 'important' : 'unimportant', [state.route.open]);
    }
    if (btn('[data-reply-all]')) return startReply('all', mkey);
    if (btn('[data-reply]')) return startReply('reply', mkey);
    if (btn('[data-forward]')) return startReply('forward', mkey);
    if (btn('[data-toggle-details]')) {
      const d = $('.msg-details', btn('.msg-card'));
      d.hidden = !d.hidden;
      return;
    }
    if ((b = btn('[data-att]'))) {
      const ref = parseKey(mkey);
      return api.saveAttachment({ account: ref.accountId, folder: ref.folder, uid: ref.uid, idx: Number(b.dataset.att) })
        .then((path) => path && snack(`Saved to ${path}`))
        .catch((err) => snack(err.message));
    }
    // Clicking a collapsed message (or the header of an expanded one) toggles
    // it, unless the click ended a text selection (selecting to copy).
    if (btn('[data-toggle-card]') && !btn('button, a, iframe') && !String(getSelection())) return toggleCard(mkey);

    // rows
    const row = btn('.row');
    if (!row) return;
    if ((b = btn('[data-row-act]'))) return doAction(b.dataset.rowAct, [row.dataset.key]);
    if (btn('[data-star]')) return toggleStar(row.dataset.key);
    if (btn('[data-imp]')) return toggleImportant(row.dataset.key);
    if (btn('.row-ctrl')) return;
    state.focusKey = row.dataset.key;
    go({ open: row.dataset.key });
  });

  $('#compose-root').addEventListener('click', (e) => {
    const t = e.target;
    const root = $('.compose');
    if (!root) return;
    if (t.closest('[data-c-close]') || t.closest('[data-c-discard]')) {
      const discard = !!t.closest('[data-c-discard]');
      closeCompose();
      if (discard && !unsent.length) snack('Draft discarded.'); // (else: the failed message waiting for you)
      return;
    }
    if (t.closest('[data-c-min]')) return root.classList.toggle('min');
    if (t.closest('[data-c-max]')) {
      root.classList.remove('min');
      const max = root.classList.toggle('max');
      $('[data-c-max] .ms', root).textContent = max ? 'close_fullscreen' : 'open_in_full';
      return;
    }
    if (t.closest('[data-c-toggle]') && !t.closest('button')) return root.classList.toggle('min');
    if (t.closest('[data-c-cc]')) {
      $$('.cfield.hidden', root).forEach((f) => f.classList.remove('hidden'));
      t.closest('[data-c-cc]').remove();
      $('[name=cc]', root).focus();
      return;
    }
    if (t.closest('[data-c-send]')) return sendCompose();
    if (t.closest('[data-c-track]')) {
      if (!state.tracking.configured) return openTrackerSetup();
      state.compose.track = !state.compose.track;
      t.closest('[data-c-track]').outerHTML = trackToggleHtml(state.compose);
      return;
    }
    if (t.closest('[data-c-attach]')) return $('[data-c-file]', root).click();
    const rm = t.closest('[data-c-remove-file]');
    if (rm) {
      state.compose.files.splice(Number(rm.dataset.cRemoveFile), 1);
      renderComposeFiles();
      return;
    }
    // Recipient chips: × removes one; clicking the empty part of the box starts typing.
    const chipX = t.closest('[data-c-chip-remove]');
    if (chipX) {
      const [field, i] = chipX.dataset.cChipRemove.split(':');
      state.compose.chips[field].splice(Number(i), 1);
      renderChips(field);
      return;
    }
    const box = t.closest('.rcpt-box');
    if (box && !t.closest('input')) return $('input', box).focus();
    // "•••": show or hide the quoted original of a reply.
    const quoteBtn = t.closest('[data-c-quote]');
    if (quoteBtn) {
      const body = $('.compose-quote-body', root);
      body.hidden = !body.hidden;
      quoteBtn.title = body.hidden ? 'Show trimmed content' : 'Hide expanded content';
      if (!body.hidden) body.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (t.matches('[data-c-scroll]')) $('textarea', root).focus();
  });
  $('#compose-root').addEventListener('change', (e) => {
    if (!e.target.matches('[data-c-file]')) return;
    const files = [...e.target.files];
    e.target.value = '';
    addComposeFiles(files);
  });
  // Drag files onto the compose window to attach them. Anywhere else, a dropped
  // file is ignored (instead of the window navigating to it).
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  const setDropping = (on) => $('.compose')?.classList.toggle('dropping', on);
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.target.closest?.('.compose') ? 'copy' : 'none';
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDropping(false);
    if (state.compose && e.target.closest?.('.compose')) addComposeFiles([...e.dataTransfer.files]);
  });
  $('#compose-root').addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !e.target.closest('.compose')) return;
    dragDepth++;
    setDropping(true);
  });
  $('#compose-root').addEventListener('dragleave', (e) => {
    if (!hasFiles(e) || !e.target.closest('.compose')) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      setDropping(false);
    }
  });
  $('#compose-root').addEventListener('input', (e) => {
    if (e.target.name === 'subject') $('.compose .title').textContent = e.target.value || 'New Message';
    const field = e.target.closest?.('.rcpt-box')?.dataset.field;
    if (field) {
      // A space after a complete address, like a comma, finishes it (and pasted lists split on commas).
      const v = e.target.value;
      if (/\s$/.test(v) && looksLikeAddress(parseAddress(v.trim()))) e.target.value = `${v.trim()},`;
      commitRecipients(field, false);
    }
  });
  $('#compose-root').addEventListener('focusout', (e) => {
    const field = e.target.closest?.('.rcpt-box')?.dataset.field;
    if (field) commitRecipients(field, true);
  });
  $('#compose-root').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendCompose();
      return;
    }
    const box = e.target.closest?.('.rcpt-box');
    if (!box) return;
    const field = box.dataset.field;
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (e.target.value.trim()) {
        e.preventDefault();
        commitRecipients(field, true);
      } else if (e.key === 'Enter') e.preventDefault();
    } else if (e.key === 'Backspace' && !e.target.value && state.compose.chips[field].length) {
      state.compose.chips[field].pop();
      renderChips(field);
    }
  });

  $('#popover-root').addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-am-manage]')) {
      closePopover();
      return openAccountsModal();
    }
    if (t.closest('[data-am-add]')) {
      closePopover();
      return openAccountForm();
    }
    const copy = t.closest('[data-am-copy]');
    if (copy) {
      copyText(copy.dataset.amCopy, 'Email address copied.');
      return;
    }
    const acc = t.closest('[data-am-account]');
    if (acc) {
      closePopover();
      go({ account: acc.dataset.amAccount, page: 1, q: '', open: null });
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#popover-root') && !e.target.closest('[data-menu]') && !e.target.closest('#avatar-btn')) closePopover();
  });
  $('#snackbar').addEventListener('click', (e) => {
    if (e.target.closest('[data-snack-close]')) $('#snackbar').classList.remove('show');
    if (e.target.closest('[data-snack-action]')) {
      const run = snackAction?.run;
      $('#snackbar').classList.remove('show');
      run?.();
    }
  });

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('focus', () => {
    if (Date.now() - state.lastChecked > 20000) poll();
  });

  api.onOpenMessage((ref) => go({ folder: 'inbox', account: 'all', page: 1, q: '', open: ref }));
  api.onMailto((url) => {
    try {
      const u = new URL(url);
      const p = u.searchParams;
      openCompose({ to: decodeURIComponent(u.pathname), cc: p.get('cc') || '', bcc: p.get('bcc') || '', subject: p.get('subject') || '', body: p.get('body') || '' });
    } catch {
      openCompose();
    }
  });
}

function openContextMenu(anchor) {
  const kind = anchor.dataset.menu;
  if (kind === 'select') {
    return openMenu(anchor, [
      { label: 'All', run: () => selectWhere(() => true) },
      { label: 'None', run: () => selectWhere(() => false) },
      { label: 'Read', run: () => selectWhere((m) => !m.unread) },
      { label: 'Unread', run: () => selectWhere((m) => m.unread) },
      { label: 'Starred', run: () => selectWhere((m) => m.starred) },
      { label: 'Unstarred', run: () => selectWhere((m) => !m.starred) },
    ]);
  }
  if (kind === 'section') {
    // Gmail's options for the Important / Unread / Starred section.
    const s = state.list?.sections?.[0];
    const size = state.settings.sectionSize;
    return openMenu(anchor, [
      { label: 'Show more messages', disabled: !s?.hasMore, run: () => go({ spage: s.page + 1, open: null }) },
      '-',
      { heading: 'Show up to' },
      ...[5, 10, 25, 50].map((n) => ({
        label: `${n} items`,
        checked: size === n,
        run: () => size !== n && changeSetting('sectionSize', n),
      })),
      '-',
      { label: 'Hide section when empty', checked: state.settings.hideEmptySection, run: () => changeSetting('hideEmptySection', !state.settings.hideEmptySection) },
      '-',
      {
        label: 'Manage Inbox settings',
        run: () => {
          state.qsOpen = true;
          renderQuickSettings();
        },
      },
    ]);
  }
  if (kind === 'list-more') {
    return openMenu(anchor, [
      {
        icon: 'drafts',
        label: 'Mark all as read',
        run: () => doAction('read', threadsOf().filter((t) => t.unread).map((t) => t.key)),
      },
      { icon: 'manage_accounts', label: 'Manage accounts', run: openAccountsModal },
    ]);
  }
  if (kind === 'message') {
    const mkey = anchor.closest('.msg-card')?.dataset.mkey;
    const m = mkey && state.thread?.full.get(mkey)?.data;
    const ref = mkey && parseKey(mkey);
    return openMenu(anchor, [
      { icon: 'reply', label: 'Reply', run: () => startReply('reply', mkey) },
      ...(m && m.to.length + m.cc.length > 1 ? [{ icon: 'reply_all', label: 'Reply all', run: () => startReply('all', mkey) }] : []),
      { icon: 'forward', label: 'Forward', run: () => startReply('forward', mkey) },
      {
        icon: 'delete',
        label: 'Delete this message',
        run: async () => {
          if (state.thread?.members.find((x) => keyOf(x) === mkey)?.pending) return snack('This message is still being delivered.');
          const th = state.thread;
          const member = th?.members.find((x) => keyOf(x) === mkey);
          const failed = await api.act({ action: 'trash', items: [ref] }).then(() => false, (err) => (snack(err.message), true));
          if (failed) return;
          if (member) {
            // Gone from the open conversation now (a refresh must not bring it back).
            (th.gone ||= new Set()).add(identity(member));
            th.members = th.members.filter((x) => x !== member);
            th.version++;
            render();
          }
          snack('Message moved to Trash.');
          refreshOpenThread();
          loadList({ silent: true });
        },
      },
    ]);
  }
}

// Gmail-style keyboard shortcuts.
let pendingG = 0;
function onKeyDown(e) {
  if (e.key === 'Escape') {
    if ($('#popover-root').firstElementChild) return closePopover();
    if (state.qsOpen && !modalOpen()) {
      state.qsOpen = false;
      return renderQuickSettings();
    }
    if (modalOpen()) return closeModal();
    if (document.activeElement === $('#search-input')) return $('#search-input').blur();
    if (state.route.open && !e.target.closest?.('.compose')) return go({ open: null });
    return;
  }
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable]') || modalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;

  if (pendingG && Date.now() - pendingG < 1500) {
    pendingG = 0;
    const dest = { i: 'inbox', s: 'starred', t: 'sent', d: 'drafts' }[e.key];
    if (dest) {
      e.preventDefault();
      go({ folder: dest, page: 1, q: '', open: null });
    }
    return;
  }

  const r = state.route;
  const threads = threadsOf();
  const handled = () => e.preventDefault();
  switch (e.key) {
    case 'g':
      pendingG = Date.now();
      return handled();
    case 'c':
      openCompose();
      return handled();
    case '/':
      $('#search-input').focus();
      return handled();
    case '?':
      openShortcuts();
      return handled();
    case 'j':
    case 'k': {
      const delta = e.key === 'j' ? 1 : -1;
      if (r.open && state.settings.readingPane === 'none') return stepMessage(delta);
      if (!threads.length) return;
      const idx = threads.findIndex((t) => t.key === state.focusKey);
      const next = idx === -1 ? 0 : Math.max(0, Math.min(threads.length - 1, idx + delta));
      state.focusKey = threads[next].key;
      renderMain();
      $('.row.focused')?.scrollIntoView({ block: 'nearest' });
      return handled();
    }
    case 'o':
    case 'Enter':
      if (threads.some((t) => t.key === state.focusKey)) go({ open: state.focusKey });
      return;
    case 'u':
      if (r.open) go({ open: null });
      return;
    case 'x': {
      const k = state.focusKey;
      if (!k || (r.open && state.settings.readingPane === 'none') || !threads.some((t) => t.key === k)) return;
      state.selected.has(k) ? state.selected.delete(k) : state.selected.add(k);
      return render();
    }
    case 's': {
      const [k] = targetKeys();
      if (k) toggleStar(k);
      return;
    }
    case 'e':
      if (r.folder === 'inbox') doAction('archive', targetKeys());
      return;
    case '#':
      doAction('trash', targetKeys());
      return;
    case '!':
      if (r.folder !== 'spam') doAction('spam', targetKeys());
      return;
    case '+':
    case '=':
      doAction('important', targetKeys());
      return;
    case '-':
      doAction('unimportant', targetKeys());
      return;
    case 'I':
      doAction('read', targetKeys());
      return;
    case 'U':
      doAction('unread', targetKeys());
      return;
    case 'r':
      if (r.open) {
        startReply('reply');
        handled();
      }
      return;
    case 'a':
      if (r.open) {
        startReply('all');
        handled();
      }
      return;
    case 'f':
      if (r.open) {
        startReply('forward');
        handled();
      }
      return;
  }
}

// ---------- startup ----------

async function init() {
  document.body.classList.add(`platform-${api.platform}`);
  if (storage('sidebarCollapsed') === '1') setSidebarCollapsed(true);
  else if (window.innerWidth < 900) $('#sidebar').classList.add('collapsed'); // narrow window, not a saved choice
  bindEvents();
  new MutationObserver(paintAvatars).observe(document.body, { childList: true, subtree: true });
  const s = await api.getState();
  state.accounts = s.accounts;
  state.providers = s.providers;
  state.demo = s.demo;
  state.settings = s.settings;
  state.tracking = s.tracking;
  // Last known unread counts first (instant), then the real ones.
  state.counts = await api.counts({ cached: true }).catch(() => ({}));
  applySettings();
  state.route = { ...readRoute(), open: null };
  if (!location.hash) history.replaceState(null, '', '#f=inbox');
  onRoute(); // the list comes from the local database, then syncs in the background
  refreshCounts();
  setInterval(poll, POLL_MS);
}

init();

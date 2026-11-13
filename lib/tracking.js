// Read tracking, like Mailsuite: an email sent with "Track" on carries an
// invisible 1x1 image served by your tracker (see /tracker). When the
// recipient's mail app loads it, the tracker records the open; this module
// polls the tracker and keeps each sent message's opens in the local database.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cache = require('./cache');
const store = require('./store');

const TRACK_DAYS = 30; // how long sent mail is checked for opens
// Opens this soon after sending are ignored: they're usually link scanners
// or the sender's own mail app, not the recipient.
const IGNORE_FIRST_MS = 10 * 1000;

let file;
let config = { url: '', secret: '' };

function init(dataDir) {
  file = path.join(dataDir, 'tracking.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    config = { url: saved.url || '', secret: saved.secret ? store.decryptString(saved.secret) : '' };
  } catch {
    /* not set up yet */
  }
}

const base = () => config.url.replace(/\/+$/, '');
const configured = () => !!(config.url && config.secret);
const publicConfig = () => ({ url: config.url, configured: configured() });

async function fetchOpens(ids) {
  const res = await fetch(`${base()}/api/opens?ids=${ids.join(',')}`, {
    headers: { authorization: `Bearer ${config.secret}` },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) throw new Error('the tracker rejected the secret');
  if (!res.ok) throw new Error(`the tracker answered ${res.status}`);
  return res.json();
}

// Saves the tracker address and secret after checking they work.
async function setConfig({ url, secret }) {
  const next = { url: String(url || '').trim(), secret: secret ? String(secret).trim() : config.secret };
  if (next.url && !/^https?:\/\//i.test(next.url)) throw new Error('The tracker address must start with https://');
  if (next.url && !next.secret) throw new Error('Enter the secret you set on the tracker (TRACKER_SECRET).');
  const previous = config;
  config = next;
  if (configured()) {
    try {
      await fetchOpens([]);
    } catch (err) {
      config = previous;
      throw new Error(`Couldn't connect to the tracker: ${err.message}.`);
    }
  }
  fs.writeFileSync(file, JSON.stringify({ url: config.url, secret: config.secret ? store.encryptString(config.secret) : '' }));
  return publicConfig();
}

// A tracking image for one outgoing message.
function newPixel() {
  const id = crypto.randomBytes(16).toString('hex');
  return { id, html: `<img src="${base()}/o/${id}.gif" width="1" height="1" alt="" style="border:0;width:1px;height:1px">` };
}

function record(messageId, info) {
  cache.put('track', String(messageId).toLowerCase(), { ...info, sentAt: new Date().toISOString(), opens: [] });
}

// { opens, firstOpen, lastOpen, client } for a sent message, or null if it isn't tracked.
function statusFor(messageId) {
  const r = messageId && cache.get('track', String(messageId).toLowerCase());
  if (!r) return null;
  const last = r.opens[r.opens.length - 1];
  return { opens: r.opens.length, firstOpen: r.opens[0]?.at || null, lastOpen: last?.at || null, client: last?.client || null };
}

// Asks the tracker about mail sent in the last 30 days. Returns the records
// that were opened since the last check (for alerts).
async function poll() {
  if (!configured()) return [];
  const since = Date.now() - TRACK_DAYS * 86400 * 1000;
  const records = cache.entries('track', '').filter(([, r]) => Date.parse(r.sentAt) > since);
  const opened = [];
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    const result = await fetchOpens(chunk.map(([, r]) => r.id));
    for (const [key, r] of chunk) {
      const opens = (result[r.id] || []).filter((o) => Date.parse(o.at) - Date.parse(r.sentAt) > IGNORE_FIRST_MS);
      if (opens.length > r.opens.length) {
        opened.push({ ...r, opens });
        cache.put('track', key, { ...r, opens });
      }
    }
  }
  return opened;
}

// Removes our tracking images from a message before it's shown, so reading
// your own sent mail (or a reply quoting it) doesn't count as an open.
function stripPixels(html) {
  if (!config.url || !html) return html;
  const escaped = base().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`<img[^>]+${escaped}/o/[a-f0-9]+\\.gif[^>]*>`, 'gi'), '');
}

module.exports = { init, configured, publicConfig, setConfig, newPixel, record, statusFor, poll, stripPixels };

// Profile pictures for senders who have one. IMAP gives no photos, so they are
// looked up on Gravatar (the picture people attach to their email address),
// using a hash of the address, never the address itself. Answers, and "none",
// are remembered on disk so each address is asked about once in a while.
const crypto = require('crypto');
const cache = require('./cache');

const HIT_DAYS = 30;
const MISS_DAYS = 7;
const MAX_BYTES = 150 * 1024;
const PARALLEL = 4;
const DAY = 86400000;

// Addresses that can't have a picture: test domains and automatic senders.
const SKIP_DOMAIN = /(^|\.)(example\.(com|org|net)|localhost|invalid|test)$/i;
const SKIP_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounces?)\b/i;

const retryAfter = new Map(); // address -> time before which we don't ask again (network trouble)
let active = 0;
const waiting = [];

function eligible(address) {
  const a = String(address || '').trim().toLowerCase();
  const m = a.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  return m && !SKIP_DOMAIN.test(m[2]) && !SKIP_LOCAL.test(m[1]) ? a : null;
}

function slot() {
  if (active < PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

async function download(address) {
  const hash = crypto.createHash('sha256').update(address).digest('hex');
  const base = process.env.UNIFIED_INBOX_AVATAR_URL || 'https://www.gravatar.com/avatar/'; // (the override is for tests)
  const url = `${base}${hash}?s=96&d=404`;
  // Electron's network stack follows the system proxy / VPN settings; plain fetch otherwise.
  let net;
  try {
    net = require('electron').net;
  } catch {}
  const res = await (net?.fetch ?? fetch)(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/^image\/(jpeg|png|webp|gif)/.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return null;
  return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
}

// The picture for one address as a data: URL, or null when there is none.
async function lookup(raw) {
  const address = eligible(raw);
  if (!address) return null;
  const stored = cache.get('avatar', address);
  if (stored && Date.now() - stored.at < (stored.url ? HIT_DAYS : MISS_DAYS) * DAY) return stored.url;
  if ((retryAfter.get(address) || 0) > Date.now()) return stored?.url ?? null;
  await slot();
  try {
    const url = await download(address);
    cache.put('avatar', address, { url, at: Date.now() });
    return url;
  } catch {
    retryAfter.set(address, Date.now() + 5 * 60000); // offline or Gravatar unreachable: try again later
    return stored?.url ?? null;
  } finally {
    release();
  }
}

// { address: dataUrl | null } for a handful of addresses.
async function lookupMany(addresses) {
  const list = [...new Set((addresses || []).map((a) => String(a || '').toLowerCase()))].slice(0, 40);
  const out = {};
  await Promise.all(list.map(async (a) => (out[a] = await lookup(a))));
  return out;
}

module.exports = { lookupMany, lookup, eligible };

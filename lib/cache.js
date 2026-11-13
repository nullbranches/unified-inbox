// Local mail database (SQLite, built into Electron's Node). Like Gmail's
// offline store, the UI reads from here first and the network only updates it:
// message summaries, previews, mailbox sync state, rendered views and raw
// message sources all survive restarts.
const path = require('path');

let db = null;
let stmts = null;
const pending = new Map(); // `${ns}\n${key}` -> value; written in one transaction shortly after
let flushTimer = null;

const MAX_SOURCES = 4000; // raw messages kept on disk (least recently used are dropped)

// Bump SCHEMA whenever a build changes how derived data is stored. On opening a
// database written by an older build, the derived copies below are dropped and
// rebuilt from the server. Everything else is kept: read-tracking history
// ('track'), importance choices ('imp'), contacts, folder names, and the
// downloaded raw messages.
// (3: previews no longer include quoted history. 4: mirrors could have skipped
// a newly arrived message; they're rebuilt.)
const SCHEMA = 4;
const DERIVED = ['view', 'mirror', 'sum', 'sum2', 'thr', 'thr2', 'oflags', 'counts'];

function init(dataDir) {
  if (db) return;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(dataDir, 'mail-cache.sqlite'));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (ns, key));
      CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, data BLOB NOT NULL, used INTEGER NOT NULL);
    `);
    stmts = {
      get: db.prepare('SELECT data FROM kv WHERE ns = ? AND key = ?'),
      put: db.prepare('INSERT OR REPLACE INTO kv (ns, key, data) VALUES (?, ?, ?)'),
      byPrefix: db.prepare("SELECT key, data FROM kv WHERE ns = ? AND key >= ? AND key < ? || char(1114111)"),
      deleteNs: db.prepare('DELETE FROM kv WHERE ns = ?'),
      deletePrefix: db.prepare("DELETE FROM kv WHERE key >= ? AND key < ? || char(1114111)"),
      getSource: db.prepare('SELECT data FROM sources WHERE key = ?'),
      touchSource: db.prepare('UPDATE sources SET used = ? WHERE key = ?'),
      putSource: db.prepare('INSERT OR REPLACE INTO sources (key, data, used) VALUES (?, ?, ?)'),
      deleteSourcePrefix: db.prepare("DELETE FROM sources WHERE key >= ? AND key < ? || char(1114111)"),
      pruneSources: db.prepare('DELETE FROM sources WHERE key NOT IN (SELECT key FROM sources ORDER BY used DESC LIMIT ?)'),
    };
    stmts.pruneSources.run(MAX_SOURCES);
    if (db.prepare('PRAGMA user_version').get().user_version < SCHEMA) {
      db.exec(`DELETE FROM kv WHERE ns IN (${DERIVED.map((ns) => `'${ns}'`).join(', ')}); PRAGMA user_version = ${SCHEMA};`);
    }
  } catch (err) {
    // Without the database the app still works, just without the disk cache.
    console.error('[cache] disabled:', err.message);
    db = null;
  }
}

function get(ns, key) {
  const p = pending.get(`${ns}\n${key}`);
  if (p !== undefined) return p;
  if (!db) return undefined;
  const row = stmts.get.get(ns, key);
  return row ? JSON.parse(row.data) : undefined;
}

// Writes are batched into one transaction (cheap even for hundreds of rows).
function put(ns, key, value) {
  if (!db) return;
  pending.set(`${ns}\n${key}`, value);
  if (!flushTimer) flushTimer = setTimeout(flush, 300);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!db || !pending.size) return;
  db.exec('BEGIN');
  try {
    for (const [k, value] of pending) {
      const i = k.indexOf('\n');
      stmts.put.run(k.slice(0, i), k.slice(i + 1), JSON.stringify(value));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[cache] write failed:', err.message);
  }
  pending.clear();
}

// All entries of a namespace whose key starts with prefix, as [key, value] pairs.
function entries(ns, prefix) {
  if (!db) return [];
  flush();
  return stmts.byPrefix.all(ns, prefix, prefix).map((r) => [r.key, JSON.parse(r.data)]);
}

function clearNs(ns) {
  if (!db) return;
  flush();
  stmts.deleteNs.run(ns);
}

// Forgets everything stored for an account (keys start with its id).
function forgetAccount(accountId) {
  if (!db) return;
  flush();
  stmts.deletePrefix.run(`${accountId}:`, `${accountId}:`);
  stmts.deleteSourcePrefix.run(`${accountId}:`, `${accountId}:`);
}

function getSource(key) {
  if (!db) return undefined;
  const row = stmts.getSource.get(key);
  if (!row) return undefined;
  stmts.touchSource.run(Date.now(), key);
  return Buffer.from(row.data);
}

function putSource(key, source) {
  if (!db) return;
  stmts.putSource.run(key, source, Date.now());
}

module.exports = { init, get, put, flush, entries, clearNs, forgetAccount, getSource, putSource };

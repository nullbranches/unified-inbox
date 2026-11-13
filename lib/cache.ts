// Local mail database (SQLite, built into Electron's Node). Like Gmail's
// offline store, the UI reads from here first and the network only updates it:
// message summaries, previews, mailbox sync state, rendered views and raw
// message sources all survive restarts.
import path from 'path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

type StatementName =
  | 'get'
  | 'put'
  | 'byPrefix'
  | 'deleteNs'
  | 'deletePrefix'
  | 'getSource'
  | 'touchSource'
  | 'putSource'
  | 'deleteSourcePrefix'
  | 'pruneSources';

let db: DatabaseSync | null = null;
let stmts: Record<StatementName, StatementSync>;
const pending = new Map<string, unknown>(); // `${ns}\n${key}` -> value; written in one transaction shortly after
let flushTimer: ReturnType<typeof setTimeout> | null = null;

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

export function init(dataDir: string): void {
  if (db) return;
  try {
    // (required here, not imported: without node:sqlite the app runs without the cache)
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const opened = new DatabaseSync(path.join(dataDir, 'mail-cache.sqlite'));
    db = opened;
    opened.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (ns, key));
      CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, data BLOB NOT NULL, used INTEGER NOT NULL);
    `);
    stmts = {
      get: opened.prepare('SELECT data FROM kv WHERE ns = ? AND key = ?'),
      put: opened.prepare('INSERT OR REPLACE INTO kv (ns, key, data) VALUES (?, ?, ?)'),
      byPrefix: opened.prepare("SELECT key, data FROM kv WHERE ns = ? AND key >= ? AND key < ? || char(1114111)"),
      deleteNs: opened.prepare('DELETE FROM kv WHERE ns = ?'),
      deletePrefix: opened.prepare("DELETE FROM kv WHERE key >= ? AND key < ? || char(1114111)"),
      getSource: opened.prepare('SELECT data FROM sources WHERE key = ?'),
      touchSource: opened.prepare('UPDATE sources SET used = ? WHERE key = ?'),
      putSource: opened.prepare('INSERT OR REPLACE INTO sources (key, data, used) VALUES (?, ?, ?)'),
      deleteSourcePrefix: opened.prepare("DELETE FROM sources WHERE key >= ? AND key < ? || char(1114111)"),
      pruneSources: opened.prepare('DELETE FROM sources WHERE key NOT IN (SELECT key FROM sources ORDER BY used DESC LIMIT ?)'),
    };
    stmts.pruneSources.run(MAX_SOURCES);
    if ((opened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < SCHEMA) {
      opened.exec(`DELETE FROM kv WHERE ns IN (${DERIVED.map((ns) => `'${ns}'`).join(', ')}); PRAGMA user_version = ${SCHEMA};`);
    }
  } catch (err) {
    // Without the database the app still works, just without the disk cache.
    console.error('[cache] disabled:', (err as Error).message);
    db = null;
  }
}

// Values come back as they were stored (JSON); callers name the type they stored.
export function get<T = unknown>(ns: string, key: string): T | undefined {
  const p = pending.get(`${ns}\n${key}`);
  if (p !== undefined) return p as T;
  if (!db) return undefined;
  const row = stmts.get.get(ns, key) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}

// Writes are batched into one transaction (cheap even for hundreds of rows).
export function put(ns: string, key: string, value: unknown): void {
  if (!db) return;
  pending.set(`${ns}\n${key}`, value);
  if (!flushTimer) flushTimer = setTimeout(flush, 300);
}

export function flush(): void {
  clearTimeout(flushTimer ?? undefined);
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
    console.error('[cache] write failed:', (err as Error).message);
  }
  pending.clear();
}

// All entries of a namespace whose key starts with prefix, as [key, value] pairs.
export function entries<T = unknown>(ns: string, prefix: string): [string, T][] {
  if (!db) return [];
  flush();
  const rows = stmts.byPrefix.all(ns, prefix, prefix) as { key: string; data: string }[];
  return rows.map((r) => [r.key, JSON.parse(r.data)]);
}

export function clearNs(ns: string): void {
  if (!db) return;
  flush();
  stmts.deleteNs.run(ns);
}

// Forgets everything stored for an account (keys start with its id).
export function forgetAccount(accountId: string): void {
  if (!db) return;
  flush();
  stmts.deletePrefix.run(`${accountId}:`, `${accountId}:`);
  stmts.deleteSourcePrefix.run(`${accountId}:`, `${accountId}:`);
}

export function getSource(key: string): Buffer | undefined {
  if (!db) return undefined;
  const row = stmts.getSource.get(key) as { data: Uint8Array } | undefined;
  if (!row) return undefined;
  stmts.touchSource.run(Date.now(), key);
  return Buffer.from(row.data);
}

export function putSource(key: string, source: Buffer): void {
  if (!db) return;
  stmts.putSource.run(key, source, Date.now());
}

// Account storage in the app's user-data folder. Passwords are encrypted at
// rest with the OS keychain (Electron safeStorage: DPAPI on Windows, Keychain
// on macOS) when available, otherwise with AES-256-GCM and a local key file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let accountsFile;
let cipher;

function fileCipher(dataDir) {
  const keyFile = path.join(dataDir, 'secret.key');
  let cachedKey;
  const key = () => {
    if (!cachedKey) {
      if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
      cachedKey = fs.readFileSync(keyFile);
    }
    return cachedKey;
  };
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
      const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return 'aes:' + [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
    },
    decrypt(payload) {
      const [iv, tag, data] = payload.slice(4).split(':').map((s) => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    },
  };
}

// safeStorage: Electron's safeStorage module, or null outside Electron.
function init(dataDir, safeStorage) {
  fs.mkdirSync(dataDir, { recursive: true });
  accountsFile = path.join(dataDir, 'accounts.json');
  const fallback = fileCipher(dataDir);
  const os = safeStorage?.isEncryptionAvailable() ? safeStorage : null;
  cipher = {
    encrypt: (text) => (os ? 'os:' + os.encryptString(String(text)).toString('base64') : fallback.encrypt(text)),
    decrypt: (payload) =>
      payload.startsWith('os:')
        ? safeStorage.decryptString(Buffer.from(payload.slice(3), 'base64'))
        : fallback.decrypt(payload),
  };
}

function readAll() {
  if (!fs.existsSync(accountsFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  } catch {
    return [];
  }
}

let decrypted = null; // cache of getAccounts(), cleared on every write

function writeAll(accounts) {
  fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  decrypted = null;
}

// Accounts with the password decrypted, for the mail backends.
function getAccounts() {
  if (!decrypted) decrypted = readAll().map((a) => ({ ...a, pass: cipher.decrypt(a.pass) }));
  return decrypted.map((a) => ({ ...a }));
}

// Account fields that are safe to hand to the renderer.
function publicAccount(a) {
  const { pass, ...rest } = a;
  return rest;
}

function addAccount(account) {
  const all = readAll();
  const id = crypto.randomBytes(6).toString('hex');
  all.push({ ...account, id, pass: cipher.encrypt(account.pass) });
  writeAll(all);
  return { ...account, id };
}

function updateAccount(id, changes) {
  const all = readAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const pass = changes.pass ? cipher.encrypt(changes.pass) : all[idx].pass;
  all[idx] = { ...all[idx], ...changes, id, pass };
  writeAll(all);
  return { ...all[idx], pass: cipher.decrypt(pass) };
}

function removeAccount(id) {
  writeAll(readAll().filter((a) => a.id !== id));
}

// Saves a new account order. Accounts missing from `ids` keep their place at the end.
function reorderAccounts(ids) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const place = (a) => rank.get(a.id) ?? ids.length;
  writeAll(readAll().sort((a, b) => place(a) - place(b)));
}

// For other secrets (the read-tracking key), with the same protection as passwords.
const encryptString = (text) => cipher.encrypt(text);
const decryptString = (payload) => cipher.decrypt(payload);

module.exports = { init, getAccounts, publicAccount, addAccount, updateAccount, removeAccount, reorderAccounts, encryptString, decryptString };

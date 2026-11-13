const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  safeStorage,
  Notification,
  nativeTheme,
  nativeImage,
  Tray,
  Menu,
  clipboard,
  session,
} = require('electron');
const store = require('./lib/store');
const settings = require('./lib/settings');
const service = require('./lib/service');

// mailpart://att/?a=<account>&f=<folder>&u=<uid>&i=<index> serves attachments
// and inline images to the message view.
protocol.registerSchemesAsPrivileged([
  { scheme: 'mailpart', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// UNIFIED_INBOX_PROFILE=<folder> runs with a separate set of accounts.
if (process.env.UNIFIED_INBOX_PROFILE) app.setPath('userData', path.resolve(process.env.UNIFIED_INBOX_PROFILE));

if (!app.requestSingleInstanceLock()) app.quit();
// Windows only shows toasts for a registered app id; the installer registers
// ours, and in development the Electron executable stands in for it.
const APP_ID = app.isPackaged ? 'dev.unifiedinbox.app' : process.execPath;
app.setAppUserModelId(APP_ID);

// Windows silently drops notifications from an app id that no Start menu
// shortcut carries. The installer creates one; a copy run without installing
// (e.g. dist\win-unpacked) creates its own so its alerts show up too.
function registerForNotifications() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Unified Inbox.lnk');
  if (fs.existsSync(link)) return;
  shell.writeShortcutLink(link, 'create', {
    target: process.execPath,
    appUserModelId: APP_ID,
    description: 'Unified Inbox',
    icon: process.execPath,
    iconIndex: 0,
  });
}

const ICON = path.join(__dirname, 'build', 'icon.png');
const WIN_ICON = path.join(__dirname, 'build', 'icon.ico');
// Started by "Start with Windows": stay in the tray until opened.
const startHidden = process.argv.includes('--hidden');

let win;
let tray;
let quitting = false;

const THEME_COLORS = {
  light: { color: '#f6f8fc', symbolColor: '#444746' },
  dark: { color: '#1b1b1b', symbolColor: '#e3e3e3' },
};
const themeColors = () => THEME_COLORS[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

function openExternal(url) {
  if (/^mailto:/i.test(url)) {
    showWindow();
    win?.webContents.send('mailto', url);
  } else if (/^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  const colors = themeColors();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Unified Inbox',
    backgroundColor: colors.color,
    // Windows reads the multi-size .ico for the taskbar; a single PNG can show as a generic icon.
    icon: process.platform === 'win32' ? WIN_ICON : ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? true : { ...colors, height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Keep checking mail at full speed while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  win.on('focus', () => {
    win.flashFrame(false);
    service.pollTracking();
  });
  // Closing the window keeps the app running in the tray (if enabled).
  win.on('close', (event) => {
    if (!quitting && settings.get().runInBackground && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links inside emails open in the default browser; mailto: opens our composer.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !/^about:/.test(event.url)) {
      event.preventDefault();
      openExternal(event.url);
    }
  });
  win.webContents.on('context-menu', (_event, params) => showContextMenu(win.webContents, params));
}

// Right-click menu for links, images, selected text and text fields (in the
// app and inside opened emails). Electron shows none by default.
function contextMenuItems(wc, params) {
  const items = [];
  const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' });
  const link = params.linkURL;
  if (link && !/^(javascript|file|about):/i.test(link)) {
    const mail = /^mailto:/i.test(link);
    if (/^(https?|mailto):/i.test(link)) items.push({ label: mail ? 'Write email' : 'Open link', click: () => openExternal(link) });
    items.push({
      label: mail ? 'Copy email address' : 'Copy link address',
      click: () => clipboard.writeText(mail ? decodeURIComponent(link.replace(/^mailto:/i, '').split('?')[0]) : link),
    });
  }
  if (params.mediaType === 'image' && /^(https?|data):/i.test(params.srcURL)) {
    sep();
    items.push({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    if (/^https?:/i.test(params.srcURL)) items.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
  }
  if (params.isEditable) {
    if (params.misspelledWord) {
      sep();
      for (const word of params.dictionarySuggestions.slice(0, 5)) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
      if (!params.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false });
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    }
    sep();
    const f = params.editFlags;
    items.push(
      { label: 'Undo', role: 'undo', enabled: f.canUndo },
      { label: 'Redo', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: f.canCut },
      { label: 'Copy', role: 'copy', enabled: f.canCopy },
      { label: 'Paste', role: 'paste', enabled: f.canPaste },
      { label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: f.canPaste },
      { label: 'Select all', role: 'selectAll', enabled: f.canSelectAll }
    );
  } else if (params.selectionText.trim()) {
    sep();
    items.push({ label: 'Copy', role: 'copy' });
  }
  return items;
}

function showContextMenu(wc, params) {
  const items = contextMenuItems(wc, params);
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

// The proxy Windows uses for a mail server (follows the system/PAC settings a
// VPN app like Astrill sets), as a URL the mail libraries accept, or null.
const PROXY_SCHEMES = { PROXY: 'http', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5' };
async function systemProxyFor(host, port) {
  const rules = await session.defaultSession.resolveProxy(`https://${host}:${port}`);
  for (const rule of rules.split(';')) {
    const [type, address] = rule.trim().split(/\s+/);
    if (/^DIRECT$/i.test(type)) return null;
    const scheme = PROXY_SCHEMES[type?.toUpperCase()];
    if (scheme && address) return `${scheme}://${address}`;
  }
  return null;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Unified Inbox');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Unified Inbox', click: showWindow },
      { label: 'Check for new mail', click: () => win?.webContents.send('check-mail') },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', showWindow);
}

function applySettings(s) {
  nativeTheme.themeSource = s.theme;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.startWithWindows, args: ['--hidden'] });
}

nativeTheme.on('updated', () => {
  if (win && process.platform !== 'darwin') win.setTitleBarOverlay({ ...themeColors(), height: 48 });
  win?.setBackgroundColor(themeColors().color);
});

function notify({ title, body, ref }) {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body, icon: nativeImage.createFromPath(ICON) });
  n.on('click', () => {
    showWindow();
    if (!ref) return;
    const open = () => win.webContents.send('open-message', ref);
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', open);
    else open();
  });
  n.show();
  if (win && !win.isFocused()) win.flashFrame(true);
  return true;
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// Windows alerts for new mail, raised here (not by the window) so they also
// show while the app is hidden in the tray.
function alertNewMail(messages) {
  if (!settings.get().notifications) return;
  if (messages.length <= 3) {
    for (const m of messages) {
      notify({
        title: m.account ? `${m.from} · ${m.account}` : m.from,
        body: `${m.subject}${m.snippet ? `\n${clip(m.snippet, 120)}` : ''}`,
        ref: m.key,
      });
    }
  } else {
    notify({
      title: `${messages.length} new messages`,
      body: messages.slice(0, 4).map((m) => `${m.from}: ${m.subject}`).join('\n'),
    });
  }
}

// "Maya Patel opened your email" when a tracked message is opened.
function alertOpened(records) {
  if (!settings.get().notifications) return;
  for (const r of records.slice(0, 3)) {
    const first = String(r.to || '').split(',')[0].trim();
    const who = (first.match(/^"?([^"<]+?)"?\s*</)?.[1] || first.replace(/[<>]/g, '')).trim() || 'Someone';
    const last = r.opens[r.opens.length - 1];
    notify({
      title: `${who} opened your email`,
      body: `“${clip(r.subject || '(no subject)', 80)}”${last?.client && last.client !== 'Other' ? ` · ${last.client}` : ''}`,
    });
  }
}

function safeFilename(name) {
  return String(name || 'attachment').replace(/[\\/:*?"<>|]+/g, '_');
}

const handlers = {
  getState: () => ({ ...service.getState(), settings: settings.get(), tracking: service.trackingConfig() }),
  setTracking: (config) => service.setTracking(config),
  checkOpens: () => service.pollTracking(),
  avatars: ({ addresses }) => (settings.get().senderPhotos ? require('./lib/avatars').lookupMany(addresses) : {}),
  listMessages: (params) => service.listMessages(params),
  listEverything: (params) => service.listEverything(params),
  getThread: (params) => service.getThread(params),
  getMessage: (params) => service.getMessage(params),
  prefetch: (params) => service.prefetch(params),
  counts: (params) => service.counts(params),
  act: (params) => service.act(params),
  send: (mail) => service.send(mail),
  addAccount: (form) => service.addAccount(form),
  updateAccount: (form) => service.updateAccount(form),
  removeAccount: (params) => service.removeAccount(params),
  reorderAccounts: (params) => service.reorderAccounts(params),
  setAccountNotify: (params) => service.setAccountNotify(params),

  setSettings(changes) {
    const s = settings.update(changes);
    applySettings(s);
    if (!s.unreadBadge) handlers.setBadge({ count: 0 });
    return s;
  },

  async saveAttachment(params) {
    const att = await service.getAttachment(params);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('downloads'), safeFilename(att.filename)),
    });
    if (canceled || !filePath) return null;
    await fs.promises.writeFile(filePath, att.content);
    shell.showItemInFolder(filePath);
    return filePath;
  },

  openExternal: (url) => openExternal(url),

  notify(params) {
    return settings.get().notifications ? notify(params) : false;
  },

  testNotification: () => notify({ title: 'Unified Inbox', body: 'Notifications are working. New mail will show up like this.' }),

  // Unread count on the taskbar icon (overlay badge drawn by the renderer) and the tray.
  setBadge({ count, image }) {
    tray?.setToolTip(count ? `Unified Inbox — ${count} unread` : 'Unified Inbox');
    if (process.platform !== 'win32') app.setBadgeCount(count);
    else if (win) win.setOverlayIcon(count && image ? nativeImage.createFromDataURL(image) : null, count ? `${count} unread` : '');
    return true;
  },
};

// Every handler resolves to { ok, data } or { ok: false, error } so the
// renderer gets clean error messages instead of Electron's IPC wrapper text.
for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(name, async (_event, arg) => {
    try {
      return { ok: true, data: await fn(arg) };
    } catch (err) {
      console.error(`[${name}]`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

app.whenReady().then(() => {
  const dataDir = path.join(app.getPath('userData'), 'data');
  store.init(dataDir, safeStorage);
  settings.init(dataDir);
  service.initCache(dataDir);
  applySettings(settings.get());
  require('./lib/imap').setProxyResolver(systemProxyFor);
  // Log in to every account while the window loads, and listen for pushed mail.
  service.warmUp();
  service.startWatching();
  service.events.on('view', (update) => win?.webContents.send('view-updated', update));
  service.events.on('mail', (accountId) => win?.webContents.send('mail-changed', accountId));
  service.events.on('new-mail', alertNewMail);
  service.events.on('opened', (records) => {
    alertOpened(records);
    win?.webContents.send('tracking-updated');
  });
  registerForNotifications();
  // Read tracking: check for opens every minute (and when the window is focused).
  service.pollTracking();
  setInterval(() => service.pollTracking(), 60 * 1000);

  protocol.handle('mailpart', async (request) => {
    try {
      const url = new URL(request.url);
      const q = url.searchParams;
      const att = await service.getAttachment({ account: q.get('a'), folder: q.get('f'), uid: q.get('u'), idx: q.get('i') });
      return new Response(att.content, {
        headers: { 'content-type': att.contentType || 'application/octet-stream' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  createTray();
  createWindow();
});

app.on('second-instance', showWindow);

app.on('before-quit', () => {
  quitting = true;
  service.flushCache();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', showWindow);

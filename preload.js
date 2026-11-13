const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => async (arg) => {
  const res = await ipcRenderer.invoke(name, arg);
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getState: call('getState'),
  avatars: call('avatars'),
  listMessages: call('listMessages'),
  listEverything: call('listEverything'),
  getThread: call('getThread'),
  getMessage: call('getMessage'),
  prefetch: call('prefetch'),
  counts: call('counts'),
  act: call('act'),
  send: call('send'),
  addAccount: call('addAccount'),
  updateAccount: call('updateAccount'),
  removeAccount: call('removeAccount'),
  reorderAccounts: call('reorderAccounts'),
  setAccountNotify: call('setAccountNotify'),
  setSettings: call('setSettings'),
  saveAttachment: call('saveAttachment'),
  openExternal: call('openExternal'),
  notify: call('notify'),
  testNotification: call('testNotification'),
  setBadge: call('setBadge'),
  onOpenMessage: (cb) => ipcRenderer.on('open-message', (_e, ref) => cb(ref)),
  onMailto: (cb) => ipcRenderer.on('mailto', (_e, url) => cb(url)),
  onCheckMail: (cb) => ipcRenderer.on('check-mail', () => cb()),
  onViewUpdated: (cb) => ipcRenderer.on('view-updated', (_e, update) => cb(update)),
  onMailChanged: (cb) => ipcRenderer.on('mail-changed', (_e, accountId) => cb(accountId)),
  onTrackingUpdated: (cb) => ipcRenderer.on('tracking-updated', () => cb()),
  setTracking: call('setTracking'),
  checkOpens: call('checkOpens'),
});

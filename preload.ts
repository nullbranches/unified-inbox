// The bridge between the window and the main process, exposed as window.api.
// Runs sandboxed: it may only import 'electron' (type imports are fine, they
// disappear when compiled), so it must stay a single file.
import { contextBridge, ipcRenderer } from 'electron';

const call =
  <K extends Inbox.IpcName>(name: K) =>
  async (arg: Inbox.IpcArg<K>): Promise<Inbox.IpcResult<K>> => {
    const res: Inbox.IpcResponse<Inbox.IpcResult<K>> = await ipcRenderer.invoke(name, arg);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  };

const api: Inbox.Api = {
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
  onOpenMessage: (cb) => ipcRenderer.on('open-message', (_e, ref: string) => cb(ref)),
  onMailto: (cb) => ipcRenderer.on('mailto', (_e, url: string) => cb(url)),
  onCheckMail: (cb) => ipcRenderer.on('check-mail', () => cb()),
  onViewUpdated: (cb) => ipcRenderer.on('view-updated', (_e, update: Inbox.ViewUpdate) => cb(update)),
  onMailChanged: (cb) => ipcRenderer.on('mail-changed', (_e, accountId: string) => cb(accountId)),
  onTrackingUpdated: (cb) => ipcRenderer.on('tracking-updated', () => cb()),
  setTracking: call('setTracking'),
  checkOpens: call('checkOpens'),
};

contextBridge.exposeInMainWorld('api', api);

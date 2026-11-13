// App preferences, kept in settings.json next to the accounts.
import fs from 'fs';
import path from 'path';

type Settings = Inbox.Settings;

export const DEFAULTS: Settings = {
  theme: 'system', // 'system' | 'light' | 'dark'
  density: 'default', // 'default' | 'comfortable' | 'compact'
  inboxType: 'default', // 'default' | 'important' | 'unread' | 'starred'
  sectionSize: 25, // conversations per page of the inbox-type section ("Show up to")
  hideEmptySection: false, // leave the inbox-type section out when it has nothing in it
  readingPane: 'none', // 'none' | 'right' | 'below'
  threading: true, // group messages into conversations
  notifications: true, // Windows notifications for new mail
  unreadBadge: true, // unread count on the taskbar icon
  senderPhotos: true, // profile pictures from Gravatar (asked with a hash of the sender's address)
  runInBackground: true, // closing the window keeps checking mail from the tray
  startWithWindows: false,
  trackOpens: true, // new mail has read tracking on (once a tracker is set up)
};

const ALLOWED: { [K in keyof Settings]?: readonly Settings[K][] } = {
  theme: ['system', 'light', 'dark'],
  density: ['default', 'comfortable', 'compact'],
  inboxType: ['default', 'important', 'unread', 'starred'],
  sectionSize: [5, 10, 25, 50],
  readingPane: ['none', 'right', 'below'],
};

let file: string;
let current: Settings = { ...DEFAULTS };

export function init(dataDir: string): void {
  file = path.join(dataDir, 'settings.json');
  try {
    current = sanitize({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) });
  } catch {
    current = { ...DEFAULTS };
  }
}

// Every known setting, each one valid (anything else falls back to its default).
function sanitize(s: Record<string, unknown>): Settings {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = s[key];
    const allowed = ALLOWED[key as keyof Settings] as readonly unknown[] | undefined;
    if (allowed) out[key] = allowed.includes(v) ? v : def;
    else out[key] = typeof v === typeof def ? v : def;
  }
  return out as unknown as Settings;
}

export function get(): Settings {
  return { ...current };
}

export function update(changes: Partial<Settings>): Settings {
  current = sanitize({ ...current, ...changes });
  fs.writeFileSync(file, JSON.stringify(current, null, 2));
  return get();
}

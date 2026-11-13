// App preferences, kept in settings.json next to the accounts.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
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

const ALLOWED = {
  theme: ['system', 'light', 'dark'],
  density: ['default', 'comfortable', 'compact'],
  inboxType: ['default', 'important', 'unread', 'starred'],
  sectionSize: [5, 10, 25, 50],
  readingPane: ['none', 'right', 'below'],
};

let file;
let current = { ...DEFAULTS };

function init(dataDir) {
  file = path.join(dataDir, 'settings.json');
  try {
    current = sanitize({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) });
  } catch {
    current = { ...DEFAULTS };
  }
}

function sanitize(s) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = s[key];
    if (ALLOWED[key]) out[key] = ALLOWED[key].includes(v) ? v : def;
    else out[key] = typeof v === typeof def ? v : def;
  }
  return out;
}

function get() {
  return { ...current };
}

function update(changes) {
  current = sanitize({ ...current, ...changes });
  fs.writeFileSync(file, JSON.stringify(current, null, 2));
  return get();
}

module.exports = { init, get, update, DEFAULTS };

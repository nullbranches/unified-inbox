# Unified Inbox

A desktop app (Electron) that puts all of your email accounts into one inbox
that looks and works like Gmail.

- **One inbox for every account**: Gmail, Yahoo, iCloud and any IMAP/SMTP
  provider, merged and sorted by date. Each message has a colored label that
  shows which account it came from.
- **Gmail-style layout**: a sidebar with Inbox, Starred, Sent, Drafts, Spam,
  Trash and All Mail; tabs that filter the inbox to one account; a search bar;
  hover actions on each row; attachment chips under rows; and a compose window
  in the bottom-right corner.
- **Conversations**: replies are grouped into one row ("Carly, me 9"),
  including your own replies from Sent. Opening a row shows the whole
  conversation, with older messages collapsed. Gmail accounts use Gmail's own
  conversation IDs; other providers are grouped by reply headers.
- **Quick settings** (gear icon), like Gmail's:
  - Theme: Light / Dark / System
  - Density: Default / Comfortable / Compact
  - Inbox type: Default / Unread first / Starred first
  - Reading pane: No split / Right of inbox / Below inbox
  - Conversation view on/off
- **Replies come from the right account**: reply, reply all and forward use
  the account that received the message. In compose, the **From** menu lets
  you send from any account.
- **Search one account at a time**, picked from the menu in the search bar,
  including its Trash and Spam. Results show where each conversation is
  ("Inbox", "Trash", "Spam").
- **Read tracking, like Mailsuite**: emails sent with **Track** on show a gray
  ✓ once sent and a green ✓✓ once the recipient opens them, with a Windows
  alert ("Maya opened your email"). This needs a small tracker server that
  you deploy once (free on Cloudflare). See [tracker/README.md](tracker/README.md).
- **Windows alerts**: a notification for new mail (raised even while the
  window is hidden in the tray), an unread-count badge on the taskbar icon,
  and a tray icon. Closing the window keeps the app running
  in the tray and checking mail. It can also start with Windows. Each of
  these can be turned on or off in Quick settings, which also has a "Send a
  test notification" button.
- **Fast, the way Gmail does it**:
  - *Local database.* Mail lists, previews and recently downloaded messages
    live in a local SQLite database. Every screen is drawn from it first, in
    milliseconds, and then updated from the server in the background.
  - *Incremental sync.* The app only asks the server what changed: new
    messages, changed flags (via `CONDSTORE`) and deletions. When nothing
    changed, a sync costs a single `STATUS` round trip.
  - *Push.* A connection idles on each Inbox (IMAP `IDLE`), so new mail shows
    up as soon as it arrives instead of on the next poll.
  - *Prefetch.* Every visible conversation is downloaded in the background and
    kept on disk, so it opens instantly, even after a restart.
  - *Separate connections.* User actions, background sync and push each have
    their own connection, so nothing waits behind anything else.
- Gmail keyboard shortcuts (press `?` in the app to see them).
- Attachments: download them, attach your own files, and forward messages
  with their original attachments.
- Links in emails open in your default browser. `mailto:` links open the
  app's own compose window.

## Run it

```bash
npm install
npm start
```

On first launch the app shows **demo accounts** with sample mail so you can
look around. They disappear when you connect your first real account.

## Connect your accounts

Click the **+** next to "Accounts" in the sidebar (or the gear icon), choose a
provider, and enter your email address and an **app password**. Most providers
don't let other apps sign in with your normal password.

| Provider | How to get an app password |
| --- | --- |
| Gmail | Turn on 2-Step Verification, then visit <https://myaccount.google.com/apppasswords> |
| Yahoo | Account security → Generate app password |
| iCloud | <https://account.apple.com> → Sign-In and Security → App-Specific Passwords |
| Other | Use the IMAP/SMTP settings from your provider (expand **Server settings**) |

The app checks the IMAP login and the SMTP login before it saves an account.

> **Outlook.com / Hotmail:** Microsoft no longer allows password sign-in over
> IMAP for personal accounts. It requires OAuth, which this app doesn't
> support yet. Work and school Microsoft 365 accounts work only if your
> administrator still allows IMAP with passwords.

## Where your data lives

Accounts are stored in `%APPDATA%\Unified Inbox\data\accounts.json`.
Passwords are encrypted with the operating system's credential protection
(DPAPI on Windows, Keychain on macOS) through Electron `safeStorage`.

For speed, the app keeps a local copy of recent mail in
`%APPDATA%\Unified Inbox\data\mail-cache.sqlite`: lists, previews and the
newest few thousand messages. Like Gmail's offline mail, this copy isn't
encrypted on disk. Removing an account deletes its cached mail.

## Build a Windows installer

```bash
npm run dist
```

The installer is written to `dist/`.

## Troubleshooting

- **`npm start` says Electron failed to install.** `npm install` downloads
  the Electron binary (~160 MB) from GitHub, and slow connections can drop
  partway through. Run `node node_modules/electron/install.js` to retry.
- **Separate test profile.** Set `UNIFIED_INBOX_PROFILE` to a folder to run
  with a separate set of accounts, for example
  `$env:UNIFIED_INBOX_PROFILE="C:\temp\inbox-test"; npm start`.

## Limitations

- On non-Gmail accounts, conversations are found among roughly the newest 150
  Inbox and Sent messages, so very old replies may not join their
  conversation.
- Compose sends plain text. Drafts are shown but can't be edited.
- Inbox changes are pushed. Other folders sync every 2 minutes and when the
  window regains focus.

## Project layout

```
main.js            Electron main process: window, IPC, notifications, mailpart:// protocol
preload.js         Safe bridge exposing window.api to the UI
lib/service.js     Merges accounts into one mailbox, conversations, actions, sending, accounts
lib/settings.js    Quick-settings preferences (settings.json)
lib/tracking.js    Read tracking: tracking images, open polling, ✓/✓✓ status
tracker/           The read-tracking server (Cloudflare Worker or Node)
lib/imap.js        IMAP/SMTP backend: incremental mailbox mirrors, push (IDLE), prefetch
lib/cache.js       Local mail database (SQLite built into Electron)
lib/demo.js        Demo accounts and sample mail
lib/store.js       Account storage with encrypted passwords
lib/providers.js   Server presets for Gmail, Yahoo, iCloud, Outlook
renderer/          The Gmail-style UI (plain HTML/CSS/JS)
```

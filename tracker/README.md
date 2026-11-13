# Read tracking server

Read tracking works the way Mailsuite does it. Each email you send with
**Track** on carries an invisible 1×1 image. When the recipient opens the email
and their mail app loads images, it fetches that image from this server, which
records the time and the kind of mail app (Gmail, Outlook, Apple Mail…). The
app checks the server every minute and shows ✓ (sent) or a green ✓✓
(opened), plus a Windows alert when someone opens your email.

This server has to be reachable from the internet, because the recipient's mail
app loads the image. It stores no IP addresses, only open times.

## Option A: Cloudflare Workers (free, nothing to maintain)

You need a free Cloudflare account. From this folder:

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create OPENS
```

Paste the printed `id` into `wrangler.toml`. Then choose a long random secret
and store it:

```bash
npx wrangler secret put TRACKER_SECRET
```

```bash
npx wrangler deploy
```

Wrangler prints your address, like `https://unified-inbox-tracker.<you>.workers.dev`.

## Option B: your own server

```bash
TRACKER_SECRET=your-long-random-secret PORT=8787 node server.js
```

Serve it over HTTPS (for example behind nginx or Caddy, or on a hosting
service).

## Connect the app

Open **Quick settings** (gear icon) → **Read tracking** → **Set up tracker**.
Enter the address and the secret, then press **Save**; the app checks the
connection first.

## Good to know

- An open is only recorded when the recipient's mail app loads images. Some
  apps (Outlook, for example) block images from unknown senders until the
  recipient allows them.
- Apple Mail's Mail Privacy Protection downloads images in advance, so mail to
  Apple Mail users can show as opened before they've actually read it.
- Viewing your own sent mail inside Unified Inbox never counts as an open. The
  app removes its tracking images before showing a message. Viewing it in
  another app, such as Gmail on the web, can count.
- Tracking is invisible to recipients. In some places (for example the EU),
  privacy rules can require telling people or asking their consent, so check
  what applies to you.

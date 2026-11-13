// Read-tracking server for Unified Inbox, for any machine with Node.js
// (same API as worker.js). Opens are kept in opens.json next to this file.
//   TRACKER_SECRET=choose-a-long-random-string PORT=8787 node server.js
// It must be reachable from the internet over HTTPS (put it behind your
// web server or a hosting service) for recipients' mail apps to load images.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.TRACKER_SECRET;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'opens.json');
if (!SECRET) {
  console.error('Set TRACKER_SECRET to a long random string.');
  process.exit(1);
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let opens = {};
try {
  opens = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  /* first run */
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(opens), () => {}), 500);
}

// Which mail app loaded the image (IP addresses are never stored).
function mailApp(ua = '') {
  if (/GoogleImageProxy/i.test(ua)) return 'Gmail';
  if (/YahooMailProxy/i.test(ua)) return 'Yahoo Mail';
  if (/Microsoft Office|Outlook|ms-office/i.test(ua)) return 'Outlook';
  if (/iPhone|iPad|Macintosh/i.test(ua)) return 'Apple Mail';
  return 'Other';
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    const pixel = url.pathname.match(/^\/o\/([a-f0-9]{16,64})\.gif$/);
    if (pixel) {
      const id = pixel[1];
      (opens[id] ||= []).push({ at: new Date().toISOString(), client: mailApp(req.headers['user-agent']) });
      opens[id] = opens[id].slice(-100);
      save();
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0' });
      return res.end(GIF);
    }

    if (url.pathname === '/api/opens') {
      if (req.headers.authorization !== `Bearer ${SECRET}`) return json(res, { error: 'unauthorized' }, 401);
      const ids = (url.searchParams.get('ids') || '').split(',').filter((id) => /^[a-f0-9]{16,64}$/.test(id)).slice(0, 200);
      return json(res, Object.fromEntries(ids.map((id) => [id, opens[id] || []])));
    }

    res.writeHead(404);
    res.end('Not found');
  })
  .listen(PORT, () => console.log(`Unified Inbox tracker listening on port ${PORT}`));

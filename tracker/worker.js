// Read-tracking server for Unified Inbox, as a Cloudflare Worker (free plan).
// Sent emails contain an invisible 1x1 image, /o/<id>.gif. When the
// recipient's mail app loads it, the open is recorded in the OPENS KV
// namespace; the app asks GET /api/opens?ids=... (with the secret) for them.
// Only the time and the kind of mail app are stored, never IP addresses.

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const KEEP_DAYS = 90;

// Which mail app loaded the image.
function mailApp(ua = '') {
  if (/GoogleImageProxy/i.test(ua)) return 'Gmail';
  if (/YahooMailProxy/i.test(ua)) return 'Yahoo Mail';
  if (/Microsoft Office|Outlook|ms-office/i.test(ua)) return 'Outlook';
  if (/iPhone|iPad|Macintosh/i.test(ua)) return 'Apple Mail';
  return 'Other';
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const pixel = url.pathname.match(/^\/o\/([a-f0-9]{16,64})\.gif$/);
    if (pixel) {
      const id = pixel[1];
      const opens = JSON.parse((await env.OPENS.get(id)) || '[]');
      opens.push({ at: new Date().toISOString(), client: mailApp(request.headers.get('user-agent') || '') });
      await env.OPENS.put(id, JSON.stringify(opens.slice(-100)), { expirationTtl: KEEP_DAYS * 86400 });
      return new Response(GIF, {
        headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0' },
      });
    }

    if (url.pathname === '/api/opens') {
      if (request.headers.get('authorization') !== `Bearer ${env.TRACKER_SECRET}`) return json({ error: 'unauthorized' }, 401);
      const ids = (url.searchParams.get('ids') || '').split(',').filter((id) => /^[a-f0-9]{16,64}$/.test(id)).slice(0, 200);
      const values = await Promise.all(ids.map((id) => env.OPENS.get(id)));
      return json(Object.fromEntries(ids.map((id, i) => [id, JSON.parse(values[i] || '[]')])));
    }

    return new Response('Not found', { status: 404 });
  },
};

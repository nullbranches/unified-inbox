// In-memory demo backend with sample accounts and mail, used until a real
// account is connected. Implements the same interface as ./imap.js.

const ACCOUNTS = [
  { id: 'demo-personal', label: 'Personal', senderName: 'Alex Rivera', email: 'alex.rivera@gmail.com', color: '#1a73e8', provider: 'gmail', demo: true },
  { id: 'demo-work', label: 'Work', senderName: 'Alex Rivera', email: 'alex@northwind.dev', color: '#188038', provider: 'custom', demo: true },
  { id: 'demo-school', label: 'School', senderName: 'Alex Rivera', email: 'arivera@lakeside.edu', color: '#a142f4', provider: 'custom', demo: true },
];

const FOLDERS = { inbox: 'INBOX', sent: 'Sent', drafts: 'Drafts', spam: 'Spam', trash: 'Trash', archive: 'Archive' };

let nextUid = 1;
const messages = [];
const idsByLabel = new Map(); // demo label -> message, for building reply chains
const now = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// opts.id names a message so later ones can reply to it with opts.reply.
function add(accountId, folder, ago, from, subject, text, opts = {}) {
  const account = ACCOUNTS.find((a) => a.id === accountId);
  const [name, address] = from;
  const parent = opts.reply ? idsByLabel.get(opts.reply) : null;
  const uid = nextUid++;
  const msg = {
    accountId,
    folder,
    uid,
    from: { name, address },
    to: opts.to || [{ name: account.senderName, address: account.email }],
    cc: opts.cc || [],
    subject,
    text,
    html: opts.html || null,
    date: new Date(now - ago).toISOString(),
    unread: !!opts.unread,
    starred: !!opts.starred,
    attachments: opts.attachments || [],
    messageId: `<demo-${uid}@unified-inbox.local>`,
    inReplyTo: parent ? parent.messageId : null,
    references: parent ? [...parent.references, parent.messageId] : [],
  };
  messages.push(msg);
  if (opts.id) idsByLabel.set(opts.id, msg);
}

const me = (id) => {
  const a = ACCOUNTS.find((x) => x.id === id);
  return [a.senderName, a.email];
};
const to = (name, address) => ({ to: [{ name, address }] });

// ---------- Personal ----------
const maya = ['Maya Patel', 'maya.patel@gmail.com'];
add('demo-personal', 'INBOX', 9 * HOUR, maya, 'Dinner Saturday? 🍝',
  "Hey Alex!\n\nAre you free Saturday night? There's a new pasta place on 5th that just opened and the reviews are great. I was thinking 7:30 — Jordan and Sam might come too.\n\nLet me know!\nMaya", { id: 'dinner1' });
add('demo-personal', 'Sent', 6 * HOUR, me('demo-personal'), 'Re: Dinner Saturday? 🍝',
  "Count me in! 7:30 works. Want me to book?", { ...to(...maya), reply: 'dinner1', id: 'dinner2' });
add('demo-personal', 'INBOX', 25 * MIN, maya, 'Re: Dinner Saturday? 🍝',
  "Already done 😄 Table for 4 at 7:30 under Patel. Jordan and Sam are both in!", {
    unread: true,
    starred: true,
    reply: 'dinner2',
    // Quoted history the way Gmail sends it; the app hides it behind "•••".
    html: `<div dir="ltr">Already done 😄 Table for 4 at 7:30 under Patel. Jordan and Sam are both in!</div><br>
      <div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Sat, Alex Rivera &lt;alex.rivera@gmail.com&gt; wrote:<br></div>
      <blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">Count me in! 7:30 works. Want me to book?<br><br>
      <div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Sat, Maya Patel &lt;maya.patel@gmail.com&gt; wrote:<br></div>
      <blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">Hey Alex!<br><br>Are you free Saturday night? There's a new pasta place on 5th that just opened and the reviews are great.</blockquote></div>
      </blockquote></div>`,
  });

add('demo-personal', 'INBOX', 3 * HOUR, ['Skyline Airways', 'no-reply@skyline-air.example'], 'Your trip to Lisbon is confirmed ✈️',
  'Booking confirmed. Confirmation code QX7P2L. Departs Nov 14, 08:35 from SFO, arrives Lisbon Nov 15, 06:10.', {
    unread: true,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden">
      <div style="background:#0b3d91;color:#fff;padding:24px 28px"><div style="font-size:13px;letter-spacing:2px;opacity:.8">SKYLINE AIRWAYS</div><div style="font-size:24px;margin-top:6px">You're going to Lisbon!</div></div>
      <div style="padding:24px 28px;color:#333;font-size:14px;line-height:1.6">
        <p>Hi Alex, your booking is confirmed. Confirmation code: <b style="font-size:16px;letter-spacing:1px">QX7P2L</b></p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:12px;background:#f5f8ff;border-radius:8px 0 0 8px"><div style="font-size:28px;font-weight:bold;color:#0b3d91">SFO</div><div style="color:#666">Nov 14 · 08:35</div></td>
          <td style="padding:12px;background:#f5f8ff;text-align:center;color:#999">──── ✈ ────</td>
          <td style="padding:12px;background:#f5f8ff;border-radius:0 8px 8px 0;text-align:right"><div style="font-size:28px;font-weight:bold;color:#0b3d91">LIS</div><div style="color:#666">Nov 15 · 06:10</div></td></tr>
        </table>
        <p>Seat 23A · Economy · 1 checked bag</p>
        <p style="margin-top:24px"><a href="https://example.com" style="background:#0b3d91;color:#fff;padding:10px 20px;border-radius:20px;text-decoration:none">Manage booking</a></p>
      </div></div>`,
    attachments: [{ filename: 'itinerary.ics', contentType: 'text/calendar', content: 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:Flight SFO → LIS\nDTSTART:20261114T083500\nEND:VEVENT\nEND:VCALENDAR\n' }],
  });
add('demo-personal', 'INBOX', 20 * HOUR, ['Mom', 'linda.rivera@gmail.com'], 'Photos from the weekend',
  "Hi sweetie,\n\nHere are the pictures from grandpa's birthday. He loved the cake you picked out! Call me when you get a chance.\n\nLove,\nMom", { unread: true });
add('demo-personal', 'INBOX', 2 * DAY, ['Lumen Bank', 'statements@lumenbank.example'], 'Your October statement is ready',
  'Your monthly statement for the account ending in 4821 is now available. Sign in to the Lumen Bank app to view it.');

const jordan = ['Jordan Lee', 'jordan.lee@gmail.com'];
const sam = ['Sam Okoro', 'sam.okoro@gmail.com'];
const campers = { to: [{ name: jordan[0], address: jordan[1] }, { name: sam[0], address: sam[1] }] };
add('demo-personal', 'Sent', 6 * DAY, me('demo-personal'), 'Camping trip gear list',
  "Hey both — who's bringing what for the lake trip? I have the tent but not much else.", { ...campers, id: 'camp1' });
add('demo-personal', 'INBOX', 5 * DAY + 3 * HOUR, jordan, 'Re: Camping trip gear list',
  "I can bring the stove and fuel. Can you handle the cooler and the lantern?", { cc: campers.to.slice(1), reply: 'camp1', id: 'camp2' });
add('demo-personal', 'INBOX', 5 * DAY, sam, 'Re: Camping trip gear list',
  "I've got sleeping pads for everyone, and I'll bring the hammock 🙂", { reply: 'camp2', id: 'camp3' });
add('demo-personal', 'Sent', 4 * DAY, me('demo-personal'), 'Re: Camping trip gear list',
  "Perfect, cooler and lantern are on me. See you Friday!", { ...campers, reply: 'camp3', id: 'camp4' });
add('demo-personal', 'INBOX', 3 * DAY, jordan, 'Re: Camping trip gear list',
  "Also — does anyone have a bear canister? The ranger said we need one.", { starred: true, reply: 'camp4' });

add('demo-personal', 'INBOX', 4 * DAY + 2 * HOUR, ['Bookshelf Weekly', 'newsletter@bookshelf.example'], '5 books to read this fall 🍂',
  'Cozy reads for shorter days: our editors pick five novels perfect for the season.', {
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#3b2f2f">
      <h1 style="font-size:28px;border-bottom:3px solid #c8553d;padding-bottom:8px">Bookshelf Weekly</h1>
      <p style="font-size:16px">Cozy reads for shorter days. Our editors picked five novels perfect for the season.</p>
      <ol style="font-size:15px;line-height:1.8"><li><b>The Lantern Keeper</b> — a lighthouse mystery</li><li><b>Orchard Road</b> — three generations, one farm</li><li><b>Small Hours</b> — short stories about night shifts</li><li><b>North of Quiet</b> — an Arctic expedition gone wrong</li><li><b>The Paper Garden</b> — a love letter to libraries</li></ol>
      <p style="font-size:13px;color:#888">You're receiving this because you subscribed to Bookshelf Weekly.</p></div>`,
  });
add('demo-personal', 'INBOX', 9 * DAY, ['CloudBox', 'support@cloudbox.example'], "You're running out of storage",
  "You've used 14.2 GB of your 15 GB. Free up space or upgrade to keep syncing your files.");
add('demo-personal', 'INBOX', 16 * DAY, ['Pixelcraft Store', 'orders@pixelcraft.example'], 'Your order has shipped 📦',
  'Good news! Order #PC-20931 (mechanical keyboard, wrist rest) is on its way. Estimated delivery: 3–5 business days.');

// ---------- Work ----------
const priya = ['Priya Shah', 'priya@northwind.dev'];
const daniel = ['Daniel Kim', 'daniel@northwind.dev'];
add('demo-work', 'INBOX', 2 * HOUR, priya, 'Q4 roadmap review — notes attached',
  "Hi team,\n\nAttached are the milestones we discussed. Please add comments before Thursday's review, especially on the API rate-limiting and the mobile onboarding items.\n\nThanks,\nPriya", {
    id: 'q4a',
    cc: [{ name: daniel[0], address: daniel[1] }],
    attachments: [{ filename: 'q4-milestones.csv', contentType: 'text/csv', content: 'Milestone,Owner,Due\nAPI rate limiting,Alex,Nov 6\nMobile onboarding v2,Sofia,Nov 20\nBilling migration,Daniel,Dec 4\n' }],
  });
add('demo-work', 'INBOX', 50 * MIN, daniel, 'Re: Q4 roadmap review — notes attached',
  "Added my comments. I think rate limiting needs per-API-key limits, not just global ones — happy to pair on it.\n\nOn Tue, Priya Shah <priya@northwind.dev> wrote:\n> Hi team,\n>\n> Attached are the milestones we discussed. Please add comments before\n> Thursday's review, especially on the API rate-limiting and the mobile\n> onboarding items.\n>\n> Thanks,\n> Priya", {
    unread: true, reply: 'q4a', to: [{ name: priya[0], address: priya[1] }], cc: [{ name: 'Alex Rivera', address: 'alex@northwind.dev' }],
  });
add('demo-work', 'INBOX', 70 * MIN, ['CodeHub', 'notifications@codehub.example'], '[northwind/api] PR #482: Add rate limiting middleware',
  'daniel-kim requested your review on #482.\n\nAdds a token-bucket rate limiter in front of the public API routes. Config via RATE_LIMIT_RPS.', { unread: true });
add('demo-work', 'INBOX', 4 * HOUR, daniel, 'Quick sync about the launch?',
  "Hey, do you have 15 min this afternoon? Want to go over the launch checklist before we send it to marketing.", { unread: true });
add('demo-work', 'INBOX', 26 * HOUR, ['Northwind People Team', 'people@northwind.dev'], 'Open enrollment ends Friday',
  'Reminder: benefits open enrollment closes this Friday at 5pm. If you do nothing, your current elections roll over.');
add('demo-work', 'INBOX', 30 * HOUR, ['PagerAlert', 'alerts@pageralert.example'], '[Resolved] High latency on checkout-service',
  'Incident #1193 resolved after 18 minutes. p99 latency back under 300ms. Root cause: connection pool exhaustion after deploy 2026.10.18-3.');

const sofia = ['Sofia Martinez', 'sofia@northwind.dev'];
add('demo-work', 'Sent', 4 * DAY, me('demo-work'), 'Customer interview notes',
  'Notes from this week are in the doc. Top themes: export, SSO, mobile.', { ...to(...sofia), id: 'int1' });
add('demo-work', 'INBOX', 3 * DAY, sofia, 'Re: Customer interview notes',
  "Thanks for sharing these! The bit about export to CSV came up in 4 of 6 interviews — feels like we should prioritize it.", { starred: true, reply: 'int1', id: 'int2' });
add('demo-work', 'Sent', 2 * DAY, me('demo-work'), 'Re: Customer interview notes',
  "Agreed — let's put CSV export on the Q4 list.", { ...to(...sofia), reply: 'int2', id: 'int3' });
add('demo-work', 'INBOX', 28 * HOUR, sofia, 'Re: Customer interview notes',
  '👍 Added it to the roadmap doc under "Quick wins".', { reply: 'int3' });

add('demo-work', 'INBOX', 4 * DAY + 5 * HOUR, priya, 'Invitation: Design review @ Thu 2pm',
  'You have been invited to: Design review\nThursday 2:00pm – 3:00pm\nRoom: Juniper / video link in invite', {
    attachments: [{ filename: 'invite.ics', contentType: 'text/calendar', content: 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:Design review\nEND:VEVENT\nEND:VCALENDAR\n' }],
  });
add('demo-work', 'INBOX', 6 * DAY, ['Team Northwind', 'team@northwind.dev'], '🎉 Team lunch Friday — vote for the place',
  'Tacos, ramen, or the salad place? Vote in the thread by Wednesday!');

// ---------- School ----------
const okafor = ['Prof. Helen Okafor', 'hokafor@lakeside.edu'];
add('demo-school', 'INBOX', 90 * MIN, okafor, 'CS 340: Assignment 3 feedback',
  'Hi Alex,\n\nNice work on the scheduler implementation. Your analysis of the round-robin quantum was especially clear. See comments in the grading portal — mostly minor style notes.\n\nGrade: 94/100\n\nProf. Okafor', { unread: true });
add('demo-school', 'Sent', 3 * DAY, me('demo-school'), 'Question about assignment 3',
  'Hi Prof. Okafor, is it OK to use a priority queue from the standard library?', { ...to(...okafor), id: 'q3' });
add('demo-school', 'INBOX', 2 * DAY + 20 * HOUR, okafor, 'Re: Question about assignment 3',
  'Yes, the standard library priority queue is fine — just explain your choice in the write-up.', { reply: 'q3' });
add('demo-school', 'INBOX', 22 * HOUR, ['Lakeside Library', 'library@lakeside.edu'], 'Your hold is ready for pickup',
  '"Operating Systems: Three Easy Pieces" is ready at the main desk. It will be held for 7 days.', { unread: true });

const lena = ['Lena Fischer', 'lfischer@lakeside.edu'];
const raj = ['Raj Mehta', 'rmehta@lakeside.edu'];
add('demo-school', 'INBOX', 3 * DAY, lena, 'Midterm study session — room 204?',
  "Who's in for a study session Wednesday evening? I can try to book room 204.", { id: 'study1' });
add('demo-school', 'Sent', 2 * DAY + 12 * HOUR, me('demo-school'), 'Re: Midterm study session — room 204?',
  "I'm in! I'll bring the practice exams.", { ...to(...lena), reply: 'study1', id: 'study2' });
add('demo-school', 'INBOX', 2 * DAY, raj, 'Re: Midterm study session — room 204?',
  'Booked room 204 for Wednesday 6–9pm. Pizza fund is $5/person 🍕', { reply: 'study2' });

add('demo-school', 'INBOX', 7 * DAY, ['Office of the Registrar', 'registrar@lakeside.edu'], 'Spring 2027 registration opens Nov 2',
  'Your registration window opens Monday, Nov 2 at 8:00am. Check your holds and meet with your advisor beforehand.');
add('demo-school', 'INBOX', 12 * DAY, ['Career Center', 'careers@lakeside.edu'], 'Internship fair next week: 40+ employers',
  'Bring your resume! Thursday 11am–3pm in the Student Union ballroom.', {
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#5b2c83;color:#fff;padding:28px;border-radius:12px 12px 0 0;text-align:center"><div style="font-size:26px;font-weight:bold">Internship Fair</div><div style="opacity:.85;margin-top:4px">Thursday · 11am–3pm · Student Union</div></div>
      <div style="border:1px solid #eee;border-top:0;padding:20px 28px;border-radius:0 0 12px 12px;font-size:14px;color:#333;line-height:1.6">
        <p>40+ employers are coming, from startups to research labs. Drop-in resume reviews all week.</p>
        <p><b>Tip:</b> prepare a 30-second intro about a project you're proud of.</p></div></div>`,
  });

// ---------- Other folders ----------
add('demo-work', 'Drafts', 5 * HOUR, me('demo-work'), 'Launch checklist (draft)', '1. Final QA pass\n2. Update status page\n3. ', to(...daniel));
add('demo-personal', 'Spam', 8 * HOUR, ['Prize Center', 'winner@prizes-now.example'], "Congratulations!!! You've WON a $1000 gift card", 'Click here to claim your prize before it expires!!!', { unread: true });
add('demo-school', 'Spam', 2 * DAY, ['IT Helpdesk', 'helpdesk@lakeside-edu-verify.example'], 'Urgent: verify your mailbox now', 'Your mailbox will be deactivated in 24 hours unless you verify your password.', { unread: true });
add('demo-personal', 'Trash', 6 * DAY, ['Daily Deals', 'deals@dailydeals.example'], 'Flash sale: 70% off everything', 'Today only!');

// ---------- interface ----------

const find = (accountId, folder, uid) =>
  messages.find((m) => m.accountId === accountId && m.folder === folder && m.uid === Number(uid));

const ROLES = Object.fromEntries(Object.entries(FOLDERS).map(([role, folder]) => [folder, role]));

function summary(m) {
  return {
    accountId: m.accountId,
    folder: m.folder,
    role: ROLES[m.folder] || null,
    uid: m.uid,
    from: m.from,
    to: m.to,
    subject: m.subject,
    snippet: m.text.replace(/\s+/g, ' ').slice(0, 200),
    date: m.date,
    size: m.text.length + (m.html?.length || 0),
    unread: m.unread,
    starred: m.starred,
    draft: m.folder === 'Drafts',
    hasAttachments: m.attachments.length > 0,
    files: m.attachments.map((a) => ({ name: a.filename, type: a.contentType })),
    messageId: m.messageId,
    inReplyTo: m.inReplyTo,
    references: m.references,
    threadId: null,
    emailId: null,
    // Demo mail has no headers to judge by; importance comes from the sender (service.js).
    bulk: false,
    priorityHigh: false,
    gmImportant: null,
  };
}

function newest(list, count) {
  const sorted = list.sort((a, b) => b.date.localeCompare(a.date));
  return { total: sorted.length, messages: sorted.slice(0, count).map(summary) };
}

const visible = (m) => m.folder !== 'Trash' && m.folder !== 'Spam';

async function list(account, folderKey, count) {
  const mine = messages.filter((m) => m.accountId === account.id);
  if (folderKey === 'starred') return newest(mine.filter((m) => m.starred && visible(m)), count);
  if (folderKey === 'all') return newest(mine.filter(visible), count);
  return newest(mine.filter((m) => m.folder === FOLDERS[folderKey]), count);
}

async function listFiltered(account, filter, count) {
  const want = (m) => (filter === 'unread' ? m.unread : m.starred);
  return newest(messages.filter((m) => m.accountId === account.id && m.folder === 'INBOX' && want(m)), count);
}

// Searches every folder, Trash and Spam included.
async function search(account, query, count) {
  const q = query.toLowerCase();
  const hit = (m) =>
    [m.subject, m.text, m.from.name, m.from.address, ...m.to.map((t) => t.address)].join(' ').toLowerCase().includes(q);
  return newest(messages.filter((m) => m.accountId === account.id && hit(m)), count);
}

// Everything else in the account's Inbox, Sent and Archive could be part of a conversation.
async function related(account, folderKey, items) {
  const own = new Set(items.map((m) => `${m.folder}|${m.uid}`));
  return messages
    .filter((m) => m.accountId === account.id && ['INBOX', 'Sent', 'Archive'].includes(m.folder) && !own.has(`${m.folder}|${m.uid}`))
    .map(summary);
}

async function threadCandidates(account, folder, uid) {
  const m = find(account.id, folder, uid);
  if (!m) throw Object.assign(new Error('Message not found'), { status: 404 });
  return { target: summary(m), candidates: await related(account, null, [summary(m)]) };
}

async function fillSnippets() {}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function textToHtml(text) {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

async function prefetch() {} // demo mail is already in memory

async function get(account, folder, uid, { markSeen = true } = {}) {
  const m = find(account.id, folder, uid);
  if (!m) throw Object.assign(new Error('Message not found'), { status: 404 });
  if (markSeen) m.unread = false;
  return {
    accountId: m.accountId,
    folder: m.folder,
    uid: m.uid,
    subject: m.subject,
    from: m.from,
    to: m.to,
    cc: m.cc,
    replyTo: [],
    date: m.date,
    html: m.html || textToHtml(m.text),
    plain: !m.html,
    text: m.text,
    messageId: m.messageId,
    references: m.references,
    attachments: m.attachments.map((a, idx) => ({
      idx,
      filename: a.filename,
      contentType: a.contentType,
      size: Buffer.byteLength(a.content),
      cid: null,
      related: false,
    })),
  };
}

async function attachment(account, folder, uid, idx) {
  const a = find(account.id, folder, uid)?.attachments[idx];
  return a && { ...a, content: Buffer.from(a.content) };
}

async function forwardAttachments(account, folder, uid) {
  return (find(account.id, folder, uid)?.attachments || []).map((a) => ({ ...a, content: Buffer.from(a.content) }));
}

async function setFlags(account, folder, uids, { seen, flagged }) {
  for (const uid of uids) {
    const m = find(account.id, folder, uid);
    if (!m) continue;
    if (seen !== undefined) m.unread = !seen;
    if (flagged !== undefined) m.starred = flagged;
  }
}

async function setImportant() {} // remembered by the service

async function move(account, folder, uids, target) {
  const dest = FOLDERS[target];
  if (!dest) throw new Error(`No ${target} folder`);
  for (const uid of uids) {
    const m = find(account.id, folder, uid);
    // Archiving only takes messages out of the inbox (not your Sent replies).
    if (m && (target !== 'archive' || m.folder === 'INBOX')) m.folder = dest;
  }
}

async function remove(account, folder, uids) {
  if (folder !== 'Trash' && folder !== 'Spam') return move(account, folder, uids, 'trash');
  for (const uid of uids) {
    const idx = messages.findIndex((m) => m.accountId === account.id && m.folder === folder && m.uid === Number(uid));
    if (idx !== -1) messages.splice(idx, 1);
  }
}

async function counts(account) {
  const mine = messages.filter((m) => m.accountId === account.id);
  return {
    inbox: mine.filter((m) => m.folder === 'INBOX' && m.unread).length,
    spam: mine.filter((m) => m.folder === 'Spam' && m.unread).length,
    drafts: mine.filter((m) => m.folder === 'Drafts').length,
  };
}

function parseAddresses(str) {
  return String(str || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const match = s.match(/^(.*)<([^>]+)>$/);
      return match ? { name: match[1].trim().replace(/^"|"$/g, ''), address: match[2].trim() } : { name: '', address: s };
    });
}

// "Sends" by filing the message in Sent, and delivers it to any demo account it was addressed to.
async function send(account, mail) {
  const recipients = parseAddresses(mail.to);
  const references = [].concat(mail.references || []).map((r) => String(r).toLowerCase());
  const base = {
    from: { name: account.senderName, address: account.email },
    to: recipients,
    cc: parseAddresses(mail.cc),
    subject: mail.subject || '(no subject)',
    text: mail.text || '',
    html: mail.html || null,
    date: new Date().toISOString(),
    starred: false,
    attachments: mail.attachments || [],
    messageId: `<demo-${nextUid}@unified-inbox.local>`,
    inReplyTo: mail.inReplyTo ? String(mail.inReplyTo).toLowerCase() : null,
    references,
  };
  messages.push({ ...base, accountId: account.id, folder: 'Sent', uid: nextUid++, unread: false });
  for (const rcpt of [...recipients, ...base.cc]) {
    const target = ACCOUNTS.find((a) => a.email.toLowerCase() === rcpt.address.toLowerCase());
    if (target) messages.push({ ...base, accountId: target.id, folder: 'INBOX', uid: nextUid++, unread: true });
  }
  return base.messageId;
}

async function test() {}
function disconnect() {}
async function warmUp() {}

module.exports = {
  ACCOUNTS,
  warmUp,
  list,
  listFiltered,
  search,
  related,
  threadCandidates,
  fillSnippets,
  get,
  prefetch,
  attachment,
  forwardAttachments,
  setFlags,
  setImportant,
  move,
  remove,
  counts,
  send,
  test,
  disconnect,
  friendlyError: (err) => err.message,
};

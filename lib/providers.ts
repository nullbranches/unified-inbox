// Server presets for common providers. All of them need an "app password"
// (a password generated in the provider's security settings), not the normal
// login password.
export const PROVIDERS: Record<Inbox.ProviderId, Inbox.Provider> = {
  gmail: {
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    // Gmail stores messages sent over SMTP in Sent automatically.
    appendSent: false,
    help: 'https://myaccount.google.com/apppasswords',
    helpText: 'Turn on 2-Step Verification, then create an app password.',
  },
  yahoo: {
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    appendSent: false,
    help: 'https://login.yahoo.com/account/security',
    helpText: 'Account security → Generate app password.',
  },
  icloud: {
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    appendSent: true,
    help: 'https://account.apple.com/account/manage',
    helpText: 'Sign-In and Security → App-Specific Passwords.',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    appendSent: false,
    help: 'https://account.microsoft.com/security',
    helpText:
      'Only works if your organization still allows IMAP with passwords. Personal Outlook.com accounts require OAuth and are not supported yet.',
  },
  custom: {
    label: 'Other (IMAP/SMTP)',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    appendSent: true,
    help: '',
    helpText: 'Enter the IMAP and SMTP settings from your mail provider.',
  },
};

export function guessProvider(email: string): Inbox.ProviderId {
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  if (['gmail.com', 'googlemail.com'].includes(domain)) return 'gmail';
  if (domain.startsWith('yahoo.') || domain === 'ymail.com') return 'yahoo';
  if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) return 'icloud';
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook';
  return 'custom';
}

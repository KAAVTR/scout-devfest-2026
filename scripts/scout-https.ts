/** Shared HTTPS admission. A prefix check is not enough. */
export function admitHttps(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length < 12 || raw.length > 300) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname;
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host === '127.0.0.1') return null;
    return url.toString();
  } catch {
    return null;
  }
}

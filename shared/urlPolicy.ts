/**
 * Exact-property listing page policy. Pure string checks; the app never fetches these URLs.
 * Only detail pages on an explicit host allowlist qualify. Roots, search/directory pages,
 * lookalike hosts, credentials, ports, IP literals and non-HTTP(S) schemes are rejected.
 */
interface HostRule {
  host: string; // registrable host; "www." prefix also accepted
  label: string;
  path: RegExp; // must match the full pathname
}

const RULES: HostRule[] = [
  { host: 'zillow.com', label: 'Zillow home details', path: /^\/homedetails\/[A-Za-z0-9-]+\/\d+_zpid\/?$/ },
  { host: 'realtor.com', label: 'Realtor.com property detail', path: /^\/realestateandhomes-detail\/[A-Za-z0-9-]+_M\d{5}-\d{5}\/?$/ },
  { host: 'redfin.com', label: 'Redfin home page', path: /^\/[A-Z]{2}\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\/home\/\d+\/?$/ },
  { host: 'homes.com', label: 'Homes.com property', path: /^\/property\/[A-Za-z0-9-]+\/[A-Za-z0-9]+\/?$/ },
  { host: 'trulia.com', label: 'Trulia home', path: /^\/home\/[A-Za-z0-9-]+-\d+\/?$/ },
  { host: 'loopnet.com', label: 'LoopNet listing', path: /^\/Listing\/[A-Za-z0-9-]+\/\d+\/?$/ },
];

export type ListingUrlVerdict =
  | { ok: true; canonical: string; host: string; label: string }
  | { ok: false; reason: string };

export function checkListingUrl(raw: unknown): ListingUrlVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'No listing URL supplied' };
  const text = raw.trim();
  if (text.length === 0 || text.length > 500) return { ok: false, reason: 'Listing URL empty or too long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(text)) return { ok: false, reason: 'Listing URL contains whitespace, control or backslash characters' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'Listing URL is not a valid absolute URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: `Scheme ${url.protocol} not allowed` };
  if (url.username || url.password) return { ok: false, reason: 'Credentials in URL not allowed' };
  if (url.port !== '') return { ok: false, reason: 'Non-default port not allowed' };
  const host = url.hostname.toLowerCase();
  if (host.endsWith('.')) return { ok: false, reason: 'Trailing-dot hostname not allowed' };
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) return { ok: false, reason: 'IP-literal host not allowed' };
  if (host.split('.').some((label) => label.startsWith('xn--'))) return { ok: false, reason: 'Internationalized (punycode) hostname not allowed' };
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  const rule = RULES.find((r) => r.host === bare);
  if (!rule) return { ok: false, reason: `Host ${host} is not an allowed listing-detail source` };
  if (url.pathname.includes('%')) return { ok: false, reason: 'Percent-encoded characters in path not allowed' };
  if (!rule.path.test(url.pathname)) return { ok: false, reason: `${rule.label}: URL is not an exact property detail page (root, search or directory pages are rejected)` };
  const canonicalPath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  return { ok: true, canonical: `https://www.${bare}${canonicalPath}`, host: bare, label: rule.label };
}

/** Canonical form used to compare citation URLs with listing URLs (query and fragment ignored). */
export function canonicalForComparison(raw: string): string | null {
  const v = checkListingUrl(raw);
  return v.ok ? v.canonical : null;
}

export const ALLOWED_LISTING_HOSTS = RULES.map((r) => r.host);

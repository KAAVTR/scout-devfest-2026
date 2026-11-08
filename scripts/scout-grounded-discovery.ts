/**
 * Opt-in Google Search grounding. Offline until a separate authorization file exists.
 * This module does not call the SDK. It does not spend the baseline 104-cent slot.
 * The installed SDK tool is `{ type: 'google_search' }`. That object has no query-count field.
 */
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { admitHttps } from './scout-https.ts';
import { PINNED_MODEL, RESEARCH_PROMPT_CHAR_CAP } from './scout-spend-ledger.ts';
import { parseEvidenceRequest, type EvidenceItem, type EvidenceLocation } from './scout-evidence-explain.ts';

export const GROUNDING_OUTPUT_TOKEN_CAP = 512;
const KEYS = ['attemptsUsed', 'credit', 'maxAttempts', 'model', 'purpose', 'searchQueriesPreCapped', 'stopOnQuota', 'v'];

export interface GroundingAuth {
  v: 1;
  purpose: 'google-search-grounding-one-off';
  model: typeof PINNED_MODEL;
  credit: 'existing';
  searchQueriesPreCapped: false;
  stopOnQuota: true;
  maxAttempts: 1;
  attemptsUsed: number;
}

export function groundingMode(env: NodeJS.ProcessEnv): 'off' | 'mock' | 'gemini' {
  const raw = env.SCOUT_GROUNDING?.trim().toLowerCase() ?? 'off';
  if (raw === 'mock') return 'mock';
  if (raw === 'gemini') return 'gemini';
  return 'off';
}

export function groundingPrompt(location: EvidenceLocation): string {
  const place = location.kind === 'zip' ? `ZIP ${location.zip}` : `${location.city}, ${location.state}`;
  return [
    `Find public web pages about residential property listings in ${place}.`,
    'Use Google Search. Return only links the search tool actually cited.',
    'Do not invent a price, a unit count, a listing status, or a street address that the tool did not return.',
    'Return JSON with a short summary and a short uncertainty note.',
  ].join(' ');
}

/** Exact body for a later live grounding call. Search billing is per model-chosen query and is not capped here. */
export function groundingOutboundPayload(location: EvidenceLocation): Record<string, unknown> | null {
  const input = groundingPrompt(location);
  if (input.length === 0 || input.length > RESEARCH_PROMPT_CHAR_CAP) return null;
  return {
    model: PINNED_MODEL,
    input,
    tools: [{ type: 'google_search' }],
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: { type: 'object', properties: { summary: { type: 'string' }, uncertainty: { type: 'string' } }, required: ['summary', 'uncertainty'] },
    },
    store: false,
    automatic_continuation: false,
    generation_config: { max_output_tokens: GROUNDING_OUTPUT_TOKEN_CAP, thinking_level: 'low' },
  };
}

export function parseGroundingAuth(raw: string): GroundingAuth | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== KEYS.join()) return null;
  if (record.v !== 1 || record.purpose !== 'google-search-grounding-one-off') return null;
  if (record.model !== PINNED_MODEL || record.credit !== 'existing' || record.searchQueriesPreCapped !== false) return null;
  if (record.stopOnQuota !== true || record.maxAttempts !== 1) return null;
  if (record.attemptsUsed !== 0 && record.attemptsUsed !== 1) return null;
  return record as unknown as GroundingAuth;
}

function writeAuth(path: string, record: GroundingAuth): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    const payload = Buffer.from(JSON.stringify(record));
    let offset = 0;
    while (offset < payload.length) offset += writeSync(fd, payload, offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** One attempt on a parent-supplied file. Does not create a file and does not touch the baseline record. */
export function claimGroundingAttempt(recordPath: string, baselinePath: string): { ok: true; auth: GroundingAuth } | { ok: false; kind: string } {
  const path = recordPath.trim();
  if (!path || !isAbsolute(path)) return { ok: false, kind: 'record-unset' };
  if (baselinePath.trim() && path === baselinePath.trim()) return { ok: false, kind: 'record-shared-with-baseline' };
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return { ok: false, kind: existsSync(path) ? 'record-corrupt' : 'record-missing' };
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch { return { ok: false, kind: 'record-unreadable' }; }
  try {
    const current = parseGroundingAuth(readFileSync(path, 'utf8'));
    if (!current) return { ok: false, kind: 'record-corrupt' };
    if (current.attemptsUsed >= 1) return { ok: false, kind: 'attempt-blocked' };
    const next: GroundingAuth = { ...current, attemptsUsed: 1 };
    writeAuth(path, next);
    return { ok: true, auth: next };
  } catch {
    return { ok: false, kind: 'record-unreadable' };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export interface DiscoveredLink {
  url: string;
  title: string | null;
  provenance: 'grounding';
  verifiedListing: false;
  price: null;
  units: null;
  status: null;
}

export function linksFromGrounding(outcome: unknown): { queries: string[]; chunks: { uri: string; title: string | null }[]; links: DiscoveredLink[] } {
  const queries: string[] = [];
  const chunks: { uri: string; title: string | null }[] = [];
  const links: DiscoveredLink[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, title: unknown) => {
    const admitted = typeof url === 'string' ? admitHttps(url) : null;
    if (!admitted || seen.has(admitted)) return;
    seen.add(admitted);
    const safeTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 160) : null;
    links.push({ url: admitted, title: safeTitle, provenance: 'grounding', verifiedListing: false, price: null, units: null, status: null });
  };
  if (!outcome || typeof outcome !== 'object') return { queries, chunks, links };
  const record = outcome as { steps?: unknown; groundingMetadata?: unknown };
  const steps = Array.isArray(record.steps) ? record.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const typed = step as { type?: string; arguments?: { queries?: unknown }; content?: unknown; groundingMetadata?: unknown };
    if (typed.type === 'google_search_call' && Array.isArray(typed.arguments?.queries)) {
      for (const query of typed.arguments.queries) if (typeof query === 'string') queries.push(query);
    }
    collectMetadata(typed.groundingMetadata, queries, chunks, add);
    if (!Array.isArray(typed.content)) continue;
    for (const part of typed.content) {
      const annotations = part && typeof part === 'object' ? (part as { annotations?: unknown }).annotations : null;
      if (!Array.isArray(annotations)) continue;
      for (const note of annotations) {
        if (!note || typeof note !== 'object' || (note as { type?: string }).type !== 'url_citation') continue;
        add((note as { url?: unknown }).url, (note as { title?: unknown }).title);
      }
    }
  }
  collectMetadata(record.groundingMetadata, queries, chunks, add);
  return { queries, chunks, links };
}

function collectMetadata(raw: unknown, queries: string[], chunks: { uri: string; title: string | null }[], add: (url: unknown, title: unknown) => void): void {
  if (!raw || typeof raw !== 'object') return;
  const meta = raw as { webSearchQueries?: unknown; groundingChunks?: unknown };
  if (Array.isArray(meta.webSearchQueries)) {
    for (const query of meta.webSearchQueries) if (typeof query === 'string') queries.push(query);
  }
  if (!Array.isArray(meta.groundingChunks)) return;
  for (const chunk of meta.groundingChunks) {
    const web = chunk && typeof chunk === 'object' ? (chunk as { web?: { uri?: unknown; title?: unknown } }).web : null;
    if (!web || typeof web.uri !== 'string') continue;
    const admitted = admitHttps(web.uri);
    if (!admitted) continue;
    const title = typeof web.title === 'string' ? web.title : null;
    chunks.push({ uri: admitted, title });
    add(admitted, title);
  }
}

export function evidenceFromDiscovery(links: DiscoveredLink[]): EvidenceItem[] {
  return links.map((link) => ({
    label: link.title ?? 'Grounding link',
    statement: 'A grounding response included this https link. Price, unit count, and listing status were not supplied.',
    provenance: 'grounding',
    sourceUrl: link.url,
    observedAt: null,
  }));
}

async function openLiveTransport(env: NodeJS.ProcessEnv): Promise<((params: Record<string, unknown>) => Promise<unknown>) | null> {
  if (env.SCOUT_GROUNDING_ENABLE !== '1') return null;
  const key = env.GEMINI_API_KEY?.trim() ?? '';
  if (key.length < 20) return null;
  const { createSdkTransport } = await import('../server/provider/gemini.ts');
  const transport = await createSdkTransport(key);
  return (params) => transport(params, { signal: AbortSignal.timeout(20_000), timeoutMs: 20_000 });
}

function quotaStop(error: unknown): { http: number; kind: string } | null {
  const record = error && typeof error === 'object' ? error as { status?: unknown; statusCode?: unknown; message?: unknown } : {};
  const status = typeof record.status === 'number' ? record.status : typeof record.statusCode === 'number' ? record.statusCode : Number.NaN;
  const message = typeof record.message === 'string' ? record.message : '';
  if (status === 402) return { http: 402, kind: 'payment-required' };
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) return { http: 429, kind: 'quota' };
  return null;
}

function parseLocation(raw: unknown): EvidenceLocation | { error: string } {
  const parsed = parseEvidenceRequest({ propertyId: 'va-demo-duplex', location: raw, evidence: [] });
  if ('error' in parsed) return { error: parsed.error.includes('location') || parsed.error.includes('ZIP') || parsed.error.includes('city') ? parsed.error : 'Send a 5-digit ZIP or a city with a two-letter US state.' };
  return parsed.location;
}

export async function handleGroundedDiscovery(args: {
  env: NodeJS.ProcessEnv;
  body: unknown;
  transport?: (params: Record<string, unknown>) => Promise<unknown>;
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'Grounded discovery input must be a JSON object.' } };
  }
  const record = args.body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === 'location')) {
    return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'Only a location is accepted. Financial fields are not sent.' } };
  }
  const location = parseLocation(record.location);
  if ('error' in location) return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: location.error } };
  const payload = groundingOutboundPayload(location);
  if (!payload) return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'The discovery prompt is outside the length bound.' } };
  const mode = groundingMode(args.env);
  const shared = {
    location,
    financeUntouched: true,
    liveReady: false,
    searchQueriesPreCapped: false,
    searchQueryCap: null,
    verifiedListings: [],
    baselineSlotUsed: false,
  };
  if (mode === 'off') {
    return { httpStatus: 200, body: { ...shared, status: 'disabled', provider: 'off', summary: 'Grounded discovery is off. No search was run.', queries: [], groundingChunks: [], discoveredUnverified: [], evidence: [] } };
  }
  if (mode === 'mock') {
    return { httpStatus: 200, body: { ...shared, status: 'mock-discovery', provider: 'mock', summary: 'TEST/MOCK discovery. No Google search ran. No listing link was invented.', queries: [], groundingChunks: [], discoveredUnverified: [], evidence: [] } };
  }
  if (!args.transport && args.env.SCOUT_RESEARCH_ARM !== '1') {
    return { httpStatus: 200, body: { ...shared, status: 'not-armed', provider: 'off', summary: 'Research is not armed. No search was run.', queries: [], groundingChunks: [], discoveredUnverified: [], evidence: [] } };
  }
  const transport = args.transport ?? await openLiveTransport(args.env);
  if (!transport) {
    return { httpStatus: 503, body: { ...shared, status: 'provider-not-wired', provider: 'gemini', summary: 'Grounded discovery is not wired. No search was run and the baseline slot was not used.', queries: [], groundingChunks: [], discoveredUnverified: [], evidence: [] } };
  }
  const claimed = claimGroundingAttempt(args.env.SCOUT_GROUNDING_RECORD ?? '', args.env.SCOUT_BUDGET_RECORD ?? '');
  if (!claimed.ok) {
    return { httpStatus: 503, body: { ...shared, status: 'error', provider: 'gemini', message: 'The separate grounding authorization did not allow a call. No search was run.', failure: { kind: claimed.kind } } };
  }
  let outcome: unknown;
  try { outcome = await transport(payload); } catch (error) {
    const stopped = quotaStop(error);
    if (stopped) {
      return { httpStatus: stopped.http, body: { ...shared, status: 'stopped', provider: args.transport ? 'injected-transport' : 'gemini', retry: false, message: 'The provider stopped this attempt. Do not retry and do not add credit automatically.', failure: { kind: stopped.kind } } };
    }
    return { httpStatus: 502, body: { ...shared, status: 'error', provider: args.transport ? 'injected-transport' : 'gemini', retry: false, message: 'The attempt failed. No retry was made.', discoveredUnverified: [], evidence: [] } };
  }
  const found = linksFromGrounding(outcome);
  return {
    httpStatus: 200,
    body: {
      ...shared,
      status: 'discovery',
      provider: args.transport ? 'injected-transport' : 'gemini',
      summary: 'Links below are copied from the grounding metadata. They are not verified listings.',
      queries: found.queries,
      groundingChunks: found.chunks,
      discoveredUnverified: found.links,
      evidence: evidenceFromDiscovery(found.links),
    },
  };
}

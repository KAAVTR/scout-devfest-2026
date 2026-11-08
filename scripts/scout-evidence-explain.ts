/**
 * Separate from POST /api/scout-research.
 * The HTTP server does not construct a provider client. A live call stays unwired.
 */
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { admitHttps } from './scout-https.ts';
import { PINNED_MODEL, RESEARCH_PROMPT_CHAR_CAP } from './scout-spend-ledger.ts';
import type { Transport } from '../server/provider/gemini.ts';

const EVIDENCE_KEYS = ['approvedByParent', 'attemptsUsed', 'maxAttempts', 'model', 'purpose', 'search', 'v'];

export const EVIDENCE_OUTPUT_TOKEN_CAP = 512;
const SAMPLE_IDS = new Set([
  'va-demo-duplex', 'va-demo-triplex', 'va-demo-quadplex', 'va-demo-incomplete', 'va-demo-unsupported-five',
  'demo-fixture-1', 'demo-fixture-2',
]);
const SAMPLE_TITLE: Record<string, string> = {
  'va-demo-duplex': 'Duplex sample',
  'va-demo-triplex': 'Triplex sample',
  'va-demo-quadplex': 'Quadplex sample',
  'va-demo-incomplete': 'Incomplete sample',
  'va-demo-unsupported-five': 'Five-unit sample',
  'demo-fixture-1': 'Sample property A',
  'demo-fixture-2': 'Sample property B',
};
const STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','IA','ID','IL','IN','KS','KY','LA','MA','MD','ME','MI','MN','MO','MS','MT','NC','ND','NE','NH','NJ','NM','NV','NY','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VA','VT','WA','WI','WV','WY']);
const PROVENANCE = new Set(['user', 'source', 'search-excerpt', 'grounding']);

export type EvidenceLocation = { kind: 'zip'; zip: string } | { kind: 'city-state'; city: string; state: string };
export type EvidenceProvenance = 'user' | 'source' | 'search-excerpt' | 'grounding';
export interface EvidenceItem {
  label: string;
  statement: string;
  provenance: EvidenceProvenance;
  sourceUrl: string | null;
  observedAt: string | null;
}
export interface EvidenceRequest {
  propertyId: string;
  location: EvidenceLocation;
  evidence: EvidenceItem[];
}

export function evidenceMode(env: NodeJS.ProcessEnv): 'off' | 'mock' | 'gemini' {
  const raw = env.SCOUT_EVIDENCE?.trim().toLowerCase() ?? 'off';
  if (raw === 'mock') return 'mock';
  if (raw === 'gemini') return 'gemini';
  return 'off';
}

export function parseEvidenceRequest(body: unknown): EvidenceRequest | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Evidence explanation input must be a JSON object.' };
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === 'propertyId' || key === 'location' || key === 'evidence')) {
    return { error: 'Only a sample id, a location, and evidence items are accepted. Financial fields are not sent.' };
  }
  if (typeof record.propertyId !== 'string' || !SAMPLE_IDS.has(record.propertyId)) return { error: 'That sample is not available.' };
  const location = parseLocation(record.location);
  if (!location) return { error: 'Send a 5-digit ZIP or a city with a two-letter US state.' };
  if (!Array.isArray(record.evidence) || record.evidence.length > 8) return { error: 'Send at most 8 evidence items.' };
  const evidence: EvidenceItem[] = [];
  for (const item of record.evidence) {
    const parsed = parseItem(item);
    if ('error' in parsed) return parsed;
    evidence.push(parsed);
  }
  return { propertyId: record.propertyId, location, evidence };
}

function parseLocation(raw: unknown): EvidenceLocation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === 'kind' || key === 'zip' || key === 'city' || key === 'state')) return null;
  if (record.kind === 'zip' && typeof record.zip === 'string' && /^\d{5}$/.test(record.zip) && record.city === undefined && record.state === undefined) return { kind: 'zip', zip: record.zip };
  if (record.kind === 'city-state' && typeof record.city === 'string' && typeof record.state === 'string' && record.zip === undefined) {
    const city = record.city.trim().replace(/\s+/g, ' ');
    const state = record.state.trim().toUpperCase();
    if (city.length < 2 || city.length > 40 || !/^[A-Za-z][A-Za-z .'-]*$/.test(city) || !STATES.has(state)) return null;
    return { kind: 'city-state', city, state };
  }
  return null;
}

function parseItem(raw: unknown): EvidenceItem | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Each evidence item must be an object.' };
  const record = raw as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === 'label' || key === 'statement' || key === 'provenance' || key === 'sourceUrl' || key === 'observedAt')) {
    return { error: 'An evidence item can carry only a label, statement, provenance, source URL, and observed time.' };
  }
  if (typeof record.label !== 'string' || record.label.trim().length < 2 || record.label.trim().length > 80) return { error: 'Each evidence label must be 2 to 80 characters.' };
  if (typeof record.statement !== 'string' || record.statement.trim().length < 2 || record.statement.trim().length > 240) return { error: 'Each evidence statement must be 2 to 240 characters.' };
  if (typeof record.provenance !== 'string' || !PROVENANCE.has(record.provenance)) return { error: 'Provenance must be user, source, search-excerpt, or grounding.' };
  const sourceUrl = record.sourceUrl === null ? null : httpsSource(record.sourceUrl);
  if (record.sourceUrl !== null && sourceUrl === null) return { error: 'A source URL must be an https URL with no user info and no local host.' };
  const observedAt = record.observedAt === null ? null : typeof record.observedAt === 'string' && !Number.isNaN(Date.parse(record.observedAt)) ? new Date(record.observedAt).toISOString() : null;
  if (record.observedAt !== null && observedAt === null) return { error: 'An observed time must be empty or a date.' };
  return {
    label: record.label.trim(),
    statement: record.statement.trim(),
    provenance: record.provenance as EvidenceProvenance,
    sourceUrl,
    observedAt,
  };
}

function httpsSource(raw: unknown): string | null {
  return typeof raw === 'string' ? admitHttps(raw) : null;
}

export function placeText(location: EvidenceLocation): string {
  return location.kind === 'zip' ? `ZIP ${location.zip}` : `${location.city}, ${location.state}`;
}

/** The only text that would be placed in the provider input field. */
export function buildEvidencePrompt(request: EvidenceRequest): string {
  const lines = [
    `Explain only the supplied evidence for sample ${request.propertyId}, labeled ${SAMPLE_TITLE[request.propertyId]}.`,
    `Place: ${placeText(request.location)}.`,
    'Do not search. Do not invent a citation, a listing, a rent, a tax, or a price.',
    'User statements, search excerpts, and grounding links are not verified listings.',
    'A source row is not a completed project and not a loan approval.',
    'If a figure was not supplied, say it is unknown.',
  ];
  if (request.evidence.length === 0) lines.push('No evidence items were supplied.');
  request.evidence.forEach((item, index) => {
    const url = item.provenance === 'source' && item.sourceUrl ? ` URL ${item.sourceUrl}` : ' no citation URL';
    const when = item.observedAt ? ` observed ${item.observedAt}` : '';
    lines.push(`${index + 1}. ${item.provenance}: ${item.label}. ${item.statement}.${url}${when}.`);
  });
  lines.push('Return JSON with a short summary and a short uncertainty note.');
  return lines.join(' ');
}

/** Exact body a later live call would send. No tools and no search. */
export function evidenceOutboundPayload(prompt: string): Record<string, unknown> | null {
  if (prompt.length === 0 || prompt.length > RESEARCH_PROMPT_CHAR_CAP) return null;
  return {
    model: PINNED_MODEL,
    input: prompt,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: { type: 'object', properties: { summary: { type: 'string' }, uncertainty: { type: 'string' } }, required: ['summary', 'uncertainty'] },
    },
    store: false,
    automatic_continuation: false,
    generation_config: { max_output_tokens: EVIDENCE_OUTPUT_TOKEN_CAP, thinking_level: 'low' },
  };
}

function allowedCitationUrls(request: EvidenceRequest): Set<string> {
  return new Set(request.evidence.filter((item) => item.provenance === 'source' && item.sourceUrl).map((item) => item.sourceUrl as string));
}

export async function handleEvidenceExplain(args: {
  env: NodeJS.ProcessEnv;
  body: unknown;
  transport?: Transport;
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const parsed = parseEvidenceRequest(args.body);
  if ('error' in parsed) return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: parsed.error } };
  const prompt = buildEvidencePrompt(parsed);
  const payload = evidenceOutboundPayload(prompt);
  if (!payload) return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'The evidence prompt is outside the 2000 character bound. No provider call was made.' } };
  const mode = evidenceMode(args.env);
  const base = resultBody(parsed, prompt);
  if (mode === 'off') {
    return { httpStatus: 200, body: { ...base, status: 'disabled', provider: 'off', liveReady: false, summary: 'Evidence explanation is off. No provider was called.', uncertainty: 'No evidence was sent to a model.', citations: [], inventedCitationsDropped: [] } };
  }
  if (mode === 'mock') return { httpStatus: 200, body: mockBody(parsed, base, false) };
  if (!args.transport && !evidenceLiveConfigured(args.env)) {
    return { httpStatus: 503, body: mockBody(parsed, base, true) };
  }
  const claimed = claimEvidenceAttempt(args.env.SCOUT_EVIDENCE_RECORD ?? '', args.env.SCOUT_BUDGET_RECORD ?? '', args.env.SCOUT_GROUNDING_RECORD ?? '');
  if (!claimed.ok) {
    return { httpStatus: 503, body: { ...base, status: 'error', provider: 'gemini', liveReady: false, baselineSlotUsed: false, message: 'The separate evidence authorization did not allow a call. No provider request was sent.', failure: { kind: claimed.kind } } };
  }
  const transport = args.transport ?? await openEvidenceTransport(args.env);
  if (!transport) {
    return { httpStatus: 503, body: { ...base, status: 'error', provider: 'gemini', liveReady: false, baselineSlotUsed: false, retry: false, message: 'The evidence client could not be opened. The attempt was reserved and no retry is made.' } };
  }
  let outcome: unknown;
  try {
    outcome = await transport(payload, { signal: AbortSignal.timeout(20_000), timeoutMs: 20_000 });
  } catch {
    return { httpStatus: 502, body: { ...base, status: 'error', provider: args.transport ? 'injected-transport' : 'gemini', liveReady: false, baselineSlotUsed: false, retry: false, message: 'The evidence attempt failed. No retry was made.' } };
  }
  const text = readModelText(outcome);
  const allowed = allowedCitationUrls(parsed);
  const invented = citedUrls(text).filter((url) => !allowed.has(url));
  let summary = 'The model reply did not include a usable summary.';
  let uncertainty = 'Figures that were not supplied stay unknown.';
  try {
    const json = JSON.parse(text) as { summary?: unknown; uncertainty?: unknown };
    if (typeof json.summary === 'string') summary = json.summary.slice(0, 1200);
    if (typeof json.uncertainty === 'string') uncertainty = json.uncertainty.slice(0, 1200);
  } catch { /* Keep the unknown notice. */ }
  if (invented.length > 0 || citedUrls(`${summary}\n${uncertainty}`).some((url) => !allowed.has(url))) {
    return {
      httpStatus: 200,
      body: {
        ...base,
        status: 'explanation-rejected',
        provider: args.transport ? 'injected-transport' : 'gemini',
        liveReady: false,
        baselineSlotUsed: false,
        summary: 'The model reply included a link that was not in the supplied evidence. That reply was not used.',
        uncertainty: 'No unverified link was kept. Missing rents, taxes, and prices stay unknown.',
        citations: citationsFrom(parsed),
        inventedCitationsDropped: invented,
      },
    };
  }
  return {
    httpStatus: 200,
    body: {
      ...base,
      status: 'explanation',
      provider: args.transport ? 'injected-transport' : 'gemini',
      liveReady: false,
      baselineSlotUsed: false,
      summary,
      uncertainty,
      citations: citationsFrom(parsed),
      inventedCitationsDropped: invented,
    },
  };
}

function evidenceLiveConfigured(env: NodeJS.ProcessEnv): boolean {
  return env.SCOUT_EVIDENCE_ENABLE === '1' && (env.GEMINI_API_KEY?.trim().length ?? 0) >= 20 && Boolean(env.SCOUT_EVIDENCE_RECORD?.trim());
}

async function openEvidenceTransport(env: NodeJS.ProcessEnv): Promise<Transport | null> {
  if (!evidenceLiveConfigured(env)) return null;
  const { createSdkTransport } = await import('../server/provider/gemini.ts');
  return createSdkTransport(env.GEMINI_API_KEY?.trim() ?? '');
}

function claimEvidenceAttempt(recordPath: string, baselinePath: string, groundingPath: string): { ok: true } | { ok: false; kind: string } {
  const path = recordPath.trim();
  if (!path || !isAbsolute(path)) return { ok: false, kind: 'record-unset' };
  if (path === baselinePath.trim() || path === groundingPath.trim()) return { ok: false, kind: 'record-shared' };
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return { ok: false, kind: existsSync(path) ? 'record-corrupt' : 'record-missing' };
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch { return { ok: false, kind: 'record-unreadable' }; }
  try {
    const current = parseEvidenceAuth(readFileSync(path, 'utf8'));
    if (!current) return { ok: false, kind: 'record-corrupt' };
    if (current.attemptsUsed >= 1) return { ok: false, kind: 'attempt-blocked' };
    writeEvidenceAuth(path, { ...current, attemptsUsed: 1 });
    return { ok: true };
  } catch {
    return { ok: false, kind: 'record-unreadable' };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function parseEvidenceAuth(raw: string): { attemptsUsed: number } | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== EVIDENCE_KEYS.join()) return null;
  if (record.v !== 1 || record.purpose !== 'evidence-explanation-one-off' || record.approvedByParent !== true) return null;
  if (record.model !== PINNED_MODEL || record.search !== false || record.maxAttempts !== 1) return null;
  if (record.attemptsUsed !== 0 && record.attemptsUsed !== 1) return null;
  return { attemptsUsed: record.attemptsUsed };
}

function writeEvidenceAuth(path: string, record: { attemptsUsed: number }): void {
  const body = JSON.stringify({ v: 1, purpose: 'evidence-explanation-one-off', model: PINNED_MODEL, search: false, approvedByParent: true, maxAttempts: 1, attemptsUsed: record.attemptsUsed });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    const payload = Buffer.from(body);
    let offset = 0;
    while (offset < payload.length) offset += writeSync(fd, payload, offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function resultBody(request: EvidenceRequest, prompt: string): Record<string, unknown> {
  return {
    propertyId: request.propertyId,
    location: request.location,
    financeUntouched: true,
    liveReady: false,
    verifiedListings: [],
    unverified: request.evidence.filter((item) => item.provenance !== 'source').map((item) => ({ label: item.label, provenance: item.provenance, statement: item.statement })),
    unknowns: request.evidence.length === 0 ? ['No evidence items were supplied.'] : [],
    promptCharacters: prompt.length,
  };
}

function mockBody(request: EvidenceRequest, base: Record<string, unknown>, unwired: boolean): Record<string, unknown> {
  const sourceLabels = request.evidence.filter((item) => item.provenance === 'source').map((item) => item.label);
  return {
    ...base,
    status: unwired ? 'provider-not-wired' : 'mock-explanation',
    provider: unwired ? 'gemini' : 'mock',
    liveReady: false,
    summary: unwired
      ? 'The evidence payload is ready for review. This process has no provider transport, so no call was made.'
      : `TEST/MOCK explanation for ${request.propertyId} at ${placeText(request.location)}. ${sourceLabels.length ? `Supplied source labels: ${sourceLabels.join('; ')}.` : 'No source row was supplied.'} This is not a live model.`,
    uncertainty: 'User statements and search excerpts are not verified listings. Missing rents, taxes, and prices stay unknown.',
    citations: citationsFrom(request),
    inventedCitationsDropped: [],
    message: unwired ? 'No provider request was sent.' : 'Mock text only.',
  };
}

function citationsFrom(request: EvidenceRequest): { url: string; label: string; provenance: 'source'; verifiedListing: false }[] {
  return request.evidence.filter((item) => item.provenance === 'source' && item.sourceUrl).map((item) => ({
    url: item.sourceUrl as string,
    label: item.label,
    provenance: 'source' as const,
    verifiedListing: false as const,
  }));
}

function readModelText(outcome: unknown): string {
  const steps = outcome && typeof outcome === 'object' && 'steps' in outcome ? (outcome as { steps?: unknown }).steps : null;
  if (!Array.isArray(steps)) return '';
  const chunks: string[] = [];
  for (const step of steps) {
    const content = step && typeof step === 'object' && 'content' in step ? (step as { content?: unknown }).content : null;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') chunks.push((part as { text: string }).text);
    }
  }
  return chunks.join('');
}

function citedUrls(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s"']+/g)].map((match) => match[0]);
}

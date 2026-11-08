/**
 * Narrow area-research action for the Scout page.
 * It does not rank properties and it does not change financial inputs.
 * The default is off. The mock provider is a labeled fixture. Gemini runs only when explicitly enabled.
 */
import { classifyError, createGeminiProvider, createSdkTransport, parseInteraction, ProviderGate, redact, type Transport } from '../server/provider/gemini.ts';
import { claimPreviewCall, type ActivationFailure } from './scout-live-activation.ts';
import { perCallReserveCents, PINNED_MODEL, reserveTransport, RESEARCH_PROMPT_CHAR_CAP, type LedgerFailure } from './scout-spend-ledger.ts';

export { oneRequestWorstCaseUsd, perCallReserveCents, PINNED_MODEL, RESEARCH_PROMPT_CHAR_CAP } from './scout-spend-ledger.ts';

export const RESEARCH_MODEL_FALLBACK = PINNED_MODEL;
/** Interactions API cap. The ledger still reserves the published model maximum, because this cap is not treated as a bill. */
export const RESEARCH_OUTPUT_TOKEN_CAP = 512;
/** Interactions `generation_config` field supported by the installed SDK. Gemini 2.5 Flash accepts low, medium, and high. */
export const RESEARCH_THINKING_LEVEL = 'low' as const;

const sharedResearchGate = new ProviderGate(8, { now: () => Date.now() });

export function researchGateUsed(): number {
  return sharedResearchGate.usedToday;
}

export function researchHttpStatus(kind: string): number {
  if (kind === 'budget-exhausted' || kind === 'provider-quota' || kind === 'provider-daily-quota' || kind === 'spend-blocked') return 429;
  if (kind === 'model-unbounded') return 409;
  if (kind === 'ledger-unset' || kind === 'ledger-missing' || kind === 'ledger-unreadable' || kind === 'ledger-unwritable' || kind === 'ledger-corrupt' || kind === 'pricing-uncertain') return 503;
  return 502;
}
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
const WINDOW_MS = 10 * 60 * 1000;
const PER_CLIENT_LIMIT = 4;
const CACHE_MS = 10 * 60 * 1000;
const DEADLINE_MS = 20_000;
const FIXTURE_URL = 'https://example.com/scout-research-fixture';
const STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','IA','ID','IL','IN','KS','KY','LA','MA','MD','ME','MI','MN','MO','MS','MT','NC','ND','NE','NH','NJ','NM','NV','NY','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VA','VT','WA','WI','WV','WY']);
export type ResearchArea = { kind: 'zip'; zip: string } | { kind: 'city-state'; city: string; state: string };

export interface ResearchSource { title: string; url: string; kind: 'fixture' | 'provider-grounding' }
export interface ResearchResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

interface CacheEntry { at: number; body: Record<string, unknown>; httpStatus: number }
const hits = new Map<string, number[]>();
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ResearchResult>>();
let providerCalls = 0;
let sdkBuilds = 0;

export function researchCalls(): number { return providerCalls; }
export function sdkTransportBuilds(): number { return sdkBuilds; }

export function researchMode(env: NodeJS.ProcessEnv): 'off' | 'mock' | 'gemini' {
  const raw = env.SCOUT_RESEARCH?.trim().toLowerCase() ?? 'off';
  if (raw === 'mock') return 'mock';
  if (raw === 'gemini' && env.SCOUT_LIVE === '1' && env.SCOUT_RESEARCH_ENABLE === '1' && (env.GEMINI_API_KEY?.trim().length ?? 0) >= 20) return 'gemini';
  return 'off';
}

export function researchPublicStatus(env: NodeJS.ProcessEnv): { mode: 'off' | 'mock' | 'gemini'; model: string | null } {
  const mode = researchMode(env);
  if (mode === 'mock') return { mode, model: 'scout-fixture' };
  if (mode === 'gemini') {
    const configured = env.GEMINI_RESEARCH_MODEL?.trim();
    return { mode, model: configured && /^[a-z0-9][a-z0-9.\-]{2,63}$/.test(configured) ? configured : RESEARCH_MODEL_FALLBACK };
  }
  return { mode: 'off', model: null };
}

export function areaText(area: ResearchArea): string {
  return area.kind === 'zip' ? `ZIP ${area.zip}` : `${area.city}, ${area.state}`;
}

const SAMPLE_FACTS: Record<string, string> = {
  'va-demo-duplex': 'Price 349000. Units 2. Owner-unit figure 9999 is not rent. Tenant rent 2200. Annual tax 4000.',
  'va-demo-triplex': 'Price 349000. Units 3. Owner-unit figure 9999 is not rent. Tenant rents 1500 and 1500. Annual tax 4000.',
  'va-demo-quadplex': 'Price 349000. Units 4. Owner-unit figure 9999 is not rent. Tenant rents 1300, 1300, and 1300. Annual tax 4000.',
  'va-demo-incomplete': 'Price 100000. Units 2. Owner-unit figure 9999 is not rent. One tenant rent is missing. Annual tax is missing.',
  'va-demo-unsupported-five': 'Price 100000. Units 5. This sample is outside the supported unit count.',
  'demo-fixture-1': 'Price 349000. Units 2. Assumed monthly rent 2760.',
  'demo-fixture-2': 'Price 300000. Units 2. This is the second conventional sample.',
};

export function buildResearchPrompt(propertyId: string, _area: ResearchArea): string {
  const title = SAMPLE_TITLE[propertyId] ?? 'Sample property';
  const facts = SAMPLE_FACTS[propertyId] ?? 'Synthetic sample.';
  return [
    `Explain the original synthetic baseline for ${propertyId}, labeled ${title}.`,
    `Use only these original baseline figures: ${facts}`,
    'These figures are not the caller\'s edited assessment. Edited rent, cash, and financing were not provided.',
    'The typed place is not included and must not be described.',
    'Do not search. Do not name a source, a street, or a business. Do not add a number that is not written here.',
    'Say that this explains the original synthetic baseline and is not a live area search and not a loan approval.',
    'Return JSON with a short summary and a short uncertainty note.',
  ].join(' ');
}

function parseArea(raw: unknown): ResearchArea | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.kind === 'zip' && keys.join() === 'kind,zip' && typeof record.zip === 'string' && /^\d{5}$/.test(record.zip)) return { kind: 'zip', zip: record.zip };
  if (record.kind === 'city-state' && keys.join() === 'city,kind,state' && typeof record.city === 'string' && typeof record.state === 'string') {
    const city = record.city.trim().replace(/\s+/g, ' ');
    const state = record.state.trim().toUpperCase();
    if (city.length < 2 || city.length > 40 || !/^[A-Za-z][A-Za-z .'-]*$/.test(city) || !STATES.has(state)) return null;
    return { kind: 'city-state', city, state };
  }
  return null;
}

function safeHttps(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2000) return null;
    return url.href;
  } catch {
    return null;
  }
}

function publicText(value: string): string {
  return redact(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

const EXPLANATION_TEXT_LIMIT = 1200;
const EXPLANATION_SECRET = /(AIza[0-9A-Za-z_\-]{20,}|key=[^&\s]+|Bearer\s+[A-Za-z0-9._\-]+)/g;

/** Secret redaction for explanation text. Does not use the 300-character error-message cap. */
function explanationText(value: string): { text: string; truncated: boolean } {
  const cleaned = value.replace(EXPLANATION_SECRET, '[redacted]').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= EXPLANATION_TEXT_LIMIT) return { text: cleaned, truncated: false };
  return { text: `${cleaned.slice(0, EXPLANATION_TEXT_LIMIT)} [cut at the display limit]`, truncated: true };
}

function takeRate(clientToken: string, now: number): number | null {
  const recent = (hits.get(clientToken) ?? []).filter((stamp) => now - stamp < WINDOW_MS);
  if (recent.length >= PER_CLIENT_LIMIT) {
    hits.set(clientToken, recent);
    return Math.ceil((WINDOW_MS - (now - recent[0])) / 1000);
  }
  recent.push(now);
  hits.set(clientToken, recent);
  return null;
}

function mockResult(propertyId: string, area: ResearchArea): ResearchResult {
  providerCalls += 1;
  return {
    httpStatus: 200,
    body: {
      status: 'fixture',
      label: 'TEST/SAMPLE',
      provider: 'mock',
      model: 'scout-fixture',
      propertyId,
      area,
      cached: false,
      summary: `TEST/SAMPLE fixture for ${areaText(area)}. This is not a live search and it is not area evidence. ${SAMPLE_TITLE[propertyId]} is a synthetic sample and is not located in that area. Nothing here changes rent, price, tax, or loan inputs.`,
      uncertainty: 'Fixture text only. It does not report a measured population, job, or price change.',
      sources: [{ title: 'Fixture source, not a live page', url: FIXTURE_URL, kind: 'fixture' } satisfies ResearchSource],
      queries: ['fixture query, not sent to a search engine'],
      financeUntouched: true,
    },
  };
}

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, uncertainty: { type: 'string' } },
  required: ['summary', 'uncertainty'],
};

function boundedParams(prompt: string): Record<string, unknown> | null {
  if (prompt.length === 0 || prompt.length > RESEARCH_PROMPT_CHAR_CAP) return null;
  if (RESEARCH_OUTPUT_TOKEN_CAP !== 512 || RESEARCH_THINKING_LEVEL !== 'low') return null;
  const params = {
    model: PINNED_MODEL,
    input: prompt,
    response_format: { type: 'text', mime_type: 'application/json', schema: RESEARCH_SCHEMA },
    store: false,
    // SDK-only. interactions.create strips this and, when it is false, does not send a continuation hop.
    automatic_continuation: false,
    generation_config: { max_output_tokens: RESEARCH_OUTPUT_TOKEN_CAP, thinking_level: RESEARCH_THINKING_LEVEL },
  };
  if (params.automatic_continuation !== false || params.store !== false || 'tools' in params) return null;
  return params;
}

function withSpendCap(inner: Transport): Transport {
  return (params, opts) => inner({
    ...params,
    automatic_continuation: false,
    generation_config: { max_output_tokens: RESEARCH_OUTPUT_TOKEN_CAP, thinking_level: RESEARCH_THINKING_LEVEL },
  }, opts);
}

/** Process-lifetime gate. Tests inject a transport; this does not construct the SDK client. */
export async function runGroundedResearch(args: {
  transport: Transport;
  model: string;
  prompt: string;
  signal: AbortSignal;
  deadlineMs: number;
}) {
  if (args.model !== RESEARCH_MODEL_FALLBACK) {
    return { ok: false as const, failure: { kind: 'not-configured' as const, message: 'Live explanation is fixed to gemini-3.8-flash. No provider call was made.', retryAfterSeconds: null } };
  }
  if (args.prompt.length === 0 || args.prompt.length > RESEARCH_PROMPT_CHAR_CAP) {
    return { ok: false as const, failure: { kind: 'not-configured' as const, message: 'Research prompt is outside the bounded length. No provider call was made.', retryAfterSeconds: null } };
  }
  const provider = createGeminiProvider({
    transport: withSpendCap(args.transport),
    model: args.model,
    gate: sharedResearchGate,
    maxAttempts: 1,
  });
  return provider.search({
    prompt: args.prompt,
    schema: {
      type: 'object',
      properties: { summary: { type: 'string' }, uncertainty: { type: 'string' } },
      required: ['summary', 'uncertainty'],
    },
    deadlineMs: args.deadlineMs,
  }, args.signal);
}

function providerFailureResult(failure: { kind: string; message: string; retryAfterSeconds: number | null }): ResearchResult {
  const message = failure.kind === 'budget-exhausted'
    ? 'Daily research limit reached in this process. No provider call was made.'
    : publicText(failure.message);
  return {
    httpStatus: researchHttpStatus(failure.kind),
    body: { status: 'error', financeUntouched: true, failure: { kind: failure.kind, message, retryAfterSeconds: failure.retryAfterSeconds } },
  };
}

function activationFailureResult(kind: ActivationFailure): ResearchResult {
  const message = kind === 'spend-blocked'
    ? 'The one remaining preview explanation is already reserved. No provider call was made.'
    : kind === 'pricing-uncertain'
      ? 'The published price window is closed. No provider call was made.'
      : kind === 'record-missing' || kind === 'record-unset'
        ? 'Live explanation needs an operator-supplied budget record that already includes the closed 156 cents. No file was created and no provider call was made.'
        : 'The budget record cannot be trusted. No provider call was made.';
  const httpStatus = kind === 'spend-blocked' ? 429 : 503;
  return { httpStatus, body: { status: 'error', financeUntouched: true, failure: { kind, message, retryAfterSeconds: null } } };
}

function ledgerFailureResult(kind: LedgerFailure): ResearchResult {
  const message = kind === 'spend-blocked'
    ? 'The $2.60 research total already has this call reserved. No provider call was made.'
    : kind === 'pricing-uncertain'
      ? 'The live-call price bound is not available. No provider call was made.'
      : kind === 'ledger-corrupt'
        ? 'The spend ledger cannot be trusted. No provider call was made.'
        : kind === 'ledger-unset'
          ? 'Live research needs SCOUT_SPEND_LEDGER set to an absolute file path. No provider call was made.'
          : kind === 'ledger-missing'
            ? 'The spend ledger file is missing, so this is not treated as a new budget. No provider call was made.'
            : 'The spend ledger could not be saved. No provider call was made.';
  return { httpStatus: researchHttpStatus(kind), body: { status: 'error', financeUntouched: true, failure: { kind, message, retryAfterSeconds: null } } };
}

/** One transport call. No loop, no provider retry, and no second attempt after an error. */
export async function callBoundedTransport(args: {
  transport: Transport;
  prompt: string;
  signal: AbortSignal;
  deadlineMs: number;
}) {
  const params = boundedParams(args.prompt);
  if (!params) {
    return { ok: false as const, failure: { kind: 'pricing-uncertain' as const, message: 'The outgoing research request is not bounded. No provider call was made.', retryAfterSeconds: null } };
  }
  if (perCallReserveCents() === null) {
    return { ok: false as const, failure: { kind: 'pricing-uncertain' as const, message: 'The published price window ended before the request was sent. No provider call was made.', retryAfterSeconds: null } };
  }
  const remaining = args.deadlineMs - Date.now();
  if (remaining < 1000 || args.signal.aborted) {
    return { ok: false as const, failure: { kind: 'timeout' as const, message: 'Deadline reached before provider call', retryAfterSeconds: null } };
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('deadline')), remaining);
  const combined = AbortSignal.any([args.signal, deadline.signal]);
  try {
    const raw = await args.transport(params, { signal: combined, timeoutMs: remaining });
    const parsed = parseInteraction(raw);
    if (!parsed) return { ok: false as const, failure: { kind: 'malformed-response' as const, message: 'Provider response had no text output', retryAfterSeconds: null } };
    return { ok: true as const, text: parsed.text, citations: [], searchQueries: [], model: PINNED_MODEL };
  } catch (error) {
    return { ok: false as const, failure: classifyError(error, args.signal, deadline.signal.aborted) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runBudgetedResearch(args: {
  transport: Transport;
  prompt: string;
  signal: AbortSignal;
  deadlineMs: number;
  ledgerPath: string;
}): Promise<ResearchResult> {
  if (perCallReserveCents() === null) return ledgerFailureResult('pricing-uncertain');
  if (args.prompt.length === 0 || args.prompt.length > RESEARCH_PROMPT_CHAR_CAP) {
    return { httpStatus: 409, body: { status: 'error', financeUntouched: true, failure: { kind: 'model-unbounded', message: 'The research prompt is outside the bounded length. No provider call was made.', retryAfterSeconds: null } } };
  }
  const reserved = reserveTransport(args.ledgerPath);
  if (!reserved.ok) return ledgerFailureResult(reserved.kind);
  providerCalls += 1;
  const outcome = await callBoundedTransport(args);
  if (!outcome.ok) return providerFailureResult(outcome.failure);
  return groundedBody('budgeted', outcome);
}

function groundedBody(propertyId: string, outcome: { text: string; citations: { url: string; title: string | null }[]; searchQueries: string[]; model: string }, area?: ResearchArea): ResearchResult {
  const whole = explanationText(outcome.text);
  let summary = whole.text;
  let summaryCut = whole.truncated;
  let uncertainty = 'This explains the original synthetic baseline only. Edited rent, cash, and financing were not sent. No search was run. No sources are shown.';
  let uncertaintyCut = false;
  try {
    const parsed = JSON.parse(outcome.text) as { summary?: unknown; uncertainty?: unknown };
    if (typeof parsed.summary === 'string') {
      const next = explanationText(parsed.summary);
      summary = next.text;
      summaryCut = next.truncated;
    }
    if (typeof parsed.uncertainty === 'string') {
      const next = explanationText(parsed.uncertainty);
      uncertainty = `${uncertainty} ${next.text}`;
      uncertaintyCut = next.truncated;
    }
  } catch { /* Keep the model text and the no-search notice. */ }
  return {
    httpStatus: 200,
    body: {
      status: 'explanation',
      label: 'Original baseline, not a live search',
      provider: 'gemini',
      model: outcome.model,
      propertyId,
      ...(area ? { area } : {}),
      cached: false,
      summary,
      uncertainty,
      truncated: summaryCut || uncertaintyCut,
      sources: [],
      queries: [],
      financeUntouched: true,
    },
  };
}

async function geminiResult(env: NodeJS.ProcessEnv, propertyId: string, area: ResearchArea, signal: AbortSignal, injected?: Transport, openTransport?: () => Promise<Transport>): Promise<ResearchResult> {
  const model = researchPublicStatus(env).model ?? RESEARCH_MODEL_FALLBACK;
  if (model !== PINNED_MODEL) {
    return { httpStatus: 409, body: { status: 'error', financeUntouched: true, failure: { kind: 'model-unbounded', message: 'Live explanation is fixed to gemini-3.8-flash. No search tool is sent. No provider call was made.', retryAfterSeconds: null } } };
  }
  const prompt = buildResearchPrompt(propertyId, area);
  if (perCallReserveCents() === null) return ledgerFailureResult('pricing-uncertain');
  const claimed = claimPreviewCall(env.SCOUT_BUDGET_RECORD ?? '');
  if (!claimed.ok) return activationFailureResult(claimed.kind);
  let transport = injected;
  if (!transport) {
    try {
      sdkBuilds += 1;
      transport = openTransport ? await openTransport() : await createSdkTransport(env.GEMINI_API_KEY?.trim() ?? '', {
        beforeDispatch() {
          if (perCallReserveCents() === null) {
            throw new Error('The published price window ended before the request was sent. No provider call was made.');
          }
        },
      });
    } catch {
      sdkBuilds -= 1;
      return { httpStatus: 503, body: { status: 'error', financeUntouched: true, failure: { kind: 'not-configured', message: 'The Gemini client could not be constructed. The reservation stands and no retry is made.', retryAfterSeconds: null } } };
    }
  }
  if (perCallReserveCents() === null) return ledgerFailureResult('pricing-uncertain');
  providerCalls += 1;
  const outcome = await callBoundedTransport({ transport, prompt, signal, deadlineMs: Date.now() + DEADLINE_MS });
  if (!outcome.ok) return providerFailureResult(outcome.failure);
  return groundedBody(propertyId, outcome, area);
}

export async function handleScoutResearch(args: { env: NodeJS.ProcessEnv; clientToken: string; body: unknown; now?: number; transport?: Transport; openTransport?: () => Promise<Transport> }): Promise<ResearchResult> {
  const now = args.now ?? Date.now();
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) return { httpStatus: 400, body: { status: 'error', failure: { kind: 'invalid-request', message: 'Research input must be a JSON object.', retryAfterSeconds: null } } };
  const record = args.body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === 'propertyId' || key === 'focus' || key === 'area')) return { httpStatus: 400, body: { status: 'error', failure: { kind: 'invalid-request', message: 'Only the sample id, area context, and area focus are accepted.', retryAfterSeconds: null } } };
  if (record.focus !== undefined && record.focus !== 'area') return { httpStatus: 400, body: { status: 'error', failure: { kind: 'invalid-request', message: 'Focus must be area.', retryAfterSeconds: null } } };
  if (typeof record.propertyId !== 'string' || !SAMPLE_IDS.has(record.propertyId)) return { httpStatus: 400, body: { status: 'error', failure: { kind: 'invalid-request', message: 'That sample is not available for area research.', retryAfterSeconds: null } } };
  const area = parseArea(record.area);
  if (!area) return { httpStatus: 400, body: { status: 'error', failure: { kind: 'invalid-request', message: 'Send a 5-digit ZIP or a city with a two-letter US state. The sample does not supply a location.', retryAfterSeconds: null } } };
  const propertyId = record.propertyId;
  const mode = researchMode(args.env);
  if (mode === 'off') {
    return { httpStatus: 200, body: { status: 'disabled', provider: 'off', financeUntouched: true, message: 'Area research is off. No provider was called. Sample figures on this page stay the assessment figures.' } };
  }
  const key = `${mode}:${propertyId}:${areaText(area)}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) return { httpStatus: cached.httpStatus, body: { ...cached.body, cached: true } };
  const wait = takeRate(args.clientToken, now);
  if (wait !== null) return { httpStatus: 429, body: { status: 'error', financeUntouched: true, failure: { kind: 'rate-limited', message: 'This browser has used its 4 area-research requests for 10 minutes.', retryAfterSeconds: wait } } };
  const pending = inflight.get(key);
  if (pending) {
    const shared = await pending;
    return { httpStatus: shared.httpStatus, body: { ...shared.body, cached: true } };
  }
  const run = (async (): Promise<ResearchResult> => {
    if (mode === 'mock') return mockResult(propertyId, area);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    try {
      return await geminiResult(args.env, propertyId, area, controller.signal, args.transport, args.openTransport);
    } catch (error) {
      return { httpStatus: 502, body: { status: 'error', financeUntouched: true, failure: { kind: 'provider-unavailable', message: publicText(error instanceof Error ? error.message : 'Research failed'), retryAfterSeconds: null } } };
    } finally {
      clearTimeout(timer);
    }
  })();
  inflight.set(key, run);
  try {
    const result = await run;
    if (result.httpStatus === 200) cache.set(key, { at: now, httpStatus: result.httpStatus, body: result.body });
    return result;
  } finally {
    inflight.delete(key);
  }
}

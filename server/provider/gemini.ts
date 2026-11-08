/**
 * Server-side Gemini adapter using the documented Interactions API with the google_search tool
 * and structured JSON output (https://ai.google.dev/gemini-api/docs/google-search,
 * https://ai.google.dev/gemini-api/docs/structured-output). There is no ungrounded fallback:
 * if grounding is rejected the call fails with 'grounding-unavailable'.
 */
import type { Citation, ProviderFailure } from '../../shared/research';
import type { GroundedResult, GroundedSearchProvider, GroundedSearchRequest } from './types';

/** Default documented model with Google Search grounding support; override with GEMINI_RESEARCH_MODEL. */
export const DEFAULT_RESEARCH_MODEL = 'gemini-3.8-flash';
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{2,63}$/;

export type Transport = (params: Record<string, unknown>, opts: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;

export interface ProviderClock { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }
export const realClock: ProviderClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
    }),
};

const PT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const ptParts = (t: number) => Object.fromEntries(PT.formatToParts(new Date(t)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)])) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
/** Pacific calendar day key (Gemini RPD quotas reset at midnight Pacific: ai.google.dev/gemini-api/docs/rate-limits). */
export const pacificDay = (t: number) => { const p = ptParts(t); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
/** Next 00:00 America/Los_Angeles after t (DST-aware). */
export function nextPacificMidnight(t: number): number {
  const p = ptParts(t);
  const wallNextMidnight = Date.UTC(p.year, p.month - 1, p.day + 1);
  let guess = wallNextMidnight + 8 * 3600_000; // PST; corrected below for PDT
  for (let i = 0; i < 3; i++) {
    const q = ptParts(guess);
    const wall = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
    guess += wallNextMidnight - wall;
  }
  return guess;
}
const MAX_COOLDOWN_S = 7 * 24 * 3600; // honor provider Retry-After fully (sanity bound only)

/** Daily provider-call budget plus cooldown after quota errors; shared by all requests in the process. */
export class ProviderGate {
  private day = '';
  private used = 0;
  private cooldownUntil = 0;
  private cooldownKind: ProviderFailure['kind'] = 'provider-quota';
  constructor(private readonly dailyBudget: number, private readonly clock: Pick<ProviderClock, 'now'>) {}
  private roll() {
    const d = pacificDay(this.clock.now());
    if (d !== this.day) { this.day = d; this.used = 0; }
  }
  /** Returns a failure if the call must not be made; otherwise consumes one unit. */
  acquire(): ProviderFailure | null {
    this.roll();
    const now = this.clock.now();
    if (now < this.cooldownUntil)
      return { kind: this.cooldownKind, message: 'Provider quota cooldown active; no call made.', retryAfterSeconds: Math.ceil((this.cooldownUntil - now) / 1000) };
    if (this.used >= this.dailyBudget) return { kind: 'budget-exhausted', message: 'ApexProp daily provider budget exhausted; no call made.', retryAfterSeconds: null };
    this.used++;
    return null;
  }
  noteQuota(f: ProviderFailure) {
    const now = this.clock.now();
    if (f.kind === 'provider-daily-quota') {
      // Daily quota: wait for the Pacific-midnight reset, or longer if the provider says so.
      this.cooldownUntil = Math.max(nextPacificMidnight(now), now + 1000 * Math.min(MAX_COOLDOWN_S, f.retryAfterSeconds ?? 0));
    } else this.cooldownUntil = now + 1000 * Math.min(MAX_COOLDOWN_S, Math.max(5, f.retryAfterSeconds ?? 60));
    this.cooldownKind = f.kind;
  }
  get usedToday() { this.roll(); return this.used; }
}

const SECRETISH = /(AIza[0-9A-Za-z_\-]{20,}|key=[^&\s]+|Bearer\s+[A-Za-z0-9._\-]+)/g;
export const redact = (s: string) => s.replace(SECRETISH, '[redacted]').slice(0, 300);

function prop(o: unknown, k: string): unknown {
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined;
}

function retryAfterFrom(err: unknown): number | null {
  const headers = prop(err, 'headers');
  let h: unknown = null;
  if (headers && typeof (headers as { get?: unknown }).get === 'function') h = (headers as Headers).get('retry-after');
  else h = prop(headers, 'retry-after');
  if (typeof h === 'string' && /^\d+$/.test(h.trim())) return Number(h.trim());
  const msg = String(prop(err, 'message') ?? '');
  const m = /retry(?:Delay)?["\s:]+"?(\d+(?:\.\d+)?)s/i.exec(msg) ?? /retry in (\d+(?:\.\d+)?)\s*s/i.exec(msg);
  return m ? Math.ceil(Number(m[1])) : null;
}

export function classifyError(err: unknown, signal: AbortSignal, deadlineHit: boolean): ProviderFailure {
  if (signal.aborted && !deadlineHit) return { kind: 'cancelled', message: 'Request cancelled by client', retryAfterSeconds: null };
  const name = String(prop(err, 'name') ?? '');
  if (deadlineHit || /Timeout|ContinuationInterrupted/i.test(name)) return { kind: 'timeout', message: 'Provider call exceeded deadline', retryAfterSeconds: null };
  if (name === 'AbortError') return { kind: 'cancelled', message: 'Request aborted', retryAfterSeconds: null };
  const statusRaw = prop(err, 'status') ?? prop(err, 'code') ?? prop(err, 'statusCode');
  const status = typeof statusRaw === 'number' ? statusRaw : Number(statusRaw);
  const msg = redact(String(prop(err, 'message') ?? 'Provider error'));
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(msg)) {
    const daily = /per ?day|PerDay|daily/i.test(msg);
    return { kind: daily ? 'provider-daily-quota' : 'provider-quota', message: msg, retryAfterSeconds: retryAfterFrom(err) };
  }
  if (status === 400 && /google_search|grounding|tool/i.test(msg)) return { kind: 'grounding-unavailable', message: msg, retryAfterSeconds: null };
  if (status === 400 || status === 404 || status === 401 || status === 403) return { kind: 'not-configured', message: `Provider rejected request (${status}): ${msg}`, retryAfterSeconds: null };
  return { kind: 'provider-unavailable', message: `Provider error${Number.isFinite(status) ? ` (${status})` : ''}: ${msg}`, retryAfterSeconds: null };
}

/** Parse an Interactions API response (untrusted). */
export function parseInteraction(raw: unknown): { text: string; citations: Citation[]; searchQueries: string[]; searched: boolean } | null {
  const steps = prop(raw, 'steps');
  if (!Array.isArray(steps)) return null;
  const texts: { text: string; citations: Citation[] }[] = [];
  const queries: string[] = [];
  let searched = false;
  for (const step of steps) {
    const type = prop(step, 'type');
    if (type === 'google_search_call' || type === 'google_search_result') {
      searched = true;
      const q = prop(prop(step, 'arguments'), 'queries');
      if (Array.isArray(q)) for (const x of q) if (typeof x === 'string' && queries.length < 20) queries.push(x.slice(0, 200));
    }
    if (type !== 'model_output') continue;
    const content = prop(step, 'content');
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (prop(block, 'type') !== 'text') continue;
      const text = prop(block, 'text');
      if (typeof text !== 'string') continue;
      const citations: Citation[] = [];
      const anns = prop(block, 'annotations');
      if (Array.isArray(anns))
        for (const a of anns.slice(0, 200)) {
          const url = prop(a, 'url');
          if (prop(a, 'type') !== 'url_citation' || typeof url !== 'string' || url.length > 2000) continue;
          const s = prop(a, 'start_index'), e = prop(a, 'end_index'), title = prop(a, 'title');
          const okIdx = typeof s === 'number' && typeof e === 'number' && Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s;
          citations.push({ url, title: typeof title === 'string' ? title.slice(0, 200) : null, startByte: okIdx ? s : null, endByte: okIdx ? e : null });
        }
      texts.push({ text, citations });
    }
  }
  if (texts.length === 0) return null;
  // Offsets are per text block; only the first JSON block is used to keep offsets meaningful.
  return { text: texts[0].text, citations: texts[0].citations, searchQueries: queries, searched };
}

const REDIRECT_HOST = 'vertexaisearch.cloud.google.com';
/** Resolve Google grounding redirect links by reading the Location header only (fixed Google host; target never fetched). */
export async function resolveGroundingRedirects(citations: Citation[], fetchImpl: typeof fetch, signal: AbortSignal): Promise<Citation[]> {
  const out: Citation[] = [];
  let budget = 20;
  for (const c of citations) {
    let url: URL | null = null;
    try { url = new URL(c.url); } catch { url = null; }
    if (url && url.protocol === 'https:' && url.hostname === REDIRECT_HOST && url.pathname.startsWith('/grounding-api-redirect/') && budget-- > 0) {
      try {
        const res = await fetchImpl(url.href, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
        const loc = res.headers.get('location');
        out.push({ ...c, url: loc && loc.length < 2000 ? loc : c.url });
        continue;
      } catch { /* leave unresolved: it will not match any listing URL */ }
    }
    out.push(c);
  }
  return out;
}

export function createGeminiProvider(opts: {
  transport: Transport | null;
  model?: string;
  gate: ProviderGate;
  clock?: ProviderClock;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}): GroundedSearchProvider {
  const clock = opts.clock ?? realClock;
  const model = opts.model && MODEL_ID.test(opts.model) ? opts.model : DEFAULT_RESEARCH_MODEL;
  const maxAttempts = Math.min(3, Math.max(1, opts.maxAttempts ?? 2));
  return {
    name: 'gemini',
    model,
    configured: opts.transport !== null,
    async search(req: GroundedSearchRequest, signal: AbortSignal): Promise<GroundedResult> {
      if (!opts.transport) return { ok: false, failure: { kind: 'not-configured', message: 'GEMINI_API_KEY is not configured on the server.', retryAfterSeconds: null } };
      // Same params object for every attempt: retries never alter inputs.
      const params = Object.freeze({
        model,
        input: req.prompt,
        tools: [{ type: 'google_search' }],
        response_format: { type: 'text', mime_type: 'application/json', schema: req.schema },
        store: false, // stateless: opt out of server-side interaction retention
      });
      let last: ProviderFailure = { kind: 'provider-unavailable', message: 'No attempt made', retryAfterSeconds: null };
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const remaining = req.deadlineMs - clock.now();
        if (remaining < 1000) return { ok: false, failure: { kind: 'timeout', message: 'Deadline reached before provider call', retryAfterSeconds: null } };
        if (signal.aborted) return { ok: false, failure: { kind: 'cancelled', message: 'Request cancelled by client', retryAfterSeconds: null } };
        const blocked = opts.gate.acquire();
        if (blocked) return { ok: false, failure: blocked };
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new Error('deadline')), remaining);
        const combined = AbortSignal.any([signal, deadline.signal]);
        try {
          const raw = await opts.transport(params, { signal: combined, timeoutMs: remaining });
          const parsed = parseInteraction(raw);
          if (!parsed) last = { kind: 'malformed-response', message: 'Provider response had no text output', retryAfterSeconds: null };
          else if (!parsed.searched && parsed.citations.length === 0)
            return { ok: false, failure: { kind: 'grounding-unavailable', message: 'Response was not grounded by Google Search; discarded.', retryAfterSeconds: null } };
          else {
            const citations = opts.fetchImpl ? await resolveGroundingRedirects(parsed.citations, opts.fetchImpl, combined) : parsed.citations;
            return { ok: true, text: parsed.text, citations, searchQueries: parsed.searchQueries, model };
          }
        } catch (err) {
          last = classifyError(err, signal, deadline.signal.aborted);
          if (last.kind === 'provider-quota' || last.kind === 'provider-daily-quota') { opts.gate.noteQuota(last); return { ok: false, failure: last }; }
          if (last.kind !== 'provider-unavailable') return { ok: false, failure: last };
        } finally {
          clearTimeout(timer);
        }
        if (attempt < maxAttempts) {
          const backoff = Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          if (req.deadlineMs - clock.now() < backoff + 1000) break;
          try { await clock.sleep(backoff, signal); } catch { return { ok: false, failure: { kind: 'cancelled', message: 'Request cancelled by client', retryAfterSeconds: null } }; }
        }
      }
      return { ok: false, failure: last };
    },
  };
}

/** Real transport via @google/genai Interactions API. Imported lazily so tests never need the SDK or a key. */
export async function createSdkTransport(apiKey: string, options?: { beforeDispatch?: () => void }): Promise<Transport> {
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: options?.beforeDispatch ? {
      // This is the HTTPClient fetcher. The SDK awaits auth before calling it.
      fetch: async (input, init) => {
        options.beforeDispatch?.();
        return fetch(input, init);
      },
    } : undefined,
  });
  return async (params, { signal, timeoutMs }) =>
    // The SDK's create() overloads are typed per params shape; params is built to the documented model-interaction shape above.
    (client.interactions.create.bind(client.interactions) as (p: unknown, o: unknown) => Promise<unknown>)(params, {
      timeout_ms: timeoutMs,
      retries: { strategy: 'none' },
      fetch_options: { signal },
    });
}

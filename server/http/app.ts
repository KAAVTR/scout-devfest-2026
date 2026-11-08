import express, { type NextFunction, type Request, type Response } from 'express';
import { parseResearchRequest } from '../../shared/criteria';
import type { GroundedSearchProvider } from '../provider/types';
import { ProviderResultCache, runResearch } from '../research/pipeline';
import { loadSnapshot, type MarketSnapshot } from '../market/snapshot';
import { lookupAddressTax, parseAddressTaxRequest } from '../tax/addressLookup';
import type { TaxLookupAdapter } from '../tax/registry';
import { researchGuard, Semaphore, SlidingWindowLimiter, type GuardConfig } from './guard';
import { parseQueryFallback } from './translate';

import { createDemoAssessment } from '../assessment/propertyAssessment';
import { createAssessmentRouter } from './assessmentRouter';

export interface AppDeps {
  provider: GroundedSearchProvider;
  enableDemoAssessment?: boolean;
  guard: GuardConfig;
  now?: () => number;
  snapshot?: MarketSnapshot;
  taxAdapters?: TaxLookupAdapter[];
  researchDeadlineMs?: number;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

export function createApiApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((event, fields) => console.info(JSON.stringify({ event, ...fields })));
  const app = express();
  app.disable('x-powered-by');
  // Only explicitly listed proxies may set X-Forwarded-For (else req.ip = socket peer; limits then apply per peer).
  app.set('trust proxy', deps.guard.trustProxy?.length ? deps.guard.trustProxy : false);
  if (deps.enableDemoAssessment === true) {
    const service = createDemoAssessment({ now });
    app.use('/api/property-assessment', createAssessmentRouter({ service, guard: deps.guard, now }));
  }
  app.use('/api', express.json({ limit: '16kb', strict: true }));

  const limiter = new SlidingWindowLimiter(deps.guard.perClientLimit, deps.guard.perClientWindowMs, now);
  // ONE global work gate: every route that calls out (provider or county GIS) holds exactly one slot from it.
  const slots = new Semaphore(deps.guard.maxConcurrent, deps.guard.maxQueue, deps.guard.queueTimeoutMs);
  /**
   * Acquire a slot bound to the client connection. Returns null (response already sent) when the queue is full,
   * times out, or the client left. The returned release is idempotent; the caller releases in finally, after the
   * work (whose signal is aborted on disconnect) has actually stopped — so the bound covers real outbound work.
   */
  async function acquireWork(req: Request, res: Response, route: string): Promise<{ signal: AbortSignal; release: () => void } | null> {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(new Error('client-closed')); });
    try {
      const release = await slots.acquire(abort.signal);
      if (abort.signal.aborted) { release(); return null; }
      return { signal: abort.signal, release };
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'queue';
      if (!res.headersSent && !abort.signal.aborted) {
        res.setHeader('Retry-After', '20');
        res.status(503).json({ status: 'rejected', failure: { kind: 'busy', message: `Server capacity full (${reason}); try again shortly.`, retryAfterSeconds: 20 } });
      }
      log('work.rejected', { route, reason });
      return null;
    }
  }
  const cache = new ProviderResultCache(15 * 60 * 1000, 100, now);

  app.post('/api/translate-priorities', (req: Request, res: Response) => {
    const q = req.body?.query;
    if (typeof q !== 'string' || !q.trim() || q.length > 1000) {
      res.status(400).json({ error: 'Query string (≤1000 chars) is required.' });
      return;
    }
    res.json(parseQueryFallback(q));
  });

  app.post('/api/research-pipeline', researchGuard(deps.guard, limiter), async (req: Request, res: Response) => {
    const parsed = parseResearchRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ status: 'invalid-request', failure: { kind: 'invalid-request', message: parsed.errors.join('; '), retryAfterSeconds: null } });
      return;
    }
    const work = await acquireWork(req, res, 'research');
    if (!work) return;
    const abort = { signal: work.signal };
    const started = now();
    try {
      const result = await runResearch(parsed.value, { provider: deps.provider, snapshot: deps.snapshot, taxAdapters: deps.taxAdapters, cache, now, deadlineMs: deps.researchDeadlineMs ?? 90_000 }, abort.signal);
      log('research.done', { requestId: result.requestId, status: result.status, markets: result.markets.length, candidates: result.candidates.length, failure: result.failure?.kind ?? null, ms: now() - started });
      if (!abort.signal.aborted) res.json(result);
    } catch (e) {
      log('research.error', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
      if (!res.headersSent) res.status(500).json({ status: 'failed', failure: { kind: 'provider-unavailable', message: 'Internal research error', retryAfterSeconds: null } });
    } finally {
      work.release();
    }
  });

  // Address-only official tax lookup: independent of the discovery model and its quota. Same access policy, own rate budget.
  const taxLimiter = new SlidingWindowLimiter(Math.max(deps.guard.perClientLimit * 4, 10), deps.guard.perClientWindowMs, now);
  app.post('/api/tax-lookup', researchGuard(deps.guard, taxLimiter), async (req: Request, res: Response) => {
    const parsed = parseAddressTaxRequest(req.body);
    if (!parsed.ok) { res.status(400).json({ status: 'invalid-request', failure: { kind: 'invalid-request', message: parsed.error, retryAfterSeconds: null } }); return; }
    const work = await acquireWork(req, res, 'tax'); // address and confirmToken share the global gate
    if (!work) return;
    try {
      const tax = await lookupAddressTax(parsed.value, deps.snapshot ?? loadSnapshot(), work.signal, deps.taxAdapters);
      log('tax.lookup', { mode: parsed.value.kind, kind: tax.kind, reason: tax.kind === 'unknown' ? tax.reason : null });
      if (!work.signal.aborted) res.json({ status: 'ok', tax });
    } catch (e) {
      log('tax.error', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
      if (!res.headersSent) res.status(500).json({ status: 'failed', failure: { kind: 'lookup-failed', message: 'Internal tax lookup error', retryAfterSeconds: null } });
    } finally {
      work.release();
    }
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    // Passive: never calls the provider.
    res.json({ status: 'healthy', researchProviderConfigured: deps.provider.configured, model: deps.provider.model, accessControl: deps.guard.accessToken ? 'token' : deps.guard.publicMode ? 'disabled-public' : 'open-dev', capacity: slots.stats });
  });

  app.use('/api', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const type = typeof err === 'object' && err !== null ? (err as { type?: unknown }).type : undefined;
    if (type === 'entity.too.large') { res.status(413).json({ status: 'rejected', failure: { kind: 'invalid-request', message: 'Request body too large', retryAfterSeconds: null } }); return; }
    if (type === 'entity.parse.failed') { res.status(400).json({ status: 'rejected', failure: { kind: 'invalid-request', message: 'Malformed JSON body', retryAfterSeconds: null } }); return; }
    next(err);
  });
  return app;
}

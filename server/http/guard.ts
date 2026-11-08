import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface GuardConfig {
  /** If set, every research call must send header x-apexprop-access with this value. */
  accessToken: string | null;
  /** Public deployment: research is refused entirely unless accessToken is configured. */
  publicMode: boolean;
  perClientLimit: number; // requests per window per client
  perClientWindowMs: number;
  maxConcurrent: number;
  maxQueue: number;
  queueTimeoutMs: number;
  /** Exact browser origins allowed (e.g. https://app.example). When empty, Origin must equal the Host header. X-Forwarded-Host is never trusted. */
  allowedOrigins?: string[];
  /** Express trust-proxy list: explicit proxy IPs/CIDRs or 'loopback'/'linklocal'/'uniquelocal'. Never a blanket hop count. */
  trustProxy?: string[];
}

const PROXY_TOKEN = /^(loopback|linklocal|uniquelocal|[0-9a-fA-F:.]+(\/\d{1,3})?)$/;
export function parseTrustProxy(v: string | undefined): string[] {
  if (!v) return [];
  const items = v.split(',').map((x) => x.trim()).filter(Boolean);
  return items.every((x) => PROXY_TOKEN.test(x) && !/^\d+$/.test(x)) ? items : []; // '1', 'true', '*' etc. rejected => trust nothing
}
export function parseAllowedOrigins(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(',').map((x) => x.trim()).flatMap((x) => { try { const u = new URL(x); return u.protocol === 'https:' || u.hostname === 'localhost' ? [u.origin] : []; } catch { return []; } });
}

export function guardConfigFromEnv(env: NodeJS.ProcessEnv): GuardConfig {
  const int = (v: string | undefined, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  const token = env.APEXPROP_ACCESS_TOKEN?.trim();
  return {
    accessToken: token && token.length >= 16 ? token : null,
    publicMode: env.NODE_ENV === 'production' || env.APEXPROP_PUBLIC === '1',
    perClientLimit: int(env.APEXPROP_RATE_LIMIT, 6, 1, 1000),
    perClientWindowMs: 10 * 60 * 1000,
    maxConcurrent: int(env.APEXPROP_MAX_CONCURRENT, 2, 1, 16),
    maxQueue: int(env.APEXPROP_MAX_QUEUE, 4, 0, 100),
    queueTimeoutMs: 15_000,
    allowedOrigins: parseAllowedOrigins(env.APEXPROP_ALLOWED_ORIGINS),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

const reject = (res: Response, status: number, kind: string, message: string, retryAfter?: number) => {
  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
  res.status(status).json({ status: 'rejected', failure: { kind, message, retryAfterSeconds: retryAfter ?? null } });
};

/** Same-origin check. Not authentication: it only blocks cross-site browser abuse of a session. */
export function sameOrigin(req: Request, allowedOrigins: string[] = []): boolean {
  const origin = req.get('origin');
  if (!origin) return req.get('sec-fetch-site') !== 'cross-site';
  try {
    const o = new URL(origin);
    if (allowedOrigins.length) return allowedOrigins.includes(o.origin);
    return o.host === req.get('host'); // X-Forwarded-Host is client-controllable unless pinned; never consulted
  } catch {
    return false;
  }
}

export function checkAccess(cfg: GuardConfig, req: Request): { ok: true } | { ok: false; status: number; kind: string; message: string } {
  if (cfg.accessToken) {
    const got = Buffer.from(req.get('x-apexprop-access') ?? '');
    const want = Buffer.from(cfg.accessToken);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, status: 401, kind: 'access-required', message: 'Access code required. Enter the code your team shared; it is kept only in this browser tab.' };
    return { ok: true };
  }
  if (cfg.publicMode) return { ok: false, status: 503, kind: 'not-configured', message: 'Live research is disabled on this public deployment until APEXPROP_ACCESS_TOKEN is configured.' };
  return { ok: true };
}

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number) {}
  take(key: string): number | null {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return Math.ceil((this.windowMs - (t - arr[0])) / 1000);
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value as string);
    return null;
  }
}

/** Bounded concurrency with a bounded FIFO queue. release() must be called exactly once. */
export class Semaphore {
  private active = 0;
  private waiters: { resolve: (r: () => void) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  constructor(private readonly max: number, private readonly maxQueue: number, private readonly queueTimeoutMs: number) {}
  get stats() { return { active: this.active, queued: this.waiters.length }; }
  acquire(signal: AbortSignal): Promise<() => void> {
    const release = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const next = this.waiters.shift();
        if (next) { clearTimeout(next.timer); next.resolve(release()); } else this.active--;
      };
    };
    if (this.active < this.max) { this.active++; return Promise.resolve(release()); }
    if (this.waiters.length >= this.maxQueue) return Promise.reject(new Error('queue-full'));
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => { this.drop(entry); reject(new Error('queue-timeout')); }, this.queueTimeoutMs),
      };
      this.waiters.push(entry);
      signal.addEventListener('abort', () => { clearTimeout(entry.timer); if (this.drop(entry)) reject(new Error('cancelled')); }, { once: true });
    });
  }
  private drop(entry: unknown): boolean {
    const i = this.waiters.indexOf(entry as (typeof this.waiters)[number]);
    if (i >= 0) this.waiters.splice(i, 1);
    return i >= 0;
  }
}

function guardPrelude(cfg: GuardConfig, req: Request, res: Response): boolean {
  if (!req.is('application/json')) { reject(res, 415, 'invalid-request', 'Content-Type must be application/json'); return false; }
  if (!sameOrigin(req, cfg.allowedOrigins)) { reject(res, 403, 'cross-origin', 'Cross-origin research requests are not allowed.'); return false; }
  const access = checkAccess(cfg, req);
  if (!access.ok) { reject(res, access.status, access.kind, access.message); return false; }
  return true;
}

export function researchGuard(cfg: GuardConfig, limiter: SlidingWindowLimiter) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!guardPrelude(cfg, req, res)) return;
    const wait = limiter.take(req.ip ?? 'unknown');
    if (wait !== null) return reject(res, 429, 'rate-limited', 'Too many research requests from this client.', wait);
    next();
  };
}

/** Local demo sessions only. Auth and origin run before any body read. */
export function demoSessionAdmit(cfg: GuardConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!guardPrelude(cfg, req, res)) return;
    next();
  };
}

/** Runs only after admission and JSON parsing. Reads do not spend the ranking-change budget. */
export function demoSessionGuard(cfg: GuardConfig, writes: SlidingWindowLimiter, reads: SlidingWindowLimiter) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!guardPrelude(cfg, req, res)) return;
    const op = req.body && typeof req.body === 'object' ? (req.body as { op?: unknown }).op : undefined;
    const reading = op === 'read' || op === 'detail';
    const wait = (reading ? reads : writes).take(req.ip ?? 'unknown');
    if (wait !== null) {
      const message = reading
        ? 'This local demo allows 30 sample reads per 10 minutes.'
        : 'This local demo allows 6 sample ranking changes per 10 minutes. Looking at a saved sample is counted separately.';
      return reject(res, 429, 'rate-limited', message, wait);
    }
    next();
  };
}

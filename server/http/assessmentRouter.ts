import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { SlidingWindowLimiter, researchGuard, type GuardConfig } from './guard';
import { handleAssessmentRequest } from '../assessment/controller';
import type { PropertyAssessmentSession } from '../../shared/propertyAssessment';

function readErrorType(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  if (!('type' in err)) {
    return undefined;
  }
  const value: unknown = Reflect.get(err, 'type');
  return typeof value === 'string' ? value : undefined;
}

function readErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  if (!('code' in err)) {
    return undefined;
  }
  const value: unknown = Reflect.get(err, 'code');
  return typeof value === 'string' ? value : undefined;
}

export function createAssessmentRouter(opts: {
  service: PropertyAssessmentSession;
  guard: GuardConfig;
  now?: () => number;
}): Router {
  const { service, guard } = opts;
  const now = opts.now ?? Date.now;
  const limiter = new SlidingWindowLimiter(guard.perClientLimit, guard.perClientWindowMs, now);
  const guardMw = researchGuard(guard, limiter);

  const router = Router();

  const setNoStore = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  const checkMethod = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      const r = handleAssessmentRequest(req.method, undefined, service);
      for (const [key, value] of Object.entries(r.headers)) {
        res.setHeader(key, value);
      }
      res.status(r.status).json(r.body);
      return;
    }
    next();
  };

  const handler = (req: Request, res: Response): void => {
    const r = handleAssessmentRequest('POST', req.body as unknown, service);
    for (const [key, value] of Object.entries(r.headers)) {
      res.setHeader(key, value);
    }
    res.status(r.status).json(r.body);
  };

  router.use(setNoStore);

  router.all('/', checkMethod, guardMw, express.json({ limit: '16kb', strict: true }), handler);

  router.use((req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.status(404).json({ error: { code: 'not-found' } });
  });

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const type = readErrorType(err);
    const code = readErrorCode(err);
    let status = 500;
    let payload: unknown = { error: { code: 'internal-error' } };
    if (type === 'entity.too.large') {
      status = 413;
      payload = {
        status: 'rejected',
        failure: { kind: 'invalid-request', message: 'Request body too large', retryAfterSeconds: null },
      };
    } else if (type === 'entity.parse.failed') {
      status = 400;
      payload = {
        status: 'rejected',
        failure: { kind: 'invalid-request', message: 'Malformed JSON body', retryAfterSeconds: null },
      };
    } else if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
      status = 415;
      payload = {
        status: 'rejected',
        failure: { kind: 'invalid-request', message: 'Unsupported content encoding or charset', retryAfterSeconds: null },
      };
    } else if (type === undefined && (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR')) {
      status = 400;
      payload = {
        status: 'rejected',
        failure: { kind: 'invalid-request', message: 'Malformed compressed body', retryAfterSeconds: null },
      };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.status(status).json(payload);
  });

  return router;
}

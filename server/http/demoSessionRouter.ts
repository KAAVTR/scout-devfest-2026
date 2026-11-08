/** Local-demo-only transport. Never mounted by server.ts/createApiApp. */
import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { SlidingWindowLimiter, demoSessionAdmit, demoSessionGuard, type GuardConfig } from './guard';
// Transport-only structural boundary; both versioned stores prepare their own JSON.
export interface SessionTransport { execute(raw:unknown,owner:string,capability:string|undefined):{status:number;serializedBody:string;capability?:string} }
export function createDemoSessionRouter(guard: GuardConfig, store: SessionTransport): Router {
  if (!guard.accessToken || !guard.publicMode) throw Error('demo-auth-required');
  // Principal comes solely from the configuration validated by researchGuard, never the JSON body.
  const owner = createHash('sha256').update(guard.accessToken).digest('hex');
  const router = Router();
  const now = () => Date.now();
  const writes = new SlidingWindowLimiter(guard.perClientLimit, guard.perClientWindowMs, now);
  const reads = new SlidingWindowLimiter(30, guard.perClientWindowMs, now);
  router.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); next(); });
  router.all('/', (req,res,next) => { if (req.method !== 'POST') { res.setHeader('Allow','POST'); res.status(405).json({error:{code:'method-not-allowed'}}); return; } next(); },
    demoSessionAdmit(guard), express.json({limit:'16kb',strict:true}), demoSessionGuard(guard, writes, reads), (req,res) => {
      try {
        const r = store.execute(req.body, owner, req.get('x-apexprop-session'));
        if (r.capability) res.setHeader('x-apexprop-session',r.capability);
        res.status(r.status).type('application/json').send(r.serializedBody);
      } catch { res.status(500).json({error:{code:'internal-error'}}); }
    });
  router.use((_req,res) => { res.status(404).json({error:{code:'not-found'}}); });
  router.use((err: unknown,_req: express.Request,res: express.Response,_next: express.NextFunction) => {
    const type = typeof err === 'object' && err !== null && 'type' in err ? err.type : undefined;
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    const status = type === 'entity.too.large' ? 413 : type === 'charset.unsupported' || type === 'encoding.unsupported' ? 415 : type === 'entity.parse.failed' || code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR' ? 400 : 500;
    res.status(status).json({error:{code:status===500?'internal-error':'invalid-request'}});
  });
  return router;
}

import express,{Router} from 'express';
import {researchGuard,SlidingWindowLimiter,type GuardConfig} from './guard';
import {calculateVaHouseHack,InvalidVaScenario} from '../assessment/vaHouseHack';
export function createVaHouseHackRouter(guard:GuardConfig):Router {
 if(!guard.accessToken||!guard.publicMode)throw Error('demo-auth-required');
 const router=Router();const limiter=new SlidingWindowLimiter(guard.perClientLimit,guard.perClientWindowMs,Date.now);
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next()});
 router.all('/',(req,res,next)=>{if(req.method!=='POST'){res.setHeader('Allow','POST');res.status(405).json({error:{code:'method-not-allowed'}});return}next()},researchGuard(guard,limiter),express.json({limit:'16kb',strict:true}),(req,res)=>{try{res.status(200).json(calculateVaHouseHack(req.body))}catch(err){res.status(err instanceof InvalidVaScenario?400:500).json({error:{code:err instanceof InvalidVaScenario?'invalid-va-scenario':'internal-error'}})}});
 router.use((_req,res)=>{res.status(404).json({error:{code:'not-found'}})});
 router.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{const type=typeof err==='object'&&err!==null&&'type' in err?err.type:undefined;const code=typeof err==='object'&&err!==null&&'code' in err?err.code:undefined;const status=type==='entity.too.large'?413:type==='charset.unsupported'||type==='encoding.unsupported'?415:type==='entity.parse.failed'||code==='Z_DATA_ERROR'||code==='Z_BUF_ERROR'?400:500;res.status(status).json({error:{code:status===500?'internal-error':'invalid-request'}})});
 return router;
}

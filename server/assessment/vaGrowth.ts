import {calculateVaHouseHack,parseVaHouseHack,InvalidVaScenario} from './vaHouseHack';
import {vaGrowthFixtures} from './vaGrowthFixtures';
import type {GrowthSignal,GrowthCategory,GrowthEvaluation,VaGrowthRequest,VaGrowthResponse,VaGrowthProperty} from '../../shared/vaGrowth';
export class InvalidVaGrowth extends Error {}
/** Normalize scale first; never multiply a score by an unnormalized tiny weight. */
export function normalizeWeightVector(values:number[]):number[]{
 if(!values.length||values.some(v=>!Number.isFinite(v)||v<0))throw new InvalidVaGrowth('invalid-weight-vector');
 const max=Math.max(...values);if(max===0)throw new InvalidVaGrowth('all-zero-weights');
 const scaled=values.map(v=>v===0?0:v/max),sum=scaled.reduce((a,b)=>a+b,0),normalized=scaled.map(v=>v/sum);
 if(values.some((v,i)=>v>0&&(scaled[i]===0||normalized[i]===0)))throw new InvalidVaGrowth('unsupported-normalized-weight-precision');
 return normalized;
}
function points(value:number,weight:number):number{
 const result=value*weight;
 if(!Number.isFinite(result)||(value>0&&weight>0&&result===0))throw new InvalidVaGrowth('unsupported-contribution-precision');
 return result;
}
const categories:GrowthCategory[]=['population','jobsIncome','infrastructure','retail'];
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
function exact(v:unknown,keys:string[]):Record<string,unknown>{if(!record(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k)))throw new InvalidVaGrowth('invalid-va-growth');return v;}
function num(v:unknown,min:number,max:number):number{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new InvalidVaGrowth('invalid-va-growth');return v;}
export function parseVaGrowth(raw:unknown):VaGrowthRequest{
 const r=exact(raw,['contractVersion','location','maxPurchasePrice','maxMonthlyOwnerCost','financing','appreciation','weights']);if(r.contractVersion!=='va-growth-v1'||r.location!=='synthetic-demo-area')throw new InvalidVaGrowth('invalid-va-growth');
 const f=exact(r.financing,['availableCash','downPercent','annualRate','termYears','closingCostsCash','reservesCash','fundingFee']);
 const checked=parseVaHouseHack({contractVersion:'va-househack-v1',occupation:'owner-occupied',unitCount:1,ownerUnit:1,monthlyRents:[0],price:1,availableCash:f.availableCash,downPercent:f.downPercent,annualRate:f.annualRate,termYears:f.termYears,closingCostsCash:f.closingCostsCash,reservesCash:f.reservesCash,fundingFee:f.fundingFee,costs:{annualTax:0,annualInsurance:0,maintenanceMonthlyCash:0,vacancyPercent:5,managementPercent:8},appreciation:r.appreciation});
 // Validate derived upfront precision against the supported comparison price before any session publication.
 calculateVaHouseHack({...checked,price:349000});
 const w=exact(r.weights,['financial','growth','ownerCost','cashSurplus',...categories]);
 const weights={financial:num(w.financial,0,100),growth:num(w.growth,0,100),ownerCost:num(w.ownerCost,0,100),cashSurplus:num(w.cashSurplus,0,100),population:num(w.population,0,100),jobsIncome:num(w.jobsIncome,0,100),infrastructure:num(w.infrastructure,0,100),retail:num(w.retail,0,100)};
 normalizeWeightVector([weights.financial,weights.growth]);normalizeWeightVector([weights.ownerCost,weights.cashSurplus]);normalizeWeightVector(categories.map(c=>weights[c]));
 return {contractVersion:'va-growth-v1',location:'synthetic-demo-area',maxPurchasePrice:num(r.maxPurchasePrice,1,50_000_000),maxMonthlyOwnerCost:num(r.maxMonthlyOwnerCost,0,1_000_000),financing:{availableCash:checked.availableCash,downPercent:checked.downPercent,annualRate:checked.annualRate,termYears:checked.termYears,closingCostsCash:checked.closingCostsCash,reservesCash:checked.reservesCash,fundingFee:checked.fundingFee},appreciation:checked.appreciation,weights};
}
export function evaluateGrowth(signals:GrowthSignal[],weights:Record<GrowthCategory,number>,now:number):GrowthEvaluation{
 if(!Number.isFinite(now)||categories.some(c=>!Number.isFinite(weights[c])||weights[c]<0||weights[c]>100)||categories.reduce((s,c)=>s+weights[c],0)===0)throw Error('invalid-growth-clock-or-weights');
 const observations:{id:string;reason:string}[]=[];const selected:GrowthSignal[]=[];const groups=new Map<string,GrowthSignal[]>();
 for(const s of signals){const list=groups.get(s.eventGroup)??[];list.push(s);groups.set(s.eventGroup,list)}
 for(const list of groups.values()){
  list.sort((a,b)=>Date.parse(b.acquiredAt)-Date.parse(a.acquiredAt)||a.id.localeCompare(b.id));const s=list[0];
  for(const duplicate of list.slice(1))observations.push({id:duplicate.id,reason:'correlated-event-duplicate-not-independent'});
  const age=now-Date.parse(s.acquiredAt),effective=Date.parse(s.effectiveAt);
  const reason=!categories.includes(s.category)||!['announced','funded','construction','open','cancelled'].includes(s.stage)||!['property-area','metro','outside','unknown'].includes(s.geography)?'unsupported-signal-shape':s.authority!=='synthetic-demo'?'unsupported-source':s.stage==='cancelled'?'cancelled':!Number.isFinite(age)||age<0||age>365*86400000?'stale-or-invalid-acquisition-date':!Number.isFinite(effective)||effective>now?'not-effective-yet':s.geography==='outside'||s.geography==='unknown'?'geography-not-applicable':!Number.isFinite(s.intensity)||s.intensity<0||s.intensity>100?'invalid-intensity':null;
  if(reason)observations.push({id:s.id,reason});else selected.push(s);
 }
 const maturity={announced:.25,funded:.5,construction:.75,open:1,cancelled:0};const normalizedCategories=normalizeWeightVector(categories.map(c=>weights[c]));const investigationValue=(s:GrowthSignal)=>points(points(s.intensity,maturity[s.stage]),s.geography==='metro'?.5:1);
 const contributions=categories.map((category,index)=>{const found=selected.filter(s=>s.category===category);const value=found.length?points(found.reduce((v,s)=>v+investigationValue(s),0),1/found.length):null;const weight=normalizedCategories[index];return {category,value,normalizedWeight:weight,points:value===null?null:points(value,weight),signals:found.map(s=>s.id)}});
 const configured=contributions.filter(c=>c.normalizedWeight>0),covered=configured.filter(c=>c.value!==null);
 const selectedSignals=selected.map(s=>({id:s.id,category:s.category,intensity:s.intensity,maturityMultiplier:maturity[s.stage],geographyMultiplier:s.geography==='metro'?.5:1,investigationValue:investigationValue(s)}));
 return {selectedSignals,geographyCoverage:{propertyArea:selected.filter(s=>s.geography==='property-area').length,metroOnly:selected.filter(s=>s.geography==='metro').length},score:covered.length===configured.length?covered.reduce((s,c)=>s+(c.points??0),0):null,configuredCategories:configured.length,coveredCategories:covered.length,contributions,observations,signalTrace:structuredClone(signals)};
}
export function createVaGrowthAssessment(options:{now?:()=>number}={}){
 const now=options.now??Date.now;
 return {assess(raw:unknown):{ok:true;value:VaGrowthResponse}|{ok:false;error:{code:'invalid-request';messages:string[]}}{
 try{const q=parseVaGrowth(raw);
 const t=now(),w=q.weights;const [financialWeight,growthWeight]=normalizeWeightVector([w.financial,w.growth]);const [ownerWeight,cashWeight]=normalizeWeightVector([w.ownerCost,w.cashSurplus]);const clamp=(x:number)=>Math.min(1,Math.max(0,x));
 const properties:VaGrowthProperty[]=vaGrowthFixtures().map(f=>{
  const growth=evaluateGrowth(f.signals,w,t);let finance:VaGrowthProperty['finance']=null;const reasons:string[]=[];
  try{finance=calculateVaHouseHack({contractVersion:'va-househack-v1',occupation:'owner-occupied',unitCount:f.units,ownerUnit:1,monthlyRents:f.rents,price:f.price,...q.financing,appreciation:q.appreciation,costs:{annualTax:f.annualTax,annualInsurance:1600,maintenanceMonthlyCash:200,vacancyPercent:5,managementPercent:8}})}catch(err){if(!(err instanceof InvalidVaScenario))throw err;reasons.push('unsupported-or-invalid-financial-profile')}
  if(f.price>q.maxPurchasePrice)reasons.push('above-budget');if(!finance||finance.status!=='scenario-complete')reasons.push('incomplete-finance');if(finance?.finance.isCashShortage)reasons.push('insufficient-cash');
  const cost=finance?.household.monthlyOwnerHousingCostAfterTenantRent??null,ratio=finance?.household.cashSurplusOnUpfrontCashPercent??null;
  if(cost===null||cost>q.maxMonthlyOwnerCost)reasons.push('owner-housing-cost-incomplete-or-over-limit');
  if(w.financial>0&&w.cashSurplus>0&&ratio===null)reasons.push('cash-return-denominator-undefined');if(w.growth>0&&growth.score===null)reasons.push('growth-coverage-incomplete');
  const financialContributions=[{metric:'owner-housing-cost',raw:cost,normalized:cost===null?null:clamp((q.maxMonthlyOwnerCost-cost)/Math.max(1,q.maxMonthlyOwnerCost))*100,weight:ownerWeight,points:null},{metric:'actual-household-cash-surplus-on-upfront-cash',raw:ratio,normalized:ratio===null?null:clamp((ratio+100)/200)*100,weight:cashWeight,points:null}].map(c=>({...c,points:c.normalized===null?null:points(c.normalized,c.weight)}));
  const financialScore=financialContributions.some(c=>c.weight>0&&c.normalized===null)?null:financialContributions.reduce((s,c)=>s+(c.points??0),0);
  const financialPoints=w.financial===0?0:financialScore===null?null:points(financialScore,financialWeight),growthPoints=w.growth===0?0:growth.score===null?null:points(growth.score,growthWeight);
  if(financialPoints===null||growthPoints===null)reasons.push('configured-score-incomplete');
  return {id:f.id,label:'SYNTHETIC VA comparison — no verified property or growth data',finance,growth,ranking:{kind:'excluded',rank:null,score:reasons.length||financialPoints===null||growthPoints===null?null:financialPoints+growthPoints,reasons,financialScore,financialContributions,financialPoints,growthPoints}};
 });
 const ordered=properties.filter(p=>p.ranking.reasons.length===0&&p.ranking.score!==null).sort((a,b)=>(b.ranking.score??0)-(a.ranking.score??0)||a.id.localeCompare(b.id));ordered.forEach((p,i)=>{p.ranking.kind='ranked';p.ranking.rank=i+1});
 return {ok:true,value:{contractVersion:'va-growth-v1',mode:'synthetic-demo-only',title:'SYNTHETIC VA growth comparison — investigate, not a forecast or approval',assessedAt:new Date(t).toISOString(),assumptions:q,orderedIds:ordered.map(p=>p.id),properties,limitations:['All candidates/rents/taxes/signals are server-owned synthetic scenarios, never verified evidence. No real retailer announcement, project, population metric or company endorsement is claimed.','Ordinal intensity0–100 and maturity/geography multipliers are transparent demo investigation weights, NOT causal price predictions. Missing configured categories exclude rather than masquerade as favorable zero.','Cash surplus ratio is actual mixed-use household surplus/upfront cash, not conventional investment cash-on-cash or imputed owner rent. Appreciation never enters that numerator.','Independent event groups are counted once across categories; latest acquired record controls cancellation. Metro-only proxies receive half property-area weight.','VA eligibility/COE/exemptions/lender approval remain unverified. Session storage is memory-only.']}};
 }catch(err){if(!(err instanceof InvalidVaGrowth)&&!(err instanceof InvalidVaScenario))throw err;return {ok:false,error:{code:'invalid-request',messages:['Invalid VA growth scenario or unsupported weight precision']}}}
 }};
}

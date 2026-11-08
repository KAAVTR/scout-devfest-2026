import type {VaHouseHackRequest,VaHouseHackResponse} from '../../shared/vaHouseHack';
export class InvalidVaScenario extends Error {}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const object=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!record(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k)))throw new InvalidVaScenario('invalid-scenario');return v;};
const number=(v:unknown,min:number,max:number):number=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new InvalidVaScenario('invalid-scenario');return v;};
const integer=(v:unknown,min:number,max:number):number=>{const n=number(v,min,max);if(!Number.isInteger(n))throw new InvalidVaScenario('invalid-scenario');return n;};
const choice=<T extends string>(v:unknown,values:readonly T[]):T=>{const n=values.find(x=>x===v);if(n===undefined)throw new InvalidVaScenario('invalid-scenario');return n;};
const amount=(v:unknown):number|null=>v===null?null:number(v,0,50_000_000);
export function parseVaHouseHack(raw:unknown):VaHouseHackRequest {
 const r=object(raw,['contractVersion','occupation','unitCount','ownerUnit','monthlyRents','price','availableCash','downPercent','annualRate','termYears','closingCostsCash','reservesCash','fundingFee','costs','appreciation']);
 const units=integer(r.unitCount,1,4);const owner=integer(r.ownerUnit,1,units);
 if(!Array.isArray(r.monthlyRents)||r.monthlyRents.length!==units)throw new InvalidVaScenario('invalid-scenario');
 const f=object(r.fundingFee,['exemption','use','payment']);const c=object(r.costs,['annualTax','annualInsurance','maintenanceMonthlyCash','vacancyPercent','managementPercent']);const a=object(r.appreciation,['lowAnnualPercent','baseAnnualPercent','highAnnualPercent','years','sellingCostPercent']);
 const low=number(a.lowAnnualPercent,-100,100),base=number(a.baseAnnualPercent,-100,100),high=number(a.highAnnualPercent,-100,100);if(low>base||base>high)throw new InvalidVaScenario('invalid-scenario');
 return {contractVersion:choice(r.contractVersion,['va-househack-v1']),occupation:choice(r.occupation,['owner-occupied']),unitCount:units,ownerUnit:owner,monthlyRents:r.monthlyRents.map(amount),price:number(r.price,1,50_000_000),availableCash:number(r.availableCash,0,50_000_000),downPercent:number(r.downPercent,0,99),annualRate:number(r.annualRate,0,25),termYears:integer(r.termYears,1,30),closingCostsCash:number(r.closingCostsCash,0,50_000_000),reservesCash:number(r.reservesCash,0,50_000_000),fundingFee:{exemption:choice(f.exemption,['unknown','assume-exempt','assume-not-exempt']),use:choice(f.use,['first','subsequent','unknown']),payment:choice(f.payment,['cash','financed'])},costs:{annualTax:amount(c.annualTax),annualInsurance:amount(c.annualInsurance),maintenanceMonthlyCash:amount(c.maintenanceMonthlyCash),vacancyPercent:number(c.vacancyPercent,0,100),managementPercent:number(c.managementPercent,0,100)},appreciation:{lowAnnualPercent:low,baseAnnualPercent:base,highAnnualPercent:high,years:integer(a.years,1,30),sellingCostPercent:number(a.sellingCostPercent,0,20)}};
}
export function calculateVaHouseHack(raw:unknown):VaHouseHackResponse {
 const q=parseVaHouseHack(raw);const missing:string[]=[];
 const down=q.price*q.downPercent/100,baseLoan=q.price-down;
 let feePercent:number|null=null;
 if(q.fundingFee.exemption==='assume-exempt')feePercent=0;
 else if(q.fundingFee.exemption==='unknown')missing.push('funding-fee-exemption-unknown');
 else if(q.fundingFee.use==='unknown')missing.push('funding-fee-use-unknown');
 else feePercent=q.downPercent>=10?1.25:q.downPercent>=5?1.5:q.fundingFee.use==='first'?2.15:3.3;
 const fee=feePercent===null?null:baseLoan*feePercent/100;
 const loan=fee===null?null:baseLoan+(q.fundingFee.payment==='financed'?fee:0);
 const rate=q.annualRate/1200,n=q.termYears*12;
 const payment=loan===null?null:rate===0?loan/n:loan/(-Math.expm1(-n*Math.log1p(rate))/rate);
 const cash=fee===null?null:down+q.closingCostsCash+q.reservesCash+(q.fundingFee.payment==='cash'?fee:0);
 if(cash!==null&&cash>0&&cash<0.01)throw new InvalidVaScenario('unsupported-positive-upfront-below-one-cent');
 const tenants=q.monthlyRents.filter((_r,i)=>i!==q.ownerUnit-1);let rent:number|null=0;
 for(const value of tenants){if(value===null){rent=null;missing.push('tenant-rent-unknown');break;}rent+=value;}
 const effective=rent===null?null:rent*(1-q.costs.vacancyPercent/100);
 const management=rent===null?null:rent*q.costs.managementPercent/100;
 for(const k of ['annualTax','annualInsurance','maintenanceMonthlyCash'] satisfies (keyof typeof q.costs)[])if(q.costs[k]===null)missing.push(k+'-unknown');
 const ownerCost=payment===null||effective===null||management===null||q.costs.annualTax===null||q.costs.annualInsurance===null||q.costs.maintenanceMonthlyCash===null?null:payment+q.costs.annualTax/12+q.costs.annualInsurance/12+q.costs.maintenanceMonthlyCash+management-effective;
 const annualSurplus=ownerCost===null?null:-ownerCost*12;
 const months=Math.min(q.appreciation.years*12,n);
 const balance=loan===null||payment===null?null:months===n?0:rate===0?loan*((n-months)/n):loan*(Math.expm1(-(n-months)*Math.log1p(rate))/Math.expm1(-n*Math.log1p(rate)));
 const scenarios:[('low'|'base'|'high'),number][]=[['low',q.appreciation.lowAnnualPercent],['base',q.appreciation.baseAnnualPercent],['high',q.appreciation.highAnnualPercent]];
 const result:VaHouseHackResponse = {contractVersion:'va-househack-v1',mode:'manual-scenario-only',officialEligibility:'not-verified',officialExemption:'not-verified',title:'MANUAL VA OWNER-OCCUPIED SCENARIO — NOT APPROVAL OR LIVE RESEARCH',status:missing.length?'incomplete':'scenario-complete',missing,assumptions:q,finance:{downPayment:down,baseLoan,fundingFeePercent:feePercent,fundingFee:fee,loanAmount:loan,monthlyPrincipalInterest:payment,cashToClose:cash,remainingCash:cash===null?null:q.availableCash-cash,isCashShortage:cash===null?null:q.availableCash<cash,cashShortageAmount:cash===null?null:Math.max(0,cash-q.availableCash)},household:{ownerUnitScheduledRentExcluded:q.monthlyRents[q.ownerUnit-1],tenantScheduledMonthlyRent:rent,effectiveTenantMonthlyRent:effective,managementMonthly:management,monthlyOwnerHousingCostAfterTenantRent:ownerCost,annualActualCashSurplus:annualSurplus,cashSurplusOnUpfrontCashPercent:annualSurplus===null||cash===null||cash===0?null:annualSurplus/cash*100,ownerImputedRentIncluded:false,cashSurplusRatioStatus:annualSurplus===null||cash===null?'incomplete':cash===0?'zero-upfront-undefined':'defined'},appreciation:scenarios.map(([scenario,growth])=>{const value=q.price*Math.pow(1+growth/100,q.appreciation.years),cost=value*q.appreciation.sellingCostPercent/100;return {scenario,annualPercent:growth,years:q.appreciation.years,hypotheticalSaleValue:value,sellingCosts:cost,remainingLoanBalance:balance,netSaleEquityBeforeTax:balance===null?null:value-cost-balance};}),limitations:['Manual assumptions only, not a COE, eligibility determination, exemption verification, underwriting or approval.','Purchase model finances ONLY the funding fee, never other closing costs. No PMI modeled.','Tenant rent is not guaranteed or lender-qualifying income. One owner unit is excluded, even if its scheduled rent was supplied.','Owner housing cost is not investment net operating income. Cash surplus ratio excludes imputed owner rent and appreciation, is mixed-use and not conventional investment cash-on-cash.','Appreciation low/base/high are manual annual assumptions, may decline and are not forecasts. Sale equity excludes taxes, transaction-specific costs and rent/cash-flow accumulation.','Growth/ranking/session integration, when used, belongs to its separately versioned contract.']};
 const finiteResult=(value:unknown):void=>{if(typeof value==='number'&&!Number.isFinite(value))throw new InvalidVaScenario('nonfinite-derived-result');if(Array.isArray(value))for(const item of value)finiteResult(item);else if(record(value))for(const item of Object.values(value))finiteResult(item)};
 finiteResult(result);
 return result;
}

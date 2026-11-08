import type {GrowthSignal,GrowthCategory} from '../../shared/vaGrowth';
export interface VaGrowthFixture {id:string;units:number;price:number;rents:(number|null)[];annualTax:number|null;signals:GrowthSignal[]}
const categories:GrowthCategory[]=['population','jobsIncome','infrastructure','retail'];
const signals=(id:string,intensity:number,geography:GrowthSignal['geography']):GrowthSignal[]=>categories.map(category=>({id:id+'-'+category,eventGroup:id+'-'+category,category,stage:'open',geography,acquiredAt:'2026-11-01T00:00:00Z',effectiveAt:'2026-10-01T00:00:00Z',authority:'synthetic-demo',intensity,label:'SYNTHETIC illustrative '+category+' evidence — not actual data/citation/retailer endorsement'}));
export function vaGrowthFixtures():VaGrowthFixture[]{
 const duplex=signals('duplex',90,'property-area');
 duplex.push({...duplex[0],id:'duplex-population-duplicate'});
 duplex.push({...duplex[2],id:'cancelled-project',eventGroup:'cancelled-project',stage:'cancelled',intensity:100});
 duplex.push({...duplex[3],id:'stale-retail',eventGroup:'stale-retail',acquiredAt:'2020-01-01T00:00:00Z',intensity:100});
 duplex.push({...duplex[1],id:'unsupported-jobs',eventGroup:'unsupported-jobs',authority:'unsupported',intensity:100});
 duplex.push({...duplex[1],id:'outside-jobs',eventGroup:'outside-jobs',geography:'outside',intensity:100});
 return [{id:'va-demo-duplex',units:2,price:349000,rents:[9999,2200],annualTax:4000,signals:duplex},{id:'va-demo-triplex',units:3,price:349000,rents:[9999,1500,1500],annualTax:4000,signals:signals('triplex',50,'metro')},{id:'va-demo-quadplex',units:4,price:349000,rents:[9999,1300,1300,1300],annualTax:4000,signals:signals('quadplex',10,'property-area')},{id:'va-demo-incomplete',units:2,price:100000,rents:[9999,null],annualTax:null,signals:[]},{id:'va-demo-unsupported-five',units:5,price:100000,rents:[9999,2000,2000,2000,2000],annualTax:4000,signals:signals('invalid',100,'property-area')}];
}

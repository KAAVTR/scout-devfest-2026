import { PROPERTY_TYPES, SCOPES, STRATEGIES, WEIGHT_KEYS } from './research';
import type { ResearchCriteria, ResearchFinancing, ResearchPropertyType, ResearchWeights } from './research';

export const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};
const STATE_CODES = new Set(Object.values(US_STATES));

export function toStateCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (/^[A-Za-z]{2}$/.test(t) && STATE_CODES.has(t.toUpperCase())) return t.toUpperCase();
  const key = t.toLowerCase();
  if (!Object.hasOwn(US_STATES, key)) return null;
  const code: unknown = US_STATES[key];
  return typeof code === 'string' && STATE_CODES.has(code) ? code : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface ParsedResearchRequest {
  criteria: ResearchCriteria;
  financing: ResearchFinancing;
  weights: ResearchWeights;
}

/** Strict boundary parse. No defaults are substituted for missing hard constraints. */
export function parseResearchRequest(body: unknown): Parsed<ParsedResearchRequest> {
  const errors: string[] = [];
  if (!isObj(body)) return { ok: false, errors: ['Body must be a JSON object'] };
  const c = isObj(body.criteria) ? body.criteria : {};
  const f = isObj(body.financingAssumptions) ? body.financingAssumptions : {};
  const w = isObj(body.weightsSnapshot) ? body.weightsSnapshot : {};

  const scope = SCOPES.find((s) => s === c.scope);
  if (!scope) errors.push('scope must be one of usa/state/metro/zip/address');
  const price = c.maxPurchasePrice;
  if (!finite(price) || price <= 0 || price > 50_000_000) errors.push('maxPurchasePrice must be a finite number > 0');
  const cash = c.downPaymentCash;
  if (!finite(cash) || cash < 0 || cash > 50_000_000) errors.push('downPaymentCash (available cash) must be a finite number >= 0');
  const types: ResearchPropertyType[] = [];
  if (!Array.isArray(c.propertyTypes) || c.propertyTypes.length === 0) errors.push('propertyTypes must be a non-empty array');
  else
    for (const t of c.propertyTypes) {
      const m = PROPERTY_TYPES.find((p) => p === t);
      if (!m) errors.push(`unsupported property type`);
      else if (!types.includes(m)) types.push(m);
    }
  const strategy = STRATEGIES.find((s) => s === c.strategy);
  if (!strategy) errors.push('strategy is required');

  let state: string | null = null, metro: string | null = null, zip: string | null = null;
  if (scope === 'state') {
    state = toStateCode(c.selectedState);
    if (!state) errors.push('selectedState must be a U.S. state');
  } else if (scope === 'metro') {
    const m = typeof c.selectedMetro === 'string' ? c.selectedMetro.trim() : '';
    if (m.length < 2 || m.length > 80 || !/^[A-Za-z .,'\-]+$/.test(m)) errors.push('selectedMetro must be a metro name');
    else metro = m;
  } else if (scope === 'zip') {
    const z = typeof c.selectedZip === 'string' ? c.selectedZip.trim() : '';
    if (!/^\d{5}$/.test(z)) errors.push('selectedZip must be 5 digits');
    else zip = z;
  }

  const down = f.downPaymentPercent, closing = f.closingCostPercent, reserves = f.initialReserves;
  if (!finite(down) || down < 0 || down > 100) errors.push('downPaymentPercent must be 0-100');
  if (!finite(closing) || closing < 0 || closing > 25) errors.push('closingCostPercent must be 0-25');
  if (!finite(reserves) || reserves < 0 || reserves > 10_000_000) errors.push('initialReserves must be >= 0');

  const weights = {} as ResearchWeights;
  for (const k of WEIGHT_KEYS) {
    const v = w[k];
    if (v === undefined && k === 'rentYield') weights[k] = 0;
    else if (finite(v) && v >= 0 && v <= 100) weights[k] = v;
    else errors.push(`weight ${k} must be 0-100`);
  }

  if (errors.length || !scope || !strategy || !finite(price) || !finite(cash) || !finite(down) || !finite(closing) || !finite(reserves)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      criteria: { scope, state, metro, zip, maxPurchasePrice: price, availableCash: cash, propertyTypes: types, strategy },
      financing: { downPaymentPercent: down, closingCostPercent: closing, initialReserves: reserves },
      weights,
    },
  };
}

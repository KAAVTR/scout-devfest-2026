import type { CandidateEvaluation, CashRequirement, ConstraintCheck, PropertyCandidate, ResearchCriteria, ResearchFinancing } from './research';

export interface GeographyContext {
  /** States of the market the candidate was researched for. */
  marketStates: string[];
  /** ZCTAs intersecting the market (null when the market has no ZIP membership data). */
  marketZctas: ReadonlySet<string> | null;
  /** ZIP -> county FIPS (Census ZCTA-county relationship), used to check the claimed state against the ZIP. */
  zctaCounties?: ReadonlyMap<string, string[]>;
}

const STATE_FIPS: Record<string, string> = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '72': 'PR' };

const UNITS: Partial<Record<string, number>> = { 'single-family': 1, duplex: 2, triplex: 3, fourplex: 4 };

export function requiredCash(price: number, f: ResearchFinancing, availableCash: number): CashRequirement {
  const downPayment = price * (f.downPaymentPercent / 100);
  const closingCosts = price * (f.closingCostPercent / 100);
  const total = downPayment + closingCosts + f.initialReserves;
  return { downPayment, closingCosts, reserves: f.initialReserves, total, availableCash, shortfall: Math.max(0, total - availableCash) };
}

const INACTIVE = /\b(pending|sold|off[- ]market|contingent|under contract|withdrawn|expired|closed|rented|for rent)\b/i;

/**
 * Deterministic hard-constraint evaluation. Model claims count only when the exact listing page
 * cited them (attribution); otherwise the constraint is 'unverified', never 'pass'.
 */
export function evaluateCandidate(
  cand: Pick<PropertyCandidate, 'claim' | 'canonicalListingUrl' | 'listingUrlRejection' | 'attribution' | 'retrievedAt'>,
  criteria: ResearchCriteria,
  financing: ResearchFinancing,
  geo: GeographyContext,
): CandidateEvaluation {
  const checks: ConstraintCheck[] = [];
  const { claim, attribution } = cand;

  // Listing page
  if (!cand.canonicalListingUrl) checks.push({ key: 'listing-page', outcome: 'fail', detail: cand.listingUrlRejection ?? 'No allowed exact-property listing URL' });
  else if (!attribution.listingPageCited) checks.push({ key: 'listing-page', outcome: 'unverified', detail: 'Listing URL was not among the grounded citations for this candidate' });
  else checks.push({ key: 'listing-page', outcome: 'pass', detail: 'Exact listing page cited by grounded search' });

  // Price
  const price = claim.listPrice;
  if (price === null || !Number.isFinite(price) || price <= 0) checks.push({ key: 'price', outcome: 'unverified', detail: 'List price unknown' });
  else if (price > criteria.maxPurchasePrice) checks.push({ key: 'price', outcome: 'fail', detail: `Reported price $${price.toLocaleString()} exceeds max $${criteria.maxPurchasePrice.toLocaleString()}` });
  else if (attribution.price !== 'cited-by-listing-page') checks.push({ key: 'price', outcome: 'unverified', detail: `Reported price $${price.toLocaleString()} not attributed to the listing page` });
  else checks.push({ key: 'price', outcome: 'pass', detail: `Cited price $${price.toLocaleString()} ≤ $${criteria.maxPurchasePrice.toLocaleString()}` });

  // Property type (units must agree when both known)
  const t = claim.propertyType;
  const expectedUnits = t ? UNITS[t] : undefined;
  if (t === null) checks.push({ key: 'property-type', outcome: 'unverified', detail: 'Property type unknown' });
  else if (!criteria.propertyTypes.includes(t)) checks.push({ key: 'property-type', outcome: 'fail', detail: `Type ${t} not in selected types (${criteria.propertyTypes.join(', ')})` });
  else if (expectedUnits !== undefined && claim.units !== null && claim.units !== expectedUnits) checks.push({ key: 'property-type', outcome: 'fail', detail: `Reported ${claim.units} units conflicts with type ${t}` });
  else if (attribution.propertyType !== 'cited-by-listing-page') checks.push({ key: 'property-type', outcome: 'unverified', detail: `Reported type ${t} not attributed to the listing page` });
  else checks.push({ key: 'property-type', outcome: 'pass', detail: `Cited type ${t}` });

  // Geography: claimed state must agree with the researched market AND with the ZIP's own counties; any contradiction fails.
  const st = claim.state, zip = claim.zip;
  const zipStates = zip && geo.zctaCounties?.get(zip)?.map((f) => STATE_FIPS[f.slice(0, 2)]).filter(Boolean);
  if (!st || !zip || !/^\d{5}$/.test(zip)) checks.push({ key: 'geography', outcome: 'unverified', detail: 'State/ZIP unknown' });
  else if (criteria.scope === 'state' && criteria.state !== st) checks.push({ key: 'geography', outcome: 'fail', detail: `State ${st} outside selected state ${criteria.state}` });
  else if (criteria.scope === 'zip' && criteria.zip !== zip) checks.push({ key: 'geography', outcome: 'fail', detail: `ZIP ${zip} outside selected ZIP ${criteria.zip}` });
  else if (!geo.marketStates.includes(st)) checks.push({ key: 'geography', outcome: 'fail', detail: `State ${st} outside researched market (${geo.marketStates.join('/')})` });
  else if (zipStates && zipStates.length && !zipStates.includes(st)) checks.push({ key: 'geography', outcome: 'fail', detail: `ZIP ${zip} is in ${[...new Set(zipStates)].join('/')}, contradicting claimed state ${st}` });
  else if (geo.marketZctas && !geo.marketZctas.has(zip)) checks.push({ key: 'geography', outcome: 'fail', detail: `ZIP ${zip} not in researched metro (Census ZCTA-county relationship)` });
  else if (!geo.marketZctas) checks.push({ key: 'geography', outcome: 'unverified', detail: 'Metro ZIP membership data unavailable' });
  else if (attribution.address !== 'cited-by-listing-page') checks.push({ key: 'geography', outcome: 'unverified', detail: 'Full address (street, city, state, ZIP) not attributed to the listing page' });
  else checks.push({ key: 'geography', outcome: 'pass', detail: `Cited ${st} ${zip} within scope` });

  // Strategy: only buy-and-hold rental of a cited residential type passes; other strategies need evidence ApexProp does not research.
  if (criteria.strategy === 'short-term-rental') checks.push({ key: 'strategy', outcome: 'unverified', detail: 'Short-term rental permission depends on local ordinances/HOA rules not checked by ApexProp' });
  else if (criteria.strategy === 'renovation-resale' || criteria.strategy === 'brrrr') checks.push({ key: 'strategy', outcome: 'unverified', detail: `${criteria.strategy === 'brrrr' ? 'BRRRR' : 'Renovation-resale'} fit needs condition, rehab scope and after-repair value evidence, which ApexProp does not research` });
  else if (t === null || attribution.propertyType !== 'cited-by-listing-page') checks.push({ key: 'strategy', outcome: 'unverified', detail: 'Rental fit unknown without a cited property type' });
  else if (t === 'commercial-multi') checks.push({ key: 'strategy', outcome: 'unverified', detail: 'Commercial rental fit requires manual review' });
  else checks.push({ key: 'strategy', outcome: 'pass', detail: `Cited ${t} is a residential rental type (zoning/HOA/rental licensing not checked)` });

  // Cash (down + closing + explicit reserves)
  let cash: CashRequirement | null = null;
  if (!Number.isFinite(criteria.availableCash) || criteria.availableCash < 0) checks.push({ key: 'cash', outcome: 'fail', detail: 'Available cash invalid' });
  else if (price === null || !Number.isFinite(price) || price <= 0) checks.push({ key: 'cash', outcome: 'unverified', detail: 'Cash requirement unknown without price' });
  else {
    cash = requiredCash(price, financing, criteria.availableCash);
    const breakdown = `down $${Math.round(cash.downPayment).toLocaleString()} + closing $${Math.round(cash.closingCosts).toLocaleString()} + reserves $${Math.round(cash.reserves).toLocaleString()} = $${Math.round(cash.total).toLocaleString()}`;
    checks.push(
      cash.shortfall > 0
        ? { key: 'cash', outcome: 'fail', detail: `Needs ${breakdown}; short $${Math.round(cash.shortfall).toLocaleString()}` }
        : { key: 'cash', outcome: attribution.price === 'cited-by-listing-page' ? 'pass' : 'unverified', detail: `Needs ${breakdown} of $${criteria.availableCash.toLocaleString()} available` },
    );
  }

  // Availability: never confirmed (no MLS/IDX feed); only negative evidence excludes.
  if (claim.listingStatus && INACTIVE.test(claim.listingStatus)) checks.push({ key: 'availability', outcome: 'fail', detail: `Source status: ${claim.listingStatus}` });
  else checks.push({ key: 'availability', outcome: 'unverified', detail: `Current availability not verified (no MLS/IDX feed); researched ${cand.retrievedAt.slice(0, 10)}` });

  const hard = checks.filter((c) => c.key !== 'availability');
  const status = checks.some((c) => c.outcome === 'fail') ? 'excluded' : hard.every((c) => c.outcome === 'pass') ? 'qualifies-on-cited-evidence' : 'unverified-lead';
  return { status, checks, cash };
}

/**
 * Re-run only the cash constraint with current cash/financing (criteria that change the search
 * itself must invalidate the snapshot instead). Status is recomputed from all checks.
 */
export function reevaluateCash(
  evaluation: CandidateEvaluation,
  cand: Pick<PropertyCandidate, 'claim' | 'attribution'>,
  availableCash: number,
  financing: ResearchFinancing,
): CandidateEvaluation {
  const price = cand.claim.listPrice;
  let cashCheck: ConstraintCheck;
  let cash: CashRequirement | null = null;
  if (!Number.isFinite(availableCash) || availableCash < 0) cashCheck = { key: 'cash', outcome: 'fail', detail: 'Available cash invalid' };
  else if (price === null || !Number.isFinite(price) || price <= 0) cashCheck = { key: 'cash', outcome: 'unverified', detail: 'Cash requirement unknown without price' };
  else {
    cash = requiredCash(price, financing, availableCash);
    const breakdown = `down $${Math.round(cash.downPayment).toLocaleString()} + closing $${Math.round(cash.closingCosts).toLocaleString()} + reserves $${Math.round(cash.reserves).toLocaleString()} = $${Math.round(cash.total).toLocaleString()}`;
    cashCheck = cash.shortfall > 0
      ? { key: 'cash', outcome: 'fail', detail: `Needs ${breakdown}; short $${Math.round(cash.shortfall).toLocaleString()}` }
      : { key: 'cash', outcome: cand.attribution.price === 'cited-by-listing-page' ? 'pass' : 'unverified', detail: `Needs ${breakdown} of $${availableCash.toLocaleString()} available` };
  }
  const checks = evaluation.checks.map((c) => (c.key === 'cash' ? cashCheck : c));
  const hard = checks.filter((c) => c.key !== 'availability');
  const status = checks.some((c) => c.outcome === 'fail') ? 'excluded' : hard.every((c) => c.outcome === 'pass') ? 'qualifies-on-cited-evidence' : 'unverified-lead';
  return { status, checks, cash };
}

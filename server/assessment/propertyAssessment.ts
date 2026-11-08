import { parseResearchRequest } from '../../shared/criteria';
import type { ParsedResearchRequest } from '../../shared/criteria';
import { evaluateCandidate } from '../../shared/qualification';
import type { GeographyContext } from '../../shared/qualification';
import { searchKeyOf } from '../../shared/research';
import type { PropertyCandidate, ResearchResponse } from '../../shared/research';
import { taxRecordToCalculatorInput } from '../../shared/tax';
import { calculatePropertyUnderwriting, createDemoFixtures, sanitizeFinancingAssumptions } from '../../shared/propertyFinance';
import type { FinancingAssumptions, PropertyTaxInput } from '../../shared/propertyFinanceTypes';
import { ASSESSMENT_VERSION, DEFAULT_PROPERTY_WEIGHTS, PROPERTY_WEIGHT_KEYS } from '../../shared/propertyAssessment';
import type { AssessmentReason, AssessmentResponse, AssessmentResult, PropertyAssumption, PropertyAssessment, PropertyAssessmentSession, PropertyWeights, ScoreContribution } from '../../shared/propertyAssessment';
import { loadSnapshot } from '../market/snapshot';
import type { MarketSnapshot } from '../market/snapshot';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const numberBetween = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
// Require normalized identity content, not raw citation coverage. No county-specific address grammar.
const hasIdentityText = (value: unknown): value is string => typeof value === 'string' && value.replace(/[\s\p{Cc}\p{Cf}]/gu, '').length > 0;
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const FINANCING_BOUNDS = {
  interestRate: [0, 30], loanTermYears: [1, 50], downPaymentPercent: [0, 100],
  propertyTaxRate: [0, 15], insuranceRate: [0, 10], maintenanceRate: [0, 50],
  vacancyRate: [0, 50], managementRate: [0, 50], holdingPeriodYears: [1, 50],
  closingCostPercent: [0, 25], initialReserves: [0, 10_000_000],
};
interface ParsedAssessment {
  request: ParsedResearchRequest;
  financing: FinancingAssumptions;
  propertyWeights: PropertyWeights;
  assumptions: Map<string, PropertyAssumption>;
}
type ParseResult = { ok: true; value: ParsedAssessment } | { ok: false; messages: string[] };

function parseRequest(raw: unknown, ids: ReadonlySet<string>): ParseResult {
  const errors: string[] = [];
  if (!isObject(raw) || !onlyKeys(raw, ['contractVersion', 'goals', 'propertyWeights', 'assumptions']) || raw.contractVersion !== ASSESSMENT_VERSION)
    return { ok: false, messages: ['Expected property-assessment-v1 with goals, optional propertyWeights and assumptions only. Source candidates and verification flags are not accepted.'] };
  const goals = raw.goals;
  if (!isObject(goals) || !onlyKeys(goals, ['criteria', 'financingAssumptions', 'weightsSnapshot']) || !isObject(goals.criteria) || !isObject(goals.financingAssumptions) || !isObject(goals.weightsSnapshot))
    return { ok: false, messages: ['goals must use the existing research request shape.'] };
  const c = goals.criteria;
  if (!onlyKeys(c, ['scope', 'locationName', 'selectedState', 'selectedMetro', 'selectedZip', 'manualListings', 'maxPurchasePrice', 'downPaymentCash', 'propertyTypes', 'strategy', 'naturalLanguageQuery'])) errors.push('Unsupported criteria fields.');
  for (const key of ['locationName', 'selectedState', 'selectedMetro', 'selectedZip', 'naturalLanguageQuery']) {
    if (c[key] !== undefined && (typeof c[key] !== 'string' || c[key].length > 1000)) errors.push(`Invalid criteria.${key}.`);
  }
  if (c.manualListings !== undefined && (!Array.isArray(c.manualListings) || c.manualListings.length > 5 || !c.manualListings.every(v => typeof v === 'string' && v.length <= 2000))) errors.push('Invalid manualListings.');
  if (!onlyKeys(goals.weightsSnapshot, ['demographics', 'infrastructure', 'retailAnchors', 'hazardRisk', 'schoolQuality', 'rentYield'])) errors.push('Unsupported market weights.');
  const parsed = parseResearchRequest(goals);
  if (!parsed.ok) return { ok: false, messages: [...errors, ...parsed.errors] };
  const f = goals.financingAssumptions;
  if (!onlyKeys(f, [...Object.keys(FINANCING_BOUNDS), 'annualInsuranceAmount'])) errors.push('Unsupported financing fields.');
  for (const [key, [min, max]] of Object.entries(FINANCING_BOUNDS)) {
    if (!numberBetween(f[key], min, max)) errors.push(`financingAssumptions.${key} must be a finite number in ${min}..${max}.`);
  }
  if (!Number.isInteger(f.loanTermYears) || !Number.isInteger(f.holdingPeriodYears)) errors.push('Loan and holding years must be integers.');
  if (f.annualInsuranceAmount !== undefined && !numberBetween(f.annualInsuranceAmount, 0, 1_000_000)) errors.push('Invalid annualInsuranceAmount.');
  let propertyWeights: PropertyWeights = { ...DEFAULT_PROPERTY_WEIGHTS };
  if (raw.propertyWeights !== undefined) {
    const w = raw.propertyWeights;
    if (!isObject(w) || !onlyKeys(w, PROPERTY_WEIGHT_KEYS) || !numberBetween(w.monthlyCashFlow, 0, 100) || !numberBetween(w.cashOnCash, 0, 100) || !numberBetween(w.capitalBuffer, 0, 100)) errors.push('propertyWeights must contain three finite weights in 0..100.');
    else {
      propertyWeights = { monthlyCashFlow: w.monthlyCashFlow, cashOnCash: w.cashOnCash, capitalBuffer: w.capitalBuffer };
      if (w.monthlyCashFlow + w.cashOnCash + w.capitalBuffer === 0) errors.push('At least one property weight must be positive.');
    }
  }
  const assumptions = new Map<string, PropertyAssumption>();
  if (raw.assumptions !== undefined) {
    if (!Array.isArray(raw.assumptions) || raw.assumptions.length > 100) errors.push('assumptions must be an array of at most 100 rows.');
    else for (const v of raw.assumptions) {
      if (!isObject(v) || !onlyKeys(v, ['id', 'rentMonthly', 'annualInsurance', 'tax']) || typeof v.id !== 'string' || !ids.has(v.id) || assumptions.has(v.id)) { errors.push('Unknown, duplicate, or malformed assumption ID.'); continue; }
      const rent = v.rentMonthly, insurance = v.annualInsurance, tax = v.tax;
      if (!(rent === null || numberBetween(rent, 0, 1_000_000)) || !(insurance === null || numberBetween(insurance, 0, 1_000_000)) || !isObject(tax)) { errors.push(`Invalid assumptions for ${v.id}.`); continue; }
      if (tax.kind === 'unknown' && onlyKeys(tax, ['kind'])) assumptions.set(v.id, { id: v.id, rentMonthly: rent, annualInsurance: insurance, tax: { kind: 'unknown' } });
      else if (tax.kind === 'manual' && onlyKeys(tax, ['kind', 'annualAmount']) && numberBetween(tax.annualAmount, 0, 1_000_000)) assumptions.set(v.id, { id: v.id, rentMonthly: rent, annualInsurance: insurance, tax: { kind: 'manual', annualAmount: tax.annualAmount } });
      else errors.push(`Tax must be unknown or a finite nonnegative manual assumption for ${v.id}. No verified flags accepted.`);
    }
  }
  if (errors.length) return { ok: false, messages: errors };
  // Every numeric field was checked above; sanitizer is reused only to construct the existing type, not to repair invalid input.
  const financing = sanitizeFinancingAssumptions(f);
  if (financing.annualInsuranceAmount === undefined) delete financing.annualInsuranceAmount;
  return { ok: true, value: { request: parsed.value, financing, propertyWeights, assumptions } };
}

interface OwnedProperty {
  id: string;
  label: string;
  price: number | null;
  type: string | null;
  defaultRent: number | null;
  defaultInsurance: number | null;
  tax: PropertyTaxInput;
  source: PropertyCandidate | null;
}
interface OwnedContext {
  mode: AssessmentResponse['mode'];
  properties: OwnedProperty[];
  originalSearchKey: string | null;
  originalStatus: ResearchResponse['status'] | null;
  sourceExcluded: AssessmentResponse['sourceExcluded'];
  geography: ReadonlyMap<string, GeographyContext>;
  now: () => number;
  maximumEvidenceAgeMs: number;
}

function session(context: OwnedContext): PropertyAssessmentSession {
  const ids = new Set<string>();
  for (const p of context.properties) {
    if (!p.id.trim() || p.id.length > 200 || ids.has(p.id)) throw new Error('Invalid or duplicate server-owned property ID');
    ids.add(p.id);
  }
  return {
    assess(raw: unknown): AssessmentResult {
      const parsed = parseRequest(raw, ids);
      if (!parsed.ok) return { ok: false, error: { code: 'invalid-request', messages: parsed.messages } };
      const { request, financing, propertyWeights, assumptions } = parsed.value;
      const criteria = request.criteria;
      const assessedAtMs = context.now();
      if (!Number.isFinite(assessedAtMs) || !Number.isFinite(new Date(assessedAtMs).getTime())) throw new Error('Invalid server assessment clock');
      const properties: PropertyAssessment[] = context.properties.map(p => {
        const reasons = new Set<AssessmentReason>();
        const a = assumptions.get(p.id);
        let tax = a ? a.tax.kind === 'manual' ? { status: 'manual' as const, annualAmount: a.tax.annualAmount, source: 'User-entered scenario assumption; not verified' } : { status: 'unknown' as const, annualAmount: null, source: 'User explicitly left tax unknown' } : p.tax;
        if (tax.status !== 'unknown' && !numberBetween(tax.annualAmount, 0, 1_000_000_000)) {
          tax = { status: 'unknown', annualAmount: null, source: 'Invalid source tax amount, not used' };
          reasons.add('invalid-source-data');
        }
        const rent = a ? a.rentMonthly : p.defaultRent;
        const insurance = a ? a.annualInsurance : p.defaultInsurance;
        if (criteria.strategy !== 'long-term-rental') reasons.add('unsupported-strategy');
        if (criteria.scope === 'address') reasons.add('unsupported-scope');
        if (!numberBetween(p.price, 0.01, 50_000_000)) reasons.add('invalid-source-data');
        else if (p.price > criteria.maxPurchasePrice) reasons.add('above-budget');
        if (!criteria.propertyTypes.some(t => t === p.type)) reasons.add('property-type-mismatch');
        let qualification: PropertyAssessment['evidence']['qualification'] = null;
        if (p.source) {
          const identityComplete = hasIdentityText(p.source.claim.address) && hasIdentityText(p.source.claim.city);
          if (!identityComplete) {
            reasons.add('incomplete-property-identity');
            reasons.add('unverified-source');
          }
          if (context.originalStatus === 'failed' || context.originalStatus === 'invalid-request') reasons.add('unverified-source');
          if (searchKeyOf(criteria) !== context.originalSearchKey) reasons.add('stale-criteria');
          const at = Date.parse(p.source.retrievedAt);
          if (!Number.isFinite(at) || at > assessedAtMs || assessedAtMs - at > context.maximumEvidenceAgeMs) reasons.add('evidence-age-limit');
          const geo = context.geography.get(p.source.marketId);
          if (!geo) reasons.add('invalid-source-data');
          else {
            qualification = evaluateCandidate(p.source, criteria, request.financing, geo);
            if (!identityComplete) {
              const detail = 'Normalized street and city must both be present before property ranking; raw citation coverage is insufficient.';
              qualification = {
                ...qualification,
                status: qualification.status === 'qualifies-on-cited-evidence' ? 'unverified-lead' : qualification.status,
                checks: qualification.checks.map(check => check.key === 'geography'
                  ? { ...check, outcome: check.outcome === 'fail' ? 'fail' : 'unverified', detail: `${check.detail} ${detail}` }
                  : check),
              };
            }
            if (qualification.status === 'excluded') reasons.add('source-constraint-failed');
            else if (qualification.status !== 'qualifies-on-cited-evidence') reasons.add('unverified-source');
          }
        }
        let calculation = numberBetween(p.price, 0.01, 50_000_000) ? calculatePropertyUnderwriting({
          purchasePrice: p.price, availableCash: criteria.availableCash, financing,
          rentMonthly: rent, rentStatus: rent === null ? 'unknown' : a ? 'manual' : 'assumed', tax,
          ...(insurance === null ? {} : { annualInsurance: insurance }),
        }) : null;
        if (calculation) {
          if (calculation.returnsIncompleteReason === undefined) delete calculation.returnsIncompleteReason;
          if (calculation.isCashShortage) reasons.add('insufficient-cash');
          if (!calculation.areReturnsComplete) reasons.add('incomplete-returns');
          if (calculation.monthlyCashFlow !== null && calculation.monthlyCashFlow < 0) reasons.add('negative-cash-flow');
          if (Object.values(calculation).some(v => typeof v === 'number' && !Number.isFinite(v)) || calculation.cashToClose <= 0) {
            reasons.add('invalid-financial-result');
            calculation = null; // Never emit NaN/Infinity as JSON null disguised as a valid breakdown.
          }
        }
        return {
          id: p.id, label: p.label, claim: p.source ? structuredClone(p.source.claim) : null,
          evidence: { kind: context.mode === 'demo-scenario' ? 'demo-not-evidence' : 'server-research-snapshot',
            geographicMatch: context.mode === 'demo-scenario' ? 'not-established' : 'see-source-checks',
            sourceObservedAt: p.source?.retrievedAt ?? null, availability: 'not-verified',
            citations: structuredClone(p.source?.citations ?? []),
            canonicalListingUrl: p.source?.canonicalListingUrl ?? null,
            provider: p.source ? structuredClone(p.source.provider) : null,
            sourceTaxRecord: p.source ? structuredClone(p.source.tax) : null, qualification,
            rent: rent === null ? 'unknown' : a ? 'manual' : 'assumed-demo', tax: structuredClone(tax),
          },
          financing: { ...financing }, calculation,
          ranking: { kind: 'excluded', rank: null, score: null, reasons: [...reasons].sort(), contributions: [] },
        };
      });
      const totalWeight = PROPERTY_WEIGHT_KEYS.reduce((sum, k) => sum + propertyWeights[k], 0);
      const sortable: { item: PropertyAssessment; contributions: ScoreContribution[]; rawScore: number }[] = [];
      for (const item of properties) {
        const c = item.calculation;
        if (item.ranking.kind !== 'excluded' || item.ranking.reasons.length || !c || c.monthlyCashFlow === null || c.cashOnCashPercent === null) continue;
        const inputs = {
          monthlyCashFlow: { rawValue: c.monthlyCashFlow, target: 500 },
          cashOnCash: { rawValue: c.cashOnCashPercent, target: 10 },
          capitalBuffer: { rawValue: criteria.availableCash === 0 ? 0 : c.remainingCash / criteria.availableCash, target: 0.25 },
        };
        const contributions = PROPERTY_WEIGHT_KEYS.map(key => {
          const { rawValue, target } = inputs[key];
          const normalizedValue = Math.max(0, Math.min(1, rawValue / target));
          const normalizedWeight = propertyWeights[key] / totalWeight;
          return { key, rawValue, target, normalizedValue, normalizedWeight, points: 100 * normalizedValue * normalizedWeight };
        });
        sortable.push({ item, contributions, rawScore: contributions.reduce((sum, x) => sum + x.points, 0) });
      }
      // Round before sorting so displayed ties use the documented code-point ID tie-breaker too.
      sortable.sort((a, b) => Math.round(b.rawScore * 10) - Math.round(a.rawScore * 10) || compareId(a.item.id, b.item.id));
      sortable.forEach(({ item, contributions, rawScore }, index) => { item.ranking = { kind: 'ranked', rank: index + 1, score: Math.round(rawScore * 10) / 10, reasons: [], contributions }; });
      properties.sort((a, b) => compareId(a.id, b.id));
      return { ok: true, value: {
        contractVersion: ASSESSMENT_VERSION, mode: context.mode,
        title: context.mode === 'demo-scenario' ? 'DEMO ONLY: synthetic property scenario order, not live recommendations' : 'Cited property snapshot order with explicit financial assumptions; availability not verified',
        assessedAt: new Date(assessedAtMs).toISOString(), criteria,
        marketWeightsSnapshot: request.weights, propertyWeights, orderedIds: sortable.map(x => x.item.id), properties,
        sourceExcluded: structuredClone(context.sourceExcluded),
        limitations: [
          'Property score is a transparent scenario comparison, not a forecast, probability, or guarantee.',
          'Only long-term-rental is ranked. Negative monthly cash flow, incomplete returns, hard-constraint failures, and stale live discovery criteria are excluded before weighting.',
          'Market priority weights are returned for compatibility but do not influence property scores. Property weights default to 50/30/20 for monthly cash flow/cash-on-cash/capital buffer.',
          'Targets are $500 monthly cash flow, 10% cash-on-cash, and 25% remaining capital. Each contribution is clipped to 0..1. Scores round to one decimal; ties use ascending case-sensitive code-point ID.',
          'Rent and manual tax are assumptions, never source verification. Tax unknown does not mean zero. No independent freshness or current availability guarantee.',
          context.mode === 'demo-scenario' ? 'Synthetic fixtures have no verified address, geographic match, listing, citation, or observation date. Ranking is demo-scenario eligibility only.' : `Evidence age policy: at most ${context.maximumEvidenceAgeMs} ms against server clock; this does not establish real-world freshness. Changed discovery goals require new research.`,
          'No provider, translation, tax lookup, external request, or persistence occurs in assessment.',
        ],
      } };
    },
  };
}

/** Explicit synthetic namespace. No supplied property facts can become verified data. */
export function createDemoAssessment(options: { now?: () => number } = {}): PropertyAssessmentSession {
  const properties: OwnedProperty[] = createDemoFixtures().map(f => ({ id: f.id, label: f.label, price: f.purchasePrice, type: f.propertyType, defaultRent: f.rentAssumedMonthly, defaultInsurance: f.insuranceAnnual, tax: { status: 'unknown', annualAmount: null, source: 'Synthetic demo: tax unknown' }, source: null }));
  return session({ mode: 'demo-scenario', properties, originalSearchKey: null, originalStatus: null, sourceExcluded: [], geography: new Map(), now: options.now ?? Date.now, maximumEvidenceAgeMs: 0 });
}

/** INTERNAL ONLY: capture actual server-owned runResearch output, never browser-submitted JSON. */
export function createResearchAssessment(args: { research: ResearchResponse; snapshot?: MarketSnapshot; now?: () => number; maximumEvidenceAgeMs?: number }): PropertyAssessmentSession {
  const research = structuredClone(args.research);
  if (hasNonfiniteNumber(research)) throw new Error('Server-owned research contains nonfinite numbers');
  const sourceIds = [...research.candidates.map(c => c.id), ...research.excluded.map(c => c.id)];
  if (sourceIds.length > 200 || sourceIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200) || new Set(sourceIds).size !== sourceIds.length) throw new Error('Invalid or duplicate server-owned property ID');
  if (!research.criteria || research.searchKey !== searchKeyOf(research.criteria)) throw new Error('Research basis missing or inconsistent');
  const maximumEvidenceAgeMs = args.maximumEvidenceAgeMs ?? 15 * 60_000;
  if (!numberBetween(maximumEvidenceAgeMs, 1, 24 * 60 * 60_000)) throw new Error('Invalid evidence age policy');
  const snapshot = structuredClone(args.snapshot ?? loadSnapshot());
  const geography = new Map<string, GeographyContext>();
  for (const metro of snapshot.metros) geography.set(`cbsa:${metro.cbsa}`, { marketStates: metro.states, marketZctas: new Set(Object.keys(metro.zctas)), zctaCounties: new Map(Object.entries(metro.zctas).map(([zip, counties]) => [zip, counties.split(',')])) });
  const properties: OwnedProperty[] = research.candidates.map(source => ({ id: source.id, label: source.claim.address ?? 'Property address unknown', price: source.claim.listPrice, type: source.claim.propertyType, defaultRent: null, defaultInsurance: null, tax: taxRecordToCalculatorInput(source.tax), source }));
  return session({ mode: 'research-snapshot', properties, originalSearchKey: research.searchKey, originalStatus: research.status, sourceExcluded: research.excluded, geography, now: args.now ?? Date.now, maximumEvidenceAgeMs });
}

function hasNonfiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonfiniteNumber);
  if (isObject(value)) return Object.values(value).some(hasNonfiniteNumber);
  return false;
}

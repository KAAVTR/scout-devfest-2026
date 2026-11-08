/**
 * ApexProp research contract shared by server and client.
 * Everything a model or web source says is an untrusted claim until checked here.
 */
import type { TaxRecord } from './tax';

export const PROPERTY_TYPES = ['single-family', 'duplex', 'triplex', 'fourplex', 'commercial-multi', 'townhome', 'condo'] as const;
export type ResearchPropertyType = (typeof PROPERTY_TYPES)[number];
export const STRATEGIES = ['long-term-rental', 'short-term-rental', 'renovation-resale', 'brrrr'] as const;
export type ResearchStrategy = (typeof STRATEGIES)[number];
export const SCOPES = ['usa', 'state', 'metro', 'zip', 'address'] as const;
export type ResearchScope = (typeof SCOPES)[number];

export const WEIGHT_KEYS = ['demographics', 'infrastructure', 'retailAnchors', 'hazardRisk', 'schoolQuality', 'rentYield'] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];
export type ResearchWeights = Record<WeightKey, number>;

/** Validated, normalized request. Produced only by parseResearchRequest. */
export interface ResearchCriteria {
  scope: ResearchScope;
  state: string | null; // two-letter USPS code when scope === 'state'
  metro: string | null; // free text metro query when scope === 'metro'
  zip: string | null; // 5 digits when scope === 'zip'
  maxPurchasePrice: number;
  availableCash: number;
  propertyTypes: ResearchPropertyType[];
  strategy: ResearchStrategy;
}

export interface ResearchFinancing {
  downPaymentPercent: number;
  closingCostPercent: number;
  initialReserves: number;
}

// ---------- Market evidence ----------
export interface SourceRef {
  publisher: string;
  dataset: string;
  period: string;
  geography: string;
  url: string;
  retrievedAt: string;
}

export type MetricEvidence =
  | { kind: 'reported'; value: number; marginOfError: number | null; source: SourceRef }
  | { kind: 'unknown'; reason: string };

export interface MetricContribution {
  key: WeightKey;
  label: string;
  weight: number;
  normalizedScore: number | null; // 0-100, null = no evidence
  contribution: number | null; // points added to overall score
}

export interface EvidencedMarket {
  id: string; // cbsa:<code>
  name: string;
  states: string[];
  geographyType: 'metropolitan-statistical-area' | 'zip-scope';
  metrics: {
    population2025: MetricEvidence;
    populationChangePct2020to2025: MetricEvidence;
    medianHomeValue: MetricEvidence;
    medianGrossRent: MetricEvidence;
    medianHouseholdIncome: MetricEvidence;
  };
  /** Weighted score using only categories with evidence. Null if no weighted category has evidence. */
  score: number | null;
  /** Share (0-1) of total weight backed by evidence. Separate from score by design. */
  evidenceCoverage: number;
  contributions: MetricContribution[];
  missingEvidence: string[];
  screening: { label: string; outcome: 'pass' | 'fail' | 'unknown' }[];
}

// ---------- Property candidates ----------
export interface Citation {
  url: string;
  title: string | null;
  /** UTF-8 byte offsets into the model output text, when provided. */
  startByte: number | null;
  endByte: number | null;
}

export type FieldAttribution = 'cited-by-listing-page' | 'uncited';

export interface CandidateClaim {
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  listPrice: number | null;
  propertyType: ResearchPropertyType | null;
  units: number | null;
  listingUrl: string | null;
  listingStatus: string | null;
  sourceObservedDate: string | null;
}

export type CheckOutcome = 'pass' | 'fail' | 'unverified';
export interface ConstraintCheck {
  key: 'listing-page' | 'price' | 'property-type' | 'geography' | 'strategy' | 'cash' | 'availability';
  outcome: CheckOutcome;
  detail: string;
}

export interface CashRequirement {
  downPayment: number;
  closingCosts: number;
  reserves: number;
  total: number;
  availableCash: number;
  shortfall: number; // 0 when feasible
}

export type QualificationStatus =
  | 'qualifies-on-cited-evidence' // every hard constraint passed using cited listing-page evidence; still not an availability guarantee
  | 'unverified-lead' // nothing failed, but at least one hard constraint could not be confirmed
  | 'excluded'; // at least one hard constraint failed

export interface CandidateEvaluation {
  status: QualificationStatus;
  checks: ConstraintCheck[];
  cash: CashRequirement | null;
}

export interface PropertyCandidate {
  id: string;
  marketId: string;
  claim: CandidateClaim;
  canonicalListingUrl: string | null;
  listingUrlRejection: string | null;
  attribution: {
    listingPageCited: boolean;
    price: FieldAttribution;
    address: FieldAttribution;
    propertyType: FieldAttribution;
  };
  citations: Citation[];
  retrievedAt: string;
  provider: { name: 'gemini'; model: string; groundingTool: 'google_search'; searchQueries: string[]; fromCache?: boolean };
  tax: TaxRecord;
  evaluation: CandidateEvaluation;
}

// ---------- Response ----------
export type ProviderFailureKind =
  | 'provider-quota'
  | 'provider-daily-quota'
  | 'provider-unavailable'
  | 'timeout'
  | 'cancelled'
  | 'malformed-response'
  | 'grounding-unavailable'
  | 'not-configured'
  | 'budget-exhausted'
  | 'invalid-request';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  message: string;
  retryAfterSeconds: number | null;
}

export interface MarketResearchOutcome {
  marketId: string;
  outcome: 'candidates' | 'no-match' | 'failed' | 'not-attempted';
  failure: ProviderFailure | null;
  candidateCount: number;
  excludedCount: number;
  /** When the provider result was originally retrieved (a cache hit keeps the original time; no fresh source check). */
  providerRetrievedAt?: string | null;
  fromCache?: boolean;
}

export interface ResearchResponse {
  /** True when any market reused a cached provider result (original retrieval times preserved per candidate). */
  fromCache?: boolean;
  /** complete = every attempted market finished; partial = some failed; failed = no market finished. */
  status: 'complete' | 'partial' | 'failed' | 'invalid-request';
  requestId: string;
  generatedAt: string;
  searchKey: string;
  criteria: ResearchCriteria | null;
  financing: ResearchFinancing | null;
  coverageNotice: string;
  marketSnapshot: { retrievedAt: string; coverage: string } | null;
  markets: EvidencedMarket[];
  marketOutcomes: MarketResearchOutcome[];
  candidates: PropertyCandidate[];
  excluded: { id: string; marketId: string; address: string | null; reasons: string[] }[];
  failure: ProviderFailure | null;
  limitations: string[];
}

/** Criteria fields that, when changed, invalidate market selection and provider results. Cash/financing are re-evaluated deterministically instead. */
export function searchKeyOf(c: ResearchCriteria): string {
  return JSON.stringify([c.scope, c.state, c.metro?.toLowerCase().trim() ?? null, c.zip, c.maxPurchasePrice, [...c.propertyTypes].sort(), c.strategy]);
}

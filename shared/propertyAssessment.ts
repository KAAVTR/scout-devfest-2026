import type { TaxRecord } from './tax';
import type { FinancingAssumptions, PropertyTaxInput, PropertyUnderwritingResult } from './propertyFinanceTypes';
import type { CandidateClaim, CandidateEvaluation, Citation, PropertyCandidate, ResearchCriteria, ResearchWeights } from './research';

export const ASSESSMENT_VERSION = 'property-assessment-v1';
export const PROPERTY_WEIGHT_KEYS = ['monthlyCashFlow', 'cashOnCash', 'capitalBuffer'] as const;
export type PropertyWeightKey = typeof PROPERTY_WEIGHT_KEYS[number];
export type PropertyWeights = Record<PropertyWeightKey, number>;
export const DEFAULT_PROPERTY_WEIGHTS: Readonly<PropertyWeights> = { monthlyCashFlow: 50, cashOnCash: 30, capitalBuffer: 20 };
export type ManualTaxAssumption = { kind: 'unknown' } | { kind: 'manual'; annualAmount: number };
export interface PropertyAssumption {
  id: string;
  rentMonthly: number | null;
  annualInsurance: number | null;
  tax: ManualTaxAssumption;
}
/** Wire goals use the EXISTING research request shape. See parseResearchRequest. */
export interface AssessmentRequest {
  contractVersion: typeof ASSESSMENT_VERSION;
  goals: {
    criteria: import('../src/types').SearchCriteria;
    financingAssumptions: FinancingAssumptions;
    weightsSnapshot: ResearchWeights;
  };
  propertyWeights?: PropertyWeights;
  assumptions?: PropertyAssumption[];
}
export type AssessmentReason =
  | 'above-budget' | 'insufficient-cash' | 'unsupported-strategy' | 'unsupported-scope'
  | 'property-type-mismatch' | 'source-constraint-failed' | 'unverified-source'
  | 'stale-criteria' | 'evidence-age-limit' | 'invalid-source-data' | 'incomplete-property-identity'
  | 'incomplete-returns' | 'negative-cash-flow' | 'invalid-financial-result';
export interface ScoreContribution {
  key: PropertyWeightKey;
  rawValue: number;
  target: number;
  normalizedValue: number;
  normalizedWeight: number;
  points: number;
}
export type PropertyRanking =
  | { kind: 'excluded'; rank: null; score: null; reasons: AssessmentReason[]; contributions: [] }
  | { kind: 'ranked'; rank: number; score: number; reasons: []; contributions: ScoreContribution[] };
export interface PropertyAssessment {
  id: string;
  label: string;
  claim: CandidateClaim | null;
  evidence: {
    kind: 'demo-not-evidence' | 'server-research-snapshot';
    geographicMatch: 'not-established' | 'see-source-checks';
    sourceObservedAt: string | null;
    availability: 'not-verified';
    citations: Citation[];
    canonicalListingUrl: string | null;
    provider: PropertyCandidate['provider'] | null;
    sourceTaxRecord: TaxRecord | null;
    qualification: CandidateEvaluation | null;
    rent: 'manual' | 'assumed-demo' | 'unknown';
    tax: PropertyTaxInput;
  };
  financing: FinancingAssumptions;
  calculation: (PropertyUnderwritingResult & { isAvailableCashValid: boolean }) | null;
  ranking: PropertyRanking;
}
export interface AssessmentResponse {
  contractVersion: typeof ASSESSMENT_VERSION;
  mode: 'demo-scenario' | 'research-snapshot';
  title: string;
  assessedAt: string;
  criteria: ResearchCriteria;
  marketWeightsSnapshot: ResearchWeights;
  propertyWeights: PropertyWeights;
  orderedIds: string[];
  properties: PropertyAssessment[];
  sourceExcluded: { id: string; marketId: string; address: string | null; reasons: string[] }[];
  limitations: string[];
}
export type AssessmentResult =
  | { ok: true; value: AssessmentResponse }
  | { ok: false; error: { code: 'invalid-request'; messages: string[] } };
export interface PropertyAssessmentSession {
  assess(request: unknown): AssessmentResult;
}

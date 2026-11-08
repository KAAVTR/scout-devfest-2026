import type { EvidencedMarket, MetricContribution, MetricEvidence, ResearchWeights, WeightKey } from './research';

const LABELS: Record<WeightKey, string> = {
  demographics: 'Demographics (population change, household income)',
  infrastructure: 'Infrastructure / capital projects',
  retailAnchors: 'Retail anchors',
  hazardRisk: 'Hazard risk',
  schoolQuality: 'School quality',
  rentYield: 'Gross rent-to-value ratio (market median, not property-specific)',
};

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const linear = (v: number, lo: number, hi: number) => clamp(((v - lo) / (hi - lo)) * 100);
const val = (m: MetricEvidence) => (m.kind === 'reported' ? m.value : null);

/** 0-100 normalized category scores; null when no government evidence exists for that category. */
export function categoryScores(metrics: EvidencedMarket['metrics']): Record<WeightKey, number | null> {
  const growth = val(metrics.populationChangePct2020to2025);
  const income = val(metrics.medianHouseholdIncome);
  const parts = [growth === null ? null : linear(growth, -5, 10), income === null ? null : linear(income, 40000, 120000)].filter(
    (x): x is number => x !== null,
  );
  const rent = val(metrics.medianGrossRent);
  const value = val(metrics.medianHomeValue);
  const yieldPct = rent !== null && value !== null && value > 0 ? ((rent * 12) / value) * 100 : null;
  return {
    demographics: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null,
    rentYield: yieldPct === null ? null : linear(yieldPct, 3, 9),
    // No key-free official source wired yet: stay unknown, never a favorable default.
    infrastructure: null,
    retailAnchors: null,
    hazardRisk: null,
    schoolQuality: null,
  };
}

export function scoreMarket(metrics: EvidencedMarket['metrics'], weights: ResearchWeights): Pick<EvidencedMarket, 'score' | 'evidenceCoverage' | 'contributions' | 'missingEvidence'> {
  const cats = categoryScores(metrics);
  const keys = Object.keys(LABELS) as WeightKey[];
  const totalWeight = keys.reduce((s, k) => s + weights[k], 0);
  const evidencedWeight = keys.reduce((s, k) => s + (cats[k] === null ? 0 : weights[k]), 0);
  const contributions: MetricContribution[] = keys.map((k) => {
    const s = cats[k];
    return {
      key: k,
      label: LABELS[k],
      weight: weights[k],
      normalizedScore: s === null ? null : Math.round(s * 10) / 10,
      contribution: s === null || evidencedWeight === 0 ? null : Math.round(((s * weights[k]) / evidencedWeight) * 10) / 10,
    };
  });
  const score = evidencedWeight > 0 ? Math.round(contributions.reduce((a, c) => a + (c.contribution ?? 0), 0) * 10) / 10 : null;
  return {
    score,
    evidenceCoverage: totalWeight > 0 ? Math.round((evidencedWeight / totalWeight) * 1000) / 1000 : 0,
    contributions,
    missingEvidence: keys.filter((k) => cats[k] === null && weights[k] > 0).map((k) => `${LABELS[k]}: no sourced data — not scored`),
  };
}

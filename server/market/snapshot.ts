import { readFileSync } from 'node:fs';
import type { EvidencedMarket, MetricEvidence, ResearchCriteria, ResearchFinancing, ResearchWeights, SourceRef } from '../../shared/research';
import { scoreMarket } from '../../shared/scoring';
import { requiredCash } from '../../shared/qualification';

interface RawSource { publisher: string; dataset: string; period: string; geography: string; url: string }
interface RawMetro {
  cbsa: string; name: string; states: string[];
  population2025: number | null; populationChangePct2020to2025: number | null;
  medianHomeValue: number | null; medianHomeValueMoe: number | null;
  medianGrossRent: number | null; medianGrossRentMoe: number | null;
  medianHouseholdIncome: number | null; medianHouseholdIncomeMoe: number | null;
  counties: { fips: string; name: string }[];
  zctas: Record<string, string>;
}
export interface MarketSnapshot {
  retrievedAt: string;
  coverage: string;
  sources: Record<'medianHomeValue' | 'medianGrossRent' | 'medianHouseholdIncome' | 'populationChange' | 'zipToMetro', RawSource>;
  metros: RawMetro[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const numOrNull = (v: unknown) => (v === null || (typeof v === 'number' && Number.isFinite(v)) ? v : undefined);

export function parseSnapshot(raw: unknown): MarketSnapshot {
  if (!isObj(raw) || typeof raw.retrievedAt !== 'string' || !Array.isArray(raw.metros) || !isObj(raw.sources)) throw new Error('Invalid market snapshot');
  for (const m of raw.metros) {
    if (!isObj(m) || typeof m.cbsa !== 'string' || typeof m.name !== 'string' || !Array.isArray(m.states)) throw new Error('Invalid metro row');
    for (const k of ['population2025', 'populationChangePct2020to2025', 'medianHomeValue', 'medianGrossRent', 'medianHouseholdIncome'])
      if (numOrNull(m[k]) === undefined) throw new Error(`Invalid metro metric ${k}`);
  }
  // Validated above field by field; the remaining structure is produced by scripts/build-market-snapshot.ts.
  return raw as unknown as MarketSnapshot;
}

let cached: MarketSnapshot | null = null;
export function loadSnapshot(): MarketSnapshot {
  cached ??= parseSnapshot(JSON.parse(readFileSync(new URL('../data/market-snapshot.json', import.meta.url), 'utf8')));
  return cached;
}

export interface SelectedMarket {
  market: EvidencedMarket;
  states: string[];
  zctas: ReadonlySet<string> | null;
  zctaCounties: ReadonlyMap<string, string[]>;
  counties: { fips: string; name: string }[];
}

function ev(value: number | null, moe: number | null, src: RawSource, retrievedAt: string): MetricEvidence {
  const source: SourceRef = { ...src, retrievedAt };
  return value === null ? { kind: 'unknown', reason: `Not published for this geography in ${src.dataset}` } : { kind: 'reported', value, marginOfError: moe, source };
}

function toMarket(m: RawMetro, snap: MarketSnapshot, criteria: ResearchCriteria, financing: ResearchFinancing, weights: ResearchWeights): SelectedMarket {
  const s = snap.sources;
  const metrics: EvidencedMarket['metrics'] = {
    population2025: ev(m.population2025, null, s.populationChange, snap.retrievedAt),
    populationChangePct2020to2025: ev(m.populationChangePct2020to2025, null, s.populationChange, snap.retrievedAt),
    medianHomeValue: ev(m.medianHomeValue, m.medianHomeValueMoe, s.medianHomeValue, snap.retrievedAt),
    medianGrossRent: ev(m.medianGrossRent, m.medianGrossRentMoe, s.medianGrossRent, snap.retrievedAt),
    medianHouseholdIncome: ev(m.medianHouseholdIncome, m.medianHouseholdIncomeMoe, s.medianHouseholdIncome, snap.retrievedAt),
  };
  const v = m.medianHomeValue;
  const cashAtMedian = v === null ? null : requiredCash(v, financing, criteria.availableCash);
  const screening: EvidencedMarket['screening'] = [
    { label: `Median owner-occupied home value ≤ budget $${criteria.maxPurchasePrice.toLocaleString()} (market screen only; not a property price)`, outcome: v === null ? 'unknown' : v <= criteria.maxPurchasePrice ? 'pass' : 'fail' },
    { label: 'Cash for a median-value home within available cash (informational)', outcome: cashAtMedian === null ? 'unknown' : cashAtMedian.shortfall === 0 ? 'pass' : 'fail' },
  ];
  const zctaCounties = new Map(Object.entries(m.zctas ?? {}).map(([z, cs]) => [z, cs.split(',')]));
  return {
    market: { id: `cbsa:${m.cbsa}`, name: `${m.name} Metro Area`, states: m.states, geographyType: 'metropolitan-statistical-area', metrics, screening, ...scoreMarket(metrics, weights) },
    states: m.states,
    zctas: zctaCounties.size ? new Set(zctaCounties.keys()) : null,
    zctaCounties,
    counties: m.counties ?? [],
  };
}

export const MAX_MARKETS = 3;
/** Nationwide runs rank metros of at least this population (disclosed in the coverage notice). */
export const MIN_NATIONWIDE_POPULATION = 250_000;

/** Deterministic, government-evidence market selection. Weight changes reorder; hard screens never relax. */
export function selectMarkets(args: { criteria: ResearchCriteria; financing: ResearchFinancing; weights: ResearchWeights; snapshot?: MarketSnapshot }): { selected: SelectedMarket[]; universe: number; screenedOut: number; notice: string } {
  const snap = args.snapshot ?? loadSnapshot();
  const { criteria } = args;
  let universe = snap.metros;
  let notice = `Nationwide coverage is limited to U.S. Metropolitan Statistical Areas with at least ${MIN_NATIONWIDE_POPULATION.toLocaleString()} residents (2025 estimate) in the Census snapshot retrieved ${snap.retrievedAt.slice(0, 10)}; smaller metros, micropolitan and rural areas are not ranked nationwide (use state scope).`;
  if (criteria.scope === 'usa') universe = universe.filter((m) => (m.population2025 ?? 0) >= MIN_NATIONWIDE_POPULATION);
  if (criteria.scope === 'state') {
    universe = universe.filter((m) => criteria.state !== null && m.states.includes(criteria.state));
    notice = `State scope ${criteria.state}: metros touching ${criteria.state} (multi-state metros included; candidates must be in ${criteria.state}).`;
  } else if (criteria.scope === 'metro') {
    const q = (criteria.metro ?? '').toLowerCase().replace(/\bmetro(politan)?( area)?\b/g, '').trim();
    const [cityPart, statePart] = q.split(',').map((x) => x.trim());
    universe = universe.filter((m) => {
      const name = m.name.toLowerCase();
      const cityOk = cityPart.length > 1 && name.split(',')[0].split('-').some((c) => c.trim().startsWith(cityPart));
      const stOk = !statePart || m.states.some((s) => s.toLowerCase() === statePart);
      return cityOk && stOk;
    });
    notice = `Metro scope "${criteria.metro}" matched ${universe.length} Census metro area(s) by principal-city name.`;
  } else if (criteria.scope === 'zip') {
    universe = universe.filter((m) => criteria.zip !== null && Object.prototype.hasOwnProperty.call(m.zctas ?? {}, criteria.zip));
    notice = `ZIP scope ${criteria.zip}: market statistics shown are for the containing metro; candidates must be in ZIP ${criteria.zip}.`;
  } else if (criteria.scope === 'address') {
    return { selected: [], universe: 0, screenedOut: 0, notice: 'Address scope: market discovery does not run. Use "Look up official property tax" on each saved street address (Franklin County, OH only). Price, type, units and rent are never inferred from an address.' };
  }
  const all = universe.map((m) => toMarket(m, snap, criteria, args.financing, args.weights));
  const eligible = criteria.scope === 'zip' ? all : all.filter((s) => s.market.screening[0].outcome === 'pass');
  eligible.sort((a, b) => (b.market.score ?? -1) - (a.market.score ?? -1) || a.market.id.localeCompare(b.market.id));
  return { selected: eligible.slice(0, MAX_MARKETS), universe: universe.length, screenedOut: all.length - eligible.length, notice };
}

/**
 * Franklin County, OH (FIPS 39049) official tax adapter.
 * 1. Street-only geocode via the county's public ArcGIS locator (fixed official host).
 * 2. Point-in-parcel query on the county Parcel_Features FeatureServer -> PARCELID.
 * 3. Bill/value join against a server-side preprocessed index of Auditor "Outside User Files"
 *    (scripts/build_franklin_tax_index.py). Never downloads bulk files per request.
 * Contract and fixtures: tax-team research 2026-11-07 (CONTRACT.md).
 */
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { TaxRecord } from '../../../shared/tax';
import type { TaxLookupAdapter, TaxLookupInput } from '../registry';
import { signCandidate, type SignedCandidate } from '../confirm';
import { confirmedIdentity, parseAddressIdentity, validateParcelAddress, unitRefusal } from '../identity';

const GIS_HOST = 'https://gis.franklincountyohio.gov';
const GEOCODE = `${GIS_HOST}/hosting/rest/services/Locators/GIS_LBRS_Locator/GeocodeServer/findAddressCandidates`;
const PARCELS = `${GIS_HOST}/hosting/rest/services/ParcelFeatures/Parcel_Features/FeatureServer/0/query`;
const ADAPTER_ID = 'oh-franklin-auditor-ty2025';
const BILL_TAX_YEAR = 2025;
const FRESHNESS = 'Tax year 2025 basis (payable 2026). The TY2026 reappraisal and rates finalize in Dec 2026; the 2027 bill will likely differ.';

type N = number | null; // null = blank cell in the Auditor file (missing, never 0)
type Bill = [N, N, N, N, N, N, N, N, N]; // subtotal, nonBusiness, ownerOcc, homestead, net, SA, prior, penalty, total
type Row = [string, string, number, string, number, number, Bill | null, string?]; // ..., siteAddress "3785 - 3787 BRIGGS RD, COLUMBUS, OH 43228"
interface Index { builtAt: string; sources: { taxDetail: { url: string; asOf: string }; parcelValue: { url: string; asOf: string }; rates: string }; parcels: Record<string, Row> }

const indexes = new Map<string, Index | null>();
function loadIndex(path: string): Index | null {
  const hit = indexes.get(path);
  if (hit !== undefined) return hit;
  let idx: Index | null = null;
  if (existsSync(path)) {
    const raw: unknown = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
    if (typeof raw !== 'object' || raw === null || typeof (raw as { parcels?: unknown }).parcels !== 'object') throw new Error('Invalid Franklin index');
    idx = raw as Index; // shape produced by our own build script; individual rows are checked on use
  }
  indexes.set(path, idx);
  return idx;
}
export const resetFranklinIndexForTests = () => { indexes.clear(); };

/**
 * Positive street contract: the official Auditor site addresses in the packaged index define the set of
 * supported street identities (name words + suffix; directionals ignored). Unit/fraction/rear site lines do
 * not parse and contribute nothing. A requested street outside this set is refused BEFORE any GIS call.
 */
const streetSets = new WeakMap<Index, Set<string>>();
function officialStreets(idx: Index): Set<string> {
  let set = streetSets.get(idx);
  if (set) return set;
  set = new Set();
  for (const row of Object.values(idx.parcels)) {
    const line = typeof row[7] === 'string' ? row[7].split(',')[0] : '';
    const rest = line.replace(/^\d+[A-Z]?(?:\s*-\s*\d+[A-Z]?)?\s+/, '');
    const v = rest && rest !== line ? validateParcelAddress(`1 ${rest}`) : null;
    if (v?.ok) set.add(v.nameKey);
  }
  streetSets.set(idx, set);
  return set;
}
const notOfficialStreet = (street: string) => `Street "${street}" is not a street in the official Franklin County Auditor site-address index; no county lookup was made (unrecognized words are never dropped). Check the street name, or enter tax manually.`;

/** Street line only (the locator returns no candidates for full lines with city/state/ZIP). Delegates to the identity owner. */
export const streetOnly = (address: string): string | null => parseAddressIdentity(address).street;

const SUFFIX: Record<string, string> = { STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', DRIVE: 'DR', COURT: 'CT', LANE: 'LN', BOULEVARD: 'BLVD', PLACE: 'PL', CIRCLE: 'CIR', PARKWAY: 'PKWY', TERRACE: 'TER', HIGHWAY: 'HWY', TRAIL: 'TRL', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };
const norm = (s: string) => s.toUpperCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] ?? w).join(' ');

/** "123 MAIN ST" -> { num: 123, name: "MAIN ST" } */
export function splitStreet(street: string): { num: number; name: string } | null {
  const m = /^(\d+)[A-Z]?\s+(.+)$/.exec(norm(street));
  return m ? { num: Number(m[1]), name: m[2] } : null;
}

/** True when the address carries unit evidence anywhere (see server/tax/identity.ts). */
export const hasUnit = (address: string) => parseAddressIdentity(address).unit !== null;

/**
 * Auditor SiteAddress ("3785 - 3787 BRIGGS RD, COLUMBUS, OH 43228") must contain the requested house number
 * and exactly the same street name, and its ZIP must equal the requested ZIP when both are known.
 */
export function siteMatches(site: string, street: string, zip: string | null, opts: { ignoreDirectional?: boolean } = {}): { ok: true; directionalDiffers: boolean } | { ok: false; why: string } {
  const want = splitStreet(street);
  const [line] = site.split(',');
  const m = /^(\d+)[A-Z]?(?:\s*-\s*(\d+)[A-Z]?)?\s+(.+)$/.exec(norm(line ?? ''));
  if (!want || !m) return { ok: false, why: `county site address "${site}" could not be compared` };
  const lo = Number(m[1]), hi = m[2] ? Number(m[2]) : lo;
  const strip = (n: string) => n.replace(/^(N|S|E|W|NE|NW|SE|SW) /, '');
  const sameName = norm(m[3]) === want.name;
  if (!sameName && !(opts.ignoreDirectional && strip(norm(m[3])) === strip(want.name))) return { ok: false, why: `county site street "${m[3]}" ≠ requested "${want.name}"` };
  if (want.num < lo || want.num > hi || (hi > lo && (want.num - lo) % 2 !== 0)) return { ok: false, why: `house number ${want.num} not within county site "${line.trim()}"` };
  const siteZip = /\b(\d{5})\s*$/.exec(site)?.[1] ?? null;
  if (zip && siteZip && zip !== siteZip) return { ok: false, why: `county site ZIP ${siteZip} ≠ requested ZIP ${zip}` };
  return { ok: true, directionalDiffers: !sameName };
}

const unknown = (reason: Extract<TaxRecord, { kind: 'unknown' }>['reason'], detail: string): TaxRecord => ({ kind: 'unknown', reason, detail, attemptedAdapterId: ADAPTER_ID });

async function getJson(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetchImpl(url, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 200_000) throw new Error('Response too large');
  return JSON.parse(text);
}

export function franklinCountyAdapter(opts: { fetchImpl?: typeof fetch; indexPath?: string; now?: () => Date } = {}): TaxLookupAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const indexPath = opts.indexPath ?? new URL('../../data/tax/oh-franklin-ty2025.json.gz', import.meta.url).pathname;
  return {
    id: ADAPTER_ID,
    countyFips: '39049',
    description: 'Franklin County Auditor (Columbus, OH): residential 1–3 family, condo and 4-unit parcels, TY2025 bills',
    async lookup(input: TaxLookupInput, signal: AbortSignal): Promise<TaxRecord> {
      if (input.state !== 'OH') return unknown('county-not-covered', 'Only Franklin County, OH is covered.');
      // Identity first, on the WHOLE input, before anything is split or sent to the county.
      if (!input.address) return unknown('insufficient-address', 'Street address missing.');
      const id = validateParcelAddress(input.address);
      if (!id.ok) return unknown('ambiguous-parcel', unitRefusal(id.why));
      if (id.zip && id.zip !== input.zip) return unknown('ambiguous-parcel', `Address ZIP ${id.zip} differs from ZIP ${input.zip}; no parcel lookup attempted.`);
      const street = id.street;
      const idx = loadIndex(indexPath);
      if (!idx) return unknown('lookup-failed', 'Franklin County tax index is not deployed on this server.');
      if (!officialStreets(idx).has(id.nameKey)) return unknown('no-parcel-match', notOfficialStreet(street));
      const retrievedAt = (opts.now?.() ?? new Date()).toISOString();

      const geoUrl = `${GEOCODE}?${new URLSearchParams({ SingleLine: street, outFields: 'Match_addr', maxLocations: '3', f: 'json' })}`;
      const geo = await getJson(fetchImpl, geoUrl, signal);
      const cands = Array.isArray((geo as { candidates?: unknown }).candidates) ? ((geo as { candidates: unknown[] }).candidates) : [];
      const valid = cands.flatMap((c) => {
        const o = c as { address?: unknown; score?: unknown; location?: { x?: unknown; y?: unknown } };
        return typeof o.address === 'string' && typeof o.score === 'number' && typeof o.location?.x === 'number' && typeof o.location?.y === 'number'
          ? [{ address: o.address, score: o.score, x: o.location.x, y: o.location.y }] : [];
      });
      if (valid.length === 0) return unknown('no-parcel-match', `No Franklin County address match for "${street}" (address may be outside the county).`);
      // Contract: exactly one score-100 candidate whose normalized street equals the request; anything else needs explicit confirmation.
      const sameStreet = (a: string) => norm(a) === norm(street);
      if (valid.length !== 1 || valid[0].score !== 100 || !sameStreet(valid[0].address)) {
        // A candidate that itself carries unit evidence is never offered for confirmation.
        // The token carries the ORIGINAL request; confirmation re-validates it (never the normalized query alone).
        const candidates = valid.filter((c) => { const v = validateParcelAddress(c.address); return v.ok && v.key === id.key; }).slice(0, 3).map((c) => ({ token: signCandidate({ adapterId: ADAPTER_ID, address: c.address, score: c.score, x: c.x, y: c.y, query: street, original: id.original, zip: input.zip }), address: c.address, score: c.score }));
        return { ...unknown('ambiguous-parcel', `Address needs confirmation: county locator returned ${valid.length} candidate(s) for "${street}", best "${valid[0].address}" (score ${valid[0].score.toFixed(1)}). No tax figures shown until you confirm one.`), candidates } as TaxRecord;
      }
      return resolveAt({ address: valid[0].address, x: valid[0].x, y: valid[0].y }, input.zip, 'exact-address', signal, idx, retrievedAt);
    },
    async lookupConfirmed(c: SignedCandidate, signal: AbortSignal): Promise<TaxRecord> {
      if (c.adapterId !== ADAPTER_ID) return unknown('lookup-failed', 'Confirmation token is for a different adapter.');
      const bad = confirmedIdentity(c);
      if (bad) return unknown('ambiguous-parcel', unitRefusal(bad));
      const idx = loadIndex(indexPath);
      if (!idx) return unknown('lookup-failed', 'Franklin County tax index is not deployed on this server.');
      const o = validateParcelAddress(c.original);
      if (!o.ok || !officialStreets(idx).has(o.nameKey)) return unknown('no-parcel-match', notOfficialStreet(c.query));
      return resolveAt({ address: c.address, x: c.x, y: c.y }, c.zip, 'user-confirmed-candidate', signal, idx, (opts.now?.() ?? new Date()).toISOString());
    },
  };

  async function resolveAt(hit: { address: string; x: number; y: number }, zip: string | null, parcelMatch: 'exact-address' | 'user-confirmed-candidate', signal: AbortSignal, idx: Index, retrievedAt: string): Promise<TaxRecord> {
      const pUrl = `${PARCELS}?${new URLSearchParams({ geometry: `${hit.x},${hit.y}`, geometryType: 'esriGeometryPoint', inSR: '3735', spatialRel: 'esriSpatialRelIntersects', outFields: 'PARCELID,SITEADDRESS,ZIPCD,UNIT,CLASSCD,CAUV', returnGeometry: 'false', f: 'json' })}`;
      const pq = await getJson(fetchImpl, pUrl, signal);
      const feats = Array.isArray((pq as { features?: unknown }).features) ? (pq as { features: unknown[] }).features : [];
      type Attr = { PARCELID?: unknown; SITEADDRESS?: unknown; ZIPCD?: unknown; UNIT?: unknown };
      const attrs = feats.map((f) => (f as { attributes?: Attr }).attributes ?? {}).filter((a): a is Attr & { PARCELID: string } => typeof a.PARCELID === 'string' && /^\d{3}-\d{6}$/.test(a.PARCELID));
      if (attrs.length !== 1) return unknown(attrs.length ? 'ambiguous-parcel' : 'no-parcel-match', attrs.length ? `Point intersects ${attrs.length} parcels; no figures shown.` : 'No parcel at matched location.');
      const gis = attrs[0];
      if (typeof gis.UNIT === 'string' && gis.UNIT.trim()) return unknown('ambiguous-parcel', `Parcel ${gis.PARCELID} is a unit (${gis.UNIT.trim()}); unit-level identity is not verified, so no figures are shown.`);
      const gisZip = typeof gis.ZIPCD === 'string' || typeof gis.ZIPCD === 'number' ? String(gis.ZIPCD).slice(0, 5) : null;
      if (zip && gisZip && /^\d{5}$/.test(gisZip) && gisZip !== zip) return unknown('ambiguous-parcel', `County parcel ZIP ${gisZip} ≠ requested ZIP ${zip}; possibly a different property. No figures shown.`);
      if (typeof gis.SITEADDRESS === 'string') {
        const m = siteMatches(gis.SITEADDRESS, hit.address, null, { ignoreDirectional: parcelMatch === 'user-confirmed-candidate' });
        if (!m.ok) return unknown('ambiguous-parcel', `Parcel identity mismatch: ${m.why}. No figures shown.`);
      }
      const parcelId = `${gis.PARCELID}-00`;
      const row = idx.parcels[parcelId];
      if (!row) return unknown('no-parcel-match', `Parcel ${parcelId} is outside indexed residential classes or has no record; tax unknown (not $0).`);
      const [luc, district, parcelTaxYear, flags, marketValue, assessedValue, bill, site] = row;
      if (typeof site !== 'string' || !site) return unknown('lookup-failed', `Parcel ${parcelId} has no Auditor site address in the index; identity cannot be confirmed.`);
      const warnings0: string[] = [];
      const sm = siteMatches(site, hit.address, zip, { ignoreDirectional: parcelMatch === 'user-confirmed-candidate' });
      if (!sm.ok) return unknown('ambiguous-parcel', `Parcel identity mismatch vs Auditor record: ${sm.why}. No figures shown.`);
      if (sm.directionalDiffers) warnings0.push(`Street directional differs between the county locator ("${hit.address}") and Auditor record ("${site}"); you confirmed it is the same property.`);
      if (!bill) return unknown('no-parcel-match', `Parcel ${parcelId} has no TaxDetail bill row (e.g. exempt); tax unknown, not $0. Exemptions do not transfer automatically.`);
      const [subtotal, nonBusiness, ownerOcc, homestead, net, saRaw, prior, penalty] = bill;
      if (net === null || subtotal === null) return unknown('lookup-failed', `Parcel ${parcelId} bill row has blank net/subtotal cells; tax unknown (not $0).`);
      const cauv = flags.includes('C');
      const exempt = flags.includes('E');
      const warnings = [FRESHNESS, ...warnings0];
      // New-owner estimate: seller net minus seller-only credits. Withheld whenever any input is missing or the result is not a positive recurring bill.
      let buyer: number | null = null;
      let withheld: string | null = null;
      if (cauv) withheld = 'CAUV agricultural valuation: buyer estimate withheld (recoupment and value change if use changes).';
      else if (exempt) withheld = 'Auditor marks this parcel with an exemption status; exemptions/abatements are not verified to transfer, so no new-owner estimate is given.';
      else if (ownerOcc === null || homestead === null) withheld = 'Seller-credit cells are blank in the Auditor file; new-owner estimate withheld.';
      else if (net <= 0) withheld = `Current net bill is $${net.toFixed(2)} (likely exemption/abatement); new-owner tax is unknown, not $0.`;
      else buyer = Math.round((net - ownerOcc - homestead) * 100) / 100;
      if (withheld) warnings.push(withheld);
      const sa = saRaw === null ? null : saRaw;
      if (sa === null) warnings.push('Special-assessment cell blank in source: unknown.');
      else if (sa < 0) warnings.push(`Special assessments show a credit of $${sa.toFixed(2)}; credits are not assumed to continue and are not subtracted from recurring tax.`);
      else if (sa > 0) warnings.push(`Special assessments $${sa.toFixed(2)}/yr shown separately; continuation for a buyer is not verified (included conservatively as a cost).`);
      if ((prior ?? 0) || (penalty ?? 0)) warnings.push(`Current invoice includes prior/penalty amounts ($${((prior ?? 0) + (penalty ?? 0)).toFixed(2)}) excluded from the recurring bill.`);
      if (parcelTaxYear !== BILL_TAX_YEAR) warnings.push(`Parcel record year ${parcelTaxYear}; bill amounts are TY${BILL_TAX_YEAR}.`);
      const docUrl = idx.sources.taxDetail.url;
      return {
        kind: 'official-record',
        adapterId: ADAPTER_ID,
        jurisdiction: { state: 'OH', county: 'Franklin' },
        parcelId,
        taxYear: BILL_TAX_YEAR,
        sellerBillAnnual: net,
        exemptions: [
          { name: 'Non-business credit (property-level)', annualAmount: nonBusiness, transfersToBuyer: true },
          { name: 'Owner-occupancy credit (seller only)', annualAmount: ownerOcc, transfersToBuyer: false },
          { name: 'Homestead reduction (seller only)', annualAmount: homestead, transfersToBuyer: false },
        ].filter((e): e is { name: string; annualAmount: number; transfersToBuyer: boolean } => e.annualAmount !== null && e.annualAmount !== 0),
        buyerEstimateAnnual: buyer,
        buyerEstimateMethod: buyer === null ? null : `Seller net bill minus seller-only owner-occupancy and homestead credits (gross $${subtotal.toFixed(2)} − property-level credits)`,
        specialAssessmentsAnnual: sa,
        assessedValue,
        marketValue,
        document: { url: docUrl, title: 'Franklin County Auditor Tax Accounting Outside User File (TaxDetail.txt)', publisher: 'Franklin County Auditor', retrievedAt },
        provenance: [
          { field: 'bill (AnnualNet, credits, AnnualSA)', url: docUrl, asOf: idx.sources.taxDetail.asOf },
          { field: 'market/assessed value, LUC ' + luc + ', district ' + district, url: idx.sources.parcelValue.url, asOf: idx.sources.parcelValue.asOf },
          { field: 'address match', url: GEOCODE, asOf: retrievedAt },
          { field: 'parcel match', url: PARCELS, asOf: retrievedAt },
        ],
        parcelMatch,
        matchedAddress: `${hit.address} (Auditor: ${site})`,
        confidence: buyer === null ? 'low' : 'high',
        warnings: parcelMatch === 'user-confirmed-candidate' ? [`You confirmed county address "${hit.address}" for this lookup.`, ...warnings] : warnings,
      };
  }
}

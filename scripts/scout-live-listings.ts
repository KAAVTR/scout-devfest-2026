/**
 * Separate from the sample-baseline explanation.
 * Columbus permits and Census vintage 2025 can be public GETs. RentCast is not called.
 * Nothing here is sent to ranking as a verified rent, tax, or unit count.
 */
import { CENSUS_TTL_MS, EMPTY_PERMIT_TTL_MS, PERMIT_TTL_MS, createMemoryAreaCache, readThrough, type AreaCache, type Freshness } from './scout-area-cache.ts';
export const COLUMBUS_PERMITS_URL = 'https://gis.columbus.gov/arcgis/rest/services/Schemas/BuildingZoning/MapServer/5/query';
export const CENSUS_VINTAGE_2025_URL = 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv';
export const RENTCAST_SALE_URL = 'https://api.rentcast.io/v1/listings/sale';
export const FRANKLIN_OH_FIPS = '39049';
export const CENSUS_VINTAGE = 'co-est2025';
export const CENSUS_YEARS = [2020, 2021, 2022, 2023, 2024, 2025] as const;

const NOT_POSITIVE = /fire|mechanical|electrical|plumbing|mep|demolition|hvac/i;

export type LiveLocation = { kind: 'zip'; zip: string } | { kind: 'city-state'; city: string; state: string };

export interface PermitSignal {
  source: 'columbus-permits';
  permitId: string;
  permitType: string;
  permitSubtype: string;
  address: string;
  zip: string;
  permitStatus: string;
  issuedOn: string;
  sourceUrl: string | null;
  unitsReported: number | null;
  permitValue: number | null;
  growthClass: 'raw-activity' | 'not-positive';
  newConstruction: false;
  unitsVerifiedForRanking: false;
  priceGuarantee: false;
  scope: 'city-of-columbus';
}

export interface PopulationPoint {
  year: number;
  estimate: number;
}

export interface PopulationSeries {
  source: 'census-popest';
  vintage: typeof CENSUS_VINTAGE;
  sourceUrl: string;
  scope: 'Franklin County, Ohio';
  fips: typeof FRANKLIN_OH_FIPS;
  sumlev: '050';
  years: PopulationPoint[];
  neighborhoodForecast: false;
  priceGuarantee: false;
}

export type LiveListingsResult = {
  httpStatus: number;
  body: Record<string, unknown>;
};

export function columbusPermitQuery(location: LiveLocation): string | null {
  const params = new URLSearchParams({
    outFields: 'B1_ALT_ID,B1_PER_TYPE,B1_PER_SUB_TYPE,SITE_ADDRESS,B1_SITUS_ZIP,PERMIT_STATUS,ISSUED_DT,UNITS,G3_VALUE_TTL,ACA_URL',
    orderByFields: 'ISSUED_DT DESC',
    returnGeometry: 'false',
    resultRecordCount: '15',
    f: 'json',
  });
  if (location.kind === 'zip') {
    if (!/^\d{5}$/.test(location.zip)) return null;
    params.set('where', `B1_SITUS_ZIP='${location.zip}'`);
  } else if (location.city.toLowerCase() === 'columbus' && location.state === 'OH') {
    params.set('where', '1=1');
  } else {
    return null;
  }
  return `${COLUMBUS_PERMITS_URL}?${params.toString()}`;
}

export function parseColumbusPermits(payload: unknown, fetchedAt: string): { partial: boolean; signals: PermitSignal[] } | { error: string } {
  if (!payload || typeof payload !== 'object') return { error: 'Columbus permit response was not an object.' };
  const record = payload as { features?: unknown; exceededTransferLimit?: unknown; error?: unknown };
  if (record.error) return { error: 'Columbus permit service returned an error.' };
  if (!Array.isArray(record.features)) return { error: 'Columbus permit response had no feature list.' };
  const signals: PermitSignal[] = [];
  for (const feature of record.features) {
    const attributes = feature && typeof feature === 'object' ? (feature as { attributes?: unknown }).attributes : null;
    if (!attributes || typeof attributes !== 'object') continue;
    const row = attributes as Record<string, unknown>;
    const permitId = typeof row.B1_ALT_ID === 'string' ? row.B1_ALT_ID.trim() : '';
    const permitType = typeof row.B1_PER_TYPE === 'string' ? row.B1_PER_TYPE.trim() : '';
    const permitSubtype = typeof row.B1_PER_SUB_TYPE === 'string' ? row.B1_PER_SUB_TYPE.trim() : '';
    const address = typeof row.SITE_ADDRESS === 'string' ? row.SITE_ADDRESS.trim() : '';
    const zip = typeof row.B1_SITUS_ZIP === 'string' ? row.B1_SITUS_ZIP.trim() : '';
    const permitStatus = typeof row.PERMIT_STATUS === 'string' ? row.PERMIT_STATUS.trim() : '';
    if (!permitId || !permitType || !address || !/^\d{5}$/.test(zip) || typeof row.ISSUED_DT !== 'number' || !Number.isFinite(row.ISSUED_DT)) continue;
    const issued = new Date(row.ISSUED_DT);
    if (Number.isNaN(issued.getTime())) continue;
    const aca = typeof row.ACA_URL === 'string' && row.ACA_URL.startsWith('https://ca.columbus.gov/') ? row.ACA_URL : null;
    const unitsReported = boundedCount(row.UNITS, 10_000);
    const permitValue = boundedAmount(row.G3_VALUE_TTL);
    const text = `${permitType} ${permitSubtype}`;
    signals.push({
      source: 'columbus-permits',
      permitId,
      permitType,
      permitSubtype,
      address,
      zip: zip.slice(0, 5),
      permitStatus,
      issuedOn: issued.toISOString().slice(0, 10),
      sourceUrl: aca,
      unitsReported,
      permitValue,
      growthClass: NOT_POSITIVE.test(text) ? 'not-positive' : 'raw-activity',
      newConstruction: false,
      unitsVerifiedForRanking: false,
      priceGuarantee: false,
      scope: 'city-of-columbus',
    });
  }
  return { partial: record.exceededTransferLimit === true || signals.length === 0, signals };
}

export function parseCensusVintage2025(csvText: string): PopulationSeries | { error: string } {
  const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return { error: 'Census file had no data row.' };
  const header = splitCsv(lines[0]);
  const needed = ['SUMLEV', 'STATE', 'COUNTY', 'STNAME', 'CTYNAME', ...CENSUS_YEARS.map((year) => `POPESTIMATE${year}`)];
  if (needed.some((name) => !header.includes(name))) return { error: 'Census file is not vintage co-est2025 county totals.' };
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']));
    if (row.SUMLEV !== '050' || row.STATE !== '39' || row.COUNTY !== '049') continue;
    if (row.STNAME !== 'Ohio' || row.CTYNAME !== 'Franklin County') return { error: 'Franklin FIPS 39049 did not match Ohio Franklin County.' };
    const years: PopulationPoint[] = [];
    for (const year of CENSUS_YEARS) {
      const estimate = censusEstimate(row[`POPESTIMATE${year}`] ?? '');
      if (estimate === null) return { error: 'Census estimate was blank or outside the supported range.' };
      years.push({ year, estimate });
    }
    return {
      source: 'census-popest',
      vintage: CENSUS_VINTAGE,
      sourceUrl: CENSUS_VINTAGE_2025_URL,
      scope: 'Franklin County, Ohio',
      fips: FRANKLIN_OH_FIPS,
      sumlev: '050',
      years,
      neighborhoodForecast: false,
      priceGuarantee: false,
    };
  }
  return { error: 'Franklin County was not in this Census vintage.' };
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

export function locationKeyOf(location: LiveLocation): string {
  if (location.kind === 'zip') return `zip:${location.zip}`;
  return `city:${location.city.toLowerCase()}|${location.state.toLowerCase()}`;
}

export function rentCastSaleQuery(location: LiveLocation): { url: string; sent: false; status: 'off'; listings: []; reason: string } {
  const params = new URLSearchParams({ status: 'Active', propertyType: 'Multi-Family' });
  if (location.kind === 'zip') params.set('zipCode', location.zip);
  else {
    params.set('city', location.city);
    params.set('state', location.state);
  }
  return {
    url: `${RENTCAST_SALE_URL}?${params.toString()}`,
    sent: false,
    status: 'off',
    listings: [],
    reason: 'RentCast listings are unavailable. The account has no subscribed API plan. Activating the Developer plan shows a card field, so the parent stopped. No key was issued and this process does not call RentCast. Multi-Family would not prove a unit count, and no listing page URL is invented.',
  };
}

export interface LiveListingsFetcher {
  (url: string, init?: { signal?: AbortSignal }): Promise<{ status: number; body: string; contentType: string | null }>;
}

export const PUBLIC_FETCH_DEADLINE_MS = 8_000;
export const PERMIT_BYTE_CAP = 1_000_000;
export const CENSUS_BYTE_CAP = 3_000_000;
export const LIVE_SOURCE_INFLIGHT = 4;
export const LIVE_ROUTE_LIMIT = 6;
export const LIVE_ROUTE_WINDOW_MS = 10 * 60 * 1000;

const routeHits = new Map<string, number[]>();
let sourceLoads = 0;

/** Six live-listing attempts per browser per 10 minutes, including failures. */
export function takeLiveRoute(clientToken: string, now: number): number | null {
  const recent = (routeHits.get(clientToken) ?? []).filter((stamp) => now - stamp < LIVE_ROUTE_WINDOW_MS);
  if (recent.length >= LIVE_ROUTE_LIMIT) {
    routeHits.set(clientToken, recent);
    return Math.max(1, Math.ceil((LIVE_ROUTE_WINDOW_MS - (now - recent[0])) / 1000));
  }
  recent.push(now);
  routeHits.set(clientToken, recent);
  return null;
}

/** Process-wide cap on source loads that have not finished. Cache hits do not call this. */
export function tryAcquireSourceLoad(): (() => void) | null {
  if (sourceLoads >= LIVE_SOURCE_INFLIGHT) return null;
  sourceLoads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sourceLoads -= 1;
  };
}

function censusEstimate(cell: string): number | null {
  if (!/^\d{1,8}$/.test(cell)) return null;
  const value = Number(cell);
  if (!Number.isSafeInteger(value) || value < 0 || value > 99_999_999) return null;
  return value;
}

function boundedCount(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return null;
  return value;
}

function boundedAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) return null;
  return value;
}

export function allowedPublicGet(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    if (parsed.hostname === 'gis.columbus.gov') return parsed.pathname === '/arcgis/rest/services/Schemas/BuildingZoning/MapServer/5/query';
    if (parsed.hostname === 'www2.census.gov') return parsed.pathname === '/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv';
    return false;
  } catch {
    return false;
  }
}

export async function fetchAllowlisted(url: string, options?: { signal?: AbortSignal }): Promise<{ status: number; body: string; contentType: string | null }> {
  if (!allowedPublicGet(url)) return { status: 0, body: '', contentType: null };
  const deadline = AbortSignal.timeout(PUBLIC_FETCH_DEADLINE_MS);
  const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'manual', signal });
  } catch {
    return { status: 0, body: '', contentType: null };
  }
  const contentType = response.headers.get('content-type');
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { status: response.status, body: '', contentType };
  }
  const cap = new URL(url).hostname === 'www2.census.gov' ? CENSUS_BYTE_CAP : PERMIT_BYTE_CAP;
  if (!response.body) return { status: response.status, body: '', contentType };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), aborted(signal)]);
      if (step.done) break;
      total += step.value.byteLength;
      if (total > cap) {
        overflow = true;
        break;
      }
      chunks.push(Buffer.from(step.value));
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { status: 0, body: '', contentType };
  } finally {
    if (overflow) await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* cancel already released a native reader */ }
  }
  if (overflow) return { status: 413, body: '', contentType };
  const encoding = new URL(url).hostname === 'www2.census.gov' ? 'latin1' : 'utf8';
  return { status: response.status, body: Buffer.concat(chunks).toString(encoding), contentType };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

export async function handleLiveListings(args: {
  body: unknown;
  fetcher?: LiveListingsFetcher;
  fetchedAt?: string;
  nowMs?: number;
  signal?: AbortSignal;
  censusText?: string;
  cache?: AreaCache;
  cacheStore?: 'memory' | 'file';
  cacheWarning?: string | null;
}): Promise<LiveListingsResult> {
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'Live research input must be a JSON object.' } };
  }
  const record = args.body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === 'location' || key === 'focus')) {
    return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'Only a location and a focus are accepted. Financial fields are not sent.' } };
  }
  if (record.focus !== 'listings' && record.focus !== 'growth') {
    return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'Focus must be listings or growth.' } };
  }
  const location = parseLocation(record.location);
  if (!location) return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'Send a 5-digit ZIP or a city with a two-letter state.' } };
  const query = columbusPermitQuery(location);
  const rentcast = rentCastSaleQuery(location);
  if (!query) {
    return {
      httpStatus: 200,
      body: {
        status: 'unavailable',
        focus: record.focus,
        location,
        permits: [],
        population: null,
        listings: [],
        rentcast,
        message: 'The connected permit source covers the City of Columbus only. No sample figures were substituted.',
        financeUntouched: true,
      },
    };
  }
  const nowMs = args.nowMs ?? (args.fetchedAt ? Date.parse(args.fetchedAt) : Date.now());
  if (!Number.isFinite(nowMs)) return { httpStatus: 400, body: { status: 'error', financeUntouched: true, message: 'The observation time was not usable.' } };
  if (!args.fetcher && !args.censusText && !args.cache) {
    return {
      httpStatus: 200,
      body: baseBody(record.focus, location, rentcast, 'unavailable', 'missing', false, 'Live sources are not enabled in this process. No sample figures were substituted. RentCast listings are unavailable.'),
    };
  }
  const cache = args.cache ?? createMemoryAreaCache();
  const key = locationKeyOf(location);
  const permitsRead = await readThrough(cache, {
    source: 'columbus-permits',
    locationKey: key,
    sourceUrl: query,
    nowMs,
    ttlMs: PERMIT_TTL_MS,
    load: async () => {
      if (!args.fetcher) return { error: 'sources-off' };
      if (!allowedPublicGet(query)) return { error: 'permit-url-blocked' };
      const release = tryAcquireSourceLoad();
      if (!release) return { error: 'admission' };
      try {
        const response = await args.fetcher(query, { signal: args.signal });
        return { status: response.status, body: response.body };
      } finally {
        release();
      }
    },
    accept: (body) => {
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return { error: 'Columbus permit response was not JSON.' }; }
      const parsed = parseColumbusPermits(payload, new Date(nowMs).toISOString());
      if ('error' in parsed) return parsed;
      const requestedZip = location.kind === 'zip' ? location.zip : null;
      const signals = requestedZip ? parsed.signals.filter((signal) => signal.zip === requestedZip) : parsed.signals;
      const newest = signals.map((signal) => signal.issuedOn).sort().at(-1) ?? null;
      return {
        payload: signals.map(ownedPermit),
        partial: parsed.partial || signals.length !== parsed.signals.length || signals.length === 0,
        asOf: newest,
        asOfPrecision: newest ? 'day' : 'none',
        vintage: 'columbus-building-zoning-mapserver-5',
        ttlMs: signals.length === 0 ? EMPTY_PERMIT_TTL_MS : PERMIT_TTL_MS,
      };
    },
  });
  const columbus = location.kind === 'city-state' && location.city.toLowerCase() === 'columbus' && location.state === 'OH';
  const populationRead = columbus && (args.censusText || args.fetcher)
    ? await readThrough(cache, {
      source: 'census-popest',
      locationKey: 'fips:39049',
      sourceUrl: CENSUS_VINTAGE_2025_URL,
      nowMs,
      ttlMs: CENSUS_TTL_MS,
      load: async () => {
        if (args.censusText) return { status: 200, body: args.censusText };
        if (!args.fetcher) return { error: 'sources-off' };
        const release = tryAcquireSourceLoad();
        if (!release) return { error: 'admission' };
        try {
          const response = await args.fetcher(CENSUS_VINTAGE_2025_URL, { signal: args.signal });
          return { status: response.status, body: response.body };
        } finally {
          release();
        }
      },
      accept: (body) => {
        const parsed = parseCensusVintage2025(body);
        if ('error' in parsed) return parsed;
        return { payload: parsed, partial: false, asOf: '2025', asOfPrecision: 'year', vintage: CENSUS_VINTAGE };
      },
    })
    : null;
  const reads = [permitsRead, populationRead].filter((item): item is NonNullable<typeof populationRead> => item !== null);
  if ((permitsRead.error === 'admission' && !permitsRead.entry) || (populationRead?.error === 'admission' && !populationRead.entry && !permitsRead.entry)) {
    return {
      httpStatus: 429,
      body: {
        status: 'error',
        financeUntouched: true,
        failure: { kind: 'admission', message: 'Too many area-source reads are already in progress. No additional source call was started.', retryAfterSeconds: 1 },
      },
    };
  }
  const present = reads.filter((item) => item.entry);
  if (present.length === 0) {
    return {
      httpStatus: 200,
      body: baseBody(record.focus, location, rentcast, 'unavailable', 'missing', false, permitsRead.error ?? 'The free sources did not return evidence. No sample figures were substituted. RentCast listings are unavailable.'),
    };
  }
  const freshness = combinedFreshness(present.map((item) => item.freshness));
  const requestedZip = location.kind === 'zip' ? location.zip : null;
  const permitSignals = permitsRead.entry?.source === 'columbus-permits' && Array.isArray(permitsRead.entry.payload)
    ? permitsRead.entry.payload.filter((row) => ownedPermitRecord(row, requestedZip)).map((row) => ownedPermit(row as PermitSignal))
    : [];
  const population = populationRead?.entry?.source === 'census-popest' ? populationRead.entry.payload as PopulationSeries : null;
  const partial = present.some((item) => item.entry?.partial) || (columbus && !population);
  const liveFetch = present.some((item) => item.freshness === 'live');
  const status = freshness === 'stale' ? 'stale' : freshness === 'mixed' || partial ? 'partial' : freshness === 'cached' ? 'cached' : 'live';
  const sources = present.flatMap((item) => item.entry ? [{
    source: item.entry.source,
    sourceUrl: item.entry.sourceUrl,
    observedAt: item.entry.observedAt,
    asOf: item.entry.asOf,
    asOfPrecision: item.entry.asOfPrecision,
    vintage: item.entry.vintage,
    expiresAt: item.entry.expiresAt,
    freshness: item.freshness,
    partial: item.entry.partial,
  }] : []);
  return {
    httpStatus: 200,
    body: {
      ...baseBody(record.focus, location, rentcast, status, freshness, liveFetch, evidenceMessage(freshness, columbus)),
      locationKey: key,
      observedAt: sources.map((source) => source.observedAt).sort().at(-1) ?? null,
      asOf: sources.find((source) => source.asOf)?.asOf ?? null,
      vintage: [...new Set(sources.map((source) => source.vintage))].join(','),
      expiresAt: sources.map((source) => source.expiresAt).sort()[0] ?? null,
      sourceUrls: sources.map((source) => source.sourceUrl),
      sources,
      permits: permitSignals,
      population,
      cacheStore: args.cacheStore ?? 'memory',
      ...(args.cacheWarning ? { cacheWarning: args.cacheWarning } : {}),
    },
  };
}

function ownedPermitRecord(row: unknown, zip: string | null): boolean {
  if (!row || typeof row !== 'object') return false;
  const record = row as Record<string, unknown>;
  if (record.newConstruction !== false || record.unitsVerifiedForRanking !== false || record.priceGuarantee !== false) return false;
  if (typeof record.zip !== 'string' || (zip !== null && record.zip !== zip)) return false;
  return true;
}

function ownedPermit(signal: PermitSignal): PermitSignal {
  return { ...signal, newConstruction: false, unitsVerifiedForRanking: false, priceGuarantee: false };
}

function baseBody(focus: unknown, location: LiveLocation, rentcast: ReturnType<typeof rentCastSaleQuery>, status: string, freshness: Freshness | 'mixed', liveFetch: boolean, message: string): Record<string, unknown> {
  return { status, focus, location, freshness, liveFetch, permits: [], population: null, listings: [], rentcast, financeUntouched: true, message };
}

function combinedFreshness(values: Freshness[]): Freshness | 'mixed' {
  const kinds = new Set(values.filter((value) => value !== 'missing'));
  if (kinds.size === 0) return 'missing';
  if (kinds.size === 1) return [...kinds][0];
  return 'mixed';
}

function evidenceMessage(freshness: Freshness | 'mixed', columbus: boolean): string {
  const stored = freshness === 'cached'
    ? 'Stored area evidence. This response did not call the source again.'
    : freshness === 'stale'
      ? 'Stored area evidence was kept after a refresh failed. This is not a new fetch.'
      : freshness === 'mixed'
        ? 'Part of this response was fetched now and part was already stored. Stored rows are not a new fetch.'
        : 'Fetched now.';
  const county = columbus
    ? ' Population is the Census co-est2025 Franklin County series, not a neighborhood forecast.'
    : ' County population is not inferred from a ZIP.';
  return `${stored} Permit rows are city activity, not new-home counts.${county} RentCast listings are unavailable.`;
}

function parseLocation(raw: unknown): LiveLocation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind === 'zip' && typeof record.zip === 'string' && /^\d{5}$/.test(record.zip)) return { kind: 'zip', zip: record.zip };
  if (record.kind === 'city-state' && typeof record.city === 'string' && typeof record.state === 'string') {
    const city = record.city.trim().replace(/\s+/g, ' ');
    const state = record.state.trim().toUpperCase();
    if (city.length < 2 || city.length > 40 || !/^[A-Za-z][A-Za-z .'-]*$/.test(city) || !/^[A-Z]{2}$/.test(state)) return null;
    return { kind: 'city-state', city, state };
  }
  return null;
}

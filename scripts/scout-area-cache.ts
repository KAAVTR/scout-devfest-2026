/**
 * Local area-evidence cache. A fresh hit is a stored fetch, not a new request.
 * An expired row is returned only after one refresh fails, and it is labeled stale.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const PERMIT_TTL_MS = 6 * 60 * 60 * 1000;
export const EMPTY_PERMIT_TTL_MS = 15 * 60 * 1000;
export const CENSUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type EvidenceSource = 'columbus-permits' | 'census-popest';
export type Freshness = 'live' | 'cached' | 'stale' | 'missing';

export interface AreaCacheEntry {
  v: 1;
  locationKey: string;
  source: EvidenceSource;
  sourceUrl: string;
  observedAt: string;
  asOf: string | null;
  asOfPrecision: 'day' | 'year' | 'none';
  vintage: string;
  expiresAt: string;
  partial: boolean;
  payload: unknown;
}

export interface AreaCache {
  get(source: EvidenceSource, locationKey: string): AreaCacheEntry | null;
  put(entry: AreaCacheEntry): void;
}

export interface ReadThrough {
  freshness: Freshness;
  entry: AreaCacheEntry | null;
  error: string | null;
}

const inflight = new WeakMap<AreaCache, Map<string, Promise<ReadThrough>>>();

export function createMemoryAreaCache(): AreaCache {
  const rows = new Map<string, AreaCacheEntry>();
  return {
    get(source, locationKey) {
      return rows.get(`${source}|${locationKey}`) ?? null;
    },
    put(entry) {
      rows.set(`${entry.source}|${entry.locationKey}`, entry);
    },
  };
}

export function createFileAreaCache(dir: string): AreaCache {
  if (!isAbsolute(dir)) throw new Error('area-cache-path');
  const root = resolve(dir);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('area-cache-path');
  return {
    get(source, locationKey) {
      const path = join(root, fileName(source, locationKey));
      try {
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink() || file.size > 1_500_000) return null;
        return parseEntry(readFileSync(path, 'utf8'), source, locationKey);
      } catch {
        return null;
      }
    },
    put(entry) {
      const path = join(root, fileName(entry.source, entry.locationKey));
      const tmp = `${path}.tmp`;
      const payload = Buffer.from(JSON.stringify(entry));
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
      try {
        let offset = 0;
        while (offset < payload.length) offset += writeSync(fd, payload, offset);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    },
  };
}

function fileName(source: EvidenceSource, locationKey: string): string {
  return `${createHash('sha256').update(`${source}|${locationKey}`).digest('hex')}.json`;
}

function parseEntry(raw: string, source: EvidenceSource, locationKey: string): AreaCacheEntry | null {
  try {
    const value = JSON.parse(raw) as AreaCacheEntry;
    if (!value || value.v !== 1 || value.source !== source || value.locationKey !== locationKey) return null;
    if (value.partial !== true && value.partial !== false) return null;
    if (typeof value.sourceUrl !== 'string' || typeof value.vintage !== 'string') return null;
    return acceptStoredEntry(value, Date.now());
  } catch {
    return null;
  }
}

/** A stored row is fresh only when its URL, clock, TTL, and payload match this source. */
export function acceptStoredEntry(entry: AreaCacheEntry, nowMs: number): AreaCacheEntry | null {
  if (entry.vintage !== (entry.source === 'census-popest' ? 'co-est2025' : 'columbus-building-zoning-mapserver-5')) return null;
  if (!sourceUrlAllowed(entry.source, entry.sourceUrl)) return null;
  if (!datesAllowed(entry.source, entry.observedAt, entry.expiresAt, nowMs)) return null;
  if (!asOfAllowed(entry.source, entry.asOf, entry.asOfPrecision, nowMs)) return null;
  if (!payloadAllowed(entry.source, entry.locationKey, entry.payload)) return null;
  return entry;
}

function sourceUrlAllowed(source: EvidenceSource, sourceUrl: string): boolean {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    if (source === 'columbus-permits') {
      return parsed.hostname === 'gis.columbus.gov' && parsed.pathname === '/arcgis/rest/services/Schemas/BuildingZoning/MapServer/5/query';
    }
    return parsed.hostname === 'www2.census.gov' && parsed.pathname === '/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv';
  } catch {
    return false;
  }
}

function datesAllowed(source: EvidenceSource, observedAt: string, expiresAt: string, nowMs: number): boolean {
  const observed = Date.parse(observedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires)) return false;
  if (observed > nowMs + 60_000) return false;
  if (expires <= observed) return false;
  const max = source === 'census-popest' ? CENSUS_TTL_MS : PERMIT_TTL_MS;
  if (expires - observed > max) return false;
  if (expires > nowMs + max) return false;
  return true;
}

function asOfAllowed(source: EvidenceSource, asOf: unknown, precision: unknown, nowMs: number): boolean {
  if (precision === 'none') return asOf === null;
  if (typeof asOf !== 'string' || (precision !== 'day' && precision !== 'year')) return false;
  if (source === 'census-popest') return precision === 'year' && asOf === '2025';
  if (precision !== 'day' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return false;
  const [year, month, day] = asOf.split('-').map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const check = new Date(stamp);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return false;
  return stamp <= nowMs;
}

function payloadAllowed(source: EvidenceSource, locationKey: string, payload: unknown): boolean {
  if (source === 'columbus-permits') {
    if (!Array.isArray(payload)) return false;
    const zip = locationKey.startsWith('zip:') ? locationKey.slice(4) : null;
    return payload.every((row) => permitRowAllowed(row, zip));
  }
  return censusRowAllowed(payload);
}

function permitRowAllowed(row: unknown, zip: string | null): boolean {
  if (!row || typeof row !== 'object') return false;
  const record = row as Record<string, unknown>;
  if (record.source !== 'columbus-permits') return false;
  if (record.newConstruction !== false || record.unitsVerifiedForRanking !== false || record.priceGuarantee !== false) return false;
  if (record.growthClass !== 'raw-activity' && record.growthClass !== 'not-positive') return false;
  if (typeof record.permitId !== 'string' || typeof record.address !== 'string' || typeof record.zip !== 'string') return false;
  if (!/^\d{5}$/.test(record.zip) || (zip !== null && record.zip !== zip)) return false;
  if (!permitCitationAllowed(record.sourceUrl)) return false;
  if (record.unitsReported !== null && (typeof record.unitsReported !== 'number' || !Number.isSafeInteger(record.unitsReported) || record.unitsReported < 0 || record.unitsReported > 10_000)) return false;
  if (record.permitValue !== null && (typeof record.permitValue !== 'number' || !Number.isFinite(record.permitValue) || record.permitValue < 0 || record.permitValue > 1_000_000_000_000)) return false;
  return true;
}

function permitCitationAllowed(sourceUrl: unknown): boolean {
  if (sourceUrl === null) return true;
  if (typeof sourceUrl !== 'string') return false;
  try {
    const parsed = new URL(sourceUrl);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.hostname === 'ca.columbus.gov';
  } catch {
    return false;
  }
}

function censusRowAllowed(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  if (record.source !== 'census-popest' || record.fips !== '39049' || record.vintage !== 'co-est2025') return false;
  if (record.scope !== 'Franklin County, Ohio' || record.sumlev !== '050') return false;
  if (record.sourceUrl !== 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv') return false;
  if (record.neighborhoodForecast !== false || record.priceGuarantee !== false) return false;
  if (!Array.isArray(record.years) || record.years.length !== 6) return false;
  return record.years.every((point, index) => {
    if (!point || typeof point !== 'object') return false;
    const year = (point as { year?: unknown; estimate?: unknown }).year;
    const estimate = (point as { estimate?: unknown }).estimate;
    return year === 2020 + index && typeof estimate === 'number' && Number.isSafeInteger(estimate) && estimate >= 0 && estimate <= 99_999_999;
  });
}

function remember(hit: AreaCacheEntry | null, error: string): ReadThrough {
  if (hit) return { freshness: 'stale', entry: hit, error };
  return { freshness: 'missing', entry: null, error };
}

/** One load per key at a time. A fresh row never calls load. */
export async function readThrough(cache: AreaCache, args: {
  source: EvidenceSource;
  locationKey: string;
  sourceUrl: string;
  nowMs: number;
  ttlMs: number;
  load: () => Promise<{ status: number; body: string } | { error: string }>;
  accept: (body: string) => { payload: unknown; partial: boolean; asOf: string | null; asOfPrecision: 'day' | 'year' | 'none'; vintage: string; ttlMs?: number } | { error: string };
}): Promise<ReadThrough> {
  const stored = cache.get(args.source, args.locationKey);
  const hit = stored ? acceptStoredEntry(stored, args.nowMs) : null;
  if (hit && Date.parse(hit.expiresAt) > args.nowMs) return { freshness: 'cached', entry: hit, error: null };
  const jobs = inflight.get(cache) ?? new Map<string, Promise<ReadThrough>>();
  if (!inflight.has(cache)) inflight.set(cache, jobs);
  const id = `${args.source}|${args.locationKey}`;
  const pending = jobs.get(id);
  if (pending) return pending;
  const job = (async (): Promise<ReadThrough> => {
    let loaded: { status: number; body: string } | { error: string };
    try {
      loaded = await args.load();
    } catch (error) {
      return remember(hit, error instanceof Error ? error.message : 'fetch-failed');
    }
    if ('error' in loaded || loaded.status !== 200 || !loaded.body) return remember(hit, 'error' in loaded ? loaded.error : `HTTP ${loaded.status}`);
    const accepted = args.accept(loaded.body);
    if ('error' in accepted) return remember(hit, accepted.error);
    const entry: AreaCacheEntry = {
      v: 1,
      locationKey: args.locationKey,
      source: args.source,
      sourceUrl: args.sourceUrl,
      observedAt: new Date(args.nowMs).toISOString(),
      asOf: accepted.asOf,
      asOfPrecision: accepted.asOfPrecision,
      vintage: accepted.vintage,
      expiresAt: new Date(args.nowMs + (accepted.ttlMs ?? args.ttlMs)).toISOString(),
      partial: accepted.partial,
      payload: accepted.payload,
    };
    try { cache.put(entry); } catch { /* A failed write does not hide the fetch and does not retry it. */ }
    return { freshness: 'live', entry, error: null };
  })();
  jobs.set(id, job);
  try {
    return await job;
  } finally {
    jobs.delete(id);
  }
}

let processCache: { cache: AreaCache; store: 'memory' | 'file'; warning: string | null } | null = null;

export function areaCacheFromEnv(env: NodeJS.ProcessEnv): { cache: AreaCache; store: 'memory' | 'file'; warning: string | null } {
  if (processCache) return processCache;
  const configured = env.SCOUT_AREA_CACHE?.trim() ?? '';
  if (!configured || !isAbsolute(configured)) {
    processCache = {
      cache: createMemoryAreaCache(),
      store: 'memory',
      warning: configured ? 'SCOUT_AREA_CACHE must be an absolute directory. This process is keeping evidence in memory only.' : null,
    };
    return processCache;
  }
  try {
    mkdirSync(configured, { recursive: true, mode: 0o700 });
    processCache = { cache: createFileAreaCache(configured), store: 'file', warning: null };
  } catch {
    processCache = { cache: createMemoryAreaCache(), store: 'memory', warning: 'The area-cache path was not a usable directory. This process is keeping evidence in memory only.' };
  }
  return processCache;
}

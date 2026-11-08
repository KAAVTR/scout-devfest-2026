/**
 * Official property-tax lookup registry. Coverage is explicit per county; there is no nationwide assessor API.
 * Tax-team boundary: add adapters as server/tax/adapters/<st>-<county>.ts and register them in ADAPTERS.
 * Adapters must only call official, permitted, key-free (or configured) endpoints and must return TaxRecord.
 */
import type { TaxRecord } from '../../shared/tax';
import type { SignedCandidate } from './confirm';
import { confirmedIdentity, isSupportedLocality, validateParcelAddress, unitRefusal } from './identity';

export interface TaxLookupInput {
  address: string | null;
  zip: string | null;
  state: string | null;
  countyFips: string[]; // candidate county FIPS from the ZCTA-county relationship (may be >1)
  /** Structured city field exactly as received (research listings); must be a supported locality when present. */
  city?: string | null;
}

export interface TaxLookupAdapter {
  id: string; // e.g. 'oh-franklin-auditor'
  countyFips: string; // 5-digit county FIPS covered
  description: string;
  lookup(input: TaxLookupInput, signal: AbortSignal): Promise<TaxRecord>;
  /** Resolve a server-signed geocoder candidate the user explicitly confirmed. */
  lookupConfirmed(candidate: SignedCandidate, signal: AbortSignal): Promise<TaxRecord>;
}

import { franklinCountyAdapter } from './adapters/oh-franklin';

export const ADAPTERS: TaxLookupAdapter[] = [franklinCountyAdapter()];

export async function lookupTax(input: TaxLookupInput, signal: AbortSignal, adapters: TaxLookupAdapter[] = ADAPTERS): Promise<TaxRecord> {
  if (!input.address || !input.zip) return { kind: 'unknown', reason: 'insufficient-address', detail: 'Address or ZIP missing; no parcel lookup attempted.', attemptedAdapterId: null };
  // Central identity gate for every adapter (research pipeline and /api/tax-lookup both arrive here).
  const id = validateParcelAddress(input.address);
  if (!id.ok) return { kind: 'unknown', reason: id.outOfArea ? 'county-not-covered' : 'ambiguous-parcel', detail: unitRefusal(id.why), attemptedAdapterId: null };
  if (input.city != null && !isSupportedLocality(input.city)) return { kind: 'unknown', reason: 'ambiguous-parcel', detail: unitRefusal(`city "${input.city}" is not a supported Franklin County, OH city`), attemptedAdapterId: null };
  if (id.zip && id.zip !== input.zip) return { kind: 'unknown', reason: 'ambiguous-parcel', detail: `Address ZIP ${id.zip} differs from listing ZIP ${input.zip}; no parcel lookup attempted.`, attemptedAdapterId: null };
  const matches = adapters.filter((a) => input.countyFips.includes(a.countyFips));
  if (matches.length === 0)
    return { kind: 'unknown', reason: 'county-not-covered', detail: `No official tax adapter covers county ${input.countyFips.join('/') || 'unknown'}. Enter a seller bill or estimate manually.`, attemptedAdapterId: null };
  // A ZIP may span counties: the adapter's own official geocoder decides whether the address is in its county.
  if (matches.length > 1) return { kind: 'unknown', reason: 'ambiguous-parcel', detail: 'More than one tax adapter matched; county must be confirmed.', attemptedAdapterId: null };
  const adapter = matches[0];
  try {
    return await adapter.lookup(input, AbortSignal.any([signal, AbortSignal.timeout(12000)]));
  } catch {
    return { kind: 'unknown', reason: 'lookup-failed', detail: `Official lookup via ${adapter.id} failed; enter tax manually.`, attemptedAdapterId: adapter.id };
  }
}

export async function lookupConfirmedTax(c: SignedCandidate, signal: AbortSignal, adapters: TaxLookupAdapter[] = ADAPTERS): Promise<TaxRecord> {
  const bad = confirmedIdentity(c);
  if (bad) return { kind: 'unknown', reason: 'ambiguous-parcel', detail: unitRefusal(bad), attemptedAdapterId: null };
  const adapter = adapters.find((a) => a.id === c.adapterId);
  if (!adapter) return { kind: 'unknown', reason: 'lookup-failed', detail: 'No adapter for this confirmation.', attemptedAdapterId: null };
  try {
    return await adapter.lookupConfirmed(c, AbortSignal.any([signal, AbortSignal.timeout(12000)]));
  } catch {
    return { kind: 'unknown', reason: 'lookup-failed', detail: `Official lookup via ${adapter.id} failed; enter tax manually.`, attemptedAdapterId: adapter.id };
  }
}

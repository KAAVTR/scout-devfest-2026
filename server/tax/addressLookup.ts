/** Address-only official tax lookup (no discovery model involved). Works when Gemini is unavailable. */
import type { TaxRecord } from '../../shared/tax';
import type { MarketSnapshot } from '../market/snapshot';
import { verifyCandidate } from './confirm';
import { parseAddressIdentity, unitRefusal, validateParcelAddress } from './identity';
import { ADAPTERS, lookupConfirmedTax, lookupTax, type TaxLookupAdapter } from './registry';

export type AddressTaxRequest = { kind: 'address'; address: string } | { kind: 'confirm'; token: string };

export function parseAddressTaxRequest(body: unknown): { ok: true; value: AddressTaxRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'JSON body required.' };
  const b = body as Record<string, unknown>;
  if (typeof b.confirmToken === 'string') return { ok: true, value: { kind: 'confirm', token: b.confirmToken } };
  if (typeof b.address !== 'string') return { ok: false, error: 'address (string) or confirmToken required.' };
  const a = b.address.replace(/^ +| +$/g, ''); // ASCII-space trim only (String.trim would strip BOM/NBSP/U+2028): identity validation sees the original text
  if (a.length < 5 || a.length > 200 || /[<>{}\\]/.test(a)) return { ok: false, error: 'address must be 5-200 plain characters.' };
  return { ok: true, value: { kind: 'address', address: a } };
}

/** Pull "ST 12345" off the end of a one-line US address (delegates to the identity owner). */
export function splitAddress(a: string): { zip: string | null; state: string | null } {
  const { zip, state } = parseAddressIdentity(a);
  return { zip, state };
}

export async function lookupAddressTax(req: AddressTaxRequest, snapshot: MarketSnapshot, signal: AbortSignal, adapters: TaxLookupAdapter[] = ADAPTERS): Promise<TaxRecord> {
  if (req.kind === 'confirm') {
    const c = verifyCandidate(req.token);
    if (!c) return { kind: 'unknown', reason: 'lookup-failed', detail: 'Confirmation expired or invalid; run the address lookup again.', attemptedAdapterId: null };
    return lookupConfirmedTax(c, signal, adapters);
  }
  const id = validateParcelAddress(req.address);
  if (!id.ok) return { kind: 'unknown', reason: id.outOfArea ? 'county-not-covered' : 'ambiguous-parcel', detail: unitRefusal(id.why), attemptedAdapterId: null };
  const { zip, state } = id;
  if (!zip) return { kind: 'unknown', reason: 'insufficient-address', detail: 'Include the 5-digit ZIP (e.g. "3785 Briggs Rd, Columbus, OH 43228").', attemptedAdapterId: null };
  if (state && state !== 'OH') return { kind: 'unknown', reason: 'county-not-covered', detail: `No official tax adapter covers ${state}. Only Franklin County, OH is supported; enter tax manually.`, attemptedAdapterId: null };
  const counties = new Set<string>();
  for (const m of snapshot.metros) for (const fips of (m.zctas?.[zip] ?? '').split(',')) if (fips) counties.add(fips);
  return lookupTax({ address: req.address, zip, state: state ?? 'OH', countyFips: [...counties] }, signal, adapters);
}

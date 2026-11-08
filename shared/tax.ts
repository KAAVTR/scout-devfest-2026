/**
 * Property-tax evidence contract (shared with the tax-integration team).
 * Adapters live in server/tax/adapters/<state>-<county>.ts and implement TaxLookupAdapter (server/tax/registry.ts).
 * A user-entered amount is never "official".
 */
export interface TaxDocumentRef {
  url: string | null; // official assessor/treasurer page or bill PDF; null for user uploads
  title: string;
  publisher: string; // e.g. "Franklin County Auditor"
  retrievedAt: string; // ISO timestamp
}

export interface TaxExemption {
  name: string; // e.g. "Homestead", "Owner-occupancy credit"
  annualAmount: number | null;
  /** Owner-specific exemptions usually end at sale; a buyer estimate must not assume them. */
  transfersToBuyer: boolean | 'unknown';
}

/** A county-geocoder candidate the user may confirm. token is server-signed; address/score are display-only. */
export interface TaxAddressCandidate {
  token: string;
  address: string;
  score: number;
}

export type TaxRecord =
  | {
      kind: 'official-record';
      adapterId: string;
      jurisdiction: { state: string; county: string };
      parcelId: string;
      taxYear: number;
      /** Seller's current bill as levied (includes the seller's exemptions). */
      sellerBillAnnual: number;
      exemptions: TaxExemption[];
      /** Estimate for a new owner (e.g. removes non-transferable exemptions, applies reassessment rule). Null if the adapter cannot estimate. */
      buyerEstimateAnnual: number | null;
      buyerEstimateMethod: string | null;
      /** Property-level special assessments billed separately (may or may not continue for a buyer). */
      specialAssessmentsAnnual: number | null;
      assessedValue: number | null;
      marketValue: number | null;
      document: TaxDocumentRef;
      /** Per-field provenance (url + as-of) for bill, values, and parcel match. */
      provenance: { field: string; url: string; asOf: string }[];
      parcelMatch: 'exact-address' | 'user-confirmed-candidate' | 'parcel-id' | 'ambiguous';
      matchedAddress: string | null;
      confidence: 'high' | 'medium' | 'low';
      warnings: string[];
    }
  | {
      kind: 'manual';
      basis: 'seller-bill' | 'buyer-estimate' | 'other';
      annualAmount: number; // finite, >= 0; 0 must be deliberate
      taxYear: number | null;
      note: string | null;
      documentName: string | null; // user-uploaded bill filename, never inspected/verified by the app
      enteredAt: string;
    }
  | {
      kind: 'unknown';
      reason: 'county-not-covered' | 'lookup-failed' | 'no-parcel-match' | 'ambiguous-parcel' | 'not-attempted' | 'insufficient-address';
      detail: string;
      attemptedAdapterId: string | null;
      /** Present only for reason 'ambiguous-parcel' from a geocoder: candidates to confirm explicitly. */
      candidates?: TaxAddressCandidate[];
    };

export type TaxInputStatus = 'unknown' | 'manual' | 'verified';

/** Map to the legacy calculator input. Buyer estimate preferred; seller bill only when no estimate exists. */
export function taxRecordToCalculatorInput(t: TaxRecord): { status: TaxInputStatus; annualAmount: number | null; source: string } {
  switch (t.kind) {
    case 'official-record': {
      if (t.parcelMatch === 'ambiguous') return { status: 'unknown', annualAmount: null, source: `Ambiguous parcel match (${t.parcelId}); not used` };
      if (t.confidence === 'low' && t.buyerEstimateAnnual === null) return { status: 'unknown', annualAmount: null, source: `Low-confidence official record (${t.parcelId}); enter tax manually` };
      // Only a positive new-owner estimate is used. Seller's bill alone (credits/exemptions may not transfer) is reference-only.
      if (t.buyerEstimateAnnual === null || !(t.buyerEstimateAnnual > 0))
        return { status: 'unknown', annualAmount: null, source: `New-owner tax unknown for parcel ${t.parcelId} (seller's TY${t.taxYear} bill $${t.sellerBillAnnual.toLocaleString()} is reference only); enter an estimate manually` };
      // Positive special assessments are added conservatively; credits (negative) and unknown (null) never lower the cost.
      const sa = t.specialAssessmentsAnnual !== null && t.specialAssessmentsAnnual > 0 ? t.specialAssessmentsAnnual : 0;
      return { status: 'verified', annualAmount: t.buyerEstimateAnnual + sa, source: `${t.document.publisher}, parcel ${t.parcelId}, tax year ${t.taxYear}, new-owner estimate (${t.buyerEstimateMethod ?? 'method unstated'})${sa ? ` + $${sa.toLocaleString()} special assessments` : ''}` };
    }
    case 'manual':
      return { status: 'manual', annualAmount: t.annualAmount, source: `User-entered ${t.basis.replace('-', ' ')}${t.taxYear ? ` (${t.taxYear})` : ''} — not an official record` };
    case 'unknown':
      return { status: 'unknown', annualAmount: null, source: t.detail };
    default: {
      const _exhaustive: never = t;
      return _exhaustive;
    }
  }
}

export function parseManualTaxRecord(input: { raw: string; basis: 'seller-bill' | 'buyer-estimate' | 'other'; taxYear?: string; documentName?: string | null; now: string }): TaxRecord | { error: string } {
  const text = input.raw.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return { error: 'Enter a finite, nonnegative annual amount.' };
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) return { error: 'Enter a finite, nonnegative annual amount.' };
  const yearText = input.taxYear?.trim() ?? '';
  const year = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
  return { kind: 'manual', basis: input.basis, annualAmount: amount, taxYear: year, note: null, documentName: input.documentName ?? null, enteredAt: input.now };
}

import type { CandidateClaim, Citation, FieldAttribution, PropertyCandidate, ResearchPropertyType } from '../../shared/research';
import { PROPERTY_TYPES } from '../../shared/research';
import { toStateCode } from '../../shared/criteria';
import { canonicalForComparison, checkListingUrl } from '../../shared/urlPolicy';
import { byteOffsetFactory, parseWithSpans, type JNode, type Span } from '../provider/jsonSpans';

export const MAX_CANDIDATES_PER_MARKET = 3;

/** JSON schema sent to the model (structured output). Server re-validates everything. */
export const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      maxItems: MAX_CANDIDATES_PER_MARKET,
      items: {
        type: 'object',
        properties: {
          address: { type: ['string', 'null'] },
          city: { type: ['string', 'null'] },
          state: { type: ['string', 'null'], description: 'Two-letter USPS code' },
          zip: { type: ['string', 'null'] },
          listPrice: { type: ['integer', 'null'] },
          propertyType: { type: ['string', 'null'], description: `One of: ${PROPERTY_TYPES.join(', ')}` },
          units: { type: ['integer', 'null'] },
          listingUrl: { type: ['string', 'null'], description: 'Exact property detail page URL that you cited' },
          listingStatus: { type: ['string', 'null'] },
          sourceObservedDate: { type: ['string', 'null'] },
        },
        required: ['address', 'city', 'state', 'zip', 'listPrice', 'propertyType', 'units', 'listingUrl', 'listingStatus', 'sourceObservedDate'],
      },
    },
  },
  required: ['candidates'],
} as const;

// eslint-disable-next-line no-control-regex
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null;

type Extracted = Omit<PropertyCandidate, 'tax' | 'evaluation' | 'provider' | 'marketId'>;
/** identityAddress: the model's address string exactly as emitted (before display cleaning), keyed by candidate id.
 *  Tax identity is validated on this original, never on the cleaned display text. */
export type ExtractResult = { ok: true; candidates: Extracted[]; droppedForSize: number; identityAddress: Map<string, { address: string | null; city: string | null }> } | { ok: false; reason: string };

function field(obj: Extract<JNode, { t: 'obj' }>, key: string): JNode | undefined {
  return obj.entries.find((e) => e.key === key)?.value;
}

export function extractCandidates(args: { text: string; citations: Citation[]; retrievedAt: string; idPrefix: string }): ExtractResult {
  let root: JNode;
  try {
    root = parseWithSpans(args.text); // untrimmed: offsets must stay aligned with provider text
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Malformed JSON' };
  }
  if (root.t !== 'obj') return { ok: false, reason: 'Root must be an object' };
  const list = field(root, 'candidates');
  if (!list || list.t !== 'arr') return { ok: false, reason: 'Missing candidates array' };
  const toByte = byteOffsetFactory(args.text);
  const byteSpan = (s: Span) => ({ start: toByte(s.start), end: toByte(s.end) });
  const out: Extracted[] = [];
  const identityAddress = new Map<string, { address: string | null; city: string | null }>();
  for (const [idx, node] of list.items.slice(0, MAX_CANDIDATES_PER_MARKET).entries()) {
    if (node.t !== 'obj') return { ok: false, reason: `Candidate ${idx} is not an object` };
    const s = (k: string, max = 200) => { const v = field(node, k); return v?.t === 'str' ? clean(v.v, max) : null; };
    const n = (k: string) => { const v = field(node, k); return v?.t === 'num' && Number.isFinite(v.v) ? v.v : null; };
    const rawType = s('propertyType', 40);
    const propertyType = (PROPERTY_TYPES as readonly string[]).includes(rawType ?? '') ? (rawType as ResearchPropertyType) : null;
    const price = n('listPrice');
    const units = n('units');
    const zip = s('zip', 10);
    const claim: CandidateClaim = {
      address: s('address'),
      city: s('city', 80),
      state: toStateCode(s('state', 30)),
      zip: zip && /^\d{5}$/.test(zip) ? zip : null,
      listPrice: price !== null && price > 0 && price <= 50_000_000 ? price : null,
      propertyType,
      units: units !== null && Number.isInteger(units) && units >= 1 && units <= 500 ? units : null,
      listingUrl: s('listingUrl', 500),
      listingStatus: s('listingStatus', 60),
      sourceObservedDate: s('sourceObservedDate', 30),
    };
    const verdict = checkListingUrl(claim.listingUrl);
    const canonical = verdict.ok ? verdict.canonical : null;
    const objSpan = byteSpan(node.span);
    const exact = canonical ? args.citations.filter((c) => canonicalForComparison(c.url) === canonical && c.startByte !== null && c.endByte !== null) : [];
    // A field is attributed only when the union of exact-listing-URL citation ranges covers its whole value
    // (string content without quotes). Partial / prefix-only coverage stays uncited.
    const merged = exact.map((c) => [c.startByte as number, c.endByte as number] as const).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const covered = (span: { start: number; end: number }) => {
      let reach = span.start;
      for (const [a, b] of merged) { if (a > reach) break; if (b > reach) reach = b; if (reach >= span.end) return true; }
      return reach >= span.end;
    };
    const valueSpan = (v: JNode) => { const b = byteSpan(v.span); return v.t === 'str' ? { start: b.start + 1, end: b.end - 1 } : b; };
    const attr = (keys: string[]): FieldAttribution => {
      const nodes = keys.map((k) => field(node, k)).filter((v): v is JNode => v !== undefined && v.t !== 'null');
      return nodes.length === keys.length && nodes.every((v) => { const sp = valueSpan(v); return sp.end > sp.start && covered(sp); }) ? 'cited-by-listing-page' : 'uncited';
    };
    const urlNode = field(node, 'listingUrl');
    { const raw = (k: string) => { const v = field(node, k); return v?.t === 'str' ? v.v : null; }; identityAddress.set(`${args.idPrefix}-${idx}`, { address: raw('address'), city: raw('city') }); }
    out.push({
      id: `${args.idPrefix}-${idx}`,
      claim,
      canonicalListingUrl: canonical,
      listingUrlRejection: verdict.ok ? null : verdict.reason,
      attribution: {
        listingPageCited: urlNode !== undefined && urlNode.t === 'str' && attr(['listingUrl']) === 'cited-by-listing-page',
        price: attr(['listPrice']),
        address: attr(['address', 'city', 'state', 'zip']),
        // Type plus unit count when the model reported one (a duplex claim with uncited units stays unverified).
        propertyType: attr(claim.units !== null ? ['propertyType', 'units'] : ['propertyType']),
      },
      citations: args.citations.filter((c) => c.startByte === null || ((c.startByte as number) < objSpan.end && (c.endByte as number) > objSpan.start)).slice(0, 10),
      retrievedAt: args.retrievedAt,
    });
  }
  return { ok: true, candidates: out, droppedForSize: Math.max(0, list.items.length - MAX_CANDIDATES_PER_MARKET), identityAddress };
}

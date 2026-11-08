/**
 * Single owner of "which property does this address string identify?" for every tax entry point
 * (research pipeline, /api/tax-lookup address, /api/tax-lookup confirmToken).
 *
 * POSITIVE grammar, validated on the ORIGINAL string before any normalization. Anything outside the
 * grammar is unsupported -> unknown, no figures, no candidates, zero county/GIS work. We reject rather
 * than normalize away: Unicode (½, fullwidth digits, combining marks, NBSP, zero-width), "#", "/",
 * attached unit tokens (Unit4, Apartment4B), sub-numbers (3785A, 3785-4, 3785.5, 3785 1/2) and any
 * secondary-unit designator are all outside the grammar.
 *
 * Covered grammar (case-insensitive, ASCII only):
 *   STREET   := HOUSE SP [PREDIR SP] NAME SP SUFFIX [SP POSTDIR]
 *   HOUSE    := [1-9][0-9]{0,5}                       (digits only)
 *   NAME     := WORD (SP WORD)*  WORD := letters [ ' letters ] [.] | ordinal (5th, 21st)
 *               a single-letter WORD is allowed only as the whole name ("1 A St")
 *   LOCALITY := [CITY] [OH|Ohio] [ZIP5[-ZIP4]] [USA]  CITY := exactly one SUPPORTED_LOCALITIES name (closed set)
 *   ADDRESS  := STREET ( "," LOCALITY-part )*  |  STREET SP LOCALITY
 * The COMPLETE original must be consumed: no unrecognized word is ever dropped. Designator words (apt, unit,
 * ste, ...) are refused in the street; numberless ones (front, side) only as the sole name word ("N Front St").
 * Confirmation candidates must carry the same identity key (house + name words + suffix; only directionals may differ).
 */
export interface ValidIdentity { ok: true; original: string; street: string; house: string; key: string; /** key without the house number: every street-name word + canonical suffix. */ nameKey: string; zip: string | null; state: string | null }
export interface RejectedIdentity { ok: false; original: string; why: string; /** Label only: tail names another US state. Never affects acceptance. */ outOfArea?: boolean }
export type ParcelIdentity = ValidIdentity | RejectedIdentity;

const NUMBERED = new Set('APT APARTMENT UNIT STE SUITE BLDG BLDNG BUILDING FL FLR FLOOR RM ROOM LOT SPC SPACE TRLR TRAILER DEPT HNGR HANGAR KEY PIER SLIP STOP BOX PMB NO NUM NUMBER POBOX'.split(' '));
const NUMBERLESS = new Set('REAR FRONT FRNT UPPER UPPR LOWER LOWR BASEMENT BSMT LOBBY LBBY OFFICE OFC SIDE PENTHOUSE PH HALF'.split(' '));
const DIR = new Set('N S E W NE NW SE SW NORTH SOUTH EAST WEST NORTHEAST NORTHWEST SOUTHEAST SOUTHWEST'.split(' '));
const SUFFIXES = new Set(('ST STREET AVE AVENUE AV RD ROAD DR DRIVE CT COURT LN LANE BLVD BOULEVARD PL PLACE CIR CIRCLE PKWY PARKWAY TER TERRACE ' +
  'HWY HIGHWAY TRL TRAIL WAY PIKE SQ SQUARE LOOP RUN PT POINT XING CROSSING PATH WALK ROW ALY ALLEY CV COVE BND BEND TRCE TRACE PASS RDG RIDGE ' +
  'VW VIEW PLZ PLAZA CRES CRESCENT GRN GREEN GLN GLEN HOLW HOLLOW MDW MEADOW MDWS MEADOWS ESTS ESTATES HTS HEIGHTS CTR CENTER CRK CREEK').split(' '));

const bare = (t: string) => t.replace(/\.$/, '').toUpperCase();
const isWord = (t: string) => /^[A-Za-z]+(?:'[A-Za-z]+)?\.?$/.test(t);
const isOrdinal = (t: string) => /^\d{1,3}(?:st|nd|rd|th)$/i.test(t);

/** STREET without locality; returns normalized line or a reason. */
const CANON: Record<string, string> = { STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', DRIVE: 'DR', COURT: 'CT', LANE: 'LN', BOULEVARD: 'BLVD', PLACE: 'PL', CIRCLE: 'CIR', PARKWAY: 'PKWY', TERRACE: 'TER',
  HIGHWAY: 'HWY', TRAIL: 'TRL', SQUARE: 'SQ', POINT: 'PT', CROSSING: 'XING', ALLEY: 'ALY', COVE: 'CV', BEND: 'BND', TRACE: 'TRCE', RIDGE: 'RDG', VIEW: 'VW', PLAZA: 'PLZ', CRESCENT: 'CRES', GREEN: 'GRN', GLEN: 'GLN',
  HOLLOW: 'HOLW', MEADOW: 'MDW', MEADOWS: 'MDWS', ESTATES: 'ESTS', HEIGHTS: 'HTS', CENTER: 'CTR', CREEK: 'CRK' };
/** Identity key: house + every street-name word + canonical suffix + post-directional ("Riverton Ct E" ≠ "Riverton Ct W"); only a PRE-directional is excluded. Different keys = different identities. */
const streetKey = (house: string, name: string[], suffix: string) => [house, ...name.map(bare), CANON[bare(suffix)] ?? bare(suffix)].join(' ');

function street(tokens: string[]): { ok: true; line: string; house: string; key: string } | { ok: false; why: string } {
  const [house, ...rest] = tokens;
  if (!house || !/^[1-9]\d{0,5}$/.test(house)) return { ok: false, why: `house number "${house ?? ''}" is not plain digits (sub-numbers like 3785A, 3785-4, 3785.5, fractions are unsupported)` };
  let body = rest;
  let postdir: string | null = null;
  if (body.length && DIR.has(bare(body[body.length - 1])) && body.length >= 3 && SUFFIXES.has(bare(body[body.length - 2]))) { postdir = bare(body[body.length - 1]); body = body.slice(0, -1); }
  if (body.length < 2 || !SUFFIXES.has(bare(body[body.length - 1]))) return { ok: false, why: 'street line must end with a recognized street suffix (St, Ave, Rd, ...)' };
  let name = body.slice(0, -1);
  if (name.length >= 2 && DIR.has(bare(name[0]))) name = name.slice(1);
  for (const t of name) {
    if (!isWord(t) && !isOrdinal(t)) return { ok: false, why: `"${t}" is not a plain street-name word (attached unit tokens are unsupported)` };
    if (NUMBERED.has(bare(t))) return { ok: false, why: `"${t}" is a unit/sub-address designator` };
    if (NUMBERLESS.has(bare(t)) && name.length > 1) return { ok: false, why: `"${t}" is a unit/sub-address designator` };
    if (isWord(t) && bare(t).replace(/'/g, '').length === 1 && name.length > 1) return { ok: false, why: `single letter "${t}" may be a unit` };
  }
  return { ok: true, house, line: [house, ...rest].map((t) => bare(t)).join(' '), key: streetKey(house, name, body[body.length - 1]) + (postdir ? ` ${postdir}` : '') };
}

/**
 * Supported localities: an exact, closed contract (Franklin County, OH incorporated municipalities, the
 * hackathon scope). A locality word that is not part of one of these names is NEVER treated as a harmless
 * city and dropped: the whole tail must be consumed by `[CITY] [OH|Ohio] [ZIP5[-ZIP4]] [USA]`.
 */
export const SUPPORTED_LOCALITIES: readonly string[] = [
  'BEXLEY', 'CANAL WINCHESTER', 'COLUMBUS', 'DUBLIN', 'GAHANNA', 'GRANDVIEW HEIGHTS', 'GROVE CITY', 'GROVEPORT', 'HILLIARD', 'NEW ALBANY',
  'REYNOLDSBURG', 'UPPER ARLINGTON', 'WESTERVILLE', 'WHITEHALL', 'WORTHINGTON',
  'BRICE', 'HARRISBURG', 'LOCKBOURNE', 'MARBLE CLIFF', 'MINERVA PARK', 'OBETZ', 'RIVERLEA', 'URBANCREST', 'VALLEYVIEW',
];
const LOCALITY = new Set(SUPPORTED_LOCALITIES);
const OTHER_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
export const SUPPORTED_FORMAT = 'Use "<house number> <street> <suffix>, <city>, OH <ZIP>" (e.g. "3785 Briggs Rd, Columbus, OH 43228") with a Franklin County, OH city and no unit/apartment/suite part';

/** Exact supported city check for structured city fields (e.g. a listing's city). */
export function isSupportedLocality(raw: string): boolean {
  if (!/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(raw)) return false;
  return LOCALITY.has(raw.toUpperCase());
}

/** LOCALITY tokens with segment ids; every token must be consumed; city never spans a comma. */
function locality(toks: { t: string; seg: number }[]): { ok: true; zip: string | null; state: string | null } | { ok: false; why: string } {
  let i = toks.length;
  if (i && /^USA$/i.test(toks[i - 1].t)) i--;
  let zip: string | null = null, state: string | null = null;
  if (i && /^\d{5}(?:-\d{4})?$/.test(toks[i - 1].t)) zip = toks[--i].t.slice(0, 5);
  if (i && /^(?:OH|OHIO)\.?$/i.test(toks[i - 1].t)) { state = 'OH'; i--; }
  const city = toks.slice(0, i);
  if (city.length) {
    if (new Set(city.map((c) => c.seg)).size > 1) return { ok: false, why: 'unexpected extra address part between street and city/state/ZIP' };
    const name = city.map((c) => c.t).join(' ');
    if (!isSupportedLocality(name)) return { ok: false, why: `"${name}" is not a supported Franklin County, OH city (unrecognized text is never dropped; it may be a unit or sub-address)` };
  }
  return { ok: true, zip, state };
}

export function validateParcelAddress(original: string): ParcelIdentity {
  const no = (why: string): RejectedIdentity => ({ ok: false, original, why });
  if (typeof original !== 'string' || original.length > 200) return no('address missing or too long');
  // Before ANY normalization: ASCII letters/digits, ASCII space, comma, period, apostrophe, hyphen only.
  if (!/^[A-Za-z0-9 ,.'-]+$/.test(original)) {
    const bad = [...original].find((ch) => !/[A-Za-z0-9 ,.'-]/.test(ch)) ?? '';
    return no(`character U+${(bad.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} ("${bad}") is outside the supported address notation (#, /, fractions, Unicode and fullwidth forms are not normalized)`);
  }
  const segs = original.trim().split(',').map((s) => s.trim().split(/ +/).filter(Boolean));
  if (segs.some((s) => s.length === 0)) return no('empty address part');
  const first = segs[0];
  // Street segment: try every suffix position (last first) so "3785 Briggs Rd Columbus OH 43228" works without commas.
  let best: { line: string; house: string; key: string; zip: string | null; state: string | null } | null = null;
  let why = 'not a supported street address';
  // Earliest suffix that leaves a fully-consumed supported locality (so "Grandview Heights" stays a city).
  for (let end = 3; end <= first.length; end++) {
    const s = street(first.slice(0, end));
    if (!s.ok) { if (end === 3 || /suffix/.test(why)) why = s.why; continue; }
    const loc = locality([...first.slice(end).map((t) => ({ t, seg: 0 })), ...segs.slice(1).flatMap((seg, k) => seg.map((t) => ({ t, seg: k + 1 })))]);
    if (!loc.ok) { why = loc.why; continue; }
    best = { line: s.line, house: s.house, key: s.key, zip: loc.zip, state: loc.state };
    break;
  }
  if (!best) {
    const st = /,\s*([A-Za-z]{2})\.?(?:\s+\d{5}(?:-\d{4})?)?\s*$/.exec(original)?.[1]?.toUpperCase();
    if (st && st !== 'OH' && OTHER_STATES.has(st)) return { ok: false, original, why: `state ${st} is outside the supported area (Franklin County, OH only)`, outOfArea: true };
    return no(why);
  }
  return { ok: true, original, street: best.line, house: best.house, key: best.key, nameKey: best.key.slice(best.house.length + 1), zip: best.zip, state: best.state };
}

/** Back-compat view used by tests/helpers: `unit` is the refusal reason (null = supported whole-parcel address). */
export interface AddressIdentity { street: string | null; unit: string | null; zip: string | null; state: string | null }
export function parseAddressIdentity(raw: string): AddressIdentity {
  const v = validateParcelAddress(raw);
  return v.ok ? { street: v.street, unit: null, zip: v.zip, state: v.state } : { street: null, unit: v.why, zip: null, state: null };
}

/** Reason text shared by every entry point that refuses an unsupported identity. */
export const unitRefusal = (why: string) =>
  `Address is not a supported whole-parcel street address: ${why}. Possible unit/sub-address or unsupported notation, so no official figures or confirmable candidates are shown and no county lookup was made. ${SUPPORTED_FORMAT}; otherwise enter tax manually.`;

/**
 * Confirmation check: BOTH the signed original request and the signed candidate must be supported
 * whole-parcel identities, the signed query must be exactly what the original normalizes to, and the
 * candidate must carry the same house number. Returns a refusal reason, or null when acceptable.
 */
export function confirmedIdentity(c: { original?: unknown; query: string; address: string; zip: string | null }): string | null {
  if (typeof c.original !== 'string') return 'confirmation lacks the original requested address';
  const o = validateParcelAddress(c.original);
  if (!o.ok) return o.why;
  if (o.street !== c.query) return 'signed query does not match the original requested address';
  if (o.zip && o.zip !== c.zip) return 'signed ZIP does not match the original requested address';
  const cand = validateParcelAddress(c.address);
  if (!cand.ok) return `candidate ${cand.why}`;
  if (cand.house !== o.house) return `candidate house number ${cand.house} differs from requested ${o.house}`;
  if (cand.key !== o.key) return `candidate street "${cand.street}" is not the requested street "${o.street}" (only a directional may differ)`;
  return null;
}

/** Server-signed geocoder candidate tokens so a confirmed candidate's identity cannot be altered client-side. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SignedCandidate { adapterId: string; address: string; score: number; x: number; y: number; query: string; /** Original user/listing address exactly as requested; re-validated at confirmation. */ original: string; zip: string | null; exp: number }

const secret = (() => {
  const env = process.env.APEXPROP_CONFIRM_SECRET;
  return env && env.length >= 32 ? Buffer.from(env) : randomBytes(32); // per-process default: tokens expire on restart
})();
const mac = (body: string) => createHmac('sha256', secret).update(body).digest('base64url');

export function signCandidate(c: Omit<SignedCandidate, 'exp'>, now = Date.now(), ttlMs = 30 * 60 * 1000): string {
  const body = Buffer.from(JSON.stringify({ ...c, exp: now + ttlMs })).toString('base64url');
  return `${body}.${mac(body)}`;
}

export function verifyCandidate(token: unknown, now = Date.now()): SignedCandidate | null {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.adapterId !== 'string' || typeof o.address !== 'string' || typeof o.score !== 'number' || typeof o.x !== 'number' || typeof o.y !== 'number' || typeof o.query !== 'string' || typeof o.original !== 'string' || typeof o.exp !== 'number' || !(o.zip === null || (typeof o.zip === 'string' && /^\d{5}$/.test(o.zip)))) return null;
    if (o.exp < now) return null;
    return { adapterId: o.adapterId, address: o.address, score: o.score, x: o.x, y: o.y, query: o.query, original: o.original, zip: o.zip as string | null, exp: o.exp };
  } catch {
    return null;
  }
}

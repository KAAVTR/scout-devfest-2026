/** DEMO ONLY: bounded process-local snapshots; never durable/live research ownership. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createVaGrowthAssessment } from './vaGrowth';
import { SESSION_VERSION, type DemoSnapshot, type SessionReply, type DemoSessionBody } from '../../shared/vaGrowthSessions';

type Command = { op: 'create'; request: unknown }
  | { op: 'read'; id: string }
  | { op: 'detail'; id: string; revision: number; propertyId: string }
  | { op: 'recalculate'; id: string; revision: number; request: unknown }
  | { op: 'delete'; id: string; revision: number };
interface Entry { owner: string; capabilityHash: Buffer; expires: number; snapshot: DemoSnapshot }
// Finish every fallible response preparation BEFORE publishing any map mutation.
const prepare = (status: number, body: DemoSessionBody, capability?: string): SessionReply => ({ status, body, serializedBody: JSON.stringify(body), ...(capability === undefined ? {} : {capability}) });
const error = (status: number, code: string): SessionReply => prepare(status, { error: { code } });
function parse(raw: unknown): Command | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !('op' in raw)) return null;
  const exact = (keys: string[]) => Object.keys(raw).length === keys.length && keys.every(k => Object.hasOwn(raw, k));
  if (raw.op === 'create' && 'request' in raw && exact(['op','request'])) return { op: 'create', request: raw.request };
  if (!('id' in raw) || typeof raw.id !== 'string' || !/^[a-f0-9]{32}$/.test(raw.id)) return null;
  if (raw.op === 'read' && exact(['op','id'])) return { op:'read', id:raw.id };
  if (!('revision' in raw) || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 1) return null;
  if (raw.op === 'delete' && exact(['op','id','revision'])) return { op:'delete', id:raw.id, revision:raw.revision };
  if (raw.op === 'recalculate' && 'request' in raw && exact(['op','id','revision','request'])) return { op:'recalculate', id:raw.id, revision:raw.revision, request:raw.request };
  if (raw.op === 'detail' && 'propertyId' in raw && typeof raw.propertyId === 'string' && raw.propertyId.length <= 128 && exact(['op','id','revision','propertyId'])) return { op:'detail', id:raw.id, revision:raw.revision, propertyId:raw.propertyId };
  return null;
}
export function createVaGrowthSessionStore(options: { now?: () => number; ttlMs?: number; capacity?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 15 * 60_000, capacity = options.capacity ?? 3;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86_400_000 || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw Error('invalid-session-bounds');
  const entries = new Map<string, Entry>();
  const service = createVaGrowthAssessment({ now });
  const hash = (s: string) => createHash('sha256').update(s).digest();
  const saved = (entry: Entry, status = 200, capability?: string): SessionReply => prepare(status, { contractVersion:SESSION_VERSION, mode:'va-growth-demo-only', session:structuredClone(entry.snapshot) }, capability);
  return {
    clear() { entries.clear(); },
    execute(raw: unknown, owner: string, capability: string | undefined): SessionReply {
      const t = now();
      for (const [id, entry] of entries) if (entry.expires <= t) entries.delete(id);
      const command = parse(raw);
      if (!command) return error(400, 'invalid-session-request');
      if (!owner) return error(401, 'access-required');
      if (command.op === 'create') {
        if (capability !== undefined) return error(400,'unexpected-session-capability');
        if (entries.size >= capacity) return error(503,'session-capacity');
        const assessed = service.assess(command.request);
        if (!assessed.ok) return error(400,'invalid-assessment');
        let id = randomBytes(16).toString('hex');
        while (entries.has(id)) id = randomBytes(16).toString('hex');
        const secret = randomBytes(32).toString('hex');
        const expires = t + ttl;
        const entry: Entry = { owner, capabilityHash:hash(secret), expires, snapshot:{ id, revision:1, expiresAt:new Date(expires).toISOString(), request:structuredClone(command.request), assessment:assessed.value } };
        const response = saved(entry, 201, secret);
        entries.set(id,entry);
        return response;
      }
      const entry = entries.get(command.id);
      if (!entry || entry.owner !== owner || !capability || !/^[a-f0-9]{64}$/.test(capability) || !timingSafeEqual(hash(capability),entry.capabilityHash)) return error(404,'session-unavailable');
      if (command.op === 'read') return saved(entry);
      if (command.revision !== entry.snapshot.revision) return error(409,'revision-conflict');
      if (command.op === 'delete') { const response = prepare(200, {deleted:true}); entries.delete(command.id); return response; }
      if (command.op === 'detail') {
        const property = entry.snapshot.assessment.properties.find(p => p.id === command.propertyId);
        if (!property || !entry.snapshot.assessment.orderedIds.includes(property.id)) return error(404,'property-not-ranked');
        return prepare(200, { contractVersion:SESSION_VERSION, mode:'va-growth-demo-only', id:command.id, revision:entry.snapshot.revision, expiresAt:entry.snapshot.expiresAt, property:structuredClone(property) });
      }
      const assessed = service.assess(command.request);
      if (!assessed.ok) return error(400,'invalid-assessment');
      if (entry.snapshot.revision === Number.MAX_SAFE_INTEGER) return error(409,'revision-exhausted');
      const next: Entry = { ...entry, snapshot:{ ...entry.snapshot, revision:entry.snapshot.revision+1, request:structuredClone(command.request), assessment:assessed.value } };
      const response = saved(next);
      entries.set(command.id, next);
      return response;
    },
  };
}

/**
 * One future preview call. The file must already exist and already record 156 cents spent.
 * This module never creates a budget and never marks storage as durable.
 */
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { perCallReserveCents, PINNED_MODEL, SPEND_CEILING_CENTS } from './scout-spend-ledger.ts';

export const CLOSED_SPENT_CENTS = 156;
export const REMAINING_CENTS = 104;
const KEYS = ['additionalTransports', 'ceilingCents', 'closedSpentCents', 'maxAdditionalTransports', 'model', 'perCallCents', 'search', 'v'];

export interface LiveActivation {
  v: 3;
  ceilingCents: 260;
  closedSpentCents: 156;
  perCallCents: 104;
  maxAdditionalTransports: 1;
  additionalTransports: number;
  search: false;
  model: typeof PINNED_MODEL;
}

export type ActivationFailure = 'record-unset' | 'record-missing' | 'record-unreadable' | 'record-corrupt' | 'spend-blocked' | 'pricing-uncertain';

export function parseLiveActivation(raw: string): LiveActivation | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== KEYS.join()) return null;
  if (record.v !== 3 || record.search !== false) return null;
  if (record.ceilingCents !== SPEND_CEILING_CENTS || record.closedSpentCents !== CLOSED_SPENT_CENTS) return null;
  if (record.perCallCents !== REMAINING_CENTS || record.maxAdditionalTransports !== 1) return null;
  if (record.model !== PINNED_MODEL) return null;
  if (record.additionalTransports !== 0 && record.additionalTransports !== 1) return null;
  if (record.closedSpentCents + record.perCallCents !== SPEND_CEILING_CENTS) return null;
  return record as unknown as LiveActivation;
}

function fail(kind: ActivationFailure): { ok: false; kind: ActivationFailure } {
  return { ok: false, kind };
}

function locate(recordPath: string): { path: string } | { kind: ActivationFailure } {
  const path = recordPath.trim();
  if (!path) return { kind: 'record-unset' };
  if (!isAbsolute(path)) return { kind: 'record-unreadable' };
  try {
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return { kind: 'record-unreadable' };
  } catch {
    return { kind: 'record-unreadable' };
  }
  return { path };
}

function writeRecord(recordPath: string, record: LiveActivation): void {
  const tmp = `${recordPath}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    const payload = Buffer.from(JSON.stringify(record));
    let offset = 0;
    while (offset < payload.length) offset += writeSync(fd, payload, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, recordPath);
  chmodSync(recordPath, 0o600);
  const dir = openSync(dirname(recordPath), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function withLock<T>(recordPath: string, body: () => T): T {
  const lockDir = `${recordPath}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try { writeFileSync(join(lockDir, 'pid'), String(process.pid), { mode: 0o600 }); } catch { /* The directory is the lock. */ }
      try {
        return body();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (Date.now() - started > 2000) throw Object.assign(new Error('activation-lock'), { code: 'ACTIVATION_LOCK' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
}

/** Takes the one remaining call. A missing file is not created. */
export function claimPreviewCall(recordPath: string): { ok: true; record: LiveActivation } | { ok: false; kind: ActivationFailure } {
  if (perCallReserveCents() === null) return fail('pricing-uncertain');
  const located = locate(recordPath);
  if ('kind' in located) return fail(located.kind);
  try {
    return withLock(located.path, () => {
      if (!existsSync(located.path)) return fail('record-missing');
      if (lstatSync(located.path).isSymbolicLink()) return fail('record-corrupt');
      let raw = '';
      try { raw = readFileSync(located.path, 'utf8'); } catch { return fail('record-unreadable'); }
      const current = parseLiveActivation(raw);
      if (!current) return fail('record-corrupt');
      if (current.additionalTransports >= 1) return fail('spend-blocked');
      const next: LiveActivation = { ...current, additionalTransports: 1 };
      try { writeRecord(located.path, next); } catch { return fail('record-unreadable'); }
      return { ok: true, record: next };
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ACTIVATION_LOCK' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return fail('record-unreadable');
    return fail('record-unreadable');
  }
}

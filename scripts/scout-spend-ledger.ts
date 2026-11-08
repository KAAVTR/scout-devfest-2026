/**
 * Durable total for one hackathon live test.
 * A restart, a new day, a second process, or a crashed request does not clear a reservation.
 * The research handler never initializes this file. --init creates a zero ledger only when the path is absent.
 * Deleting the file and running --init again is a new explicit initialization, not something the server does by itself.
 */
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export const PINNED_MODEL = 'gemini-3.8-flash';
export const SPEND_CEILING_CENTS = 260;
/** Closed first attempt. This file records it and does not reopen it. */
export const PRIOR_SPENT_CENTS = 52;
export const PER_CALL_CENTS = 104;
export const MAX_TRANSPORTS = 1;
export const ATTEMPT = 2;
export const RESEARCH_PROMPT_CHAR_CAP = 2000;
/** Gemini 3 guide: 1 million input tokens and up to 64k output tokens. 1,048,576 and 65,536 are those ceilings. */
export const PUBLISHED_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const PUBLISHED_MODEL_MAX_OUTPUT_TOKENS = 65_536;
/** Standard paid tier through December 31, 2026. Output price includes thinking tokens. No search tool, so no grounding charge. */
export const PUBLISHED_INPUT_USD_PER_MILLION = 0.75;
export const PUBLISHED_OUTPUT_USD_PER_MILLION = 3.75;
export const PRICE_UNTIL_MS = Date.UTC(2027, 0, 1);

const LEDGER_KEYS = ['attempt', 'ceilingCents', 'maxTransports', 'model', 'perCallCents', 'priorSpentCents', 'reservedCents', 'search', 'transports', 'v'];

export interface SpendLedger {
  v: 2;
  attempt: 2;
  ceilingCents: 260;
  priorSpentCents: 52;
  perCallCents: 104;
  maxTransports: 1;
  reservedCents: number;
  transports: number;
  search: false;
  model: typeof PINNED_MODEL;
}

export type LedgerFailure = 'ledger-unset' | 'ledger-missing' | 'ledger-unreadable' | 'ledger-unwritable' | 'ledger-corrupt' | 'spend-blocked' | 'pricing-uncertain';

/**
 * One grounded prompt at the published ceilings: the full context window at the text input rate,
 * the maximum output (the price includes thinking tokens), and one grounding charge.
 * The 512-token request setting is not this number.
 */
export function oneRequestWorstCaseUsd(): number {
  const input = (PUBLISHED_CONTEXT_WINDOW_TOKENS / 1_000_000) * PUBLISHED_INPUT_USD_PER_MILLION;
  const output = (PUBLISHED_MODEL_MAX_OUTPUT_TOKENS / 1_000_000) * PUBLISHED_OUTPUT_USD_PER_MILLION;
  return input + output;
}

/** 104 cents is that ceiling rounded up. It must fit in the 208 cents left after the closed 52-cent attempt. */
export function perCallReserveCents(now = Date.now()): number | null {
  if (now >= PRICE_UNTIL_MS) return null;
  const worst = oneRequestWorstCaseUsd();
  const remaining = SPEND_CEILING_CENTS - PRIOR_SPENT_CENTS;
  if (!Number.isFinite(worst) || worst <= 0 || worst > remaining / 100) return null;
  const cents = Math.ceil(worst * 100 - 1e-9);
  if (cents !== PER_CALL_CENTS || cents > remaining) return null;
  return cents;
}

export function parseSpendLedger(raw: string): SpendLedger | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== LEDGER_KEYS.join()) return null;
  if (record.v !== 2 || record.attempt !== ATTEMPT || record.search !== false) return null;
  if (record.ceilingCents !== SPEND_CEILING_CENTS || record.priorSpentCents !== PRIOR_SPENT_CENTS || record.perCallCents !== PER_CALL_CENTS) return null;
  if (record.maxTransports !== MAX_TRANSPORTS || record.model !== PINNED_MODEL) return null;
  const reserved = record.reservedCents;
  const transports = record.transports;
  if (!Number.isInteger(reserved) || !Number.isInteger(transports)) return null;
  if ((reserved as number) < 0 || (reserved as number) > SPEND_CEILING_CENTS) return null;
  if ((transports as number) < 0 || (transports as number) > MAX_TRANSPORTS) return null;
  if (transports === 0 && reserved !== 0) return null;
  if (transports === 1 && reserved !== PER_CALL_CENTS) return null;
  return record as unknown as SpendLedger;
}

function fail(kind: LedgerFailure): { ok: false; kind: LedgerFailure } {
  return { ok: false, kind };
}

function writeLedger(ledgerPath: string, ledger: SpendLedger): void {
  const tmp = `${ledgerPath}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    const payload = Buffer.from(JSON.stringify(ledger));
    let offset = 0;
    while (offset < payload.length) offset += writeSync(fd, payload, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, ledgerPath);
  chmodSync(ledgerPath, 0o600);
  const dir = openSync(dirname(ledgerPath), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function withLock<T>(ledgerPath: string, body: () => T): T {
  const lockDir = `${ledgerPath}.lock`;
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
      if (Date.now() - started > 2000) throw Object.assign(new Error('ledger-lock'), { code: 'LEDGER_LOCK' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
}

function ledgerPathError(ledgerPath: string): { path: string } | { kind: LedgerFailure } {
  const path = ledgerPath.trim();
  if (!path) return { kind: 'ledger-unset' };
  if (!isAbsolute(path)) return { kind: 'ledger-unreadable' };
  try {
    const parentStat = lstatSync(dirname(path));
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return { kind: 'ledger-unreadable' };
  } catch {
    return { kind: 'ledger-unreadable' };
  }
  return { path };
}

const ZERO_LEDGER: SpendLedger = {
  v: 2,
  attempt: ATTEMPT,
  ceilingCents: SPEND_CEILING_CENTS,
  priorSpentCents: PRIOR_SPENT_CENTS,
  perCallCents: PER_CALL_CENTS,
  maxTransports: MAX_TRANSPORTS,
  reservedCents: 0,
  transports: 0,
  search: false,
  model: PINNED_MODEL,
};

/** Creates a zero ledger. An existing valid file is left unchanged, including one that is already spent. */
export function initSpendLedger(ledgerPath: string): { ok: true; created: boolean } | { ok: false; kind: LedgerFailure } {
  if (perCallReserveCents() === null) return fail('pricing-uncertain');
  const located = ledgerPathError(ledgerPath);
  if ('kind' in located) return fail(located.kind);
  try {
    return withLock(located.path, () => {
      if (existsSync(located.path)) {
        if (lstatSync(located.path).isSymbolicLink()) return fail('ledger-corrupt');
        let raw = '';
        try { raw = readFileSync(located.path, 'utf8'); } catch { return fail('ledger-unreadable'); }
        if (!parseSpendLedger(raw)) return fail('ledger-corrupt');
        return { ok: true, created: false };
      }
      try { writeLedger(located.path, ZERO_LEDGER); } catch { return fail('ledger-unwritable'); }
      return { ok: true, created: true };
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'LEDGER_LOCK' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return fail('ledger-unwritable');
    return fail('ledger-unreadable');
  }
}

/** Records one 25-cent reservation or refuses. A missing file is not a new budget. It never refunds and never resets. */
export function reserveTransport(ledgerPath: string): { ok: true; ledger: SpendLedger } | { ok: false; kind: LedgerFailure } {
  if (perCallReserveCents() === null) return fail('pricing-uncertain');
  const located = ledgerPathError(ledgerPath);
  if ('kind' in located) return fail(located.kind);
  try {
    return withLock(located.path, () => {
      if (!existsSync(located.path)) return fail('ledger-missing');
      if (lstatSync(located.path).isSymbolicLink()) return fail('ledger-corrupt');
      let raw = '';
      try { raw = readFileSync(located.path, 'utf8'); } catch { return fail('ledger-unreadable'); }
      const current = parseSpendLedger(raw);
      if (!current) return fail('ledger-corrupt');
      if (current.transports >= MAX_TRANSPORTS || current.priorSpentCents + current.reservedCents + PER_CALL_CENTS > SPEND_CEILING_CENTS) return fail('spend-blocked');
      if (current.transports !== 0 || current.reservedCents !== 0) return fail('ledger-corrupt');
      const next: SpendLedger = { ...current, reservedCents: PER_CALL_CENTS, transports: 1 };
      try { writeLedger(located.path, next); } catch { return fail('ledger-unwritable'); }
      return { ok: true, ledger: next };
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'LEDGER_LOCK' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return fail('ledger-unwritable');
    return fail('ledger-unreadable');
  }
}

const direct = process.argv[1]?.endsWith('scout-spend-ledger.ts') === true;
if (direct && process.argv[2] === '--init') {
  if (process.env.SCOUT_LEDGER_INIT !== 'test-fixture') {
    process.stderr.write('ledger-init-disabled\n');
    process.exitCode = 1;
  } else {
  const result = initSpendLedger(process.env.SCOUT_SPEND_LEDGER ?? '');
  if (!result.ok) {
    process.stderr.write(`${result.kind}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(result.created ? 'ledger-created\n' : 'ledger-unchanged\n');
  }
  }
}

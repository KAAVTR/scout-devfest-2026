/**
 * Offline phone smoke. Starts the loopback server, ranks the two sample fixtures,
 * reads detail, and checks that providers stay off. No provider SDK call.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROVIDER_KEYS = [
  'GEMINI_API_KEY',
  'RENTCAST_API_KEY',
  'GEMINI_RESEARCH_MODEL',
  'SCOUT_GROUNDING',
  'SCOUT_GROUNDING_ENABLE',
  'SCOUT_EVIDENCE',
  'SCOUT_EVIDENCE_ENABLE',
  'SCOUT_LIVE',
  'SCOUT_PUBLIC_SOURCES',
  'SCOUT_RESEARCH',
  'SCOUT_RESEARCH_ENABLE',
  'SCOUT_RESEARCH_ARM',
];

const rankRequest = {
  contractVersion: 'property-assessment-v1',
  goals: {
    criteria: {
      scope: 'zip',
      locationName: 'ZIP 43215',
      selectedState: 'Ohio',
      selectedMetro: 'Columbus, OH',
      selectedZip: '43215',
      manualListings: [],
      maxPurchasePrice: 450000,
      downPaymentCash: 90000,
      propertyTypes: ['duplex'],
      strategy: 'long-term-rental',
    },
    financingAssumptions: {
      interestRate: 6.5,
      loanTermYears: 30,
      downPaymentPercent: 20,
      propertyTaxRate: 1.25,
      insuranceRate: 0.6,
      maintenanceRate: 5,
      vacancyRate: 5,
      managementRate: 8,
      holdingPeriodYears: 5,
      closingCostPercent: 3,
      initialReserves: 0,
    },
    weightsSnapshot: {
      demographics: 50,
      infrastructure: 50,
      retailAnchors: 50,
      hazardRisk: 50,
      schoolQuality: 50,
      rentYield: 50,
    },
  },
  propertyWeights: { monthlyCashFlow: 50, cashOnCash: 30, capitalBuffer: 20 },
  assumptions: [
    { id: 'demo-fixture-1', rentMonthly: 2760, annualInsurance: 1600, tax: { kind: 'manual', annualAmount: 4000 } },
    { id: 'demo-fixture-2', rentMonthly: 2760, annualInsurance: 1600, tax: { kind: 'manual', annualAmount: 4000 } },
  ],
};

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SCOUT_SKIP_BUILD: '1' };
  for (const key of PROVIDER_KEYS) delete env[key];
  return env;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGINT');
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timer);
}

async function start(args: string[]): Promise<{ child: ChildProcess; base: string }> {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${stderr.slice(-500)}`)), 20000);
    child.stdout?.on('data', () => {
      const line = stdout.split('\n').find((item) => item.includes('"status":"ready"'));
      if (!line) return;
      clearTimeout(timer);
      resolve(line);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr.slice(-500)}`));
    });
  });
  try {
    const line = await ready;
    const parsed = JSON.parse(line) as { status?: string; version?: string; phone?: string; research?: string };
    assert.equal(parsed.status, 'ready');
    assert.equal(parsed.version, 'v21');
    assert.equal(parsed.research, 'off');
    assert.equal(typeof parsed.phone, 'string');
    const base = new URL(parsed.phone ?? '').origin;
    return { child, base };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

async function request(base: string, cookie: { value: string }, path: string, init?: RequestInit): Promise<{ status: number; json: unknown; text: string }> {
  const headers = new Headers(init?.headers);
  if (cookie.value) headers.set('cookie', cookie.value);
  const response = await fetch(new URL(path, base), { ...init, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie.value = setCookie.split(';')[0] ?? cookie.value;
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
}

async function exercise(label: string, args: string[]): Promise<void> {
  const { child, base } = await start(args);
  const cookie = { value: '' };
  try {
    const page = await request(base, cookie, '/phone');
    assert.equal(page.status, 200, label);
    assert.match(page.text, /AI-generated demo evidence — not verified/);
    assert.match(page.text, /monthlyCashFlow: 50, cashOnCash: 30, capitalBuffer: 20/);

    const status = await request(base, cookie, '/api/scout-status');
    assert.equal(status.status, 200, label);
    const statusBody = status.json as { research?: { mode?: string; model?: string | null } };
    assert.equal(statusBody.research?.mode, 'off', label);
    assert.equal(statusBody.research?.model, null, label);

    const created = await request(base, cookie, '/api/demo-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'create', request: rankRequest }),
    });
    assert.equal(created.status, 201, `${label} ${created.text.slice(0, 300)}`);
    const session = (created.json as { session?: { id?: string; revision?: number; assessment?: { orderedIds?: string[]; propertyWeights?: Record<string, number>; properties?: Array<{ id: string; calculation: { purchasePrice: number; cashToClose: number }; ranking: { rank: number }; evidence: { kind: string; provider: unknown; availability: string } }> } } }).session;
    assert.ok(session?.id && session.assessment);
    assert.deepEqual(session.assessment.orderedIds, ['demo-fixture-2', 'demo-fixture-1']);
    assert.deepEqual(session.assessment.propertyWeights, { monthlyCashFlow: 50, cashOnCash: 30, capitalBuffer: 20 });
    const byId = new Map(session.assessment.properties?.map((item) => [item.id, item]));
    const first = byId.get('demo-fixture-2');
    const second = byId.get('demo-fixture-1');
    assert.equal(first?.calculation.purchasePrice, 300000);
    assert.equal(first?.calculation.cashToClose, 69000);
    assert.equal(first?.ranking.rank, 1);
    assert.equal(first?.evidence.kind, 'demo-not-evidence');
    assert.equal(first?.evidence.provider, null);
    assert.equal(first?.evidence.availability, 'not-verified');
    assert.equal(second?.calculation.purchasePrice, 349000);
    assert.equal(second?.calculation.cashToClose, 80270);
    assert.equal(second?.ranking.rank, 2);

    const detail = await request(base, cookie, '/api/demo-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'detail', id: session.id, revision: session.revision, propertyId: 'demo-fixture-1' }),
    });
    assert.equal(detail.status, 200, label);
    const property = (detail.json as { property?: { id?: string; calculation?: { purchasePrice?: number; cashToClose?: number }; evidence?: { provider?: unknown } } }).property;
    assert.equal(property?.id, 'demo-fixture-1');
    assert.equal(property?.calculation?.purchasePrice, 349000);
    assert.equal(property?.calculation?.cashToClose, 80270);
    assert.equal(property?.evidence?.provider, null);

    const research = await request(base, cookie, '/api/scout-research', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ propertyId: 'demo-fixture-2', area: { kind: 'zip', zip: '43215' } }),
    });
    assert.equal(research.status, 200, label);
    const researchBody = research.json as { status?: string; provider?: string; message?: string };
    assert.equal(researchBody.status, 'disabled');
    assert.equal(researchBody.provider, 'off');
    assert.match(researchBody.message ?? '', /No provider was called/);
    console.log(`${label} ok ${base}`);
  } finally {
    await stop(child);
  }
}

const tsxServer = ['--import', 'tsx', 'scripts/scout-serve.ts', '0'];
const bundledServer = ['dist/scout-serve.js', '0'];
await exercise('phone-source', tsxServer);
await exercise('phone-bundle', bundledServer);

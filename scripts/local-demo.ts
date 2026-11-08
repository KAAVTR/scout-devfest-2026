/** Explicit offline demo entry only. Never imported by production server.ts. */
import express from 'express';
import { createVaGrowthSessionStore } from '../server/assessment/vaGrowthSessions';
import { createVaHouseHackRouter } from '../server/http/vaHouseHackRouter';
import { createDemoSessionStore } from '../server/assessment/demoSessions';
import { createDemoSessionRouter } from '../server/http/demoSessionRouter';
import { randomBytes } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createApiApp } from '../server/http/app';
import { guardConfigFromEnv } from '../server/http/guard';
import type { GroundedSearchProvider } from '../server/provider/types';
import { SCOUT_VERSION } from '../shared/scoutVersion.ts';

export async function runLocalDemo(args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && !/^(0|[1-9][0-9]{0,4})$/.test(args[0]))) throw Error('invalid-port');
  const port = args.length ? Number(args[0]) : 0;
  if (port > 65535) throw Error('invalid-port');
  const code = randomBytes(32).toString('hex');
  const dir = await mkdtemp(join(tmpdir(), 'apexprop-demo-'));
  let stopping = false;
  const lifetime = new AbortController();
  const provider: GroundedSearchProvider = {
    name: 'gemini', model: 'offline-demo', configured: false,
    search: async () => ({ ok: false, failure: { kind: 'not-configured', message: 'Offline demo only', retryAfterSeconds: null } }),
  };
  const guard = guardConfigFromEnv({ NODE_ENV: 'production', APEXPROP_ACCESS_TOKEN: code });
  const sessions = createDemoSessionStore();
  const vaGrowthSessions = createVaGrowthSessionStore();
  const app = express();
  app.set('trust proxy', false);
  app.use('/api/va-growth-sessions', createDemoSessionRouter(guard, vaGrowthSessions));
  app.use('/api/va-househack', createVaHouseHackRouter(guard));
  app.use('/api/demo-sessions', createDemoSessionRouter(guard, sessions));
  app.use(createApiApp({ enableDemoAssessment: true, provider, taxAdapters: [], log: () => {}, guard }));
  const server = createServer(app);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.timeout = 15_000;
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 20;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    sessions.clear();
    vaGrowthSessions.clear();
    lifetime.abort();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  };
  const onSignal = () => { void cleanup().catch(() => { process.exitCode = 1; }); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    await chmod(dir, 0o700);
    const headerFile = join(dir, 'access-header');
    await writeFile(headerFile, `x-apexprop-access: ${code}\n`, { mode: 0o600, flag: 'wx' });
    if (stopping) return;
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen({ port, host: '127.0.0.1', signal: lifetime.signal }, () => { server.off('error', fail); ok(); });
    });
    if (stopping) return;
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('invalid-bind');
    process.stdout.write(JSON.stringify({ status: 'ready', version: SCOUT_VERSION, label: 'DEMO ONLY: synthetic property scenarios, not live listings',
      url: `http://127.0.0.1:${address.port}/api/property-assessment`, headerFile, pid: process.pid }) + '\n');
  } catch {
    await cleanup();
    throw Error('demo-start-failed');
  }
}

function startedDirectly(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    if (import.meta.url === pathToFileURL(resolve(arg)).href) return true;
  } catch { /* A Windows path can still match below. */ }
  try {
    const selfPath = resolve(fileURLToPath(import.meta.url));
    const argPath = resolve(arg);
    return process.platform === 'win32' ? selfPath.toLowerCase() === argPath.toLowerCase() : selfPath === argPath;
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  runLocalDemo(process.argv.slice(2)).catch(() => {
    process.stderr.write('Offline demo could not start. Check the optional port and local permissions.\n');
    process.exitCode = 1;
  });
}

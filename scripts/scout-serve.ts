/**
 * Local Scout UI bridge. Does not modify assessment, finance, or session code.
 * The reviewed local-demo process keeps authentication, origin, method, body, and rate guards.
 * This process only serves the built page on 127.0.0.1 and forwards listed POSTs with the private app header.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { areaCacheFromEnv } from './scout-area-cache.ts';
import { evaluatePreviewConfig, previewHostAllowed, previewOriginAllowed } from './scout-preview-policy.ts';
import { handleEvidenceExplain } from './scout-evidence-explain.ts';
import { handleGroundedDiscovery } from './scout-grounded-discovery.ts';
import { fetchAllowlisted, handleLiveListings, takeLiveRoute } from './scout-live-listings.ts';
import { handleScoutResearch, researchPublicStatus } from './scout-research.ts';
import { SCOUT_VERSION } from '../shared/scoutVersion.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = existsSync(join(HERE, 'phone-demo', 'work.html')) ? HERE : join(HERE, '..');
if (existsSync(join(HERE, 'scout-demo.js'))) {
  for (const key of ['GEMINI_API_KEY', 'RENTCAST_API_KEY', 'SCOUT_GROUNDING', 'SCOUT_GROUNDING_ENABLE', 'SCOUT_EVIDENCE', 'SCOUT_EVIDENCE_ENABLE', 'SCOUT_LIVE', 'SCOUT_PUBLIC_SOURCES', 'SCOUT_RESEARCH', 'SCOUT_RESEARCH_ENABLE', 'SCOUT_RESEARCH_ARM', 'PORT']) delete process.env[key];
  process.env.SCOUT_SKIP_BUILD = '1';
}
const DIST = join(ROOT, 'scout', 'dist');
const POST_PATHS = new Set([
  '/api/va-growth-sessions',
  '/api/va-househack',
  '/api/demo-sessions',
  '/api/property-assessment',
]);
const MAX_BODY = 16 * 1024;
interface BrowserClient { token: string; capabilities: Map<string, string> }
const clients = new Map<string, BrowserClient>();
let proxiedPosts = 0;
let ownedChild: ChildProcess | null = null;
let ownedDemoDir: string | null = null;
let ownedServer: ReturnType<typeof createServer> | null = null;
let shutdownStarted = false;

function childEnv(): NodeJS.ProcessEnv {
  const temp = process.env.TEMP ?? process.env.TMP ?? process.env.TMPDIR ?? tmpdir();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? temp,
    TMPDIR: process.env.TMPDIR ?? temp,
    TEMP: temp,
    TMP: process.env.TMP ?? temp,
  };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'PATHEXT', 'ComSpec', 'COMSPEC', 'windir', 'WINDIR', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

function startedDirectly(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    if (import.meta.url === pathToFileURL(resolvePath(arg)).href) return true;
  } catch { /* A Windows path can still match below. */ }
  try {
    const selfPath = resolvePath(fileURLToPath(import.meta.url));
    const argPath = resolvePath(arg);
    return process.platform === 'win32' ? selfPath.toLowerCase() === argPath.toLowerCase() : selfPath === argPath;
  } catch {
    return false;
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload).toString(),
    ...extra,
  });
  res.end(payload);
}

function cookieValue(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'scout_local') return rest.join('=');
  }
  return null;
}

function clientFromRequest(req: IncomingMessage): BrowserClient | null {
  const value = cookieValue(req);
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  const client = clients.get(value);
  if (!client || !sameSecret(client.token, value)) return null;
  return client;
}

function mintClient(res: ServerResponse): BrowserClient {
  const token = randomBytes(32).toString('hex');
  const client = { token, capabilities: new Map<string, string>() };
  clients.set(token, client);
  res.setHeader('Set-Cookie', `scout_local=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
  return client;
}

function parseListenPort(raw: string): number {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(raw)) throw Error('invalid-port');
  const port = Number(raw);
  if (!Number.isInteger(port) || port > 65535) throw Error('invalid-port');
  return port;
}

async function shutdown(code: number): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const child = ownedChild;
  ownedServer?.close();
  const childPid = child?.pid;
  if (child && child.exitCode === null && childPid) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32') child.kill();
          else process.kill(-childPid, 'SIGKILL');
        } catch { /* The owned child is already gone. */ }
        resolve();
      }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-childPid, 'SIGINT');
      } catch { try { child.kill('SIGINT'); } catch { /* already gone */ } }
    });
  }
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  if (ownedDemoDir) {
    try { rmSync(ownedDemoDir, { recursive: true, force: true }); } catch { /* The child already removed it. */ }
  }
  process.exit(code);
}

function contentType(file: string): string {
  switch (extname(file)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.ttf': return 'font/ttf';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function safeFile(urlPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/'); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const rel = decoded === '/' ? '/index.html' : decoded;
  const full = normalize(join(DIST, rel));
  const root = normalize(DIST + sep);
  if (full !== join(DIST, 'index.html') && !full.startsWith(root)) return null;
  return full;
}

function readBody(req: IncomingMessage): Promise<Buffer | 'too-large' | 'incomplete'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Buffer | 'too-large' | 'incomplete') => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        settle('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('aborted', () => settle('incomplete'));
    req.on('error', () => settle('incomplete'));
    req.on('close', () => { if (!req.complete) settle('incomplete'); });
    req.on('end', () => {
      if (settled || !req.complete) {
        settle('incomplete');
        return;
      }
      const declared = req.headers['content-length'];
      const body = Buffer.concat(chunks);
      if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) !== body.length) {
        settle('incomplete');
        return;
      }
      settle(body);
    });
  });
}

function rememberCapability(client: BrowserClient, responseBody: Buffer, header: string | string[] | undefined): void {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return;
  try {
    const parsed = JSON.parse(responseBody.toString('utf8')) as { session?: { id?: unknown } };
    const id = parsed.session?.id;
    if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) client.capabilities.set(id, value);
  } catch {
    /* This client's capability stays in memory only when the saved id is present. */
  }
}

function proxyPost(req: IncomingMessage, res: ServerResponse, body: Buffer, client: BrowserClient, token: string, port: number, path: string): void {
  let capability: string | undefined;
  let sessionId = '';
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { op?: unknown; id?: unknown };
    const op = typeof parsed.op === 'string' ? parsed.op : '';
    sessionId = typeof parsed.id === 'string' ? parsed.id : '';
    if (op && op !== 'create' && /^[a-f0-9]{32}$/.test(sessionId)) capability = client.capabilities.get(sessionId);
  } catch {
    capability = undefined;
  }
  const headers: Record<string, string> = {
    'content-length': body.length.toString(),
    'x-apexprop-access': token,
    connection: 'close',
  };
  if (typeof req.headers['content-type'] === 'string') headers['content-type'] = req.headers['content-type'];
  if (typeof req.headers['content-encoding'] === 'string') headers['content-encoding'] = req.headers['content-encoding'];
  if (capability) headers['x-apexprop-session'] = capability;
  const upstream = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path,
    headers,
    timeout: 15_000,
  }, (upstreamResponse) => {
    const chunks: Buffer[] = [];
    upstreamResponse.on('data', (chunk: Buffer) => {
      if (chunks.reduce((sum, item) => sum + item.length, 0) + chunk.length > 2_000_000) {
        upstreamResponse.destroy();
        if (!res.headersSent) sendJson(res, 502, { error: { code: 'internal-error' } });
      } else chunks.push(chunk);
    });
    upstreamResponse.on('end', () => {
      const payload = Buffer.concat(chunks);
      rememberCapability(client, payload, upstreamResponse.headers['x-apexprop-session']);
      if ((upstreamResponse.statusCode ?? 0) === 200 && sessionId) {
        try {
          const parsed = JSON.parse(payload.toString('utf8')) as { deleted?: unknown };
          if (parsed.deleted === true) client.capabilities.delete(sessionId);
        } catch { /* Leave this client's capability when the body is not a delete receipt. */ }
      }
      proxiedPosts += 1;
      const retry = upstreamResponse.headers['retry-after'];
      const extra: Record<string, string> = {};
      if (typeof retry === 'string' && /^\d+$/.test(retry)) extra['Retry-After'] = retry;
      res.writeHead(upstreamResponse.statusCode ?? 502, {
        ...securityHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': payload.length.toString(),
        ...extra,
      });
      res.end(payload);
    });
  });
  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { error: { code: 'unavailable' } });
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.end(body);
}

function startBackend(): Promise<{ port: number; token: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const bundledDemo = join(HERE, 'scout-demo.js');
    const child = spawn(process.execPath, existsSync(bundledDemo) ? [bundledDemo, '0'] : ['--import', 'tsx', join(ROOT, 'scripts', 'local-demo.ts'), '0'], {
      cwd: ROOT,
      env: childEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ownedChild = child;
    let buffer = '';
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Error(message));
    };
    const timer = setTimeout(() => fail('demo-start-timeout'), 20_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0 || settled) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      try {
        const ready = JSON.parse(line) as { status?: string; url?: string; headerFile?: string };
        if (ready.status !== 'ready' || !ready.url || !ready.headerFile) {
          fail('demo-start-unreadable');
          return;
        }
        const port = Number(new URL(ready.url).port);
        const header = readFileSync(ready.headerFile, 'utf8');
        const match = header.match(/^x-apexprop-access:\s*([a-f0-9]{64})\s*$/i);
        if (!Number.isInteger(port) || !match?.[1]) {
          fail('demo-start-unreadable');
          return;
        }
        const demoDir = dirname(ready.headerFile);
        const tempRoot = resolvePath(tmpdir());
        const resolvedDir = resolvePath(demoDir);
        if (resolvedDir.startsWith(tempRoot + sep) && basename(demoDir).startsWith('apexprop-demo-')) ownedDemoDir = resolvedDir;
        settled = true;
        clearTimeout(timer);
        resolve({ port, token: match[1], child });
      } catch {
        fail('demo-start-unreadable');
      }
    });
    child.stderr?.on('data', () => {
      /* Child diagnostics stay off this process's output so private paths are not copied. */
    });
    child.on('exit', () => {
      if (!settled) fail('demo-start-exited');
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, uiPort: number, apiPort: number, token: string): Promise<void> {
  const preview = evaluatePreviewConfig(process.env);
  const host = req.headers.host;
  if (!previewHostAllowed(host, uiPort, preview)) {
    sendJson(res, 403, { error: { code: 'cross-origin' } });
    return;
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${uiPort}`);
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { error: { code: 'cross-origin' } });
    return;
  }
  const origin = req.headers.origin;
  if (!previewOriginAllowed(typeof origin === 'string' ? origin : undefined, uiPort, preview)) {
    sendJson(res, 403, { error: { code: 'cross-origin' } });
    return;
  }
  if (url.pathname === '/api/scout-status' && req.method === 'GET') {
    sendJson(res, 200, {
      service: 'scout-local-demo',
      persistence: 'memory-only',
      ttlMinutes: 15,
      sessionCapacity: 3,
      rateLimitPerRoute: 6,
      rateWindowMinutes: 10,
      proxiedPosts,
      restartClearsSessions: true,
      research: researchPublicStatus(process.env),
    });
    return;
  }
  if (url.pathname === '/api/scout-research') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'POST' });
      return;
    }
    const client = clientFromRequest(req);
    if (!client) {
      sendJson(res, 401, { error: { code: 'access-required' } });
      return;
    }
    if (req.headers['transfer-encoding']) {
      sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    const encoding = req.headers['content-encoding'];
    if (typeof encoding === 'string' && encoding.toLowerCase() !== 'identity') {
      sendJson(res, 415, { error: { code: 'invalid-request' } });
      return;
    }
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, { error: { code: 'invalid-request' } });
      return;
    }
    const researchBody = await readBody(req);
    if (researchBody === 'too-large') {
      sendJson(res, 413, { error: { code: 'invalid-request' } });
      return;
    }
    if (researchBody === 'incomplete') {
      if (!res.headersSent) sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(researchBody.toString('utf8')); } catch {
      sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    const reply = await handleScoutResearch({ env: process.env, clientToken: client.token, body: parsed });
    if (reply.httpStatus === 429) {
      const retry = reply.body.failure && typeof reply.body.failure === 'object' && reply.body.failure !== null && 'retryAfterSeconds' in reply.body.failure ? reply.body.failure.retryAfterSeconds : null;
      sendJson(res, 429, reply.body, typeof retry === 'number' ? { 'Retry-After': String(retry) } : {});
      return;
    }
    sendJson(res, reply.httpStatus, reply.body);
    return;
  }
  if (url.pathname === '/api/live-listings') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'POST' });
      return;
    }
    const client = clientFromRequest(req);
    if (!client) {
      sendJson(res, 401, { error: { code: 'access-required' } });
      return;
    }
    if (req.headers['transfer-encoding']) {
      sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    const encoding = req.headers['content-encoding'];
    if (typeof encoding === 'string' && encoding.toLowerCase() !== 'identity') {
      sendJson(res, 415, { error: { code: 'invalid-request' } });
      return;
    }
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, { error: { code: 'invalid-request' } });
      return;
    }
    const retryAfter = takeLiveRoute(client.token, Date.now());
    if (retryAfter !== null) {
      sendJson(res, 429, { status: 'error', financeUntouched: true, failure: { kind: 'rate-limited', message: 'This browser has used its 6 live-listing requests for 10 minutes.', retryAfterSeconds: retryAfter } }, { 'Retry-After': String(retryAfter) });
      return;
    }
    const liveBody = await readBody(req);
    if (liveBody === 'too-large' || liveBody === 'incomplete') {
      sendJson(res, liveBody === 'too-large' ? 413 : 400, { error: { code: 'invalid-request' } });
      return;
    }
    let liveParsed: unknown;
    try { liveParsed = JSON.parse(liveBody.toString('utf8')); } catch {
      sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    const publicSources = process.env.SCOUT_PUBLIC_SOURCES === '1';
    const cacheInfo = publicSources ? areaCacheFromEnv(process.env) : null;
    const outbound = new AbortController();
    const stopOutbound = () => outbound.abort();
    req.on('aborted', stopOutbound);
    res.on('close', () => { if (!res.writableEnded) stopOutbound(); });
    const liveReply = await handleLiveListings({
      body: liveParsed,
      fetcher: publicSources ? (url, init) => fetchAllowlisted(url, { signal: init?.signal ?? outbound.signal }) : undefined,
      signal: outbound.signal,
      cache: cacheInfo?.cache,
      cacheStore: cacheInfo?.store,
      cacheWarning: cacheInfo?.warning ?? null,
    });
    if (liveReply.httpStatus === 429) {
      const retry = liveReply.body.failure && typeof liveReply.body.failure === 'object' && liveReply.body.failure !== null && 'retryAfterSeconds' in liveReply.body.failure ? liveReply.body.failure.retryAfterSeconds : null;
      sendJson(res, 429, liveReply.body, typeof retry === 'number' ? { 'Retry-After': String(retry) } : {});
      return;
    }
    sendJson(res, liveReply.httpStatus, liveReply.body);
    return;
  }
  if (url.pathname === '/api/evidence-explain') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'POST' });
      return;
    }
    const client = clientFromRequest(req);
    if (!client) {
      sendJson(res, 401, { error: { code: 'access-required' } });
      return;
    }
    const encoding = req.headers['content-encoding'];
    if (typeof encoding === 'string' && encoding.toLowerCase() !== 'identity') {
      sendJson(res, 415, { error: { code: 'invalid-request' } });
      return;
    }
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, { error: { code: 'invalid-request' } });
      return;
    }
    const evidenceBody = await readBody(req);
    if (evidenceBody === 'too-large' || evidenceBody === 'incomplete') {
      sendJson(res, evidenceBody === 'too-large' ? 413 : 400, { error: { code: 'invalid-request' } });
      return;
    }
    let evidenceParsed: unknown;
    try { evidenceParsed = JSON.parse(evidenceBody.toString('utf8')); } catch {
      sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    const evidenceReply = await handleEvidenceExplain({ env: process.env, body: evidenceParsed });
    sendJson(res, evidenceReply.httpStatus, evidenceReply.body);
    return;
  }
  if (url.pathname === '/api/grounded-discovery') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'POST' });
      return;
    }
    const client = clientFromRequest(req);
    if (!client) {
      sendJson(res, 401, { error: { code: 'access-required' } });
      return;
    }
    const encoding = req.headers['content-encoding'];
    if (typeof encoding === 'string' && encoding.toLowerCase() !== 'identity') {
      sendJson(res, 415, { error: { code: 'invalid-request' } });
      return;
    }
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, { error: { code: 'invalid-request' } });
      return;
    }
    const discoveryBody = await readBody(req);
    if (discoveryBody === 'too-large' || discoveryBody === 'incomplete') {
      sendJson(res, discoveryBody === 'too-large' ? 413 : 400, { error: { code: 'invalid-request' } });
      return;
    }
    let discoveryParsed: unknown;
    try { discoveryParsed = JSON.parse(discoveryBody.toString('utf8')); } catch {
      sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    const discoveryReply = await handleGroundedDiscovery({ env: process.env, body: discoveryParsed });
    if (discoveryReply.httpStatus === 429 || discoveryReply.httpStatus === 402) {
      sendJson(res, discoveryReply.httpStatus, discoveryReply.body);
      return;
    }
    sendJson(res, discoveryReply.httpStatus, discoveryReply.body);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (!POST_PATHS.has(url.pathname) || url.search) {
      sendJson(res, 404, { error: { code: 'not-found' } });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'POST' });
      return;
    }
    const client = clientFromRequest(req);
    if (!client) {
      sendJson(res, 401, { error: { code: 'access-required' } });
      return;
    }
    if (req.headers['transfer-encoding']) {
      sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    const body = await readBody(req);
    if (body === 'too-large') {
      sendJson(res, 413, { error: { code: 'invalid-request' } });
      return;
    }
    if (body === 'incomplete') {
      if (!res.headersSent) sendJson(res, 400, { error: { code: 'invalid-request' } });
      return;
    }
    proxyPost(req, res, body, client, token, apiPort, url.pathname);
    return;
  }
  const phoneImage = url.pathname === '/phone-assets/house-left-pass.jpg'
    ? 'house-left-pass.jpg'
    : url.pathname === '/phone-assets/house-right-inspect.jpg'
      ? 'house-right-inspect.jpg'
      : '';
  if (phoneImage) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'GET' });
      return;
    }
    const imagePath = join(ROOT, 'phone-demo', phoneImage);
    if (!existsSync(imagePath)) {
      sendJson(res, 404, { error: { code: 'not-found' } });
      return;
    }
    const imageBody = readFileSync(imagePath);
    res.writeHead(200, { ...securityHeaders(), 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', 'Content-Length': imageBody.length.toString() });
    res.end(req.method === 'HEAD' ? undefined : imageBody);
    return;
  }
  if (url.pathname === '/phone' || url.pathname === '/phone/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'GET' });
      return;
    }
    const phonePage = join(ROOT, 'phone-demo', 'work.html');
    if (!existsSync(phonePage)) {
      sendJson(res, 404, { error: { code: 'not-found' } });
      return;
    }
    if (!clientFromRequest(req)) mintClient(res);
    const phoneBody = readFileSync(phonePage);
    const phoneHeaders = securityHeaders();
    phoneHeaders['Content-Security-Policy'] = phoneHeaders['Content-Security-Policy'].replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    res.writeHead(req.method === 'HEAD' ? 200 : 200, {
      ...phoneHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': phoneBody.length.toString(),
    });
    res.end(req.method === 'HEAD' ? undefined : phoneBody);
    return;
  }
  if (url.pathname === '/phone/sample') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'GET' });
      return;
    }
    const samplePage = join(ROOT, 'phone-demo', 'index.html');
    if (!existsSync(samplePage)) {
      sendJson(res, 404, { error: { code: 'not-found' } });
      return;
    }
    if (!clientFromRequest(req)) mintClient(res);
    const sampleBody = readFileSync(samplePage);
    const sampleHeaders = securityHeaders();
    sampleHeaders['Content-Security-Policy'] = sampleHeaders['Content-Security-Policy'].replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    res.writeHead(200, { ...sampleHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': sampleBody.length.toString() });
    res.end(req.method === 'HEAD' ? undefined : sampleBody);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: { code: 'method-not-allowed' } }, { Allow: 'GET' });
    return;
  }
  const file = safeFile(url.pathname);
  const fallback = join(DIST, 'index.html');
  const selected = file && existsSync(file) && statSync(file).isFile() ? file : fallback;
  if (!existsSync(selected)) {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const phonePage = join(ROOT, 'phone-demo', 'work.html');
      if (existsSync(phonePage)) {
        if (!clientFromRequest(req)) mintClient(res);
        const phoneBody = readFileSync(phonePage);
        const phoneHeaders = securityHeaders();
        phoneHeaders['Content-Security-Policy'] = phoneHeaders['Content-Security-Policy'].replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
        res.writeHead(200, { ...phoneHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': phoneBody.length.toString() });
        res.end(req.method === 'HEAD' ? undefined : phoneBody);
        return;
      }
    }
    sendJson(res, 503, { error: { code: 'ui-not-built' } });
    return;
  }
  const headers = {
    ...securityHeaders(),
    'Content-Type': contentType(selected),
    'Cache-Control': selected.endsWith('index.html') ? 'no-store' : 'no-cache',
  };
  if (selected.endsWith('index.html') && !clientFromRequest(req)) mintClient(res);
  res.writeHead(req.method === 'HEAD' ? 200 : 200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(selected).pipe(res);
}

async function main(): Promise<void> {
  process.on('SIGINT', () => { void shutdown(0); });
  process.on('SIGTERM', () => { void shutdown(0); });
  const preview = evaluatePreviewConfig(process.env);
  if (!preview.ok) {
    process.stderr.write(`${preview.reason}\n`);
    await shutdown(1);
    return;
  }
  const arg = process.argv[2];
  const fromEnv = process.env.SCOUT_PORT;
  const requested = arg ?? fromEnv ?? '47221';
  const port = parseListenPort(requested);
  if (process.env.SCOUT_SKIP_BUILD !== '1') {
    const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const built = spawn(process.execPath, [vite, 'build', '--config', join(ROOT, 'scout', 'vite.config.ts')], {
      cwd: ROOT,
      env: childEnv(),
      stdio: 'inherit',
    });
    const code = await new Promise<number>((resolve) => built.on('exit', (status) => resolve(status ?? 1)));
    if (code !== 0) throw Error('ui-build-failed');
  }
  const backend = await startBackend();
  const server = createServer((req, res) => {
    const address = server.address();
    const uiPort = address && typeof address !== 'string' ? address.port : 0;
    void handle(req, res, uiPort, backend.port, backend.token).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal-error' } });
    });
  });
  ownedServer = server;
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.maxConnections = 64;
  const listenOn = (listenPort: number) => new Promise<void>((resolve, reject) => {
    const onStartupError = (err: Error) => {
      server.off('error', onStartupError);
      reject(err);
    };
    server.once('error', onStartupError);
    server.listen({ host: '127.0.0.1', port: listenPort }, () => {
      server.off('error', onStartupError);
      resolve();
    });
  });
  try {
    await listenOn(port);
  } catch (err) {
    const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' && port === 47221;
    if (!busy) throw err;
    process.stderr.write('Port 47221 is in use. Listening on 47232.\n');
    await listenOn(47232);
  }
  server.on('error', () => {
    process.stderr.write('Scout listener failed after start. Stopping the owned assessment process.\n');
    void shutdown(1);
  });
  if (process.env.SCOUT_TEST_POST_LISTEN_ERRORS === '1') {
    setTimeout(() => server.emit('error', new Error('injected-post-listen-1')), 50);
    setTimeout(() => server.emit('error', new Error('injected-post-listen-2')), 150);
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('invalid-bind');
  process.stdout.write(JSON.stringify({
    status: 'ready',
    version: SCOUT_VERSION,
    service: 'scout-local-demo',
    ui: `http://127.0.0.1:${address.port}`,
    phone: `http://127.0.0.1:${address.port}/phone`,
    persistence: 'memory-only',
    ttlMinutes: 15,
    sessionCapacity: 3,
    research: researchPublicStatus(process.env).mode,
  }) + '\n');
  process.stdout.write(`Open http://127.0.0.1:${address.port}/phone in a browser on this computer.\n`);
}

if (startedDirectly()) {
  main().catch(() => {
    process.stderr.write('Scout could not start. Check the port and that dependencies are installed.\n');
    void shutdown(1);
  });
}

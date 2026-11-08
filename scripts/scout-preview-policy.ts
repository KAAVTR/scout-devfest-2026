/** Private preview access. The default is local loopback. A partial preview configuration does not start. */

export interface PreviewDecision {
  ok: boolean;
  reason: string;
  hosts: string[] | null;
  origins: string[] | null;
}

function list(raw: string | undefined): string[] | null {
  if (!raw || !raw.trim()) return null;
  const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) return null;
  if (items.some((item) => item === '*' || item.includes('*'))) return null;
  return items;
}

/** SCOUT_PREVIEW is unset for the local demo. SCOUT_PREVIEW=1 requires explicit hosts and origins. */
export function evaluatePreviewConfig(env: NodeJS.ProcessEnv): PreviewDecision {
  if (env.PORT && env.SCOUT_PREVIEW !== '1') {
    return { ok: false, reason: 'PORT is set without SCOUT_PREVIEW=1. Refusing to choose a public bind.', hosts: null, origins: null };
  }
  if (env.SCOUT_PREVIEW !== '1') {
    return { ok: true, reason: 'local', hosts: null, origins: null };
  }
  const hosts = list(env.SCOUT_PREVIEW_HOSTS);
  const origins = list(env.SCOUT_PREVIEW_ORIGINS);
  if (!hosts || !origins) {
    return { ok: false, reason: 'SCOUT_PREVIEW=1 needs explicit SCOUT_PREVIEW_HOSTS and SCOUT_PREVIEW_ORIGINS. Wildcards are refused.', hosts: null, origins: null };
  }
  if (origins.some((origin) => origin === 'null' || !/^https?:\/\/[^/]+$/.test(origin))) {
    return { ok: false, reason: 'A preview origin must be an http(s) origin with no path and no wildcard.', hosts: null, origins: null };
  }
  return { ok: true, reason: 'preview', hosts, origins };
}

export function previewHostAllowed(host: string | undefined, uiPort: number, decision: PreviewDecision): boolean {
  if (!decision.ok) return false;
  if (!decision.hosts) return host === `127.0.0.1:${uiPort}`;
  return host !== undefined && decision.hosts.includes(host);
}

export function previewOriginAllowed(origin: string | undefined, uiPort: number, decision: PreviewDecision): boolean {
  if (!decision.ok) return false;
  if (!origin) return true;
  if (!decision.origins) return origin === `http://127.0.0.1:${uiPort}`;
  return decision.origins.includes(origin);
}

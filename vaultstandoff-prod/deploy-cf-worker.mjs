// One-off: redeploy the standoff.vaultrobbers.com proxy Worker with real-client-IP forwarding.
// Does NOT touch the platform skill. Token from env (never logged). Secret from env.
const CF_API = 'https://api.cloudflare.com/client/v4';
const COMPAT_DATE = '2024-11-01';
const token = process.env.CF_API_TOKEN;
const SECRET = process.env.VS_PROXY_SECRET;
const ORIGIN = 'build-fdb6259277d28616cd0aa5a0.emblem.build';
const BASE = '/pub/main/vault-standoff';
const APEX = 'vaultrobbers.com';
const SCRIPT = 'emblem-main-vault-standoff';
if (!token || !SECRET) { console.error('missing CF_API_TOKEN or VS_PROXY_SECRET'); process.exit(2); }

async function cf(method, path, { body, headers } = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !headers ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body ? (headers ? body : JSON.stringify(body)) : undefined,
  });
  let json; try { json = await res.json(); } catch { json = { success: false, errors: [{ message: `non-JSON ${res.status}` }] }; }
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

const WORKER = `// proxy.js — standoff.vaultrobbers.com. Forwards the REAL client IP (per-player rate buckets).
const ORIGIN = '${ORIGIN}';
const BASE = '${BASE}';
const PROXY_SECRET = '${SECRET}';
export default {
  async fetch(request) {
    const inUrl = new URL(request.url);
    const up = new URL(request.url);
    up.hostname = ORIGIN; up.protocol = 'https:'; up.port = '';
    up.pathname = BASE + (inUrl.pathname === '/' ? '/' : inUrl.pathname);
    const headers = new Headers(request.headers);
    headers.set('Host', ORIGIN);
    headers.set('X-Forwarded-Host', inUrl.host);
    headers.set('X-Forwarded-Proto', 'https');
    // Per-player rate limiting: forward the real client IP with a shared secret the origin trusts.
    // Always strip any client-supplied pair first so it can never be spoofed; only set when CF gives us the IP.
    headers.delete('X-VS-Real-IP'); headers.delete('X-VS-Proxy-Auth');
    const cip = request.headers.get('CF-Connecting-IP');
    if (cip) { headers.set('X-VS-Real-IP', cip); headers.set('X-VS-Proxy-Auth', PROXY_SECRET); }
    const resp = await fetch(new Request(up, { method: request.method, headers, body: request.body, redirect: 'manual' }));
    const loc = resp.headers.get('Location');
    if (loc) {
      const out = new Headers(resp.headers);
      try {
        const l = new URL(loc, up);
        if (l.hostname === ORIGIN) {
          l.hostname = inUrl.hostname; l.protocol = 'https:'; l.port = '';
          if (l.pathname.startsWith(BASE)) l.pathname = l.pathname.slice(BASE.length) || '/';
          out.set('Location', l.toString());
        }
      } catch (_) {}
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
    }
    return resp;
  },
};
`;

(async () => {
  const zoneRes = await cf('GET', `/zones?name=${encodeURIComponent(APEX)}`);
  const zone = zoneRes.json?.result?.[0];
  if (!zone) { console.error('zone not found / token lacks scope:', JSON.stringify(zoneRes.json?.errors)); process.exit(1); }
  const accountId = zone.account?.id;
  console.log('zone', APEX, zone.status, 'acct', accountId ? 'ok' : 'MISSING');

  const fd = new FormData();
  fd.set('metadata', new Blob([JSON.stringify({ main_module: 'proxy.js', compatibility_date: COMPAT_DATE })], { type: 'application/json' }));
  fd.set('proxy.js', new Blob([WORKER], { type: 'application/javascript+module' }), 'proxy.js');
  const up = await cf('PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}`, { body: fd, headers: {} });
  console.log('worker upload:', up.ok ? 'OK' : 'FAIL ' + JSON.stringify(up.json?.errors));
  if (!up.ok) process.exit(1);

  // read it back and assert the forwarding lines are present
  const back = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${SCRIPT}/content`, { headers: { Authorization: `Bearer ${token}` } });
  const src = await back.text();
  const hasIp = src.includes("headers.set('X-VS-Real-IP'") && src.includes("CF-Connecting-IP");
  const hasSecret = src.includes("X-VS-Proxy-Auth");
  console.log('readback: X-VS-Real-IP line', hasIp ? 'present' : 'MISSING', '| X-VS-Proxy-Auth', hasSecret ? 'present' : 'MISSING');

  // health-check the live domain still serves the right artifact
  try {
    const h = await fetch('https://standoff.vaultrobbers.com/__connect_health', { redirect: 'manual' });
    const j = await h.json().catch(() => null);
    console.log('domain health:', h.status, j ? `${j.group}/${j.name}` : '(no json)');
  } catch (e) { console.log('domain health: fetch error', e.message); }
})();

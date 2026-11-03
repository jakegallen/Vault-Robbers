/* Vault Robbers Gallery — passcode-gated preview of the full 1,000-piece collection.
 *
 * Purpose: give our artist a single shareable link to review every artwork at full
 * resolution, WITHOUT exposing the unreleased art to the public internet.
 *
 * Security model:
 *   - A single ACCESS_CODE gates everything.
 *   - POST /auth validates the code and sets an HttpOnly, signed cookie (HMAC over a
 *     server-generated secret). The cookie value is NOT the code — it's an opaque token
 *     that only this server can mint/verify, so a leaked cookie can't reveal the code.
 *   - EVERY data and image route verifies the cookie. No metadata and no image bytes
 *     are ever served without a valid cookie. The only ungated routes are the passcode
 *     entry page (GET /) and POST /auth.
 *
 * No database. No external API calls. No secrets in client code. The art lives outside
 * the artifact tree (read-only) and is streamed through gated routes only.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Access code (easy to change) -----------------------------------------
const ACCESS_CODE = 'MASK-1000';

// ---- Cookie signing --------------------------------------------------------
// A per-process secret. Generated once at boot; persisted so cookies survive a
// restart. Kept server-side only — never sent to the browser.
const COOKIE_NAME = 'vrg';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SECRET_FILE = path.join(__dirname, '.cookie-secret');

function loadOrCreateSecret() {
  try {
    if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch (_) {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); } catch (_) {}
  return s;
}
const SECRET = loadOrCreateSecret();

// The cookie value is `<expiryMs>.<hmac(expiryMs)>`. Verifying recomputes the HMAC
// (constant-time compare) and checks the expiry — so the server alone can mint it.
function mintToken() {
  const exp = Date.now() + COOKIE_MAX_AGE_MS;
  const sig = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false; // expired
  const expect = crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expect, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Minimal cookie parser (avoids an extra dependency).
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function isAuthed(req) {
  return verifyToken(getCookie(req, COOKIE_NAME));
}

// ---- App -------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

// Art source (lives outside the artifact tree; read-only).
const COLLECTION = '/data/app-groups/main/_vr-art/collection';
const IMG_DIR = path.join(COLLECTION, 'img');
const MYTHICS_DIR = path.join(COLLECTION, 'mythics');
const META_FILE = path.join(COLLECTION, 'metadata.json');

// Load + normalize the 1,000 rows once at boot (immutable source of truth).
function loadCollection() {
  const raw = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  return raw.map((r) => {
    const art = r.tokenId;                 // art index 0-999 (NOT an on-chain id)
    const isMythic = art >= 990;
    const attrs = Array.isArray(r.attributes) ? r.attributes : [];
    const getAttr = (t) => { const a = attrs.find((x) => x.trait_type === t); return a ? a.value : null; };
    return {
      art,                                 // 0-999
      name: r.name,
      image: `img/${art}.png`,             // always the gated /img route (mythics resolved server-side)
      tier: r.rarityTier || null,          // Common/Uncommon/Rare/Ultra/Mythic
      rank: typeof r.rarityRank === 'number' ? r.rarityRank : null,
      isMythic,
      inspiredBy: isMythic ? getAttr('Inspired By') : null,
      klass: isMythic ? getAttr('Class') : null, // Real | Fictional
      attributes: attrs,
    };
  });
}
const COLLECTION_DATA = loadCollection();

// ---- Ungated routes: entry page + auth -------------------------------------
app.get('/', (req, res) => {
  if (isAuthed(req)) return res.sendFile(path.join(PUBLIC, 'gallery.html'));
  res.sendFile(path.join(PUBLIC, 'enter.html'));
});

app.post('/auth', (req, res) => {
  const code = (req.body && (req.body.code != null ? String(req.body.code) : '')).trim();
  const wantsJson = (req.headers['content-type'] || '').includes('application/json');
  if (code !== ACCESS_CODE) {
    if (wantsJson) return res.status(401).json({ ok: false, error: 'Wrong passcode.' });
    return res.redirect('/?e=1');
  }
  const token = mintToken();
  res.setHeader('Set-Cookie', buildCookie(token));
  if (wantsJson) return res.json({ ok: true });
  res.redirect('/');
});

function buildCookie(token) {
  const expires = new Date(Date.now() + COOKIE_MAX_AGE_MS).toUTCString();
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires}`;
}

// Optional: clear the cookie.
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// ---- Gate: everything below requires a valid cookie ------------------------
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Collection metadata (1,000 rows).
app.get('/api/collection', requireAuth, (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json({
    total: COLLECTION_DATA.length,
    generative: COLLECTION_DATA.filter((r) => !r.isMythic).length,
    mythics: COLLECTION_DATA.filter((r) => r.isMythic).length,
    items: COLLECTION_DATA,
  });
});

// Image streaming. Validates `^\d+\.png$`, bounds the index 0-999, and resolves
// 990-999 to the mythics/ dir. Never serves bytes without auth.
app.get('/img/:file', requireAuth, (req, res) => {
  const file = req.params.file;
  if (!/^\d+\.png$/.test(file)) return res.status(400).end();
  const idx = parseInt(file, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx > 999) return res.status(400).end();
  const dir = idx >= 990 ? MYTHICS_DIR : IMG_DIR;
  const full = path.join(dir, `${idx}.png`);
  // Defense in depth: ensure resolved path stays inside the expected directory.
  if (!full.startsWith(dir + path.sep)) return res.status(400).end();
  if (!fs.existsSync(full)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('Content-Type', 'image/png');
  fs.createReadStream(full).pipe(res);
});

// Gated static assets (gallery JS/CSS). enter.html/gallery.html are served via routes
// above, so this only exposes supporting assets to authed clients.
app.use(requireAuth, express.static(PUBLIC, {
  index: false,
  setHeaders: (res) => res.set('Cache-Control', 'private'),
}));

app.listen(process.env.PORT, () => console.log('[vault-robbers-gallery] listening on', process.env.PORT));

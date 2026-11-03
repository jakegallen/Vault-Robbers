'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const LAYERS_DIR = path.join(ROOT, 'layers');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const MANIFEST_PATH = path.join(LAYERS_DIR, 'manifest.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

app.use(express.json({ limit: '16mb' }));

// Serve trait images statically under /layers
app.use('/layers', express.static(LAYERS_DIR, { maxAge: '1h' }));

// Manifest (the authoritative trait catalog)
app.get('/api/manifest', (req, res) => {
  fs.readFile(MANIFEST_PATH, 'utf8', (err, raw) => {
    if (err) return res.status(500).json({ error: 'Manifest not found' });
    try {
      res.json(JSON.parse(raw));
    } catch (e) {
      res.status(500).json({ error: 'Manifest is not valid JSON' });
    }
  });
});

// ---------------------------------------------------------------------------
// Promote an experimental trait into the original (shipping) pool. This flips a
// single trait's "pool" field from "experimental" to "original" in the manifest
// and nothing else: tiers, weights, rules, ids, files are all left intact. It is
// idempotent (promoting an already-original trait is a no-op) and non-destructive
// (no file is moved or deleted). Every move is appended to data/promote-log.json.
// ---------------------------------------------------------------------------
const PROMOTE_LOG = path.join(DATA_DIR, 'promote-log.json');

app.post('/api/promote', (req, res) => {
  const { category, id } = req.body || {};
  if (!category || !id) return res.status(400).json({ error: 'need category and id' });
  fs.readFile(MANIFEST_PATH, 'utf8', (err, raw) => {
    if (err) return res.status(500).json({ error: 'Manifest not found' });
    let manifest;
    try { manifest = JSON.parse(raw); } catch (e) { return res.status(500).json({ error: 'Manifest is not valid JSON' }); }
    const cat = (manifest.categories || []).find((c) => c.key === category);
    if (!cat) return res.status(404).json({ error: 'Unknown category' });
    const trait = (cat.traits || []).find((t) => t.id === id);
    if (!trait) return res.status(404).json({ error: 'Unknown trait' });
    if (trait.pool === 'original') {
      return res.json({ ok: true, alreadyOriginal: true, category, id, name: trait.name });
    }
    trait.pool = 'original';
    fs.mkdir(DATA_DIR, { recursive: true }, () => {
      fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', (wErr) => {
        if (wErr) return res.status(500).json({ error: 'Could not write manifest' });
        const entry = { ts: new Date().toISOString(), category, id, name: trait.name, file: trait.file, from: 'experimental', to: 'original' };
        let logArr = [];
        try { logArr = JSON.parse(fs.readFileSync(PROMOTE_LOG, 'utf8')); } catch (e) { logArr = []; }
        if (!Array.isArray(logArr)) logArr = [];
        logArr.push(entry);
        try { fs.writeFileSync(PROMOTE_LOG, JSON.stringify(logArr, null, 2) + '\n'); } catch (e) { /* log is best-effort */ }
        console.log('promoted ' + category + '/' + id + ' (' + trait.name + ') to original');
        res.json({ ok: true, promoted: entry });
      });
    });
  });
});

// Load the team's saved tuning, or an empty object on first run
app.get('/api/config', (req, res) => {
  fs.readFile(CONFIG_PATH, 'utf8', (err, raw) => {
    if (err) return res.json({});
    try {
      res.json(JSON.parse(raw));
    } catch (e) {
      res.json({});
    }
  });
});

// Persist the team's weight, rule, and one-of-one tuning
app.post('/api/save-config', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Config must be a JSON object' });
  }
  fs.mkdir(DATA_DIR, { recursive: true }, (mkErr) => {
    if (mkErr) return res.status(500).json({ error: 'Could not create data directory' });
    fs.writeFile(CONFIG_PATH, JSON.stringify(body, null, 2), (wErr) => {
      if (wErr) return res.status(500).json({ error: 'Could not write config' });
      res.json({ ok: true, savedAt: new Date().toISOString() });
    });
  });
});

// ---------------------------------------------------------------------------
// One-of-one image generation via the xAI (Grok) image API, server-side only.
// The X_API_KEY is a per-group secret injected into this process; it never
// touches the browser. The route is gated by the dashboard token so public
// visitors cannot burn credits.
// ---------------------------------------------------------------------------
const MYTHIC_SRC = path.join(ROOT, 'mythic-src');
const XAI_URL = 'https://api.x.ai/v1/images/generations';

function genAuthed(req) {
  const tok = process.env.DASHBOARD_TOKEN;
  const hdr = req.headers.authorization || '';
  return tok && hdr === 'Bearer ' + tok;
}

app.get('/api/x-ready', (req, res) => {
  res.json({ ready: !!process.env.X_API_KEY });
});

app.post('/api/generate-1of1', async (req, res) => {
  if (!genAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  const key = process.env.X_API_KEY;
  if (!key) return res.status(400).json({ error: 'X_API_KEY not set in this process' });
  const { index, prompt, n, model } = req.body || {};
  if (typeof index !== 'number' || !prompt) return res.status(400).json({ error: 'need numeric index and prompt' });
  const count = Math.max(1, Math.min(4, Number(n) || 1));
  try {
    fs.mkdirSync(MYTHIC_SRC, { recursive: true });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180000);
    const r = await fetch(XAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: model || 'grok-imagine-image-2.0', prompt, n: count }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!r.ok) return res.status(502).json({ error: 'xai ' + r.status, detail: (data && (data.error || data)) || text.slice(0, 500) });
    const items = (data && data.data) || [];
    const saved = [];
    for (let k = 0; k < items.length; k++) {
      let buf;
      if (items[k].b64_json) buf = Buffer.from(items[k].b64_json, 'base64');
      else if (items[k].url) buf = Buffer.from(await (await fetch(items[k].url)).arrayBuffer());
      else continue;
      const file = `${index}-${k}.png`;
      fs.writeFileSync(path.join(MYTHIC_SRC, file), buf);
      saved.push(file);
    }
    res.json({ ok: true, index, saved, revised: items.map((i) => i.revised_prompt).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// Image-to-image edit of a base Robber, so the body stays identical and only the
// traits and background change. Takes the base image as a data URI. Server-side only.
const XAI_EDIT_URL = 'https://api.x.ai/v1/images/edits';
app.post('/api/edit-1of1', async (req, res) => {
  if (!genAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  const key = process.env.X_API_KEY;
  if (!key) return res.status(400).json({ error: 'X_API_KEY not set in this process' });
  const { index, prompt, image, model } = req.body || {};
  if (typeof index !== 'number' || !prompt || !image) return res.status(400).json({ error: 'need numeric index, prompt, and image data uri' });
  try {
    fs.mkdirSync(MYTHIC_SRC, { recursive: true });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180000);
    const r = await fetch(XAI_EDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: model || 'grok-imagine-image-2.0', prompt, image: { url: image, type: 'image_url' } }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!r.ok) return res.status(502).json({ error: 'xai ' + r.status, detail: (data && (data.error || data)) || text.slice(0, 500) });
    const items = (data && data.data) || [];
    const saved = [];
    for (let k = 0; k < items.length; k++) {
      let buf;
      if (items[k].b64_json) buf = Buffer.from(items[k].b64_json, 'base64');
      else if (items[k].url) buf = Buffer.from(await (await fetch(items[k].url)).arrayBuffer());
      else continue;
      const file = `${index}-${k}.png`;
      fs.writeFileSync(path.join(MYTHIC_SRC, file), buf);
      saved.push(file);
    }
    res.json({ ok: true, index, saved });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log('vaultrobbers-studio listening on ' + PORT);
});

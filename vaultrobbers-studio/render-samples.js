#!/usr/bin/env node
/*
 * Render ~20 curated SAMPLE Vault Robbers for the pass-2 quality-bar review.
 *
 * Same compositing flow as render.js (manifest z-order, sharp, fit:cover on a
 * 2048 canvas). 20 hand-picked combinations spanning Common / Rare / Ultra that
 * exercise the new body silhouettes (lean / broad / hunched), the expanded
 * jackets, masks, eyes, hats and held items. Output to render-out/samples/ with
 * a dark contact-sheet index.html (EmblemScan Developer Hub aesthetic).
 *
 * Standalone. Reads layers/manifest.json. Does not touch render.js, config, the
 * live mint artifact, deployed metadata, or any contract.
 *
 * Pool note: the hand-picked SAMPLES below exercise the expanded generative set,
 * so this sheet is the combined "original + experimental" view. The authoritative
 * original-only vs combined render lives in render.js (VR_POOL=original|all). This
 * script reads whatever the manifest points at regardless of a trait's pool field.
 *
 * Run: node render-samples.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = __dirname;
const LAYERS = path.join(ROOT, 'layers');
const OUT = path.join(ROOT, 'render-out', 'samples');
const S = 2048;

const manifest = JSON.parse(fs.readFileSync(path.join(LAYERS, 'manifest.json'), 'utf8'));
const Z_ORDER = manifest.categories.map((c) => c.key);
const catByKey = {};
for (const c of manifest.categories) catByKey[c.key] = c;

function trait(catKey, traitId) {
  const cat = catByKey[catKey];
  if (!cat) throw new Error(`No category ${catKey}`);
  const t = cat.traits.find((x) => x.id === traitId);
  if (!t) throw new Error(`No trait ${catKey}/${traitId}`);
  return t;
}

const SAMPLES = [
  // -- Common: show body variety + the staple jackets/masks --
  { tier: 'Common', traits: { background: 'concrete', body: 'lean-standing', head: 'classic-skull', clothes: 'trench-charcoal', mask: 'domino-black', eyes: null, headwear: 'fedora', fx: 'faint-sparkle', item: null } },
  { tier: 'Common', traits: { background: 'smoke', body: 'broad-standing', head: 'grinning-skull', clothes: 'bomber-olive', mask: 'gas', eyes: null, headwear: 'beanie', fx: null, item: 'crowbar' } },
  { tier: 'Common', traits: { background: 'slate', body: 'hunched-standing', head: 'brute-skull', clothes: 'vest-tactical', mask: 'ski', eyes: null, headwear: 'cap', fx: null, item: null } },
  { tier: 'Common', traits: { background: 'dusk', body: 'lean-crouch', head: 'wide-eye-skull', clothes: 'denim', mask: 'bandana-navy', eyes: null, headwear: 'cap-back', fx: 'faint-mark', item: 'flashlight' } },
  { tier: 'Common', traits: { background: 'mist', body: 'broad-standing', head: 'cracked-skull', clothes: 'peacoat-slate', mask: 'surgical', eyes: 'wide', headwear: 'newsboy', fx: null, item: null } },
  { tier: 'Common', traits: { background: 'sand', body: 'hunched-crouch', head: 'classic-skull', clothes: 'puffer-plum', mask: 'balaclava', eyes: null, headwear: 'bucket', fx: null, item: 'drill' } },
  { tier: 'Common', traits: { background: 'ash', body: 'lean-standing', head: 'mustache-skull', clothes: 'trench-tan', mask: 'domino-crimson', eyes: 'shades', headwear: null, fx: null, item: 'briefcase' } },
  { tier: 'Common', traits: { background: 'steel', body: 'broad-standing', head: 'grinning-skull', clothes: 'bomber-blood', mask: 'bandana-red', eyes: null, headwear: 'visor', fx: 'faint-sparkle', item: 'spray-can' } },
  { tier: 'Common', traits: { background: 'blush', body: 'hunched-standing', head: 'classic-skull', clothes: 'hoodie-grey', mask: 'surgical', eyes: 'halflid', headwear: 'cap', fx: null, item: null } },
  // -- Rare --
  { tier: 'Rare', traits: { background: 'corner', body: 'lean-peek', head: 'classic-skull', clothes: 'hoodup-black', mask: 'ski', eyes: 'glow-blue', headwear: null, fx: null, item: 'lockpick' } },
  { tier: 'Rare', traits: { background: 'searchlight', body: 'hunched-peek', head: 'wolf-skull', clothes: 'varsity-navy', mask: 'opera', eyes: null, headwear: 'cap-back', fx: 'soft-glints', item: null } },
  { tier: 'Rare', traits: { background: 'alarm-red', body: 'broad-handsup', head: 'classic-skull', clothes: 'raincoat-yellow', mask: 'hockey', eyes: null, headwear: 'bucket', fx: null, item: null } },
  { tier: 'Rare', traits: { background: 'royal', body: 'broad-loot', head: 'grinning-skull', clothes: 'jailbird', mask: 'bandana-red', eyes: null, headwear: 'crown', fx: null, item: null } },
  { tier: 'Rare', traits: { background: 'blackout', body: 'lean-standing', head: 'classic-skull', clothes: 'suit-black', mask: 'opera', eyes: 'glow-gold', headwear: 'tophat', fx: 'gold-dashes', item: 'key' } },
  { tier: 'Rare', traits: { background: 'smoke', body: 'hunched-peek', head: 'olive-alien-skull', clothes: 'hoodie-grey', mask: 'plague', eyes: null, headwear: 'newsboy', fx: null, item: 'flashlight' } },
  { tier: 'Rare', traits: { background: 'slate', body: 'broad-loot', head: 'classic-skull', clothes: 'peacoat-slate', mask: 'respirator', eyes: null, headwear: 'fedora-tan', fx: 'soft-glints', item: 'loot-bag' } },
  // -- Ultra --
  { tier: 'Ultra', traits: { background: 'vault-door', body: 'lean-vault', head: 'classic-skull', clothes: 'suit-black', mask: 'gold-vault', eyes: null, headwear: 'tophat', fx: null, item: 'safe-dial' } },
  { tier: 'Ultra', traits: { background: 'vault-gold', body: 'broad-loot', head: 'grinning-skull', clothes: 'trench-gold', mask: 'gold-vault', eyes: 'dollar', headwear: 'crown', fx: 'gold-dashes', item: 'gold-bar' } },
  { tier: 'Ultra', traits: { background: 'searchlight', body: 'lean-vault', head: 'gas-mask-skull', clothes: 'hoodup-black', mask: null, eyes: 'visor-glow', headwear: 'hood-up', fx: 'soft-glints', item: 'dynamite' } },
  { tier: 'Ultra', traits: { background: 'vault-door', body: 'broad-handsup', head: 'classic-skull', clothes: 'trench-gold', mask: 'gold-vault', eyes: null, headwear: 'gold-halo', fx: 'gold-dashes', item: null } },
];

async function composite(sampleTraits, outPath) {
  const layers = [];
  for (const key of Z_ORDER) {
    const id = sampleTraits[key];
    if (!id) continue;
    const t = trait(key, id);
    const fp = path.join(LAYERS, t.file);
    if (!fs.existsSync(fp)) throw new Error(`Missing file ${t.file}`);
    const buf = await sharp(fp, { density: 300 }).resize(S, S, { fit: 'cover' }).png().toBuffer();
    layers.push({ input: buf });
  }
  await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toFile(outPath);
}

function attrList(sampleTraits) {
  const rows = [];
  for (const key of Z_ORDER) {
    const id = sampleTraits[key];
    if (!id) continue;
    rows.push({ label: catByKey[key].label, value: trait(key, id).name });
  }
  return rows;
}

function contactSheet(items) {
  const cards = items.map((it) => {
    const attrs = it.attrs.map((a) => `<li><span>${a.label}</span>${a.value}</li>`).join('');
    const tierClass = it.tier.toLowerCase();
    return `
    <figure class="card">
      <div class="imgwrap"><img src="${it.file}" alt="Vault Robber sample ${it.n}" loading="lazy"/></div>
      <figcaption>
        <div class="head"><span class="n">#${it.n}</span><span class="tier ${tierClass}">${it.tier}</span></div>
        <ul class="attrs">${attrs}</ul>
      </figcaption>
    </figure>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Vault Robbers Sample Set</title>
<style>
  :root { --bg:#070708; --panel:#101014; --line:#1e1e26; --ink:#e9e9ee; --muted:#9a9aa6;
    --accent:#4ea3ff; --gold:#d9a528; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:40px 32px 18px; border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,#0b0b0f,transparent); }
  h1 { margin:0 0 6px; font-size:26px; letter-spacing:-0.02em; }
  header p { margin:0; color:var(--muted); max-width:720px; }
  .legend { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
  .pill { font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .pill b { color:var(--ink); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:20px; padding:28px 32px 56px; }
  .card { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:14px; overflow:hidden;
    transition:border-color .2s ease, transform .2s ease; }
  .card:hover { border-color:#30303c; transform:translateY(-2px); }
  @media (prefers-reduced-motion: reduce) { .card { transition:none; } .card:hover { transform:none; } }
  .imgwrap { aspect-ratio:1/1; background:#0c0c10; }
  .imgwrap img { width:100%; height:100%; object-fit:contain; display:block; }
  figcaption { padding:12px 14px 14px; border-top:1px solid var(--line); }
  .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
  .n { font-weight:600; letter-spacing:0.02em; }
  .tier { font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; text-transform:uppercase; letter-spacing:0.05em; }
  .tier.common { background:#1a1f27; color:#9fb4c9; }
  .tier.rare { background:#13233a; color:var(--accent); }
  .tier.ultra { background:#2a2007; color:var(--gold); }
  ul.attrs { list-style:none; margin:0; padding:0; display:grid; gap:3px; }
  ul.attrs li { display:flex; justify-content:space-between; gap:12px; font-size:12.5px; }
  ul.attrs li span { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Vault Robbers sample set</h1>
  <p>Twenty robbers across the rarity tiers on the live compositing pipeline, showcasing the redrawn body silhouettes and the expanded apparel.</p>
  <div class="legend">
    <span class="pill"><b>${items.length}</b> samples</span>
    <span class="pill"><b>${items.filter(i=>i.tier==='Common').length}</b> Common</span>
    <span class="pill"><b>${items.filter(i=>i.tier==='Rare').length}</b> Rare</span>
    <span class="pill"><b>${items.filter(i=>i.tier==='Ultra').length}</b> Ultra</span>
  </div>
</header>
<main class="grid">${cards}</main>
</body>
</html>`;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const items = [];
  for (let i = 0; i < SAMPLES.length; i++) {
    const s = SAMPLES[i];
    const file = `sample-${String(i + 1).padStart(2, '0')}.png`;
    await composite(s.traits, path.join(OUT, file));
    items.push({ n: i + 1, file, tier: s.tier, attrs: attrList(s.traits) });
    console.log('rendered', file, `(${s.tier})`);
  }

  fs.writeFileSync(path.join(OUT, 'index.html'), contactSheet(items));
  console.log('wrote index.html contact sheet');
  console.log('output:', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });

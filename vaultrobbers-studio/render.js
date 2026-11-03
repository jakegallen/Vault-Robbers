#!/usr/bin/env node
/*
 * Vault Robbers launch render + metadata pipeline.
 *
 * Standalone script (NOT a server route). Run as:
 *   node render.js [count]
 *
 * Default count is 12 (a small preview). To render the full collection
 * explicitly, pass the total:
 *   node render.js 1000
 *
 * Art-agnostic: reads whatever trait files the manifest points at, PNG or SVG.
 * Loads layers/manifest.json, then overlays data/config.json when present
 * (weights, tier, enabled, noneWeight, rules, mythic, manifest).
 *
 * Output is ART-INDEX keyed (0..999), NOT token-id keyed. The deployed mainnet
 * contract (contracts/vaultrobbers/src/VaultRobbers.sol) resolves tokenURI as
 * baseURI + ((tokenId + startingIndex) % MAX_SUPPLY) + ".json", so the art file
 * a token points to is a 0-indexed number 0..999 while token ids are 1..1000.
 * File 0 must exist. We generate 990 unique generative at art indices 0..989
 * and place the 10 mythics at art indices 990..999.
 *
 * Produces, under render-out/:
 *   images/<n>.png         composited 2048x2048 tokens, n = 0..999 (skipped if sharp fails)
 *   metadata/<n>.json      ERC-721 metadata, n = 0..999
 *   _rarity.json           [{id, rank, score}] id = art index, rank 1 = rarest
 *   _provenance.txt        BAYC-standard provenance: SHA-256 of concatenated per-image SHA-256 (art-index order)
 *   _provenance.json       per-image SHA-256 manifest so anyone can recompute and verify
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const LAYERS_DIR = path.join(ROOT, 'layers');
const MANIFEST_PATH = path.join(LAYERS_DIR, 'manifest.json');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
const OUT_DIR = path.join(ROOT, 'render-out');
const IMAGES_DIR = path.join(OUT_DIR, 'images');
const METADATA_DIR = path.join(OUT_DIR, 'metadata');

const TOTAL = 1000;
const MYTHIC = 10;
const GENERATIVE = TOTAL - MYTHIC; // 990
const CANVAS = 2048;
const IPFS_CID_PLACEHOLDER = 'REPLACE_CID';
const MAX_ATTEMPTS_FACTOR = 200; // guard: attempts per requested generative token

const TIER_WEIGHTS = { common: 100, rare: 28, 'ultra-rare': 6 };

// Pool filter. Default is original-only (the shipping set). Set VR_POOL=all to
// include experimental candidates alongside originals, or VR_POOL=original to be
// explicit. Traits with no pool field are treated as original so older configs
// keep working unchanged.
const POOL_MODE = (process.env.VR_POOL || 'original').toLowerCase();
function traitInPool(t) {
  if (POOL_MODE === 'all' || POOL_MODE === 'original+experimental') return true;
  const p = t.pool || 'original';
  // VR_POOL=experimental rolls ONLY the experimental set (forces the one legless
  // body + the expanded experimental traits); used for experimental sample runs.
  if (POOL_MODE === 'experimental') return p === 'experimental';
  return p === 'original';
}

// z-order is the canonical stacking sequence (background at the back).
// This is a fallback default; loadModel() overwrites it from the manifest so any
// category taxonomy (background, body, clothes, mask, eyes, hat, fx, etc.) works.
let Z_ORDER = ['background', 'body', 'head', 'eyes', 'headwear', 'fx'];

// ---------------------------------------------------------------------------
// Config loading and overlay
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadModel() {
  const manifest = readJson(MANIFEST_PATH);

  let config = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = readJson(CONFIG_PATH);
    } catch (err) {
      console.warn(`Warning: could not parse data/config.json (${err.message}); using manifest defaults.`);
      config = null;
    }
  }

  // config.manifest, when present, replaces the base manifest categories.
  const baseManifest = config && config.manifest ? config.manifest : manifest;
  const canvas = Number(baseManifest.canvas) || CANVAS;

  // Index config category overrides by key for quick lookup.
  const cfgCats = {};
  if (config && Array.isArray(config.categories)) {
    for (const c of config.categories) cfgCats[c.key] = c;
  }

  const categories = (baseManifest.categories || []).map((cat) => {
    const override = cfgCats[cat.key] || {};
    const required = cat.optional !== true; // body and any non-optional cat
    const noneWeight = resolveNoneWeight(cat, override, required);

    const cfgTraitsByIdOrName = indexTraits(override.traits);

    const traits = (cat.traits || []).filter(traitInPool).map((t) => {
      const to = matchTrait(cfgTraitsByIdOrName, t);
      const tier = to.tier != null ? to.tier : t.tier;
      const enabled = to.enabled != null ? to.enabled : (t.enabled != null ? t.enabled : true);
      const weight = resolveWeight(t, to, tier);
      return {
        id: t.id,
        name: t.name,
        file: t.file,
        tier: tier || 'common',
        enabled: enabled !== false,
        weight,
        pool: t.pool || 'original',
      };
    });

    return {
      key: cat.key,
      z: cat.z,
      label: cat.label || cat.key,
      optional: !required,
      noneWeight,
      traits,
    };
  });

  const mythic = config && Array.isArray(config.mythic) ? config.mythic : [];

  const rules = config && Array.isArray(config.rules) ? config.rules : [];

  // Derive the z-order from the manifest so renamed or new categories are honored.
  Z_ORDER = categories.map((c) => c.key);

  return { name: baseManifest.name || 'Vault Robbers', canvas, categories, mythic, rules };
}

function resolveNoneWeight(cat, override, required) {
  if (required) return 0;
  if (override && override.noneWeight != null) return Number(override.noneWeight);
  if (cat.noneWeight != null) return Number(cat.noneWeight);
  return 0;
}

// Prefer an explicit weight override; otherwise derive from tier.
function resolveWeight(baseTrait, overrideTrait, tier) {
  if (overrideTrait && overrideTrait.weight != null) return Number(overrideTrait.weight);
  if (overrideTrait && overrideTrait.tier != null) {
    const w = TIER_WEIGHTS[overrideTrait.tier];
    if (w != null) return w;
  }
  // Derive from tier per the spec. Only fall back to the manifest's own
  // numeric weight when the tier is unknown.
  const tw = TIER_WEIGHTS[tier];
  if (tw != null) return tw;
  if (baseTrait.weight != null) return Number(baseTrait.weight);
  return 100;
}

function indexTraits(traits) {
  const idx = {};
  if (Array.isArray(traits)) {
    for (const t of traits) {
      if (t.id != null) idx['id:' + t.id] = t;
      if (t.name != null) idx['name:' + t.name] = t;
    }
  }
  return idx;
}

function matchTrait(idx, t) {
  if (t.id != null && idx['id:' + t.id]) return idx['id:' + t.id];
  if (t.name != null && idx['name:' + t.name]) return idx['name:' + t.name];
  return {};
}

// ---------------------------------------------------------------------------
// Rule application
// ---------------------------------------------------------------------------

// Rules shape: { ifCat, ifTrait, type: 'exclude'|'force', thenCat, thenTrait }
// exclude: when ifCat==ifTrait is chosen, remove thenTrait from thenCat's pool.
// force:   when ifCat==ifTrait is chosen, pin thenCat to thenTrait.
function applyRules(rules, chosen, categoriesByKey) {
  // chosen: { catKey: traitObjOrNull }
  // Returns possibly-mutated chosen; we re-resolve affected downstream cats.
  const forced = {}; // catKey -> traitId to force
  const excluded = {}; // catKey -> Set of traitIds to remove

  for (const r of rules) {
    if (!r || !r.ifCat || !r.ifTrait) continue;
    const picked = chosen[r.ifCat];
    if (!picked || picked.id !== r.ifTrait) continue;
    if (r.type === 'exclude' && r.thenCat && r.thenTrait) {
      if (!excluded[r.thenCat]) excluded[r.thenCat] = new Set();
      excluded[r.thenCat].add(r.thenTrait);
    } else if (r.type === 'force' && r.thenCat && r.thenTrait) {
      forced[r.thenCat] = r.thenTrait;
    }
  }

  return { forced, excluded };
}

// ---------------------------------------------------------------------------
// Weighted selection
// ---------------------------------------------------------------------------

function weightedPick(entries) {
  // entries: [{ item, weight }]
  const total = entries.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r < 0) return e.item;
  }
  return entries[entries.length - 1].item;
}

function pickCategory(cat, excludedSet, forcedTraitId) {
  const pool = cat.traits.filter(
    (t) => t.enabled && t.weight > 0 && !(excludedSet && excludedSet.has(t.id))
  );

  if (forcedTraitId) {
    const f = pool.find((t) => t.id === forcedTraitId) ||
      cat.traits.find((t) => t.id === forcedTraitId);
    if (f) return f;
  }

  const entries = pool.map((t) => ({ item: t, weight: t.weight }));

  if (cat.optional && cat.noneWeight > 0) {
    // A null item represents "no trait" for this optional category.
    entries.push({ item: null, weight: cat.noneWeight });
  }

  if (entries.length === 0) {
    // Required category with no valid traits is a hard configuration error.
    return null;
  }

  return weightedPick(entries);
}

function buildToken(model) {
  const categoriesByKey = {};
  for (const c of model.categories) categoriesByKey[c.key] = c;

  const chosen = {};

  // First pass: pick every category in z-order.
  for (const key of Z_ORDER) {
    const cat = categoriesByKey[key];
    if (!cat) continue;
    chosen[key] = pickCategory(cat, null, null);
  }

  // Resolve rules, then re-pick any affected downstream categories so that
  // force/exclude constraints are respected.
  const { forced, excluded } = applyRules(model.rules, chosen, categoriesByKey);
  for (const key of Z_ORDER) {
    const cat = categoriesByKey[key];
    if (!cat) continue;
    if (forced[key] || excluded[key]) {
      chosen[key] = pickCategory(cat, excluded[key], forced[key]);
    }
  }

  // Body is required and must always resolve to a present trait.
  if (!chosen.body) {
    const body = categoriesByKey.body;
    const pool = body ? body.traits.filter((t) => t.enabled && t.weight > 0) : [];
    if (pool.length === 0) throw new Error('Body category has no enabled traits; cannot generate.');
    chosen.body = weightedPick(pool.map((t) => ({ item: t, weight: t.weight })));
  }

  return chosen;
}

function comboHash(chosen) {
  // Stable per-token identity over the ordered category -> trait id (or _none_).
  const parts = Z_ORDER.map((key) => {
    const t = chosen[key];
    return key + '=' + (t ? t.id : '_none_');
  });
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ---------------------------------------------------------------------------
// Generation (dedupe + mythic reservation)
// ---------------------------------------------------------------------------

function generate(model, generativeCount) {
  const tokens = [];
  const seen = new Set();
  const maxAttempts = Math.max(1000, generativeCount * MAX_ATTEMPTS_FACTOR);
  let attempts = 0;

  while (tokens.length < generativeCount && attempts < maxAttempts) {
    attempts++;
    const chosen = buildToken(model);
    const hash = comboHash(chosen);
    if (seen.has(hash)) continue;
    seen.add(hash);
    tokens.push({ chosen, hash, mythic: null });
  }

  return { tokens, attempts, maxAttempts };
}

// ---------------------------------------------------------------------------
// Rarity
// ---------------------------------------------------------------------------

function computeRarity(allTokens) {
  const total = allTokens.length;
  // Frequency key: "cat:traitId" plus "cat:_none_" for absent optionals.
  const counts = {};
  for (const tok of allTokens) {
    for (const key of Z_ORDER) {
      const t = tok.chosen ? tok.chosen[key] : null;
      const fk = key + ':' + (t ? t.id : '_none_');
      counts[fk] = (counts[fk] || 0) + 1;
    }
    if (tok.mythic) {
      counts['__mythic__'] = (counts['__mythic__'] || 0) + 1;
    }
  }

  const scored = allTokens.map((tok) => {
    let score = 0;
    for (const key of Z_ORDER) {
      const t = tok.chosen ? tok.chosen[key] : null;
      const fk = key + ':' + (t ? t.id : '_none_');
      const freq = counts[fk] / total;
      score += 1 / freq;
    }
    if (tok.mythic) {
      const freq = counts['__mythic__'] / total;
      score += 1 / freq;
    }
    // Keyed by art index (0..999), the stable public identity of each piece.
    return { id: tok.artIndex, score };
  });

  // Rank by descending score; rank 1 = rarest. Stable tiebreak on art index.
  const ranked = scored.slice().sort((a, b) => b.score - a.score || a.id - b.id);
  const rankById = {};
  ranked.forEach((r, i) => {
    rankById[r.id] = i + 1;
  });

  return { counts, total, scoreById: Object.fromEntries(scored.map((s) => [s.id, s.score])), rankById };
}

// ---------------------------------------------------------------------------
// Image compositing (sharp)
// ---------------------------------------------------------------------------

function layerPath(file) {
  return path.join(LAYERS_DIR, file);
}

async function compositeGenerative(sharp, chosen, outPath) {
  const layers = [];
  for (const key of Z_ORDER) {
    const t = chosen[key];
    if (!t) continue;
    const fp = layerPath(t.file);
    if (!fs.existsSync(fp)) {
      throw new Error(`Missing trait file for ${key}/${t.id}: ${t.file}`);
    }
    // Normalize every layer to the canvas size. sharp reads PNG and SVG.
    const buf = await sharp(fp, { density: 300 })
      .resize(CANVAS, CANVAS, { fit: 'cover' })
      .png()
      .toBuffer();
    layers.push({ input: buf });
  }

  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
    .png()
    .toFile(outPath);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function compositeMythic(sharp, mythicEntry, outPath) {
  const name = (mythicEntry && mythicEntry.name) || 'Mythic';
  const img = mythicEntry && mythicEntry.image ? mythicEntry.image : null;

  if (img) {
    let input;
    if (/^data:/.test(img)) {
      const comma = img.indexOf(',');
      input = Buffer.from(img.slice(comma + 1), 'base64');
    } else {
      const fp = path.isAbsolute(img) ? img : path.join(ROOT, img);
      if (fs.existsSync(fp)) input = fp;
    }
    if (input) {
      await sharp(input, { density: 300 })
        .resize(CANVAS, CANVAS, { fit: 'cover' })
        .png()
        .toFile(outPath);
      return;
    }
  }

  // Labeled placeholder tile with the 1 of 1 name.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a1410"/>
      <stop offset="1" stop-color="#0b0a08"/>
    </linearGradient>
  </defs>
  <rect width="${CANVAS}" height="${CANVAS}" fill="url(#g)"/>
  <rect x="64" y="64" width="${CANVAS - 128}" height="${CANVAS - 128}" fill="none" stroke="#d4af37" stroke-width="12"/>
  <text x="50%" y="46%" fill="#d4af37" font-family="Georgia, serif" font-size="140" font-weight="bold" text-anchor="middle">1 of 1</text>
  <text x="50%" y="56%" fill="#f4ead0" font-family="Georgia, serif" font-size="96" text-anchor="middle">${escapeXml(name)}</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function labelByKey(model) {
  const m = {};
  for (const c of model.categories) m[c.key] = c.label;
  return m;
}

function buildMetadata(model, tok, labels, rank) {
  const attributes = [];
  for (const key of Z_ORDER) {
    const t = tok.chosen ? tok.chosen[key] : null;
    if (!t) continue; // absent optional traits are simply not listed
    attributes.push({ trait_type: labels[key] || key, value: t.name });
  }

  // n is the 0-indexed art number this metadata file is keyed by.
  const n = tok.artIndex;

  let name;
  let description;
  if (tok.mythic) {
    attributes.push({ trait_type: 'Type', value: '1 of 1' });
    if (tok.mythic.inspiredBy) attributes.push({ trait_type: 'Inspired By', value: tok.mythic.inspiredBy });
    if (tok.mythic.klass) attributes.push({ trait_type: 'Class', value: tok.mythic.klass });
    const mythName = tok.mythic.name || `Mythic ${n}`;
    name = `Vault Robber #${n} ${mythName}`;
    description = tok.mythic.lore || `A one of one Vault Robber, ${mythName}, hand selected from the heist crew.`;
  } else {
    name = `Vault Robber #${n}`;
    description = 'A generative Vault Robber assembled from the collection trait set.';
  }

  attributes.push({ trait_type: 'Rank', display_type: 'number', value: rank });

  return {
    name,
    description,
    image: `ipfs://${IPFS_CID_PLACEHOLDER}/${n}.png`,
    attributes,
  };
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

function tierDistribution(model, tokens) {
  // Count trait tier occurrences across generative tokens.
  const tierByTrait = {};
  for (const c of model.categories) {
    for (const t of c.traits) tierByTrait[c.key + ':' + t.id] = t.tier;
  }
  const dist = { common: 0, rare: 0, 'ultra-rare': 0, none: 0 };
  for (const tok of tokens) {
    if (tok.mythic) continue;
    for (const key of Z_ORDER) {
      const t = tok.chosen[key];
      if (!t) {
        dist.none++;
        continue;
      }
      const tier = tierByTrait[key + ':' + t.id] || 'common';
      dist[tier] = (dist[tier] || 0) + 1;
    }
  }
  return dist;
}

function traitFrequencyExtremes(model, counts, total) {
  const labels = labelByKey(model);
  let rarest = null;
  let common = null;
  for (const c of model.categories) {
    for (const t of c.traits) {
      const fk = c.key + ':' + t.id;
      const n = counts[fk] || 0;
      if (n === 0) continue;
      const entry = { label: `${labels[c.key]} / ${t.name}`, count: n, pct: ((n / total) * 100).toFixed(2) };
      if (!rarest || n < rarest.count) rarest = entry;
      if (!common || n > common.count) common = entry;
    }
  }
  return { rarest, common };
}

function maxUniqueCapacity(model) {
  let cap = 1;
  for (const key of Z_ORDER) {
    const cat = model.categories.find((c) => c.key === key);
    if (!cat) continue;
    const n = cat.traits.filter((t) => t.enabled && t.weight > 0).length;
    let options = n;
    if (cat.optional && cat.noneWeight > 0) options = n + 1; // the "none" slot
    if (options <= 0) options = 1; // a required-but-empty cat is a config error handled elsewhere
    cap *= options;
  }
  return cap;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

function resetOutput() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(METADATA_DIR, { recursive: true });
}

function loadSharp() {
  try {
    return require('sharp');
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argCount = parseInt(process.argv[2], 10);
  const requested = Number.isFinite(argCount) && argCount > 0 ? argCount : 12;
  const count = Math.min(requested, TOTAL);
  // --meta-only: write metadata + rarity + provenance, skip image compositing.
  // Use while art is still placeholder; provenance falls back to combo hashes
  // (the real BAYC image-byte provenance is computed on the final art run).
  const META_ONLY = process.argv.includes('--meta-only');

  const model = loadModel();
  const capacity = maxUniqueCapacity(model);

  console.log('Vault Robbers render pipeline');
  console.log('-----------------------------');
  console.log(`Collection size target: ${TOTAL} (${GENERATIVE} generative + ${MYTHIC} mythic)`);
  console.log(`Rendering this run: ${count} token(s) at art indices 0..${count - 1}`);
  console.log(`Max unique capacity with current traits: ${capacity.toLocaleString()}`);
  console.log('');

  if (capacity < GENERATIVE) {
    console.warn(`Warning: capacity (${capacity}) is below the ${GENERATIVE} generative target. A full run cannot dedupe to ${GENERATIVE} unique combos.`);
  }

  // Decide how many generative vs mythic tokens to produce in this run.
  // Output is art-index keyed 0..999: generative occupy 0..989, mythics 990..999.
  // For a partial run we take the first `count` art indices, so mythics only
  // appear once count > 990.
  const genThisRun = Math.min(count, GENERATIVE);
  const mythicThisRun = Math.max(0, count - GENERATIVE);

  const { tokens: genTokens, attempts, maxAttempts } = generate(model, genThisRun);

  if (genTokens.length < genThisRun) {
    console.warn(`Warning: only produced ${genTokens.length} unique generative combos out of ${genThisRun} requested after ${attempts} attempts (guard ${maxAttempts}).`);
  }

  // Assign art indices: generative 0..989, mythic 990..999.
  const allTokens = [];
  genTokens.forEach((t, i) => {
    t.artIndex = i;
    allTokens.push(t);
  });
  for (let i = 0; i < mythicThisRun; i++) {
    const artIndex = GENERATIVE + i;
    const mythicEntry = model.mythic[i] || { name: `Mythic ${artIndex}`, image: null };
    allTokens.push({ chosen: null, hash: crypto.createHash('sha256').update('mythic:' + artIndex).digest('hex'), mythic: mythicEntry, artIndex });
  }

  resetOutput();

  // Rarity over the tokens actually produced in this run.
  const rarity = computeRarity(allTokens);

  const sharp = loadSharp();
  const labels = labelByKey(model);
  let imagesWritten = 0;
  let imagesSkipped = false;

  for (const tok of allTokens) {
    const n = tok.artIndex;
    const rank = rarity.rankById[n];
    const meta = buildMetadata(model, tok, labels, rank);
    fs.writeFileSync(path.join(METADATA_DIR, `${n}.json`), JSON.stringify(meta, null, 2));

    if (sharp && !META_ONLY) {
      const outPath = path.join(IMAGES_DIR, `${n}.png`);
      try {
        if (tok.mythic) {
          await compositeMythic(sharp, tok.mythic, outPath);
        } else {
          await compositeGenerative(sharp, tok.chosen, outPath);
        }
        imagesWritten++;
      } catch (err) {
        console.error(`Image compositing failed for art index ${n}: ${err.message}`);
        throw err;
      }
    } else {
      imagesSkipped = true;
    }
  }

  // Rarity file: [{ id, rank, score }] where id is the art index, sorted by rank.
  const rarityOut = allTokens
    .map((t) => ({ id: t.artIndex, rank: rarity.rankById[t.artIndex], score: Number(rarity.scoreById[t.artIndex].toFixed(6)) }))
    .sort((a, b) => a.rank - b.rank);
  fs.writeFileSync(path.join(OUT_DIR, '_rarity.json'), JSON.stringify(rarityOut, null, 2));

  // Provenance, BAYC image-byte standard: SHA-256 each final PNG, concatenate the
  // per-image hashes in art-index order, then SHA-256 the concatenation. Anyone can
  // recompute this from the published art to prove the exact ordered set shipped
  // unchanged. We publish this hash before reveal; the on-chain provenanceHash field
  // was deployed as an immutable placeholder, so this is the canonical record.
  const ordered = allTokens.slice().sort((a, b) => a.artIndex - b.artIndex);
  const perImage = [];
  let provenance, provenanceMethod;
  if (!imagesSkipped) {
    for (const t of ordered) {
      const buf = fs.readFileSync(path.join(IMAGES_DIR, `${t.artIndex}.png`));
      perImage.push({ index: t.artIndex, image: `${t.artIndex}.png`, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    }
    provenance = crypto.createHash('sha256').update(perImage.map((p) => p.sha256).join('')).digest('hex');
    provenanceMethod = 'SHA-256 of concatenated per-image SHA-256, art-index order (BAYC standard)';
  } else {
    // No images this run (sharp unavailable): fall back to combo-hash provenance.
    provenance = crypto.createHash('sha256').update(ordered.map((t) => t.hash).join('')).digest('hex');
    provenanceMethod = 'SHA-256 of concatenated combo hashes (fallback, images were not rendered)';
  }
  fs.writeFileSync(path.join(OUT_DIR, '_provenance.txt'), provenance + '\n');
  fs.writeFileSync(path.join(OUT_DIR, '_provenance.json'), JSON.stringify({
    method: provenanceMethod,
    hashAlgo: 'SHA-256',
    order: 'art-index ascending, 0 to N-1',
    count: ordered.length,
    provenanceHash: provenance,
    images: perImage,
  }, null, 2));

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const uniqueGen = new Set(genTokens.map((t) => t.hash)).size;
  const dist = tierDistribution(model, allTokens);
  const extremes = traitFrequencyExtremes(model, rarity.counts, rarity.total);

  console.log('Run complete');
  console.log('------------');
  console.log(`Unique generative combos: ${uniqueGen} (target for full run: ${GENERATIVE})`);
  console.log(`Generative produced: ${genTokens.length}, Mythic produced: ${mythicThisRun}`);
  console.log(`Tier distribution (trait occurrences): common=${dist.common}, rare=${dist.rare}, ultra-rare=${dist['ultra-rare']}, none(optional absent)=${dist.none}`);
  if (extremes.rarest) console.log(`Rarest trait this run: ${extremes.rarest.label} (${extremes.rarest.count} / ${extremes.rarest.pct}%)`);
  if (extremes.common) console.log(`Most common trait this run: ${extremes.common.label} (${extremes.common.count} / ${extremes.common.pct}%)`);
  console.log('');
  if (META_ONLY) {
    console.log('NOTE: --meta-only run, image compositing SKIPPED on purpose.');
    console.log('      Metadata + rarity + provenance (combo-hash fallback) produced. Rerun without --meta-only on final art for images + BAYC image-byte provenance.');
  } else if (imagesSkipped) {
    console.log('NOTE: sharp is not available on this host, so image compositing was SKIPPED.');
    console.log('      Metadata, rarity, and provenance were still produced. Install sharp (npm i sharp) and rerun to generate images.');
  } else {
    console.log(`Images written: ${imagesWritten} (${CANVAS}x${CANVAS} PNG)`);
  }
  console.log('');
  console.log('Output paths:');
  console.log(`  Images:     ${IMAGES_DIR}`);
  console.log(`  Metadata:   ${METADATA_DIR}`);
  console.log(`  Rarity:     ${path.join(OUT_DIR, '_rarity.json')}`);
  console.log(`  Provenance: ${path.join(OUT_DIR, '_provenance.txt')} + _provenance.json (per-image manifest)`);
  console.log('');
  console.log(`Provenance hash (${provenanceMethod}): ${provenance}`);
  if (count < TOTAL) {
    console.log('');
    console.log(`This was a preview of ${count} token(s). To render the full collection explicitly: node render.js ${TOTAL}`);
  }
}

main().catch((err) => {
  console.error('Render pipeline failed:', err);
  process.exit(1);
});

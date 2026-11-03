'use strict';

/* Vault Robbers Studio, client logic.
   All images are bundled under /layers and composited locally on a canvas.
   No external network calls, config persists through the app server only. */

const TOTAL_SUPPLY = 1000;
const MYTHIC_SLOTS = 10;
const SIM_TARGET = TOTAL_SUPPLY - MYTHIC_SLOTS; // 990 generative

// The ten one of ones, each a famous robber archetype (fully bespoke, may be off-style).
const MYTHIC_NAMES = [
  'The Prince of Thieves', 'The Gentleman', 'The Vanisher', 'The Outlaw', 'The Ironclad',
  'The Mastermind', 'The Cat', 'Public Enemy', 'The Professor', 'The Lovers',
];
const MYTHIC_LORE = [
  'Steals from the vault, gives to the mob.',
  'He left a thank you note where the diamonds used to be.',
  'Jumped with the bag and was never seen again.',
  'Dead or alive, the reward keeps going up.',
  'Bullets bounce, the vault does not.',
  'He already left with it before you noticed.',
  'Nine lives, one diamond at a time.',
  'The feds have a file, and it is very thick.',
  'The whole city is watching, and he planned on that.',
  'They robbed together, and they ran together.',
];

// Rarity tiers drive each trait's weight. One of ones live in the Mythic tab, outside the roll.
const TIER_WEIGHTS = { common: 100, rare: 28, 'ultra-rare': 6 };
const TIER_ORDER = [['common', 'Common'], ['rare', 'Rare'], ['ultra-rare', 'Ultra Rare']];
const validTier = (t) => (t in TIER_WEIGHTS ? t : 'common');

const state = {
  manifest: null,
  artMode: 'original', // 'original' = artist's canonical traits only; 'experimental' = include the new candidate traits too
  cats: [],            // ordered by z
  catByKey: {},
  weights: {},         // weights[catKey][traitId] = number
  tier: {},            // tier[catKey][traitId] = 'common'|'rare'|'ultra-rare'
  enabled: {},         // enabled[catKey][traitId] = bool
  noneWeight: {},      // noneWeight[catKey] = number (weight of picking nothing, optional cats only)
  optional: {},        // optional[catKey] = bool
  rules: [],           // { ifCat, ifTrait, type:'exclude'|'force', thenCat, thenTrait }
  mythic: [],          // [{ name, image|null }]
  locks: {},           // locks[catKey] = bool
  current: {},         // current[catKey] = traitId | null (preview selection)
  images: {},          // path -> HTMLImageElement
  lastSim: null,       // last simulation result
  artistNotes: '',     // shared notes shown on the Brief tab
};

/* ------------------------------------------------------------------ utils */
const $ = (sel, root) => (root || document).querySelector(sel);
const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const kebabName = (s) => s;

function debounce(fn, ms) {
  let t;
  return function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
}

/* Deterministic hashing via crypto.subtle */
async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- loading */
async function boot() {
  let manifest;
  try {
    manifest = await fetch('api/manifest').then((r) => r.json());
  } catch (e) {
    document.body.innerHTML = '<p style="padding:40px;color:#ef5a6a">Could not load the trait manifest.</p>';
    return;
  }
  state.manifest = manifest;
  state.cats = (manifest.categories || []).slice().sort((a, b) => a.z - b.z);
  state.cats.forEach((c) => { state.catByKey[c.key] = c; });

  // defaults from manifest
  state.cats.forEach((c) => {
    state.weights[c.key] = {};
    state.tier[c.key] = {};
    state.enabled[c.key] = {};
    state.locks[c.key] = false;
    state.current[c.key] = null;
    state.optional[c.key] = !!c.optional;
    state.noneWeight[c.key] = c.optional ? (typeof c.noneWeight === 'number' ? c.noneWeight : 100) : 0;
    c.traits.forEach((t) => {
      const tier = validTier(t.tier);
      state.tier[c.key][t.id] = tier;
      state.weights[c.key][t.id] = TIER_WEIGHTS[tier];
      state.enabled[c.key][t.id] = true;
    });
  });
  state.mythic = Array.from({ length: MYTHIC_SLOTS }, (_, i) => ({ name: MYTHIC_NAMES[i] || 'Robber #' + (i + 1), lore: MYTHIC_LORE[i] || '', inspiredBy: '', klass: '', image: null }));

  // overlay saved config
  let saved = {};
  try { saved = await fetch('api/config').then((r) => r.json()); } catch (e) { saved = {}; }
  applySavedConfig(saved);

  preloadImages();
  buildLayerRows();
  buildRarity();
  buildRuleSelectors();
  renderRules();
  buildMythic();
  buildBrief();
  wireTabs();
  wireButtons();

  rollAll(true);
}

function buildBrief() {
  const ta = document.getElementById('artistNotes');
  if (!ta) return;
  ta.value = state.artistNotes || '';
  ta.addEventListener('input', () => { state.artistNotes = ta.value; persist(); });
}

function applySavedConfig(saved) {
  if (!saved || typeof saved !== 'object') return;
  // Tier first so it sets the base weight, then an explicit saved weight can fine-tune it.
  if (saved.tier) {
    for (const ck in saved.tier) {
      if (!state.tier[ck]) continue;
      for (const tid in saved.tier[ck]) {
        if (tid in state.tier[ck]) {
          const tier = validTier(saved.tier[ck][tid]);
          state.tier[ck][tid] = tier;
          state.weights[ck][tid] = TIER_WEIGHTS[tier];
        }
      }
    }
  }
  if (saved.weights) {
    for (const ck in saved.weights) {
      if (!state.weights[ck]) continue;
      for (const tid in saved.weights[ck]) {
        if (tid in state.weights[ck]) state.weights[ck][tid] = Number(saved.weights[ck][tid]) || 0;
      }
    }
  }
  if (saved.enabled) {
    for (const ck in saved.enabled) {
      if (!state.enabled[ck]) continue;
      for (const tid in saved.enabled[ck]) {
        if (tid in state.enabled[ck]) state.enabled[ck][tid] = !!saved.enabled[ck][tid];
      }
    }
  }
  if (saved.noneWeight) {
    for (const ck in saved.noneWeight) {
      if (ck in state.noneWeight && state.optional[ck]) state.noneWeight[ck] = Number(saved.noneWeight[ck]) || 0;
    }
  }
  if (Array.isArray(saved.rules)) {
    state.rules = saved.rules.filter((r) => r && r.ifCat && r.ifTrait && r.thenCat && r.thenTrait && (r.type === 'exclude' || r.type === 'force'));
  }
  if (typeof saved.artistNotes === 'string') state.artistNotes = saved.artistNotes;
  if (Array.isArray(saved.mythic)) {
    for (let i = 0; i < MYTHIC_SLOTS; i++) {
      if (saved.mythic[i]) {
        state.mythic[i] = {
          name: saved.mythic[i].name || MYTHIC_NAMES[i] || ('Robber #' + (i + 1)),
          lore: typeof saved.mythic[i].lore === 'string' ? saved.mythic[i].lore : (MYTHIC_LORE[i] || ''),
          inspiredBy: typeof saved.mythic[i].inspiredBy === 'string' ? saved.mythic[i].inspiredBy : '',
          klass: typeof saved.mythic[i].klass === 'string' ? saved.mythic[i].klass : '',
          image: typeof saved.mythic[i].image === 'string' ? saved.mythic[i].image : null,
        };
      }
    }
  }
}

function preloadImages() {
  state.cats.forEach((c) => c.traits.forEach((t) => {
    const img = new Image();
    img.src = 'layers/' + t.file;
    state.images[t.file] = img;
  }));
}

/* --------------------------------------------------------------- persist */
function serializeConfig() {
  return {
    collection: state.manifest.name || 'Vault Robbers',
    totalSupply: TOTAL_SUPPLY,
    mythicReserved: MYTHIC_SLOTS,
    generativeTarget: SIM_TARGET,
    weights: state.weights,
    tier: state.tier,
    enabled: state.enabled,
    noneWeight: state.noneWeight,
    rules: state.rules,
    mythic: state.mythic,
    artistNotes: state.artistNotes,
    manifest: state.manifest,
    savedAt: new Date().toISOString(),
  };
}

const setSaveState = (cls, text) => {
  const el = $('#saveState');
  el.className = 'save-state ' + cls;
  $('#saveText').textContent = text;
};

const persist = debounce(async () => {
  setSaveState('saving', 'Saving');
  try {
    const r = await fetch('api/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeConfig()),
    });
    if (!r.ok) throw new Error('bad status');
    setSaveState('saved', 'Saved');
  } catch (e) {
    setSaveState('error', 'Save failed');
  }
}, 600);

/* ------------------------------------------------------ weighted picking */
function pickWeighted(catKey, exclude) {
  const c = state.catByKey[catKey];
  const pool = c.traits.filter((t) =>
    state.enabled[catKey][t.id] &&
    (state.weights[catKey][t.id] || 0) > 0 &&
    (!exclude || !exclude.has(t.id)) &&
    // Original mode shuffles only the artist's canonical traits; Experimental also allows the new candidate traits.
    (state.artMode === 'experimental' || t.pool !== 'experimental')
  );
  const noneW = state.optional[catKey] ? (state.noneWeight[catKey] || 0) : 0;
  if (!pool.length) return null;
  let total = noneW;
  pool.forEach((t) => { total += state.weights[catKey][t.id]; });
  if (total <= 0) return null;
  let r = Math.random() * total;
  if (noneW > 0) { r -= noneW; if (r <= 0) return null; }
  for (const t of pool) {
    r -= state.weights[catKey][t.id];
    if (r <= 0) return t.id;
  }
  return pool[pool.length - 1].id;
}

/* Build one selection honoring rules. Returns {catKey: traitId|null}. */
function generateSelection(seedSelection) {
  const sel = {};
  const forced = {};        // catKey -> traitId forced by a rule
  const excludedByCat = {}; // catKey -> Set of traitIds

  const addExclude = (cat, trait) => {
    if (!excludedByCat[cat]) excludedByCat[cat] = new Set();
    excludedByCat[cat].add(trait);
  };

  // Decide scene first so exclusivity applies to body/head/headwear.
  const order = state.cats.map((c) => c.key);
  order.sort((a, b) => (a === 'scene' ? -1 : b === 'scene' ? 1 : 0));

  for (const catKey of order) {
    // locked layers keep the current preview trait
    if (seedSelection && state.locks[catKey] && state.current[catKey]) {
      sel[catKey] = state.current[catKey];
    } else if (forced[catKey]) {
      sel[catKey] = forced[catKey];
    } else {
      sel[catKey] = pickWeighted(catKey, excludedByCat[catKey]);
    }

    const chosen = sel[catKey];
    if (!chosen) continue;

    // user rules
    state.rules.forEach((rule) => {
      if (rule.ifCat === catKey && rule.ifTrait === chosen) {
        if (rule.type === 'exclude') addExclude(rule.thenCat, rule.thenTrait);
        else if (rule.type === 'force') forced[rule.thenCat] = rule.thenTrait;
      }
    });
  }

  // scene forced-none sentinel cleanup
  for (const k in sel) if (sel[k] === '__NONE__') sel[k] = null;
  return sel;
}

function comboHash(sel) {
  return state.cats.map((c) => c.key + ':' + (sel[c.key] || '-')).join('|');
}

/* ------------------------------------------------------------- rendering */
function drawSelection(canvas, sel) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const pending = [];
  state.cats.forEach((c) => {
    const tid = sel[c.key];
    if (!tid) return;
    const trait = c.traits.find((t) => t.id === tid);
    if (!trait) return;
    const img = state.images[trait.file];
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else if (img) {
      pending.push(new Promise((res) => { img.onload = res; img.onerror = res; }));
    }
  });
  if (pending.length) {
    Promise.all(pending).then(() => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      state.cats.forEach((c) => {
        const tid = sel[c.key];
        if (!tid) return;
        const trait = c.traits.find((t) => t.id === tid);
        if (!trait) return;
        const img = state.images[trait.file];
        if (img && img.naturalWidth) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      });
    });
  }
}

function renderPreview() {
  drawSelection($('#previewCanvas'), state.current);
  // reflect in layer dropdowns
  state.cats.forEach((c) => {
    const sel = $('#sel-' + c.key);
    if (sel) sel.value = state.current[c.key] || '';
  });
  updateDesignMeta();
}

function rollAll(keepLocks) {
  state.current = generateSelection(!!keepLocks);
  renderPreview();
}

/* -------------------------------------------------------- layer rows UI */
function buildLayerRows() {
  const host = $('#layerRows');
  host.innerHTML = '';
  state.cats.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'layer-row';

    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = c.label;

    const sel = document.createElement('select');
    sel.id = 'sel-' + c.key;
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'None';
    sel.appendChild(none);
    c.traits.forEach((t) => {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      state.current[c.key] = sel.value || null;
      drawSelection($('#previewCanvas'), state.current);
      updateDesignMeta();
    });

    const lock = document.createElement('button');
    lock.className = 'lock' + (state.locks[c.key] ? ' on' : '');
    lock.title = 'Lock this layer while shuffling';
    lock.textContent = state.locks[c.key] ? 'L' : 'U';
    lock.addEventListener('click', () => {
      state.locks[c.key] = !state.locks[c.key];
      lock.className = 'lock' + (state.locks[c.key] ? ' on' : '');
      lock.textContent = state.locks[c.key] ? 'L' : 'U';
    });

    row.appendChild(lbl); row.appendChild(sel); row.appendChild(lock);
    host.appendChild(row);
  });
}

/* ------------------------------------------------------------ rarity UI */
function buildRarity() {
  const host = $('#rarityBlocks');
  host.innerHTML = '';
  const legend = document.createElement('div');
  legend.className = 'tier-legend';
  legend.innerHTML = 'Set each trait to a tier to shape rarity across the whole set, the ten one of ones live in the Mythic tab.' +
    '<span class="tier-chip tier-common">Common</span><span class="tier-chip tier-rare">Rare</span><span class="tier-chip tier-ultra-rare">Ultra Rare</span>';
  host.appendChild(legend);
  state.cats.forEach((c) => {
    const block = document.createElement('div');
    block.className = 'cat-block';
    const head = document.createElement('div');
    head.className = 'cat-head';
    head.innerHTML = '<span>' + c.label + '</span><span>z' + c.z + (state.optional[c.key] ? ' optional' : '') + '</span>';
    block.appendChild(head);

    if (state.optional[c.key]) {
      const row = document.createElement('div');
      row.className = 'trait-row';
      const spacer = document.createElement('span');
      const nm = document.createElement('div');
      nm.className = 'tname'; nm.innerHTML = '<i style="color:var(--muted)">None, layer absent</i>';
      const num = document.createElement('input');
      num.type = 'number'; num.min = '0'; num.max = '10000'; num.step = '1';
      num.value = state.noneWeight[c.key];
      const prob = document.createElement('div');
      prob.className = 'prob'; prob.id = 'prob-' + c.key + '-__none__';
      num.addEventListener('input', () => {
        state.noneWeight[c.key] = Math.max(0, Math.min(10000, Math.round(Number(num.value) || 0)));
        updateProbabilities(c.key); persist();
      });
      row.appendChild(spacer); row.appendChild(nm); row.appendChild(num); row.appendChild(prob);
      block.appendChild(row);
    }

    c.traits.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'trait-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = state.enabled[c.key][t.id];

      const nm = document.createElement('div');
      nm.className = 'tname' + (cb.checked ? '' : ' disabled');
      nm.textContent = t.name;

      const tierSel = document.createElement('select');
      tierSel.className = 'tier-sel tier-' + state.tier[c.key][t.id];
      TIER_ORDER.forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l; tierSel.appendChild(o);
      });
      tierSel.value = state.tier[c.key][t.id];

      const num = document.createElement('input');
      num.type = 'number'; num.min = '0'; num.max = '1000'; num.step = '1';
      num.value = state.weights[c.key][t.id];

      const prob = document.createElement('div');
      prob.className = 'prob';
      prob.id = 'prob-' + c.key + '-' + t.id;

      cb.addEventListener('change', () => {
        state.enabled[c.key][t.id] = cb.checked;
        nm.className = 'tname' + (cb.checked ? '' : ' disabled');
        updateProbabilities(c.key); persist();
      });
      tierSel.addEventListener('change', () => {
        const tier = validTier(tierSel.value);
        state.tier[c.key][t.id] = tier;
        tierSel.className = 'tier-sel tier-' + tier;
        state.weights[c.key][t.id] = TIER_WEIGHTS[tier];
        num.value = TIER_WEIGHTS[tier];
        updateProbabilities(c.key); persist();
      });
      num.addEventListener('input', () => {
        let v = Math.max(0, Math.min(1000, Math.round(Number(num.value) || 0)));
        state.weights[c.key][t.id] = v;
        updateProbabilities(c.key); persist();
      });

      row.appendChild(cb); row.appendChild(nm); row.appendChild(tierSel); row.appendChild(num); row.appendChild(prob);
      block.appendChild(row);
    });
    host.appendChild(block);
    updateProbabilities(c.key);
  });
}

function updateProbabilities(catKey) {
  const c = state.catByKey[catKey];
  const noneW = state.optional[catKey] ? (state.noneWeight[catKey] || 0) : 0;
  let total = noneW;
  c.traits.forEach((t) => {
    if (state.enabled[catKey][t.id]) total += state.weights[catKey][t.id] || 0;
  });
  const noneEl = $('#prob-' + catKey + '-__none__');
  if (noneEl) noneEl.textContent = total === 0 ? '0%' : ((noneW / total) * 100).toFixed(1) + '%';
  c.traits.forEach((t) => {
    const el = $('#prob-' + catKey + '-' + t.id);
    if (!el) return;
    if (!state.enabled[catKey][t.id] || !(state.weights[catKey][t.id] > 0) || total === 0) {
      el.textContent = '0%';
    } else {
      el.textContent = ((state.weights[catKey][t.id] / total) * 100).toFixed(1) + '%';
    }
  });
}

/* ------------------------------------------------------------- rules UI */
function buildRuleSelectors() {
  const fill = (selId, withNone) => {
    const el = $(selId); el.innerHTML = '';
    state.cats.forEach((c) => {
      const o = document.createElement('option'); o.value = c.key; o.textContent = c.label; el.appendChild(o);
    });
  };
  fill('#ruleIfCat'); fill('#ruleThenCat');
  const syncTraits = (catSelId, traitSelId) => {
    const cat = $(catSelId).value;
    const el = $(traitSelId); el.innerHTML = '';
    (state.catByKey[cat].traits || []).forEach((t) => {
      const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; el.appendChild(o);
    });
  };
  $('#ruleIfCat').addEventListener('change', () => syncTraits('#ruleIfCat', '#ruleIfTrait'));
  $('#ruleThenCat').addEventListener('change', () => syncTraits('#ruleThenCat', '#ruleThenTrait'));
  syncTraits('#ruleIfCat', '#ruleIfTrait');
  syncTraits('#ruleThenCat', '#ruleThenTrait');
}

function renderRules() {
  const host = $('#ruleList');
  host.innerHTML = '';
  if (!state.rules.length) {
    const li = document.createElement('li'); li.className = 'builtin';
    li.innerHTML = '<span class="tagline">No custom rules yet.</span>';
    host.appendChild(li); return;
  }
  state.rules.forEach((rule, idx) => {
    const li = document.createElement('li');
    const ifT = traitName(rule.ifCat, rule.ifTrait);
    const thenT = traitName(rule.thenCat, rule.thenTrait);
    const verb = rule.type === 'exclude' ? 'then exclude' : 'then force';
    li.innerHTML = '<span>If <b>' + catLabel(rule.ifCat) + '</b> is <b>' + ifT + '</b> ' + verb +
      ' <b>' + catLabel(rule.thenCat) + '</b> <b>' + thenT + '</b></span>';
    const rm = document.createElement('span'); rm.className = 'rm'; rm.textContent = 'remove';
    rm.addEventListener('click', () => { state.rules.splice(idx, 1); renderRules(); persist(); });
    li.appendChild(rm);
    host.appendChild(li);
  });
}

const catLabel = (k) => (state.catByKey[k] ? state.catByKey[k].label : k);
function traitName(catKey, traitId) {
  const c = state.catByKey[catKey]; if (!c) return traitId;
  const t = c.traits.find((x) => x.id === traitId); return t ? t.name : traitId;
}

/* ---------------------------------------------------- live token metadata
   Mirrors render.js buildMetadata() exactly so what shows here is byte-for-byte
   how the attributes land on OpenSea and on-chain. Generative tokens list their
   trait layers; Mythic one of ones carry Type / Inspired By / Class. The art
   index (0..999) is the metadata file number; token ids 1..1000 map to it via
   the reveal startingIndex. Rank is assigned at the final full render. */
const IPFS_CID_PLACEHOLDER = 'REPLACE_CID';
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function tokenMeta(selection, opts) {
  opts = opts || {};
  const attributes = [];
  if (selection) {
    state.cats.forEach((c) => {
      const tid = selection[c.key];
      if (tid) attributes.push({ trait_type: c.label, value: traitName(c.key, tid) });
    });
  }
  const n = (typeof opts.artIndex === 'number') ? opts.artIndex : null;
  const idLabel = (n === null) ? '#' : ('#' + n);
  let name, description;
  if (opts.mythic) {
    attributes.push({ trait_type: 'Type', value: '1 of 1' });
    if (opts.mythic.inspiredBy) attributes.push({ trait_type: 'Inspired By', value: opts.mythic.inspiredBy });
    if (opts.mythic.klass) attributes.push({ trait_type: 'Class', value: opts.mythic.klass });
    const mn = opts.mythic.name || ('Mythic ' + (n === null ? '' : n)).trim();
    name = ('Vault Robber ' + idLabel + ' ' + mn).trim();
    description = opts.mythic.lore || ('A one of one Vault Robber, the ' + mn + ', hand selected from the heist crew.');
  } else {
    name = 'Vault Robber ' + idLabel;
    description = 'A generative Vault Robber assembled from the collection trait set.';
  }
  attributes.push({ trait_type: 'Rank', display_type: 'number', value: (opts.rank != null ? opts.rank : null) });
  return {
    name,
    description,
    image: 'ipfs://' + IPFS_CID_PLACEHOLDER + '/' + (n === null ? '<art>' : n) + '.png',
    attributes,
  };
}

function renderTraitChips(container, meta) {
  if (!container) return;
  container.innerHTML = '';
  meta.attributes.forEach((a) => {
    if (a.value === null || a.value === undefined || a.value === '') return;
    const special = (a.trait_type === 'Type' || a.trait_type === 'Inspired By' || a.trait_type === 'Class');
    const chip = document.createElement('div');
    chip.className = 'os-trait' + (special ? ' special' : '');
    chip.innerHTML = '<span class="k">' + escHtml(a.trait_type) + '</span><span class="v">' + escHtml(String(a.value)) + '</span>';
    container.appendChild(chip);
  });
  if (!container.children.length) container.innerHTML = '<div class="os-empty">No traits selected.</div>';
}

function updateDesignMeta() {
  const meta = tokenMeta(state.current, {});
  renderTraitChips($('#metaChips'), meta);
  const json = $('#metaJson'); if (json) json.textContent = JSON.stringify(meta, null, 2);
}

/* ------------------------------------------------------------ mythic UI */
function buildMythic() {
  const host = $('#mythicGrid');
  host.innerHTML = '';
  state.mythic.forEach((slot, i) => {
    const card = document.createElement('div');
    card.className = 'slot' + (slot.image ? ' filled' : '');

    const box = document.createElement('div');
    box.className = 'box';
    if (slot.image) { const im = document.createElement('img'); im.src = slot.image + (slot.image.indexOf('data:') === 0 ? '' : ('?v=' + Date.now())); box.appendChild(im); }
    else { const ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = 'Placeholder'; box.appendChild(ph); }

    const nm = document.createElement('input'); nm.className = 'nm'; nm.value = slot.name;
    nm.addEventListener('input', () => { state.mythic[i].name = nm.value; persist(); });
    const lore = document.createElement('textarea'); lore.className = 'lore'; lore.rows = 2;
    lore.placeholder = 'Lore line'; lore.value = slot.lore || '';
    lore.addEventListener('input', () => { state.mythic[i].lore = lore.value; persist(); });

    const up = document.createElement('label'); up.className = 'upload'; up.textContent = slot.image ? 'Replace image' : 'Upload image';
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { state.mythic[i].image = reader.result; buildMythic(); persist(); };
      reader.readAsDataURL(f);
    });
    up.appendChild(input);

    const insp = document.createElement('div'); insp.className = 'insp';
    insp.textContent = slot.inspiredBy ? (slot.inspiredBy + (slot.klass ? '  ·  ' + slot.klass : '')) : '';
    card.appendChild(box); card.appendChild(nm); card.appendChild(insp); card.appendChild(lore); card.appendChild(up);

    // live on-chain metadata for this one of one (art index 990 + i)
    const meta = tokenMeta(null, { mythic: state.mythic[i], artIndex: SIM_TARGET + i });
    const metaWrap = document.createElement('div'); metaWrap.className = 'slot-meta';
    const chips = document.createElement('div'); chips.className = 'os-traits'; renderTraitChips(chips, meta);
    const det = document.createElement('details'); det.className = 'meta-json-wrap';
    const sum = document.createElement('summary'); sum.textContent = 'Metadata #' + (SIM_TARGET + i) + ' (as on OpenSea)';
    const pre = document.createElement('pre'); pre.className = 'meta-json'; pre.textContent = JSON.stringify(meta, null, 2);
    det.appendChild(sum); det.appendChild(pre);
    metaWrap.appendChild(chips); metaWrap.appendChild(det);
    card.appendChild(metaWrap);

    if (slot.image) {
      const clr = document.createElement('span'); clr.className = 'clear'; clr.textContent = 'x';
      clr.title = 'Clear slot';
      clr.addEventListener('click', () => { state.mythic[i].image = null; buildMythic(); persist(); });
      card.appendChild(clr);
    }
    host.appendChild(card);
  });
  $('#mythicMath').textContent =
    'Total supply ' + TOTAL_SUPPLY + ', reserve ' + MYTHIC_SLOTS + ' Mythic one of ones, so the generative target is ' + SIM_TARGET + ' unique Robbers.';
}

/* --------------------------------------------------- unique capacity math */
function uniqueCapacity() {
  // Product of available options per category. An optional category adds one
  // outcome (None) when its noneWeight is above zero.
  const options = (catKey) => {
    const c = state.catByKey[catKey];
    let n = c.traits.filter((t) => state.enabled[catKey][t.id] && state.weights[catKey][t.id] > 0).length;
    if (state.optional[catKey] && (state.noneWeight[catKey] || 0) > 0) n += 1;
    return n;
  };
  let total = 1;
  state.cats.forEach((c) => { total *= Math.max(1, options(c.key)); });
  return { total: total };
}

/* ------------------------------------------------------------ simulate */
function simulate() {
  const seen = new Set();
  const counts = {};        // traitKey -> count
  const combos = [];        // ordered combo hashes for provenance
  let attempts = 0;
  const maxAttempts = SIM_TARGET * 60;

  state.cats.forEach((c) => c.traits.forEach((t) => { counts[c.key + '/' + t.id] = 0; }));

  while (seen.size < SIM_TARGET && attempts < maxAttempts) {
    attempts++;
    const sel = generateSelection(false);
    const h = comboHash(sel);
    if (seen.has(h)) continue;
    seen.add(h);
    combos.push(h);
    state.cats.forEach((c) => { const tid = sel[c.key]; if (tid) counts[c.key + '/' + tid]++; });
  }

  const cap = uniqueCapacity();
  const result = {
    unique: seen.size,
    target: SIM_TARGET,
    attempts: attempts,
    counts: counts,
    combos: combos,
    capacity: cap,
    enough: seen.size >= SIM_TARGET,
  };
  state.lastSim = result;
  renderSimulation(result);
  return result;
}

function renderSimulation(res) {
  // notice
  const notice = $('#simNotice');
  if (res.enough) {
    notice.innerHTML = '<div class="notice ok">Produced ' + res.unique + ' unique combos for the ' + SIM_TARGET + ' generative slots.</div>';
  } else {
    notice.innerHTML = '<div class="notice warn">Only ' + res.unique + ' unique combos are reachable, the settings cannot fill ' + SIM_TARGET +
      ', estimated maximum unique capacity is ' + res.capacity.total.toLocaleString() + '.</div>';
  }

  // stats
  $('#simStats').innerHTML = [
    stat('Unique combos', res.unique.toLocaleString(), res.enough ? 'ok' : 'warn'),
    stat('Generative target', SIM_TARGET.toLocaleString(), ''),
    stat('Est. max capacity', res.capacity.total.toLocaleString(), ''),
    stat('Draws used', res.attempts.toLocaleString(), ''),
  ].join('');

  // rarity tiers, by how rare the rarest trait on a combo is, approximated by per trait share buckets
  renderTiers(res);

  // per trait table
  const rows = [];
  state.cats.forEach((c) => {
    c.traits.forEach((t) => {
      const count = res.counts[c.key + '/' + t.id] || 0;
      const share = res.unique ? (count / res.unique) * 100 : 0;
      rows.push({ name: t.name, cat: c.label, count: count, share: share, tier: state.tier[c.key][t.id] });
    });
  });
  rows.sort((a, b) => b.count - a.count);
  const maxShare = rows.length ? Math.max(1, rows[0].share) : 1;
  const tierName = { common: 'Common', rare: 'Rare', 'ultra-rare': 'Ultra Rare' };
  const tbody = $('#distTable tbody');
  tbody.innerHTML = rows.map((r) =>
    '<tr><td>' + r.name + '<span class="dist-tier tier-' + r.tier + '">' + (tierName[r.tier] || r.tier) + '</span></td>' +
    '<td class="cat-tag">' + r.cat + '</td><td>' + r.count +
    '</td><td>' + r.share.toFixed(1) + '%</td><td><div class="bar-track"><div class="bar" style="width:' +
    (r.share / maxShare * 100).toFixed(1) + '%"></div></div></td></tr>'
  ).join('');

  $('#simTargetLabel').textContent = 'Deduped to ' + res.unique + ' uniques';
}

function stat(k, v, cls) {
  return '<div class="stat"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>';
}

function renderTiers(res) {
  // Tier a combo by its rarest trait share. Lower share means rarer.
  // Reconstruct per combo rarity from counts by sampling the recorded combos.
  const shareOf = {};
  state.cats.forEach((c) => c.traits.forEach((t) => {
    const key = c.key + '/' + t.id;
    shareOf[key] = res.unique ? (res.counts[key] / res.unique) : 0;
  }));
  const tiers = { Mythic: 0, Legendary: 0, Rare: 0, Uncommon: 0, Common: 0 };
  res.combos.forEach((h) => {
    // h looks like cat:trait|cat:trait...
    let rarest = 1;
    h.split('|').forEach((part) => {
      const [ck, tid] = part.split(':');
      if (tid && tid !== '-') {
        const s = shareOf[ck + '/' + tid];
        if (typeof s === 'number' && s < rarest) rarest = s;
      }
    });
    if (rarest < 0.01) tiers.Mythic++;
    else if (rarest < 0.03) tiers.Legendary++;
    else if (rarest < 0.08) tiers.Rare++;
    else if (rarest < 0.20) tiers.Uncommon++;
    else tiers.Common++;
  });
  const order = ['Mythic', 'Legendary', 'Rare', 'Uncommon', 'Common'];
  $('#tierGrid').innerHTML = order.map((name) => {
    const n = tiers[name];
    const pct = res.unique ? (n / res.unique * 100).toFixed(1) : '0.0';
    return '<div class="tier"><div class="tl">' + name + '</div><div class="tc">' + n + '</div><div class="tp">' + pct + '% of run</div></div>';
  }).join('');
}

/* ------------------------------------------------------------- samples */
function generateSamples(n) {
  const host = $('#sampleGrid');
  host.innerHTML = '';
  const seen = new Set();
  let made = 0, guard = 0;
  while (made < n && guard < n * 40) {
    guard++;
    const sel = generateSelection(false);
    const h = comboHash(sel);
    if (seen.has(h)) continue;
    seen.add(h); made++;

    const cell = document.createElement('div');
    cell.className = 'sample-cell';
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 320;
    drawSelection(cv, sel);
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = state.cats.map((c) => sel[c.key] ? traitName(c.key, sel[c.key]) : null).filter(Boolean).slice(0, 3).join(', ');
    cell.appendChild(cv); cell.appendChild(cap);
    host.appendChild(cell);
  }
  if (!made) host.innerHTML = '<p class="hint">No combos are possible with the current settings.</p>';
}

/* -------------------------------------------------------------- export */
function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportConfig() {
  download('vaultrobbers-config.json', JSON.stringify(serializeConfig(), null, 2));
}

function exportSampleMetadata() {
  const meta = tokenMeta(state.current, {});
  download('vaultrobbers-sample-metadata.json', JSON.stringify(meta, null, 2));
}

async function computeProvenance() {
  const box = $('#provenanceVal');
  box.textContent = 'Computing';
  const res = state.lastSim || simulate();
  const concatenated = [];
  for (const h of res.combos) {
    concatenated.push(await sha256Hex(h));
  }
  const provenance = await sha256Hex(concatenated.join(''));
  box.textContent = provenance;
}

/* ---------------------------------------------------------------- wiring */
function wireTabs() {
  $all('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $all('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      $all('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== target));
    });
  });
}

function wireButtons() {
  $('#shuffleBtn').addEventListener('click', () => rollAll(true));
  // Original vs Experimental trait-set toggle (lives in the shuffle panel)
  $all('#artMode [data-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      state.artMode = b.dataset.mode;
      $all('#artMode [data-mode]').forEach((x) => {
        const on = x.dataset.mode === state.artMode;
        x.classList.toggle('active', on);
        x.classList.toggle('ghost', !on);
      });
      rollAll(true);   // re-shuffle from the selected set
    });
  });
  $('#clearLocksBtn').addEventListener('click', () => {
    state.cats.forEach((c) => { state.locks[c.key] = false; });
    buildLayerRows(); renderPreview();
  });
  $('#downloadPreviewBtn').addEventListener('click', () => {
    const big = document.createElement('canvas'); big.width = 2048; big.height = 2048;
    drawSelection(big, state.current);
    setTimeout(() => { const a = document.createElement('a'); a.href = big.toDataURL('image/png'); a.download = 'vault-robber-preview.png'; a.click(); }, 150);
  });
  $('#addRuleBtn').addEventListener('click', () => {
    const rule = {
      ifCat: $('#ruleIfCat').value, ifTrait: $('#ruleIfTrait').value,
      type: $('#ruleType').value,
      thenCat: $('#ruleThenCat').value, thenTrait: $('#ruleThenTrait').value,
    };
    if (rule.ifCat === rule.thenCat) { alert('Pick two different categories for a rule.'); return; }
    state.rules.push(rule); renderRules(); persist();
  });
  $('#simulateBtn').addEventListener('click', simulate);
  $('#gen12Btn').addEventListener('click', () => generateSamples(12));
  $('#exportConfigBtn').addEventListener('click', exportConfig);
  $('#exportMetaBtn').addEventListener('click', exportSampleMetadata);
  $('#provenanceBtn').addEventListener('click', computeProvenance);
}

boot();

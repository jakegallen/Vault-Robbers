#!/usr/bin/env node
/*
 * One-time, non-destructive manifest pool tagger for the Vault Robbers studio.
 *
 * Two outcomes, both inside layers/manifest.json only:
 *   1. Every trait already in the manifest gets a "pool" field by the file-mtime
 *      date rule: file dated 2026-10-08 or earlier => "original", 2026-10-09 => "experimental".
 *   2. The artist's original-named source files that still live on disk but were
 *      dropped from the manifest by the generative passes (sage-puffer + shadow-silhouette
 *      bodies, the old clothes / masks / eyes / hats / backgrounds) are re-added as
 *      pool:"original" entries so the Original (Artist) gallery renders from real
 *      original art. Nothing is deleted, no image files are touched.
 *
 * The cutoff is a plain date compare on fs.statSync(mtime). Run once:
 *   node tag-pools.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LAYERS = path.join(ROOT, 'layers');
const MANIFEST = path.join(LAYERS, 'manifest.json');

const CUTOFF = new Date('2026-10-09T00:00:00Z').getTime(); // >= this => experimental

function poolForFile(rel) {
  const fp = path.join(LAYERS, rel);
  if (!fs.existsSync(fp)) return 'original'; // missing file: treat as canonical, never experimental
  const m = fs.statSync(fp).mtime.getTime();
  return m >= CUTOFF ? 'experimental' : 'original';
}

// Artist original-named files to re-add, keyed by category. tier drives weight in
// the render pipeline; these mirror the old hand-drawn set.
const ORIGINAL_ADDS = {
  background: [
    { id: 'o-cool-grey', name: 'Cool Grey', file: 'background/cool-grey.png', tier: 'common', weight: 100 },
    { id: 'o-warm-grey', name: 'Warm Grey', file: 'background/warm-grey.png', tier: 'common', weight: 100 },
    { id: 'o-light-grey', name: 'Light Grey', file: 'background/light-grey.png', tier: 'common', weight: 100 },
    { id: 'o-periwinkle', name: 'Periwinkle', file: 'background/periwinkle.png', tier: 'common', weight: 100 },
    { id: 'o-steel-blue', name: 'Steel Blue', file: 'background/steel-blue.png', tier: 'common', weight: 100 },
  ],
  body: [
    { id: 'o-sage-puffer', name: 'Sage Puffer', file: 'body/sage-puffer.png', tier: 'common', weight: 100 },
    { id: 'o-shadow-silhouette', name: 'Shadow Silhouette', file: 'body/shadow-silhouette.png', tier: 'common', weight: 100 },
  ],
  clothes: [
    { id: 'o-charcoal', name: 'Charcoal Coat', file: 'clothes/charcoal.png', tier: 'common', weight: 100 },
    { id: 'o-blood', name: 'Blood Coat', file: 'clothes/blood.png', tier: 'common', weight: 100 },
    { id: 'o-forest', name: 'Forest Coat', file: 'clothes/forest.png', tier: 'common', weight: 100 },
    { id: 'o-denim', name: 'Denim', file: 'clothes/denim.png', tier: 'common', weight: 100 },
    { id: 'o-ice', name: 'Ice Coat', file: 'clothes/ice.png', tier: 'common', weight: 100 },
    { id: 'o-navy', name: 'Navy Coat', file: 'clothes/navy.png', tier: 'common', weight: 100 },
    { id: 'o-plum', name: 'Plum Coat', file: 'clothes/plum.png', tier: 'common', weight: 100 },
    { id: 'o-rust', name: 'Rust Coat', file: 'clothes/rust.png', tier: 'common', weight: 100 },
    { id: 'o-sand', name: 'Sand Coat', file: 'clothes/sand.png', tier: 'common', weight: 100 },
    { id: 'o-striped', name: 'Striped Coat', file: 'clothes/striped.png', tier: 'rare', weight: 28 },
    { id: 'o-vault-gold', name: 'Vault Gold Coat', file: 'clothes/vault-gold.png', tier: 'ultra-rare', weight: 6 },
  ],
  mask: [
    { id: 'o-mask-black', name: 'Black Mask', file: 'mask/mask-black.png', tier: 'common', weight: 100 },
    { id: 'o-mask-crimson', name: 'Crimson Mask', file: 'mask/mask-crimson.png', tier: 'common', weight: 100 },
    { id: 'o-mask-bone', name: 'Bone Mask', file: 'mask/mask-bone.png', tier: 'rare', weight: 28 },
  ],
  eyes: [
    { id: 'o-round-glasses', name: 'Round Glasses', file: 'eyes/round-glasses.png', tier: 'common', weight: 100 },
    { id: 'o-white-lens', name: 'White Lens', file: 'eyes/white-lens.png', tier: 'rare', weight: 28 },
    { id: 'o-masquerade', name: 'Masquerade', file: 'eyes/masquerade-mask.png', tier: 'rare', weight: 28 },
  ],
  headwear: [
    { id: 'o-robin-hat', name: 'Robin Hat', file: 'headwear/robin-hat.png', tier: 'common', weight: 100 },
    { id: 'o-tan-beret', name: 'Tan Beret', file: 'headwear/tan-beret.png', tier: 'common', weight: 100 },
    { id: 'o-trucker-cap', name: 'Trucker Cap', file: 'headwear/trucker-cap.png', tier: 'common', weight: 100 },
  ],
};

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const log = { tagged: { original: 0, experimental: 0 }, added: 0, perLayer: {} };

  for (const cat of manifest.categories) {
    const counts = { original: 0, experimental: 0, added: 0 };

    // 1. tag existing entries by file date
    for (const t of cat.traits) {
      t.pool = poolForFile(t.file);
      counts[t.pool]++;
      log.tagged[t.pool]++;
    }

    // 2. re-add original-named artist files that are not already present
    const existingFiles = new Set(cat.traits.map((t) => t.file));
    const existingIds = new Set(cat.traits.map((t) => t.id));
    const adds = ORIGINAL_ADDS[cat.key] || [];
    for (const a of adds) {
      if (existingFiles.has(a.file) || existingIds.has(a.id)) continue;
      if (!fs.existsSync(path.join(LAYERS, a.file))) continue;
      cat.traits.push(Object.assign({}, a, { pool: 'original' }));
      counts.original++;
      counts.added++;
      log.added++;
    }

    log.perLayer[cat.key] = counts;
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(log, null, 2));
}

main();

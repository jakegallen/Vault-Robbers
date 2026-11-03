#!/usr/bin/env node
/*
 * Manifest update for the EXPERIMENTAL pool redesign.
 *
 *  1. Adds the ONE legless hooded body (x-hooded-nolegs) as the only live
 *     experimental body.
 *  2. Takes the pass-2 experimental bodies (b-* and pose-*) OUT of the roll by
 *     setting weight 0 (files kept on disk, just not rolled).
 *  3. Appends all new experimental masks / heads / eyes / clothes / hats.
 *
 * Does NOT touch any pool:"original" trait or the Mythic 1/1s. Idempotent: it
 * removes any previously-added x-* / legless rows before re-adding them, and
 * re-zeroes the pass-2 bodies every run.
 *
 * Run: node update-manifest-experimental.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const MANIFEST = path.join(__dirname, 'layers', 'manifest.json');
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const cat = (k) => m.categories.find((c) => c.key === k);

// id prefix we own for the new experimental additions
const NEW = 'x-';

function stripOurs(c) {
  // remove previously-added x-* experimental rows so re-runs are idempotent
  c.traits = c.traits.filter((t) => !String(t.id).startsWith(NEW));
}

// ---- BODY ----------------------------------------------------------------
{
  const c = cat('body');
  stripOurs(c);
  // zero out the pass-2 experimental bodies (b-* files and pose-* files) so they
  // never roll; keep them in the list (files on disk untouched) per the brief.
  for (const t of c.traits) {
    if (t.pool === 'experimental' && /^(body\/b-|body\/pose-)/.test(t.file)) {
      t.weight = 0;
      t.enabled = false;
    }
  }
  // the single live experimental body
  c.traits.push({
    id: 'x-hooded-nolegs', name: 'Hooded Ghost', file: 'body/x-hooded-nolegs.png',
    tier: 'common', weight: 100, pool: 'experimental',
  });
}

// ---- MASKS (+10) ---------------------------------------------------------
{
  const c = cat('mask');
  stripOurs(c);
  const add = [
    ['x-visor-slit', 'Visor Slit', 'x-visor-slit', 'common', 100],
    ['x-muzzle', 'Muzzle', 'x-muzzle', 'common', 100],
    ['x-blindfold', 'Blindfold', 'x-blindfold', 'common', 100],
    ['x-kerchief', 'Star Kerchief', 'x-kerchief', 'common', 100],
    ['x-neon-domino', 'Neon Domino', 'x-neon-domino', 'common', 100],
    ['x-welder', 'Welder Shield', 'x-welder', 'rare', 28],
    ['x-scarf', 'Scarf Wrap', 'x-scarf', 'rare', 28],
    ['x-split-chrome', 'Chrome Split', 'x-split-chrome', 'rare', 28],
    ['x-jester', 'Jester', 'x-jester', 'rare', 28],
    ['x-oni', 'Oni Demon', 'x-oni', 'ultra-rare', 6],
  ];
  for (const [id, name, f, tier, weight] of add) {
    c.traits.push({ id, name, file: `mask/${f}.png`, tier, weight, pool: 'experimental' });
  }
}

// ---- HEADS (+7) ----------------------------------------------------------
{
  const c = cat('head');
  stripOurs(c);
  const add = [
    ['x-cracked-gold', 'Gold Cracked Skull', 'x-cracked-gold', 'common', 100],
    ['x-wolf-grey', 'Grey Wolf Skull', 'x-wolf-grey', 'common', 100],
    ['x-chrome', 'Chrome Skull', 'x-chrome', 'common', 100],
    ['x-melting', 'Melting Skull', 'x-melting', 'rare', 28],
    ['x-horned', 'Horned Skull', 'x-horned', 'rare', 28],
    ['x-alien', 'Alien Skull', 'x-alien', 'rare', 28],
    ['x-golden', 'Golden Skull', 'x-golden', 'ultra-rare', 6],
  ];
  for (const [id, name, f, tier, weight] of add) {
    c.traits.push({ id, name, file: `head/${f}.png`, tier, weight, pool: 'experimental' });
  }
}

// ---- EYES (+8) -----------------------------------------------------------
{
  const c = cat('eyes');
  stripOurs(c);
  const add = [
    ['x-sleepy', 'Sleepy', 'x-sleepy', 'common', 100],
    ['x-heart', 'Heart Eyes', 'x-heart', 'common', 100],
    ['x-monocle', 'Monocle', 'x-monocle', 'common', 100],
    ['x-glow-green', 'Green Glow', 'x-glow-green', 'rare', 28],
    ['x-glow-red', 'Red Glow', 'x-glow-red', 'rare', 28],
    ['x-spiral', 'Spiral', 'x-spiral', 'rare', 28],
    ['x-cyclops', 'Cyclops', 'x-cyclops', 'rare', 28],
    ['x-laser', 'Laser Eyes', 'x-laser', 'ultra-rare', 6],
  ];
  for (const [id, name, f, tier, weight] of add) {
    c.traits.push({ id, name, file: `eyes/${f}.png`, tier, weight, pool: 'experimental' });
  }
}

// ---- CLOTHES (+10) -------------------------------------------------------
{
  const c = cat('clothes');
  stripOurs(c);
  const add = [
    ['x-trench-oxblood', 'Oxblood Trench', 'x-trench-oxblood', 'common', 100],
    ['x-hoodie-ash', 'Ash Hoodie', 'x-hoodie-ash', 'common', 100],
    ['x-peacoat-navy', 'Navy Peacoat', 'x-peacoat-navy', 'common', 100],
    ['x-denim-black', 'Black Denim', 'x-denim-black', 'common', 100],
    ['x-puffer-crimson', 'Crimson Puffer', 'x-puffer-crimson', 'common', 100],
    ['x-varsity-green', 'Green Varsity', 'x-varsity-green', 'rare', 28],
    ['x-raincoat-teal', 'Teal Raincoat', 'x-raincoat-teal', 'rare', 28],
    ['x-suit-pinstripe', 'Pinstripe Suit', 'x-suit-pinstripe', 'rare', 28],
    ['x-straitjacket', 'Straitjacket', 'x-straitjacket', 'rare', 28],
    ['x-bomber-gold', 'Gold Bomber', 'x-bomber-gold', 'ultra-rare', 6],
  ];
  for (const [id, name, f, tier, weight] of add) {
    c.traits.push({ id, name, file: `clothes/${f}.png`, tier, weight, pool: 'experimental' });
  }
}

// ---- HATS (+11) ----------------------------------------------------------
{
  const c = cat('headwear');
  stripOurs(c);
  const add = [
    ['x-fedora-grey', 'Grey Fedora', 'x-fedora-grey', 'common', 100],
    ['x-newsboy-rust', 'Rust Newsboy', 'x-newsboy-rust', 'common', 100],
    ['x-beanie-olive', 'Olive Beanie', 'x-beanie-olive', 'common', 100],
    ['x-bucket-camo', 'Camo Bucket', 'x-bucket-camo', 'common', 100],
    ['x-durag', 'Durag', 'x-durag', 'common', 100],
    ['x-visor-sun', 'Sun Visor', 'x-visor-sun', 'common', 100],
    ['x-cowboy', 'Cowboy Hat', 'x-cowboy', 'rare', 28],
    ['x-tophat-plum', 'Plum Top Hat', 'x-tophat-plum', 'rare', 28],
    ['x-party', 'Party Hat', 'x-party', 'rare', 28],
    ['x-crown-gold', 'Gold Crown', 'x-crown-gold', 'ultra-rare', 6],
    ['x-halo', 'Halo', 'x-halo', 'ultra-rare', 6],
  ];
  for (const [id, name, f, tier, weight] of add) {
    c.traits.push({ id, name, file: `headwear/${f}.png`, tier, weight, pool: 'experimental' });
  }
}

fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');

// report experimental per-layer live counts
function liveExp(k) {
  return cat(k).traits.filter((t) => t.pool === 'experimental' && (t.weight > 0) && t.enabled !== false).length;
}
console.log('Experimental LIVE counts (weight>0, enabled):');
for (const k of ['body', 'head', 'eyes', 'clothes', 'mask', 'headwear']) {
  console.log(`  ${k.padEnd(9)} ${liveExp(k)}`);
}

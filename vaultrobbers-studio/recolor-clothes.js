'use strict';

/* Recolor the base garment into colorways using a luminance-preserving tint.
   This keeps the black linework and the shading marks intact and only swaps the
   garment color, so it looks like a different jacket, not a hue-rotated mess.

   SVG-ready: when the artist delivers the vector garment, set SRC to that file
   (sharp rasterizes SVG at any size) and re-run, or swap to editing the SVG fill
   directly for perfect crispness. Same palette, same output filenames, so the
   manifest and the render pipeline do not change.

   Usage: SRC=layers/body/sage-puffer.png node recolor-clothes.js
*/

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = process.env.SRC || 'layers/body/sage-puffer.png';
const OUT = 'layers/clothes';
const SIZE = 2048;

// id, display name, hex, tier. Sage (the artist original) is kept separately in the manifest.
const PALETTE = [
  ['charcoal', 'Charcoal Puffer', '#3b4046', 'common'],
  ['navy', 'Navy Puffer', '#2f3d63', 'common'],
  ['rust', 'Rust Puffer', '#a85334', 'common'],
  ['forest', 'Forest Puffer', '#3f5e43', 'common'],
  ['plum', 'Plum Puffer', '#6a4a6e', 'common'],
  ['sand', 'Sand Puffer', '#c7b273', 'common'],
  ['blood', 'Blood Puffer', '#7e2d2d', 'rare'],
  ['ice', 'Ice Puffer', '#8fb8cf', 'rare'],
  ['vault-gold', 'Vault Gold Puffer', '#cfa23b', 'ultra-rare'],
];

const hexToRgb = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

(async () => {
  if (!fs.existsSync(SRC)) { console.error('source not found: ' + SRC); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  for (const [id, name, hex, tier] of PALETTE) {
    await sharp(SRC)
      .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .tint(hexToRgb(hex))
      .png()
      .toFile(path.join(OUT, id + '.png'));
    console.log('wrote clothes/' + id + '.png  (' + tier + ')');
  }
  console.log('done, ' + PALETTE.length + ' colorways from ' + SRC);
})();

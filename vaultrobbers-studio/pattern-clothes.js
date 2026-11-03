'use strict';

/* Pattern colorways for the garment: stripes, camo, denim.
   Each pattern is generated full-canvas, clipped to the garment's own alpha so it
   only appears on the jacket, then laid over a tinted base so the black linework
   and shading show through. Patterns use semi-transparent fills so nothing flattens.

   SVG-ready: set SRC to the artist's vector garment and re-run; the clip uses the
   garment alpha, so it adapts to any garment shape. Output filenames are stable so
   the manifest and render pipeline do not change.

   Usage: SRC=layers/body/sage-puffer.png node pattern-clothes.js
*/

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = process.env.SRC || 'layers/body/sage-puffer.png';
const OUT = 'layers/clothes';
const S = 2048;
const rgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

function stripesSvg() {
  let r = '';
  for (let y = -40; y < S; y += 150) r += `<rect x="0" y="${y}" width="${S}" height="78" fill="#2f3d63" fill-opacity="0.5"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${r}</svg>`;
}
function denimSvg() {
  let r = '';
  for (let x = 0; x < S; x += 22) r += `<rect x="${x}" y="0" width="9" height="${S}" fill="#ffffff" fill-opacity="0.08"/>`;
  for (let x = 0; x < S; x += 260) r += `<rect x="${x}" y="0" width="60" height="${S}" fill="#0f2038" fill-opacity="0.14"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${r}</svg>`;
}
function camoSvg() {
  const cols = ['#3f4a2a', '#6f5f3a', '#272e1a', '#9a8a5e'];
  const blobs = [
    [520, 640, 230, 180], [760, 560, 180, 150], [980, 720, 260, 210], [620, 900, 200, 170],
    [900, 980, 190, 160], [1180, 880, 170, 150], [720, 1180, 240, 190], [1040, 1200, 200, 160],
    [560, 1360, 180, 150], [980, 1420, 210, 170], [840, 760, 150, 130], [1120, 1060, 160, 140],
  ];
  let r = '';
  blobs.forEach((b, i) => { r += `<ellipse cx="${b[0]}" cy="${b[1]}" rx="${b[2]}" ry="${b[3]}" fill="${cols[i % cols.length]}" fill-opacity="0.62"/>`; });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${r}</svg>`;
}

const PATTERNS = [
  ['striped', 'Striped Puffer', '#cdbf9a', stripesSvg, 'common'],
  ['denim', 'Denim Puffer', '#3a5a86', denimSvg, 'common'],
  ['camo', 'Camo Puffer', '#5a6b3f', camoSvg, 'rare'],
];

(async () => {
  if (!fs.existsSync(SRC)) { console.error('source not found: ' + SRC); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const garment = await sharp(SRC).resize(S, S, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().png().toBuffer();
  for (const [id, name, baseHex, svgFn, tier] of PATTERNS) {
    const base = await sharp(garment).tint(rgb(baseHex)).png().toBuffer();
    const pattern = await sharp(Buffer.from(svgFn())).png().toBuffer();
    const clipped = await sharp(pattern).composite([{ input: garment, blend: 'dest-in' }]).png().toBuffer();
    await sharp(base).composite([{ input: clipped, blend: 'over' }]).png().toFile(path.join(OUT, id + '.png'));
    console.log('wrote clothes/' + id + '.png  (' + tier + ')');
  }
  console.log('done, ' + PATTERNS.length + ' pattern colorways from ' + SRC);
})();

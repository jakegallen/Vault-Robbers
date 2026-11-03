'use strict';

/* Generic luminance-preserving recolor for any trait (hats, masks, etc.).
   Same approach as the clothes recolor: keeps linework and shading, swaps color.
   SVG-ready: point a job's src at the artist's vector and re-run, filenames stay
   stable so the manifest and render pipeline do not change.

   Usage: node recolor-traits.js
*/

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const S = 2048;
const rgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

const JOBS = [
  {
    src: 'layers/headwear/trucker-cap.png', outDir: 'layers/hat',
    items: [
      ['trucker-red', 'Red Trucker', '#b23a34', 'common'],
      ['trucker-black', 'Black Trucker', '#24262b', 'common'],
      ['trucker-blue', 'Blue Trucker', '#2f4f86', 'common'],
      ['trucker-bone', 'Bone Trucker', '#d8d2c4', 'common'],
      ['trucker-orange', 'Orange Trucker', '#cf7a2e', 'rare'],
    ],
  },
  {
    src: 'layers/headwear/tan-beret.png', outDir: 'layers/hat',
    items: [
      ['beret-black', 'Black Beret', '#24262b', 'common'],
      ['beret-crimson', 'Crimson Beret', '#8c2f2f', 'common'],
      ['beret-navy', 'Navy Beret', '#2f3d63', 'common'],
    ],
  },
  {
    src: 'layers/eyes/masquerade-mask.png', outDir: 'layers/mask',
    items: [
      ['mask-black', 'Black Masquerade', '#24262b', 'rare'],
      ['mask-crimson', 'Crimson Masquerade', '#8c2f2f', 'rare'],
      ['mask-bone', 'Bone Masquerade', '#d8d2c4', 'rare'],
    ],
  },
];

(async () => {
  for (const job of JOBS) {
    if (!fs.existsSync(job.src)) { console.error('skip, source missing: ' + job.src); continue; }
    fs.mkdirSync(job.outDir, { recursive: true });
    for (const [id, name, hex, tier] of job.items) {
      await sharp(job.src)
        .resize(S, S, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .tint(rgb(hex))
        .png()
        .toFile(path.join(job.outDir, id + '.png'));
      console.log('wrote ' + path.join(job.outDir, id + '.png') + '  (' + tier + ')');
    }
  }
  console.log('done');
})();

'use strict';

/* Stopgap registration for the PLACEHOLDER faces: anchors each face so its chin
   sits in the jacket collar, so heads stop floating above the body. The real art
   will come pre-registered from the artist, so this script is a temporary aid, not
   part of the launch pipeline. Re-runnable: it reads the base garment to find the
   collar line and re-places each face onto a clean 2048 canvas.

   Usage: node align-faces.js
*/

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const S = 2048;

async function alphaBBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * ch + 3] > 20) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

(async () => {
  const puffer = 'layers/body/sage-puffer.png';
  const pb = await alphaBBox(puffer);
  const collarTop = pb.minY;             // top of the jacket shoulders
  const faceBottomTarget = collarTop + 150; // chin sits slightly into the collar
  const faces = ['classic-skull', 'grinning-skull', 'wide-eye-skull', 'mustache-skull', 'olive-alien-skull', 'gas-mask-skull', 'wolf-skull', 'droopy-brute'];
  fs.mkdirSync('layers/faces', { recursive: true });
  for (const id of faces) {
    const src = 'layers/head/' + id + '.png';
    if (!fs.existsSync(src)) { console.log('skip, missing ' + src); continue; }
    const bb = await alphaBBox(src);
    const cw = bb.maxX - bb.minX + 1, chh = bb.maxY - bb.minY + 1;
    const newTop = Math.max(0, Math.round(faceBottomTarget - chh));
    const newLeft = Math.max(0, Math.round(S / 2 - cw / 2));
    const content = await sharp(src).extract({ left: bb.minX, top: bb.minY, width: cw, height: chh }).png().toBuffer();
    await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: content, left: newLeft, top: newTop }])
      .png().toFile('layers/faces/' + id + '.png');
    console.log(id + ': placed at top ' + newTop + ' (h ' + chh + ')');
  }
  console.log('collarTop ' + collarTop + ', faceBottomTarget ' + faceBottomTarget);
})();

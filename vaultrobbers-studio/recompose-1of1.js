'use strict';
/* Fix pass: give five 1/1s a unique mask (so none repeat), change the Lovers'
   outfit so it differs from Public Enemy, and re-composite all ten WITHOUT the
   corner seal. Re-edits only the five chars that need it; everything else is
   re-composited from the saved layers (no new generation).
   Run: node recompose-1of1.js
*/
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const R = __dirname;
const TOK = process.env.DASHBOARD_TOKEN;
const APIE = 'http://localhost:4000/pub/main/vaultrobbers-studio/api/edit-1of1';
const S = 2048;
const STYLE = ' Flat hand drawn cartoon, bold black outlines, flat colors, no text, no watermark.';
const KEEP = ' Keep the solid magenta background and keep everything else exactly the same, same pose and size.';
const MASKS = {
  990: 'Add a green leaf shaped domino eye mask over the eyes.',
  991: 'Add a sleek black silk domino eye mask, keep the gold monocle.',
  995: 'Add a slim high tech black and gold visor eye mask.',
  997: 'Add a grey cloth mask covering the lower half of the face.',
  999: 'Change the pinstripe outfit to a brown leather jacket with a flat cap, and add a small red lace masquerade eye mask.',
};
async function post(url, body) {
  for (let a = 0; a < 6; a++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOK }, body: JSON.stringify(body) }); const j = await r.json(); if (j.ok) return j; console.log('  err', JSON.stringify(j).slice(0, 80)); }
    catch (e) { console.log('  retry', a, String(e).slice(0, 40)); }
    await new Promise(z => setTimeout(z, 7000));
  }
  return null;
}
function keyMagenta(d, w, h) { for (let i = 0; i < w * h; i++) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; if (r > 150 && b > 110 && g < 105 && (r - g) > 60 && (b - g) > 30) d[i * 4 + 3] = 0; } return d; }
function bbox(d, w, h) { let minX = w, minY = h, maxX = -1, maxY = -1; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (d[(y * w + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } } return { minX, minY, maxX, maxY }; }
(async () => {
  for (const idx of Object.keys(MASKS)) {
    const ci = 7000 + (Number(idx) - 990);
    const uri = 'data:image/png;base64,' + fs.readFileSync(path.join(R, `mythic-src/${ci}-0.png`)).toString('base64');
    console.log('mask edit', idx);
    await post(APIE, { index: ci, prompt: MASKS[idx] + KEEP + STYLE, image: uri });
  }
  const sil = await sharp(path.join(R, 'layers/body/shadow-silhouette.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sb = bbox(sil.data, sil.info.width, sil.info.height);
  const targetH = (sb.maxY - sb.minY) * 1.14; const targetCX = S / 2, targetCY = (sb.minY + sb.maxY) / 2 * (S / sil.info.width);
  for (let i = 0; i < 10; i++) {
    const ci = 7000 + i, bi = 7500 + i, idx = 990 + i;
    const cm = await sharp(path.join(R, `mythic-src/${ci}-0.png`)).resize(S, S, { fit: 'contain', background: { r: 255, g: 0, b: 255 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    keyMagenta(cm.data, cm.info.width, cm.info.height);
    const cb = bbox(cm.data, cm.info.width, cm.info.height);
    const charPng = await sharp(Buffer.from(cm.data), { raw: { width: cm.info.width, height: cm.info.height, channels: 4 } }).extract({ left: cb.minX, top: cb.minY, width: Math.max(1, cb.maxX - cb.minX), height: Math.max(1, cb.maxY - cb.minY) }).png().toBuffer();
    const ch = cb.maxY - cb.minY, cw = cb.maxX - cb.minX; const scale = targetH / ch; const nw = Math.round(cw * scale), nh = Math.round(ch * scale);
    const scaled = await sharp(charPng).resize(nw, nh).png().toBuffer();
    const charLayer = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: scaled, left: Math.round(targetCX - nw / 2), top: Math.round(targetCY - nh / 2) }]).png().toBuffer();
    const bgBuf = await sharp(path.join(R, `mythic-src/${bi}-0.png`)).resize(S, S, { fit: 'cover' }).toBuffer();
    await sharp(bgBuf).composite([{ input: charLayer }]).png().toFile(path.join(R, `layers/mythic/${idx}.png`));
    console.log(idx, 'recomposited (no seal)');
  }
  console.log('done');
})();

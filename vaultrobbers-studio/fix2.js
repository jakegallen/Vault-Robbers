'use strict';
/* Fix pass 2:
   - Gentleman/Vanisher/Outlaw/Mastermind: fully cover/replace the face so no bare
     skull shows, each distinct.
   - The Lovers: make it a real DUO (Bonnie AND Clyde, two figures) from a two-robber base.
   Recomposite all ten, no seal, scale-matched, no legs.
*/
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const R = __dirname;
const TOK = process.env.DASHBOARD_TOKEN;
const APIE = 'http://localhost:4000/pub/main/vaultrobbers-studio/api/edit-1of1';
const S = 2048;
const STYLE = ' Flat hand drawn cartoon, bold black outlines, flat colors, no text, no watermark.';
const KEEP = ' Keep the solid magenta background and keep everything else exactly the same, same pose, costume and size.';
const FULL = {
  991: 'Give it a full smooth white theatrical opera mask that covers the entire face, with a gold monocle, so NO skull is visible.',
  992: 'Make the face a dark featureless shadow under the hat brim and the sunglasses, like an unidentified man, so NO skull is visible.',
  993: 'Pull the red bandana up over the nose and mouth and the brown cowboy hat brim low over the eyes, so the face is fully covered and NO skull is visible.',
  995: 'Give it a smooth featureless sleek black full-face mask with a thin gold rim, so NO skull is visible.',
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
async function cutScaleCompose(charFile, bgFile, outFile, targetH, targetCX, targetCY) {
  const cm = await sharp(charFile).resize(S, S, { fit: 'contain', background: { r: 255, g: 0, b: 255 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  keyMagenta(cm.data, cm.info.width, cm.info.height);
  const cb = bbox(cm.data, cm.info.width, cm.info.height);
  const charPng = await sharp(Buffer.from(cm.data), { raw: { width: cm.info.width, height: cm.info.height, channels: 4 } }).extract({ left: cb.minX, top: cb.minY, width: Math.max(1, cb.maxX - cb.minX), height: Math.max(1, cb.maxY - cb.minY) }).png().toBuffer();
  const ch = cb.maxY - cb.minY, cw = cb.maxX - cb.minX; const scale = targetH / ch; const nw = Math.round(cw * scale), nh = Math.round(ch * scale);
  const scaled = await sharp(charPng).resize(nw, nh).png().toBuffer();
  const layer = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: scaled, left: Math.round(targetCX - nw / 2), top: Math.round(targetCY - nh / 2) }]).png().toBuffer();
  const bgBuf = await sharp(bgFile).resize(S, S, { fit: 'cover' }).toBuffer();
  await sharp(bgBuf).composite([{ input: layer }]).png().toFile(outFile);
}
(async () => {
  // A: full-cover mask edits
  for (const idx of Object.keys(FULL)) {
    const ci = 7000 + (Number(idx) - 990);
    const uri = 'data:image/png;base64,' + fs.readFileSync(path.join(R, `mythic-src/${ci}-0.png`)).toString('base64');
    console.log('full mask', idx);
    await post(APIE, { index: ci, prompt: FULL[idx] + KEEP + STYLE, image: uri });
  }
  // B: Lovers duo
  const SB = 1024;
  const dmbg = await sharp({ create: { width: SB, height: SB, channels: 3, background: { r: 255, g: 0, b: 255 } } }).png().toBuffer();
  const bodyB = await sharp(path.join(R, 'layers/body/shadow-silhouette.png')).resize(Math.round(SB * 0.58), Math.round(SB * 0.58), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  const skullB = await sharp(path.join(R, 'layers/head/classic-skull.png')).resize(Math.round(SB * 0.58), Math.round(SB * 0.58), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  const yoff = Math.round(SB * 0.20);
  const duoBase = await sharp(dmbg).composite([
    { input: bodyB, left: Math.round(SB * 0.00), top: yoff }, { input: skullB, left: Math.round(SB * 0.00), top: yoff },
    { input: bodyB, left: Math.round(SB * 0.42), top: yoff }, { input: skullB, left: Math.round(SB * 0.42), top: yoff },
  ]).png().toBuffer();
  const duoUri = 'data:image/png;base64,' + duoBase.toString('base64');
  const duoPrompt = 'Two 1930s outlaws standing side by side as a couple, Bonnie and Clyde. The left one is a woman in a red beret and a long brown coat holding a revolver, with a small red domino mask and NO skull. The right one is a man in a brown leather jacket and a flat cap holding a stack of cash, with a small black domino mask and NO skull. Keep the solid magenta background.' + STYLE;
  console.log('lovers duo');
  await post(APIE, { index: 7009, prompt: duoPrompt, image: duoUri });

  // target scale
  const sil = await sharp(path.join(R, 'layers/body/shadow-silhouette.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sb = bbox(sil.data, sil.info.width, sil.info.height);
  const targetH = (sb.maxY - sb.minY) * 1.14; const targetCX = S / 2, targetCY = (sb.minY + sb.maxY) / 2 * (S / sil.info.width);

  // recomposite 990-998 from chars
  for (let i = 0; i < 9; i++) {
    await cutScaleCompose(path.join(R, `mythic-src/${7000 + i}-0.png`), path.join(R, `mythic-src/${7500 + i}-0.png`), path.join(R, `layers/mythic/${990 + i}.png`), targetH, targetCX, targetCY);
    console.log(990 + i, 'done');
  }
  // 999 duo: wider footprint
  await cutScaleCompose(path.join(R, 'mythic-src/7009-0.png'), path.join(R, 'mythic-src/7509-0.png'), path.join(R, 'layers/mythic/999.png'), targetH * 1.08, targetCX, targetCY);
  console.log('999 duo done');
  console.log('all done');
})();

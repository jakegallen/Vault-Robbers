#!/usr/bin/env node
/*
 * EXPERIMENTAL BODY authoring for Vault Robbers.
 *
 * Derives ONE experimental body from the CEO-approved ORIGINAL body art
 * (layers/body/shadow-silhouette.png) by REMOVING THE LEGS and closing the
 * bottom into a smooth rounded hood shape, matching the Mythic 1/1 silhouette
 * (rounded, legless, floating ghost-robber).
 *
 * HOW IT WORKS (keeps the approved art, only redraws the removed-legs zone):
 *   1. Load the real original PNG pixels (2048x2048, transparent).
 *   2. Keep every row ABOVE the cut line y=CUT (the head, hood, torso the CEO
 *      liked) exactly as drawn. The original tapers to a pointed teardrop with
 *      two leg-like lobes below this line; that whole zone is discarded.
 *   3. Under the cut, draw a procedural ROUNDED DOME in the SAME charcoal fill
 *      (#393939) with the SAME ink outline, starting at the original body's
 *      left/right edge at the cut (L=783, R=1300) and curving smoothly inward
 *      to a closed rounded bottom at BOT. No point, no legs, no gap.
 *   4. The widest part of the body sits at ~y1180..1260, right where the clothes
 *      hem (y~1431 per the anchor grid) crosses it, so every jacket closes over
 *      the body with no floating hem and no gap where the legs used to be.
 *   5. Re-attach the original floating ground-dash + puddle motif (it lives far
 *      below at y~1728 in the original, well under the dome, so it survives the
 *      cut untouched).
 *
 * Anchor grid honored (from author-pass2.js / author-sample-traits.js):
 *   skull head   x 753..1101  y 504..798    (kept clear, drawn by head layer)
 *   clothes box  x 723..1378  y 626..1431    hem y~1431  (dome fills under it)
 *   ground dash  y ~ 1775                      (kept from the original)
 *
 * Standalone. Writes ONLY layers/body/x-hooded-nolegs.png. Does NOT touch the
 * original pool art, the Mythic 1/1s, render.js, config, deployed metadata, or
 * any contract.
 *
 * Run: node author-experimental-body.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = __dirname;
const LAYERS = path.join(ROOT, 'layers');
const SRC = path.join(LAYERS, 'body', 'shadow-silhouette.png');
const OUT = path.join(LAYERS, 'body', 'x-hooded-nolegs.png');
const S = 2048;

// Body profile measured from the original (see the bbox probe in the build notes):
//   at the cut line y=1250 the body edges are L=783, R=1300 (centre ~1041).
// We keep everything above CUT and cap it with a rounded dome that bottoms at BOT.
const CUT = 1248;      // discard the original teardrop/legs below this row
const BLEND = 12;      // short feather so no bright partial-alpha seam shows
const L_CUT = 781;     // original left edge at the cut
const R_CUT = 1301;    // original right edge at the cut
// The rounded bottom must tuck UNDER the jacket hems so nothing pokes out. Jacket
// hems land y~1395..1453 and the narrowest (vest/puffer) only cover ~x860..1230
// at the hem line, so the dome bottoms at BOT just inside that and pulls its base
// width in to BASE_HALF around the centre. Standalone (no jacket) it still reads
// as a clean rounded legless hood.
const BOT = 1418;      // rounded bottom, just inside the shallowest jacket hem
const BASE_HALF = 150; // half-width of the flat-ish rounded base at the very bottom
const CX = Math.round((L_CUT + R_CUT) / 2); // 1041

const FILL = '#393939';   // exact original charcoal torso fill (57,57,57)
const INK = '#141414';    // house ink outline (original edge is near-black)
const STROKE = 13;        // outline weight at 2048, matched to the original line

// Rounded dome cap. Two cubic curves from the cut edges sweeping in to a single
// rounded bottom at (CX, BOT). The top edge is a short flat run across the cut so
// it merges invisibly with the kept body edges; the fill is painted first, then
// only the LEFT, BOTTOM and RIGHT arc get the ink outline (the top seam stays
// open so it tucks under the original body with no double line).
function domeSvg() {
  // The dome TOP starts well above the cut (topY) so it tucks fully under the
  // opaque kept body, hiding its open top seam. From the hips it eases down one
  // continuous curve per side into a single smooth rounded bottom at (CX, BOT),
  // a closed hood shape (not a ball, not a point).
  const topY = CUT - 90;              // overlap generously under the opaque body
  const bulgeL = L_CUT - 4;           // keep the hips full just under the cut
  const bulgeR = R_CUT + 4;
  const sideY = topY + 150;           // where the sides are still near full width
  const baseL = CX - BASE_HALF;       // narrow rounded base so jacket hems cover it
  const baseR = CX + BASE_HALF;
  // each side eases from the full hip down to the narrow rounded base, then a short
  // arc across the bottom joins them into a smooth closed hood (no point, no legs).
  const fillPath =
    `M${L_CUT} ${topY} ` +
    `C${bulgeL} ${sideY}, ${baseL - 30} ${BOT - 20}, ${baseL} ${BOT} ` +
    `Q${CX} ${BOT + 30} ${baseR} ${BOT} ` +
    `C${baseR + 30} ${BOT - 20}, ${bulgeR} ${sideY}, ${R_CUT} ${topY} ` +
    `Z`;
  const outlinePath =
    `M${L_CUT} ${topY} ` +
    `C${bulgeL} ${sideY}, ${baseL - 30} ${BOT - 20}, ${baseL} ${BOT} ` +
    `Q${CX} ${BOT + 30} ${baseR} ${BOT} ` +
    `C${baseR + 30} ${BOT - 20}, ${bulgeR} ${sideY}, ${R_CUT} ${topY}`;
  // the signature floating ground-dash + puddle (same motif + coordinates the
  // original body and the pass-2 bodies use, so the legless body still floats).
  const ground = `
    <g stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" fill="none">
      <line x1="520" y1="1775" x2="640" y2="1775"/>
      <line x1="690" y1="1778" x2="1180" y2="1778"/>
      <line x1="1230" y1="1775" x2="1360" y2="1775"/>
    </g>
    <g fill="${INK}" opacity="0.9">
      <ellipse cx="980" cy="1838" rx="60" ry="16"/>
      <ellipse cx="900" cy="1852" rx="48" ry="12"/>
      <ellipse cx="1060" cy="1850" rx="44" ry="11"/>
    </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <path d="${fillPath}" fill="${FILL}"/>
    <path d="${outlinePath}" fill="none" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
    ${ground}
  </svg>`;
}

// A vertical alpha gradient mask: fully opaque above the seam, feathering to 0
// across the seam band, so the kept original art fades into the dome instead of
// leaving a hard horizontal line.
function keepMaskSvg() {
  const y0 = CUT - BLEND;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <defs>
      <linearGradient id="k" x1="0" y1="0" x2="0" y2="${S}" gradientUnits="userSpaceOnUse">
        <stop offset="${(y0 / S)}" stop-color="#ffffff"/>
        <stop offset="${(CUT / S)}" stop-color="#000000"/>
      </linearGradient>
    </defs>
    <rect width="${S}" height="${S}" fill="url(#k)"/>
  </svg>`;
}

async function main() {
  // 1. Original art, raw RGBA.
  const src = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = src.info.width, h = src.info.height, ch = src.info.channels;

  // 2. Build the keep-mask (greyscale) and multiply it into the original alpha so
  //    everything at/below the cut is removed with a soft feather.
  const maskPng = await sharp(Buffer.from(keepMaskSvg()))
    .resize(S, S).greyscale().raw().toBuffer();
  const kept = Buffer.from(src.data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const m = maskPng[y * w + x] / 255;
      kept[i + 3] = Math.round(kept[i + 3] * m);
    }
  }
  const keptPng = await sharp(kept, { raw: { width: w, height: h, channels: ch } }).png().toBuffer();

  // 3. Rasterize the dome cap.
  const domePng = await sharp(Buffer.from(domeSvg())).png().toBuffer();

  // 4. Composite: dome UNDER the kept body art so the body edges overlap the
  //    dome's open top seam and hide it.
  await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: domePng }, { input: keptPng }])
    .png()
    .toFile(OUT);

  console.log('wrote', path.relative(ROOT, OUT));
  console.log(`cut y=${CUT}, dome bottom y=${BOT}, hips L=${L_CUT} R=${R_CUT}, centre x=${CX}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/*
 * EXPERIMENTAL POOL EXPANSION for Vault Robbers.
 *
 * Adds a large batch of new EXPERIMENTAL traits (masks, heads, eyes, clothes,
 * hats) in the ink-outline / flat-fill house style, every one authored to the
 * measured anchor grid so it composites on-anchor over the ONE experimental
 * legless hooded body (layers/body/x-hooded-nolegs.png).
 *
 * ANCHOR GRID (verified by compositing over the real skull + legless body):
 *   skull head   box x 753..1101  y 504..798   crown top y~504  jaw y~798
 *   eye centres  left (812,634)  right (968,622)   (sockets of classic skull)
 *   mask band    x 742..1100  y 560..760  (hugs the eye sockets)
 *   clothes box  x 723..1378  y 626..1431   collar y~700  hem y~1400
 *                legless body bottom tucks to y~1418 so hems cover it
 *   hat crown    sits above the skull crown, bottom edge no lower than y~560
 *
 * Writes ONLY new x-* / experimental files into layers/. Does NOT touch the
 * original-pool art, the Mythic 1/1s, render.js, deployed metadata, or contract.
 *
 * Run: node author-experimental-expand.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = __dirname;
const LAYERS = path.join(ROOT, 'layers');
const S = 2048;

// House style -------------------------------------------------------------
const INK = '#141414';
const STROKE = 12;
const STROKE_THIN = 7;
const BONE = '#d9d2c4';
const BONE_SH = '#b8ae9c';

function rasterize(svg, outPath) {
  return sharp(Buffer.from(svg), { density: 300 }).resize(S, S, { fit: 'cover' }).png().toFile(outPath);
}
function svgDoc(inner, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${defs}</defs>${inner}</svg>`;
}
function seams(d, color = 'rgba(0,0,0,0.2)', wsw = STROKE_THIN) {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${wsw}" stroke-linecap="round"/>`;
}

// Eye centres on the skull sockets.
const EYE_L = { x: 812, y: 634 };
const EYE_R = { x: 968, y: 622 };
function eyeHole(e, rx, ry, fill = '#ffffff') {
  return `<ellipse cx="${e.x}" cy="${e.y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${INK}" stroke-width="${STROKE_THIN}"/>`;
}

// ===========================================================================
// MASKS  (z5). Band footprint x 742..1100 y 560..760, over the eye sockets.
// ===========================================================================
function bandPath() {
  return 'M742 606 q140 -58 258 -42 q120 16 128 56 q8 54 -116 84 q-146 34 -278 -6 q-56 -38 8 -76 z';
}
function maskBand(fill, inner, extra = '') {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="${bandPath()}" fill="${fill}"/>${inner}${extra}</g>`);
}

// full-face knit (balaclava-like) base used by several styles
function fullFace(fill, inner) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M756 520 q150 -48 296 -18 q74 16 72 140 q-4 150 -176 168 q-170 -14 -196 -150 q-12 -92 4 -140 z" fill="${fill}"/>
    ${inner}</g>`);
}

// 1 visor band (cyclops slit)
function maskVisorSlit(fill, glow) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M734 584 q150 -54 284 -34 q120 18 126 70 q6 60 -118 92 q-150 36 -288 -8 q-56 -42 4 -92 z" fill="${fill}"/>
    <path d="M770 614 q140 -24 260 -4" stroke="${glow}" stroke-width="16" fill="none" stroke-linecap="round"/>
    <path d="M770 614 q140 -24 260 -4" stroke="${glow}" stroke-width="34" fill="none" stroke-linecap="round" opacity="0.25"/>
  </g>`);
}
// 2 muzzle (lower-face cage)
function maskMuzzle(fill) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M774 678 q138 -22 268 -2 q50 10 46 58 q-8 78 -164 96 q-156 -12 -164 -92 q-4 -50 14 -58 z" fill="${fill}"/>
    <g stroke="${INK}" stroke-width="8">
      <path d="M800 690 l0 120 M860 684 l0 128 M912 682 l0 128 M968 684 l0 124 M1020 692 l0 110"/>
      <path d="M784 724 q140 20 268 0 M790 764 q130 18 250 0"/>
    </g>
  </g>`);
}
// 3 blindfold (over the eyes, tie off the side)
function maskBlindfold(fill) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M734 598 q150 -36 290 -14 q50 8 48 52 q-6 56 -150 76 q-150 18 -244 -22 q-38 -46 6 -92 z" fill="${fill}"/>
    <path d="M734 606 l-60 -26 l30 56 z" fill="${fill}"/>
    <path d="M700 600 l-70 40 M706 626 l-74 30" stroke="${fill}" stroke-width="22" stroke-linecap="round"/>
    ${seams('M770 616 q130 18 250 2', 'rgba(255,255,255,0.14)')}
  </g>`);
}
// 4 welding visor (flip shield)
function maskWelder(fill) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M752 546 q150 -40 290 -12 q66 16 64 150 q-2 120 -60 150 l0 40 q0 36 -40 38 l-210 0 q-40 -2 -40 -38 l0 -46 q-56 -34 -58 -148 q-2 -92 ${62} -126 z" fill="${fill}"/>
    <rect x="800" y="612" width="196" height="54" rx="12" fill="#1a2b22" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <path d="M820 639 h156" stroke="#3fae7a" stroke-width="8"/>
    ${seams('M770 560 q140 -22 262 0', 'rgba(255,255,255,0.12)')}
  </g>`);
}
// 5 kabuki / oni (horned demon full-face)
function maskOni(fill, horn) {
  return fullFace(fill, `
    ${eyeHole(EYE_L, 44, 24, '#b8202a')} ${eyeHole(EYE_R, 48, 26, '#b8202a')}
    <path d="M770 540 q-40 -120 -96 -150 q70 10 120 90 z" fill="${horn}"/>
    <path d="M1050 536 q40 -120 96 -150 q-70 10 -120 90 z" fill="${horn}"/>
    <path d="M842 744 q74 20 152 0 q-20 44 -78 44 q-56 0 -74 -44 z" fill="#1a1a1a"/>
    <g stroke="#fff" stroke-width="7"><path d="M862 748 l0 34 M912 752 l0 32 M962 748 l0 34"/></g>`);
}
// 6 scarf wrap (full wrap, only eyes show)
function maskScarf(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M756 560 q150 -46 296 -16 q74 16 72 120 q-2 90 -70 150 l20 150 q6 44 -40 46 q-50 -2 -58 -46 l-30 -130 q-150 -14 -192 -140 q-20 -90 ${0} -130 z" fill="${fill}"/>
    ${eyeHole(EYE_L, 42, 26, '#ffffff')} ${eyeHole(EYE_R, 46, 28, '#ffffff')}
    <path d="M992 814 l44 150 q-40 30 -72 0 z" fill="${sh}"/>
    ${seams('M786 700 q140 24 260 4', 'rgba(0,0,0,0.18)')}
  </g>`);
}
// 7 bandit kerchief low with star
function maskKerchief(fill, star) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M760 678 q150 -24 290 -4 q58 10 54 60 q-10 72 -152 94 q-150 20 -224 -40 q-40 -56 32 -110 z" fill="${fill}"/>
    <path d="M760 678 l-54 -12 l34 48 z" fill="${fill}"/>
    <path d="M905 712 l16 34 l38 2 l-28 26 l10 38 l-36 -22 l-36 22 l10 -38 l-28 -26 l38 -2 z" fill="${star}"/>
  </g>`);
}
// 8 half-chrome split mask
function maskSplit(a, b) {
  return maskBand(a,
    eyeHole(EYE_L, 44, 34, '#141414') + eyeHole(EYE_R, 48, 36, '#141414'),
    `<clipPath id="sp"><path d="${bandPath()}"/></clipPath>
     <rect x="905" y="520" width="300" height="300" fill="${b}" clip-path="url(#sp)"/>
     <path d="M905 540 l0 260" stroke="${INK}" stroke-width="${STROKE_THIN}"/>`);
}
// 9 carnival jester (two-tone with bell tips at the band ends)
function maskJester(a, b) {
  return maskBand(a,
    eyeHole(EYE_L, 42, 32) + eyeHole(EYE_R, 46, 34),
    `<path d="M742 606 l-48 -40 q-30 40 10 70 z" fill="${b}"/>
     <path d="M1120 636 l48 -30 q24 42 -18 66 z" fill="${b}"/>
     <circle cx="686" cy="560" r="16" fill="#f3d150"/><circle cx="1178" cy="600" r="16" fill="#f3d150"/>`);
}
// 10 neon rave domino (glowing rim)
function maskNeonDomino(fill, glow) {
  return maskBand(fill,
    eyeHole(EYE_L, 46, 36, '#0b0b0b') + eyeHole(EYE_R, 50, 38, '#0b0b0b'),
    `<path d="${bandPath()}" fill="none" stroke="${glow}" stroke-width="10"/>
     <path d="${bandPath()}" fill="none" stroke="${glow}" stroke-width="22" opacity="0.25"/>`);
}

// ===========================================================================
// HEADS / SKULLS  (z3). Skull box x 753..1101 y 504..798. Sockets at EYE_L/R.
// ===========================================================================
function skullBase(fill, inner, defs = '') {
  // a rounded skull on-anchor with jaw + teeth; inner draws sockets + extras.
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M760 632 q0 -132 168 -142 q168 10 168 142 q0 72 -48 114 l0 54 q0 36 -40 38 l-160 0 q-40 -2 -40 -38 l0 -54 q-48 -42 -48 -114 z" fill="${fill}"/>
    ${inner}
  </g>`, defs);
}
function teeth(color = INK) {
  return `<g stroke="${color}" stroke-width="7"><path d="M842 792 l0 -28 M886 794 l0 -30 M930 794 l0 -30 M974 792 l0 -28"/></g>`;
}
function nose() { return `<path d="M905 686 l-22 42 l44 0 z" fill="#1a1a1a"/>`; }

function headCrackedGold() {
  return skullBase(BONE,
    eyeHole(EYE_L, 52, 46, '#1a1a1a') + eyeHole(EYE_R, 56, 48, '#1a1a1a') + nose() + teeth() +
    `<path d="M905 500 l-28 66 l32 44 l-20 54" fill="none" stroke="#d9a528" stroke-width="10" stroke-linecap="round"/>
     <path d="M1010 560 l-30 50" stroke="#d9a528" stroke-width="7"/>`);
}
function headHorned() {
  return skullBase(BONE,
    `<path d="M772 560 q-70 -120 -150 -150 q110 0 190 110 z" fill="${BONE}"/>
     <path d="M1084 556 q70 -120 150 -150 q-110 0 -190 110 z" fill="${BONE}"/>` +
    eyeHole(EYE_L, 50, 44, '#1a1a1a') + eyeHole(EYE_R, 54, 46, '#1a1a1a') + nose() + teeth());
}
function headGolden() {
  return skullBase('#e7c04a',
    eyeHole(EYE_L, 50, 44, '#5a4410') + eyeHole(EYE_R, 54, 46, '#5a4410') +
    `<path d="M905 686 l-22 42 l44 0 z" fill="#5a4410"/>` + teeth('#8a6410') +
    `<path d="M800 580 q120 -26 220 0" stroke="#fff" stroke-width="8" fill="none" opacity="0.5"/>`);
}
function headMelting() {
  return skullBase(BONE,
    eyeHole(EYE_L, 50, 52, '#1a1a1a') + eyeHole(EYE_R, 54, 54, '#1a1a1a') + nose() +
    `<path d="M812 686 q-10 120 20 190 q30 -60 10 -190 z" fill="${BONE}" stroke="${INK}" stroke-width="${STROKE}"/>
     <path d="M1000 672 q20 150 -14 230 q-40 -70 -18 -230 z" fill="${BONE}" stroke="${INK}" stroke-width="${STROKE}"/>` +
    teeth());
}
function headChrome() {
  return skullBase('#aeb4bc',
    eyeHole(EYE_L, 50, 44, '#20242a') + eyeHole(EYE_R, 54, 46, '#20242a') + nose() + teeth() +
    `<path d="M790 560 q110 -30 210 0" stroke="#ffffff" stroke-width="12" fill="none" opacity="0.7"/>
     <path d="M1030 640 q20 60 -10 110" stroke="#5c646e" stroke-width="12" fill="none"/>`,
    '');
}
function headAlien() {
  // big teardrop cranium, slanted black almond eyes
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M905 492 q180 10 190 170 q6 120 -90 180 l0 20 q0 34 -40 36 l-120 0 q-40 -2 -40 -36 l0 -20 q-96 -60 -90 -180 q10 -160 190 -170 z" fill="#7fae7a"/>
    <path d="M800 636 q40 -40 96 -10 q-30 56 -96 44 q-18 -18 0 -34 z" fill="#101410"/>
    <path d="M1010 626 q-40 -40 -96 -10 q30 56 96 44 q18 -18 0 -34 z" fill="#101410"/>
    <path d="M905 712 l-12 24 l24 0 z" fill="#101410"/>
  </g>`);
}
function headWolfGrey() {
  // wolf skull snout variant (grey), long muzzle under the sockets
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M768 620 q0 -120 150 -130 q150 10 150 130 q0 50 -26 86 l-10 120 q-4 44 -60 50 q-40 70 -94 0 q-56 -6 -60 -50 l-10 -120 q-26 -36 -30 -86 z" fill="#c7ccd2"/>
    ${eyeHole(EYE_L, 40, 30, '#1a1a1a')} ${eyeHole(EYE_R, 44, 32, '#1a1a1a')}
    <path d="M882 820 q46 24 92 0 l-10 40 q-36 24 -72 0 z" fill="#1a1a1a"/>
    <g stroke="${INK}" stroke-width="7"><path d="M876 792 l-6 30 M934 794 l6 30"/></g>
  </g>`);
}

// ===========================================================================
// EYES  (z6). Over sockets, under masks visually. Expressions / glow.
// ===========================================================================
function eyesBase(inner) { return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE_THIN}" stroke-linejoin="round">${inner}</g>`); }

function eyesGlowGreen() {
  const c = '#4effa3';
  return eyesBase(`
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="34" fill="${c}"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="36" fill="${c}"/>
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="62" fill="${c}" opacity="0.22"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="64" fill="${c}" opacity="0.22"/>`);
}
function eyesGlowRed() {
  const c = '#ff4d4d';
  return eyesBase(`
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="34" fill="${c}"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="36" fill="${c}"/>
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="62" fill="${c}" opacity="0.22"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="64" fill="${c}" opacity="0.22"/>`);
}
function eyesLaser() {
  return eyesBase(`
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="20" fill="#ff2a2a"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="22" fill="#ff2a2a"/>
    <path d="M${EYE_L.x} ${EYE_L.y} L120 ${EYE_L.y + 220}" stroke="#ff2a2a" stroke-width="14" opacity="0.85"/>
    <path d="M${EYE_R.x} ${EYE_R.y} L1920 ${EYE_R.y + 180}" stroke="#ff2a2a" stroke-width="14" opacity="0.85"/>`);
}
function eyesHeart() {
  const h = (e, s) => `<path d="M${e.x} ${e.y + s * 0.5} c-${s} -${s} -${s * 1.6} ${s * 0.3} 0 ${s * 1.1} c${s * 1.6} -${s * 0.8} ${s} -${s * 1.3} 0 -${s * 0.5} z" fill="#ff5a7a"/>`;
  return eyesBase(h(EYE_L, 34) + h(EYE_R, 36));
}
function eyesSpiral() {
  const sp = (e, r) => {
    let d = `M${e.x} ${e.y}`;
    for (let i = 0; i < 26; i++) { const a = i * 0.6, rr = r * i / 26; d += ` L${(e.x + Math.cos(a) * rr).toFixed(1)} ${(e.y + Math.sin(a) * rr).toFixed(1)}`; }
    return `<circle cx="${e.x}" cy="${e.y}" r="${r}" fill="#fff"/><path d="${d}" fill="none" stroke="#141414" stroke-width="9"/>`;
  };
  return eyesBase(sp(EYE_L, 40) + sp(EYE_R, 42));
}
function eyesMonocle() {
  return eyesBase(`
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="18" fill="#141414"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="58" fill="rgba(200,230,255,0.25)" stroke="#d9a528" stroke-width="12"/>
    <path d="M${EYE_R.x} ${EYE_R.y + 58} q20 120 -60 200" stroke="#d9a528" stroke-width="7" fill="none"/>`);
}
function eyesCyclops() {
  const cx = (EYE_L.x + EYE_R.x) / 2, cy = (EYE_L.y + EYE_R.y) / 2;
  return eyesBase(`
    <circle cx="${cx}" cy="${cy}" r="70" fill="#fff" stroke="#141414" stroke-width="12"/>
    <circle cx="${cx}" cy="${cy}" r="30" fill="#141414"/>`);
}
function eyesSleepy() {
  const lid = (e, w) => `<path d="M${e.x - w} ${e.y} q${w} 34 ${w * 2} 0" fill="none" stroke="#141414" stroke-width="14" stroke-linecap="round"/><circle cx="${e.x}" cy="${e.y + 8}" r="10" fill="#141414"/>`;
  return eyesBase(lid(EYE_L, 44) + lid(EYE_R, 48));
}

// ===========================================================================
// CLOTHES / JACKETS  (z4). Footprint x 723..1378 y 626..1431, collar y~700,
// hem lands near y~1400 so it covers the legless body bottom (y~1418). Drawn in
// the pass-2 jacket idiom (same silhouette family) so they nest consistently.
// ===========================================================================
function jacketBody(fill, d) {
  return `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round"/>`;
}
// standard long coat outline reaching the hem
const COAT_D = 'M812 706 q232 -96 460 0 q78 32 86 132 l30 548 q4 60 -70 62 l-562 0 q-74 -2 -70 -62 l30 -548 q10 -102 86 -132 z';
const BOMBER_D = 'M800 720 q250 -96 500 0 q90 34 96 150 l10 500 q0 64 -84 66 q-268 28 -534 0 q-84 -2 -84 -66 l10 -500 q6 -116 86 -150 z';

function clTrench(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, COAT_D)}
    <path d="M1000 706 l-74 240 l82 42 l62 -282 z" fill="${sh}"/>
    <path d="M1100 706 l74 240 l-82 42 l-62 -282 z" fill="${sh}"/>
    <rect x="766" y="1130" width="572" height="56" rx="12" fill="${sh}"/>
    <rect x="1020" y="1126" width="80" height="64" rx="8" fill="${fill}" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    ${seams('M1050 952 l0 460')}
  </g>`);
}
function clBomber(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, BOMBER_D)}
    <rect x="740" y="1320" width="620" height="90" rx="30" fill="${sh}"/>
    ${seams('M770 1342 h560 M770 1372 h560', 'rgba(0,0,0,0.25)')}
    <path d="M900 700 q150 -40 300 0 l-10 60 q-140 -34 -280 0 z" fill="${sh}"/>
    ${seams('M1050 760 l0 560')}
    ${seams('M880 904 q170 50 340 0 M860 1086 q190 54 380 0', 'rgba(255,255,255,0.12)')}
  </g>`);
}
function clVarsity(fill, sleeve) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, 'M862 724 q190 -80 380 0 l20 660 q-210 44 -420 0 z')}
    <path d="M862 744 q-120 20 -150 150 l40 460 q80 30 150 10 l0 -620 z" fill="${sleeve}"/>
    <path d="M1242 744 q120 20 150 150 l-40 460 q-80 30 -150 10 l0 -620 z" fill="${sleeve}"/>
    ${seams('M1052 744 l0 640', 'rgba(0,0,0,0.3)')}
    <g fill="#e9e4d8"><circle cx="1052" cy="860" r="10"/><circle cx="1052" cy="990" r="10"/><circle cx="1052" cy="1120" r="10"/><circle cx="1052" cy="1250" r="10"/></g>
    <rect x="842" y="1360" width="420" height="60" rx="16" fill="${sleeve}"/>
  </g>`);
}
function clHoodie(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, 'M790 744 q260 -110 520 0 q84 36 86 150 l6 490 q0 60 -74 62 l-556 0 q-74 -2 -74 -62 l6 -490 q2 -114 80 -150 z')}
    <path d="M900 724 q150 -70 300 0 q40 70 -20 120 q-130 -60 -260 0 q-60 -50 -20 -120 z" fill="${sh}"/>
    <path d="M980 804 l-14 150 M1120 804 l14 150" stroke="#e9e4d8" stroke-width="10" fill="none" stroke-linecap="round"/>
    <circle cx="966" cy="960" r="14" fill="#e9e4d8"/><circle cx="1134" cy="960" r="14" fill="#e9e4d8"/>
    <path d="M870 1160 q180 46 360 0 l0 160 q-180 44 -360 0 z" fill="${sh}"/>
  </g>`);
}
function clPea(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, COAT_D)}
    <path d="M950 700 l-128 160 l74 58 l128 -180 z" fill="${sh}"/>
    <path d="M1150 700 l128 160 l-74 58 l-128 -180 z" fill="${sh}"/>
    <g fill="${sh}"><circle cx="958" cy="1010" r="20"/><circle cx="1142" cy="1010" r="20"/><circle cx="958" cy="1160" r="20"/><circle cx="1142" cy="1160" r="20"/></g>
  </g>`);
}
function clRaincoat(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, COAT_D)}
    <path d="M900 700 q150 -46 300 0 l-10 94 q-140 -40 -280 0 z" fill="${sh}"/>
    <g fill="${sh}"><rect x="1022" y="970" width="56" height="22" rx="10"/><rect x="1022" y="1090" width="56" height="22" rx="10"/><rect x="1022" y="1210" width="56" height="22" rx="10"/></g>
    ${seams('M900 864 q60 420 20 520', 'rgba(255,255,255,0.18)')}
  </g>`);
}
function clSuit(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, 'M850 712 q200 -84 400 0 q62 26 70 132 l18 544 q2 56 -66 58 l-446 0 q-68 -2 -66 -58 l18 -544 q8 -106 72 -132 z')}
    <path d="M1050 724 l-154 126 l62 72 l92 -114 z" fill="${sh}"/>
    <path d="M1050 724 l154 126 l-62 72 l-92 -114 z" fill="${sh}"/>
    <path d="M980 1010 l70 -124 l70 124 l-70 370 z" fill="#1c1c20"/>
    <circle cx="1050" cy="1130" r="16" fill="${sh}"/>
    <path d="M1182 970 l60 0 l-20 54 l-30 -20 z" fill="#e9e4d8"/>
  </g>`);
}
function clDenim(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, 'M830 712 q220 -86 440 0 q66 28 76 132 l18 548 q2 56 -68 58 l-480 0 q-70 -2 -68 -58 l18 -548 q10 -104 64 -132 z')}
    <path d="M830 860 q220 50 440 0" fill="none" stroke="#e8b24a" stroke-width="6" stroke-dasharray="18 14"/>
    <path d="M1050 724 l0 640" stroke="${sh}" stroke-width="${STROKE_THIN}" fill="none"/>
    <g fill="#d9a528"><circle cx="1050" cy="930" r="10"/><circle cx="1050" cy="1060" r="10"/><circle cx="1050" cy="1190" r="10"/></g>
    <rect x="888" y="930" width="110" height="130" rx="8" fill="${sh}"/>
    <rect x="1102" y="930" width="110" height="130" rx="8" fill="${sh}"/>
  </g>`);
}
function clStraitjacket(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, BOMBER_D)}
    <path d="M820 820 q100 60 230 60 q130 0 230 -60 l-40 160 q-190 60 -380 0 z" fill="${sh}"/>
    <path d="M1000 820 q50 420 -120 520 M1100 820 q-50 420 120 520" fill="none" stroke="${sh}" stroke-width="40" stroke-linecap="round"/>
    <g stroke="${INK}" stroke-width="8">
      <path d="M900 1080 h300 M900 1180 h300 M900 1280 h300"/>
    </g>
    <rect x="1010" y="1060" width="80" height="260" rx="14" fill="${sh}"/>
  </g>`);
}
function clPuffer(fill, sh) {
  return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    ${jacketBody(fill, 'M800 740 q250 -104 500 0 q92 36 96 158 l6 440 q0 64 -84 66 q-268 28 -536 0 q-84 -2 -84 -66 l6 -440 q4 -122 100 -158 z')}
    ${seams('M800 904 q250 60 500 0 M800 1044 q250 60 500 0 M800 1184 q250 60 500 0 M800 1324 q250 56 500 0', 'rgba(0,0,0,0.22)')}
    <path d="M910 720 q140 -40 280 0 l-10 70 q-130 -34 -260 0 z" fill="${sh}"/>
    ${seams('M1050 760 l0 600', 'rgba(0,0,0,0.25)')}
  </g>`);
}

// ===========================================================================
// HATS / HEADWEAR  (z7). Above the skull crown (y~504); bottom no lower than
// ~y560 so the face stays clear. Crown centre ~ x 905 (over the skull).
// ===========================================================================
const HATCX = 905;
function hatBase(inner) { return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">${inner}</g>`); }

function hatFedora2(fill, band) {
  return hatBase(`
    <ellipse cx="${HATCX}" cy="516" rx="320" ry="64" fill="${fill}"/>
    <path d="M${HATCX - 200} 496 q0 -206 200 -216 q200 10 200 216 q-200 68 -400 0 z" fill="${fill}"/>
    <path d="M${HATCX - 200} 496 q200 64 400 0 l-6 40 q-200 58 -388 0 z" fill="${band}"/>`);
}
function hatNewsboy2(fill) {
  return hatBase(`
    <path d="M${HATCX - 230} 516 q-28 -224 230 -244 q258 20 230 244 q-230 68 -460 0 z" fill="${fill}"/>
    <path d="M${HATCX - 240} 512 q240 68 480 0 l38 20 q-18 44 -68 44 l-420 0 q-50 0 -68 -44 z" fill="${fill}"/>
    <circle cx="${HATCX}" cy="300" r="16" fill="${fill}" stroke="${INK}" stroke-width="7"/>`);
}
function hatBeanie2(fill, cuff) {
  return hatBase(`
    <path d="M${HATCX - 210} 536 q-18 -262 210 -276 q228 14 210 276 q-210 58 -420 0 z" fill="${fill}"/>
    <rect x="${HATCX - 226}" y="496" width="452" height="72" rx="30" fill="${cuff}"/>`);
}
function hatBucket2(fill) {
  return hatBase(`
    <path d="M${HATCX - 190} 496 q-10 -196 190 -210 q200 14 190 210 q-190 54 -380 0 z" fill="${fill}"/>
    <path d="M${HATCX - 270} 496 q270 78 540 0 q10 52 -58 68 q-212 48 -424 0 q-68 -16 -58 -68 z" fill="${fill}"/>`);
}
function hatCrown2(fill) {
  return hatBase(`
    <path d="M${HATCX - 210} 506 l38 -204 l78 118 l96 -166 l96 166 l78 -118 l38 204 q-212 68 -424 0 z" fill="${fill}"/>
    <g fill="#c0392b"><circle cx="${HATCX - 172}" cy="300" r="18"/><circle cx="${HATCX}" cy="272" r="20"/><circle cx="${HATCX + 172}" cy="300" r="18"/></g>
    <rect x="${HATCX - 214}" y="496" width="428" height="40" rx="12" fill="#d9a528"/>`);
}
function hatTophat2(fill, band) {
  return hatBase(`
    <ellipse cx="${HATCX}" cy="520" rx="290" ry="52" fill="${fill}"/>
    <rect x="${HATCX - 164}" y="192" width="328" height="336" rx="14" fill="${fill}"/>
    <rect x="${HATCX - 164}" y="468" width="328" height="56" fill="${band}"/>`);
}
function hatHalo() {
  return hatBase(`
    <ellipse cx="${HATCX}" cy="420" rx="200" ry="46" fill="none" stroke="#f3d150" stroke-width="26"/>
    <ellipse cx="${HATCX}" cy="420" rx="200" ry="46" fill="none" stroke="#fff4bf" stroke-width="10"/>
    <ellipse cx="${HATCX}" cy="420" rx="230" ry="56" fill="none" stroke="#f3d150" stroke-width="40" opacity="0.2"/>`);
}
function hatVisor2(fill) {
  return hatBase(`
    <path d="M${HATCX - 200} 506 q200 60 400 0 q10 40 -30 56 q-170 44 -340 0 q-40 -16 -30 -56 z" fill="${fill}"/>
    <path d="M${HATCX - 200} 512 q-150 -4 -230 40 q-16 30 16 46 q140 10 220 -36 z" fill="${fill}"/>`);
}
function hatDurag(fill) {
  return hatBase(`
    <path d="M${HATCX - 210} 520 q-20 -250 210 -262 q230 12 210 262 q-210 56 -420 0 z" fill="${fill}"/>
    <path d="M${HATCX + 150} 520 q140 40 240 150 q-120 -10 -220 -70 z" fill="${fill}"/>
    <path d="M${HATCX + 160} 560 q130 50 220 160" fill="none" stroke="${INK}" stroke-width="${STROKE_THIN}"/>`);
}
function hatParty(a, b) {
  return hatBase(`
    <path d="M${HATCX} 210 l140 300 q-140 46 -280 0 z" fill="${a}"/>
    <path d="M${HATCX} 210 l70 150 l-120 70 z" fill="${b}"/>
    <circle cx="${HATCX}" cy="200" r="24" fill="#f3d150"/>
    <g fill="${b}"><circle cx="${HATCX - 70}" cy="470" r="14"/><circle cx="${HATCX + 70}" cy="470" r="14"/></g>`);
}
function hatCowboy(fill, band) {
  return hatBase(`
    <path d="M${HATCX - 360} 520 q360 86 720 0 q-30 70 -200 96 q-160 24 -320 0 q-170 -26 -200 -96 z" fill="${fill}"/>
    <path d="M${HATCX - 180} 500 q-10 -200 180 -214 q190 14 180 214 q-180 56 -360 0 z" fill="${fill}"/>
    <path d="M${HATCX - 180} 500 q180 50 360 0 l-8 38 q-176 48 -344 0 z" fill="${band}"/>`);
}

// ===========================================================================
// Write everything (experimental pool)
// ===========================================================================
async function main() {
  const jobs = [];

  // MASKS (+10)
  jobs.push(
    ['mask/x-visor-slit.png', maskVisorSlit('#2a2e36', '#4effc8')],
    ['mask/x-muzzle.png', maskMuzzle('#2b2b30')],
    ['mask/x-blindfold.png', maskBlindfold('#1f1f24')],
    ['mask/x-welder.png', maskWelder('#4a4038')],
    ['mask/x-oni.png', maskOni('#b23b2f', '#d9d2c4')],
    ['mask/x-scarf.png', maskScarf('#2a3550', '#1f2740')],
    ['mask/x-kerchief.png', maskKerchief('#9a2b26', '#f3d150')],
    ['mask/x-split-chrome.png', maskSplit('#26262c', '#aeb4bc')],
    ['mask/x-jester.png', maskJester('#3a2a52', '#9a2b26')],
    ['mask/x-neon-domino.png', maskNeonDomino('#141418', '#ff4dd2')],
  );

  // HEADS (+6+1 wolf grey = 7, distinct styles)
  jobs.push(
    ['head/x-cracked-gold.png', headCrackedGold()],
    ['head/x-horned.png', headHorned()],
    ['head/x-golden.png', headGolden()],
    ['head/x-melting.png', headMelting()],
    ['head/x-chrome.png', headChrome()],
    ['head/x-alien.png', headAlien()],
    ['head/x-wolf-grey.png', headWolfGrey()],
  );

  // EYES (+8 distinct)
  jobs.push(
    ['eyes/x-glow-green.png', eyesGlowGreen()],
    ['eyes/x-glow-red.png', eyesGlowRed()],
    ['eyes/x-laser.png', eyesLaser()],
    ['eyes/x-heart.png', eyesHeart()],
    ['eyes/x-spiral.png', eyesSpiral()],
    ['eyes/x-monocle.png', eyesMonocle()],
    ['eyes/x-cyclops.png', eyesCyclops()],
    ['eyes/x-sleepy.png', eyesSleepy()],
  );

  // CLOTHES (+8 distinct garments/colourways, hems covering the legless body)
  jobs.push(
    ['clothes/x-trench-oxblood.png', clTrench('#6a2a28', '#4e1d1c')],
    ['clothes/x-bomber-gold.png', clBomber('#b9933a', '#8f7026')],
    ['clothes/x-varsity-green.png', clVarsity('#2f4a38', '#d9c58a')],
    ['clothes/x-hoodie-ash.png', clHoodie('#6a6e76', '#51555c')],
    ['clothes/x-peacoat-navy.png', clPea('#283347', '#1c2534')],
    ['clothes/x-raincoat-teal.png', clRaincoat('#2f6e6a', '#245653')],
    ['clothes/x-suit-pinstripe.png', clSuit('#2a2c34', '#15151a')],
    ['clothes/x-denim-black.png', clDenim('#2b2f36', '#1e2127')],
    ['clothes/x-straitjacket.png', clStraitjacket('#d8d4c8', '#c0bbac')],
    ['clothes/x-puffer-crimson.png', clPuffer('#7a2220', '#5c1917')],
  );

  // HATS (+8 distinct toppers, on-anchor over the crown)
  jobs.push(
    ['headwear/x-fedora-grey.png', hatFedora2('#4a4e56', '#2a2c31')],
    ['headwear/x-newsboy-rust.png', hatNewsboy2('#7a4326')],
    ['headwear/x-beanie-olive.png', hatBeanie2('#5c6346', '#454b34')],
    ['headwear/x-bucket-camo.png', hatBucket2('#55603f')],
    ['headwear/x-crown-gold.png', hatCrown2('#e7c04a')],
    ['headwear/x-tophat-plum.png', hatTophat2('#2a1f30', '#5a3f5c')],
    ['headwear/x-halo.png', hatHalo()],
    ['headwear/x-visor-sun.png', hatVisor2('#b9933a')],
    ['headwear/x-durag.png', hatDurag('#1a1a1f')],
    ['headwear/x-party.png', hatParty('#c0392b', '#f3d150')],
    ['headwear/x-cowboy.png', hatCowboy('#6a4a2c', '#3a2a18')],
  );

  for (const d of ['mask', 'head', 'eyes', 'clothes', 'headwear']) {
    fs.mkdirSync(path.join(LAYERS, d), { recursive: true });
  }
  for (const [rel, svg] of jobs) {
    await rasterize(svg, path.join(LAYERS, rel));
    console.log('wrote', rel);
  }
  console.log('done:', jobs.length, 'experimental expansion trait files');
}

main().catch((e) => { console.error(e); process.exit(1); });

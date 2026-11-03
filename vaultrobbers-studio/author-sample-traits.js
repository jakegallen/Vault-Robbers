#!/usr/bin/env node
/*
 * Author a SAMPLE SLICE of new Vault Robbers trait art.
 *
 * Writes new layer PNGs (2048x2048, transparent) that drop straight into the
 * existing sharp compositing flow in render.js. Everything is authored as SVG
 * then rasterized by sharp so the output matches the hand-drawn ink-outline
 * flat-fill house style of the existing layers and the Mythic 1 of 1s.
 *
 * Anchor system (measured from the existing layers, normalized to the 2048
 * canvas; see the bbox probe in the build notes):
 *   skull head  center ~ (0.45, 0.32)  box x 753..1101  y 504..798
 *   mask        center ~ (0.447,0.309) box x 746..1085  y 541..725 (over the eyes)
 *   clothes     center ~ (0.513,0.50)  box x 723..1378  y 626..1431
 *   hat         crown    ~ (0.46, 0.18) bottom edge meets skull top at y~520
 *   ground dash           y ~ 0.86
 *
 * New bodies MUST: keep the skull-head zone clear (so the skull face layer lands
 * on top), present a neck/shoulder that meets the skull jaw near y~790, keep the
 * torso centered under the clothes box, and keep the floating ground-dash motif.
 *
 * Standalone. Does not touch render.js, the manifest, config, or deployed data.
 * Run: node author-sample-traits.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = __dirname;
const LAYERS = path.join(ROOT, 'layers');
const S = 2048;

// ---------------------------------------------------------------------------
// House style palette + stroke weights (matched to the existing ink-outline art)
// ---------------------------------------------------------------------------
const INK = '#141414';          // bold ink outline
const STROKE = 11;              // main outline weight at 2048
const STROKE_THIN = 7;          // interior lines
const GHOST_DARK = '#1a1a1a';   // near-black ghost silhouette (hair/head mass)
const GHOST_BODY = '#3a3a3c';   // charcoal body fill (matches shadow-silhouette torso)
const GHOST_BODY_SH = '#2c2c2e';// body shadow
const BONE = '#d9d2c4';         // skull / bone tone
const BONE_SH = '#b8ae9c';

function rasterize(svg, outPath) {
  return sharp(Buffer.from(svg), { density: 300 })
    .resize(S, S, { fit: 'cover' })
    .png()
    .toFile(outPath);
}

function svgDoc(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="6"/></filter>
  </defs>
  ${inner}
</svg>`;
}

// A floating ground-dash + puddle shadow, same motif the silhouette uses.
function groundDash() {
  return `
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
}

// Charcoal neck stub that meets the skull jaw (~y 790) so the skull sits on it.
function neck(cx = 930) {
  return `<path d="M${cx - 70} 735 q70 70 140 0 l10 95 q-80 60 -160 0 z"
    fill="${GHOST_BODY}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round"/>`;
}

// ---------------------------------------------------------------------------
// BODY / POSE variants  (z: body, under head + clothes)
//
// Design law learned from the original shadow-silhouette: the puffer (clothes
// box x723..1378 y626..1431) HIDES the whole torso. Only three things read as
// "body": the head-neck above the collar, and a thin floating TAIL plus the
// lower arms/hands that peek BELOW the puffer hem (y>1330). So every body here
// keeps a slim torso fully inside the puffer box, and expresses its pose purely
// through the tail silhouette and the hands that show below the hem. This keeps
// every body compatible with every puffer without charcoal leaking out the sides.
// ---------------------------------------------------------------------------

// Shared slim torso that stays inside the puffer so it never pokes out.
function slimTorso() {
  return `<path d="M815 820 q0 -70 115 -78 q120 8 120 82 l0 470 q-8 60 -118 72
           q-112 -12 -117 -72 z" fill="${GHOST_BODY}" stroke="${INK}" stroke-width="${STROKE}"
           stroke-linejoin="round"/>`;
}

// 1. Standing at ease: straight thin floating tail, both hands tucked low.
function bodyStanding() {
  const inner = `
  ${groundDash()}
  ${neck()}
  ${slimTorso()}
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round" fill="${GHOST_BODY}">
    <!-- thin floating tail below the hem -->
    <path d="M858 1300 q72 36 150 0 l-26 210 q-50 70 -98 0 z"/>
    <!-- resting hands peeking below the hem -->
    <path d="M770 1330 q-30 40 -18 96 q10 40 56 30 q34 -8 30 -56 l-8 -78 z" fill="${GHOST_BODY_SH}"/>
    <path d="M1090 1330 q30 40 18 96 q-10 40 -56 30 q-34 -8 -30 -56 l8 -78 z" fill="${GHOST_BODY_SH}"/>
  </g>`;
  return svgDoc(inner);
}

// 2. Crouched / sneaking: the tail is tucked and swept forward-left, one hand
//    low reaching out ahead.
function bodyCrouch() {
  const inner = `
  ${groundDash()}
  ${neck(930)}
  ${slimTorso()}
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round" fill="${GHOST_BODY}">
    <!-- swept, low tucked tail -->
    <path d="M858 1305 q80 34 156 0 q40 150 -120 220 q-150 -40 -36 -220 z"/>
    <!-- lead hand reaching forward low -->
    <path d="M820 1340 q-150 40 -210 150 q-28 50 24 78 q46 24 76 -22 q50 -78 150 -110 z"
          fill="${GHOST_BODY_SH}"/>
    <!-- trailing hand close to body -->
    <path d="M1080 1350 q46 20 50 76 q2 44 -44 50 q-40 4 -50 -40 l-4 -70 z" fill="${GHOST_BODY_SH}"/>
  </g>`;
  return svgDoc(inner);
}

// 3. Peeking / glancing back over the shoulder: tail flicked to the right, one
//    hand raised near the collar as if signalling "quiet".
function bodyPeek() {
  const inner = `
  ${groundDash()}
  ${neck(930)}
  ${slimTorso()}
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round" fill="${GHOST_BODY}">
    <!-- tail flicked out to the right -->
    <path d="M858 1300 q78 34 152 0 q120 70 90 230 q-150 30 -140 -130 q-60 40 -130 20 z"/>
    <!-- hand raised to the collar (reads just under the jaw) -->
    <path d="M1030 860 q90 -30 120 30 q22 46 -26 72 q-46 24 -84 -14 q-28 -28 -10 -88 z"
          fill="${GHOST_BODY_SH}"/>
    <!-- low resting hand -->
    <path d="M778 1335 q-28 40 -16 94 q10 40 54 30 q34 -8 30 -54 l-8 -78 z" fill="${GHOST_BODY_SH}"/>
  </g>`;
  return svgDoc(inner);
}

// 4. Loot over the shoulder: a sack rides high behind the right shoulder (reads
//    above the puffer shoulder), the near hand grips its neck.
function bodyLootShoulder() {
  const inner = `
  ${groundDash()}
  ${neck()}
  ${slimTorso()}
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round">
    <!-- sack behind/above the right shoulder, clears the puffer top -->
    <path d="M1120 470 q150 -34 214 86 q58 112 10 224 q-40 96 -150 96
             q-120 0 -150 -120 q-34 -150 76 -286 z" fill="${GHOST_BODY}"/>
    <path d="M1150 476 q74 -36 150 4 l-16 -58 q-70 -26 -140 8 z" fill="${GHOST_BODY_SH}"/>
    <!-- straight tail -->
    <path d="M858 1300 q72 36 150 0 l-26 210 q-50 70 -98 0 z" fill="${GHOST_BODY}"/>
    <!-- gripping hand up near the sack strap -->
    <path d="M1075 840 q96 -40 150 40 q26 44 -22 70 q-46 24 -82 -14 q-30 -30 -46 -96 z"
          fill="${GHOST_BODY_SH}"/>
    <!-- resting hand -->
    <path d="M778 1335 q-28 40 -16 94 q10 40 54 30 q34 -8 30 -54 l-8 -78 z" fill="${GHOST_BODY_SH}"/>
  </g>`;
  return svgDoc(inner);
}

// 5. Hands up / caught: both hands raised high above the shoulders, palms out.
//    Tail hangs slack and straight (the "busted" slump).
function bodyHandsUp() {
  const inner = `
  ${groundDash()}
  ${neck()}
  ${slimTorso()}
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round">
    <!-- slack straight tail -->
    <path d="M858 1300 q72 36 150 0 l-20 200 q-52 66 -100 0 z" fill="${GHOST_BODY}"/>
    <!-- left hand up -->
    <path d="M800 840 q-70 -150 -30 -250 q22 -54 76 -34 q50 18 36 76
             q-22 96 18 180 z" fill="${GHOST_BODY_SH}"/>
    <!-- right hand up -->
    <path d="M1060 840 q70 -150 30 -250 q-22 -54 -76 -34 q-50 18 -36 76
             q22 96 -18 180 z" fill="${GHOST_BODY_SH}"/>
  </g>`;
  return svgDoc(inner);
}

// 6. Mid vault-crack: leaning in, one hand reaching high to the right toward a
//    dial, the other braced. (The actual vault door lives in the BACKGROUND
//    layer bg-vault-door so no slab pokes out of the figure.)
function bodyVaultCrack() {
  const inner = `
  ${groundDash()}
  ${neck(930)}
  ${slimTorso()}
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round">
    <!-- tail swept to the right with the lean -->
    <path d="M858 1300 q78 34 152 0 q100 60 80 210 q-140 34 -132 -120 q-50 30 -118 14 z"
          fill="${GHOST_BODY}"/>
    <!-- reaching hand up-right toward the dial zone -->
    <path d="M1070 900 q140 -70 220 10 q34 40 -14 74 q-46 32 -86 -6
             q-40 -38 -120 -6 z" fill="${GHOST_BODY_SH}"/>
    <!-- bracing hand low -->
    <path d="M778 1335 q-32 38 -20 94 q10 40 54 30 q34 -8 30 -54 l-6 -80 z" fill="${GHOST_BODY_SH}"/>
  </g>`;
  return svgDoc(inner);
}

// ---------------------------------------------------------------------------
// MASKS (z: mask, over the skull eyes). Align to the mask box x746..1085 y541..725.
// Eye centers in the existing masks: left ~ (810,640) right ~ (980,620).
// ---------------------------------------------------------------------------

// Bandit domino with a tie knot (slim outlaw mask).
function maskBandit() {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M740 600 q130 -70 250 -50 q120 20 130 60 q10 60 -120 90
             q-140 30 -270 -10 q-60 -30 10 -90 z" fill="#2a2a2c"/>
    <!-- eye cutouts -->
    <ellipse cx="820" cy="628" rx="46" ry="38" fill="#ffffff" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <ellipse cx="965" cy="620" rx="52" ry="40" fill="#ffffff" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <!-- side ties -->
    <path d="M745 612 l-70 -18 l55 55 z" fill="#2a2a2c"/>
  </g>`;
  return svgDoc(inner);
}

// Gold vault mask (ultra-rare feel): rounded plate with gold rim.
function maskGold() {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M735 600 q135 -80 260 -55 q125 25 128 70 q3 70 -130 100
             q-150 32 -280 -12 q-55 -45 22 -103 z" fill="#d9a528"/>
    <path d="M735 600 q135 -80 260 -55 q125 25 128 70 q3 70 -130 100
             q-150 32 -280 -12 q-55 -45 22 -103 z" fill="none" stroke="#8a6410" stroke-width="${STROKE_THIN}"/>
    <ellipse cx="820" cy="632" rx="40" ry="34" fill="#1b1b1b" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <ellipse cx="966" cy="622" rx="44" ry="36" fill="#1b1b1b" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <path d="M770 560 q120 -26 210 6" fill="none" stroke="#f3d87a" stroke-width="8" stroke-linecap="round"/>
  </g>`;
  return svgDoc(inner);
}

// Gas-filter half mask over the lower face/eyes (industrial robber).
function maskRespirator() {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M745 595 q130 -60 245 -42 q118 18 128 58 q8 55 -110 86
             q-150 38 -285 -4 q-55 -42 22 -98 z" fill="#4a5250"/>
    <ellipse cx="818" cy="625" rx="44" ry="36" fill="#cfe7e8" fill-opacity="0.85" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <ellipse cx="966" cy="618" rx="50" ry="38" fill="#cfe7e8" fill-opacity="0.85" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <!-- filter canister on cheek -->
    <circle cx="730" cy="690" r="42" fill="#3a4240" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <circle cx="730" cy="690" r="18" fill="#222" />
  </g>`;
  return svgDoc(inner);
}

// ---------------------------------------------------------------------------
// HELD ITEMS  (new layer, z above clothes, in the hand zone ~ x 760..860 y 980..1300)
// Drawn so they read as being held at the lower-left tucked-hand area.
// ---------------------------------------------------------------------------

function itemCrowbar() {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round" fill="#9a3b2f">
    <path d="M820 980 l40 20 l-150 360 l-40 -20 z"/>
    <path d="M700 1330 q-50 20 -70 -20 q40 -40 80 -30 z"/>
    <path d="M846 986 q60 -40 110 10 q30 35 -10 60 q-45 10 -70 -30 z"/>
  </g>`;
  return svgDoc(inner);
}

function itemLootBag() {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" fill="#b59a5c">
    <path d="M740 1080 q140 -40 250 60 q80 130 20 250 q-60 110 -170 110
             q-120 0 -170 -120 q-50 -180 70 -300 z"/>
    <path d="M770 1080 q90 -46 190 -4 l-22 -56 q-70 -30 -150 6 z" fill="#8f7640"/>
    <text x="870" y="1340" font-family="Georgia, serif" font-size="150" fill="#2f2a1c"
      text-anchor="middle" font-weight="bold">$</text>
  </g>`;
  return svgDoc(inner);
}

function itemLockpick() {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round" fill="#8a8f96">
    <path d="M770 1000 l26 -8 l70 250 l-26 8 z"/>
    <path d="M840 1250 l50 40 l-20 26 l-50 -40 z"/>
    <path d="M800 1000 q30 -40 70 -10" fill="none" stroke-width="${STROKE_THIN}"/>
  </g>`;
  return svgDoc(inner);
}

function itemKey() {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" fill="#d9a528">
    <circle cx="790" cy="1060" r="70"/>
    <circle cx="790" cy="1060" r="26" fill="#8a6410"/>
    <rect x="776" y="1120" width="28" height="240" rx="8"/>
    <rect x="804" y="1300" width="60" height="26" rx="6"/>
    <rect x="804" y="1250" width="44" height="24" rx="6"/>
  </g>`;
  return svgDoc(inner);
}

function itemDynamite() {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <rect x="740" y="1080" width="70" height="260" rx="20" fill="#b23b2f"/>
    <rect x="820" y="1080" width="70" height="260" rx="20" fill="#b23b2f"/>
    <rect x="720" y="1150" width="190" height="60" fill="#7a2a20"/>
    <path d="M775 1080 q10 -80 70 -120" fill="none" stroke="#5a4a2a" stroke-width="${STROKE_THIN}"/>
    <circle cx="850" cy="950" r="18" fill="#f3c04a" stroke="#d98a1a" stroke-width="6"/>
  </g>`;
  return svgDoc(inner);
}

// ---------------------------------------------------------------------------
// BACKGROUNDS (z: background, full frame)
// ---------------------------------------------------------------------------

function bgVaultDoor() {
  const inner = `
  <rect width="${S}" height="${S}" fill="#2b2f36"/>
  <rect width="${S}" height="${S}" fill="url(#vd)"/>
  <defs>
    <radialGradient id="vd" cx="0.5" cy="0.42" r="0.7">
      <stop offset="0" stop-color="#3b414a"/><stop offset="1" stop-color="#1c2026"/>
    </radialGradient>
  </defs>
  <g opacity="0.5" stroke="#10131a" stroke-width="6" fill="none">
    <circle cx="1024" cy="900" r="520"/>
    <circle cx="1024" cy="900" r="420"/>
    <circle cx="1024" cy="900" r="120"/>
  </g>
  <g opacity="0.5" fill="#10131a">
    <circle cx="640" cy="520" r="18"/><circle cx="1408" cy="520" r="18"/>
    <circle cx="640" cy="1280" r="18"/><circle cx="1408" cy="1280" r="18"/>
  </g>`;
  return svgDoc(inner);
}

function bgCorner() {
  const inner = `
  <rect width="${S}" height="${S}" fill="#20242b"/>
  <!-- a dim wall on the right with a lit corner edge the robber peeks past -->
  <rect x="1240" y="0" width="808" height="${S}" fill="#15181e"/>
  <rect x="1240" y="0" width="18" height="${S}" fill="#394150"/>
  <g opacity="0.35" stroke="#0e1015" stroke-width="6">
    <line x1="1440" y1="0" x2="1440" y2="${S}"/>
    <line x1="1660" y1="0" x2="1660" y2="${S}"/>
    <line x1="1880" y1="0" x2="1880" y2="${S}"/>
  </g>
  <rect x="0" y="1760" width="${S}" height="288" fill="#171a20"/>
  <polygon points="300,0 520,0 180,${S} -60,${S}" fill="#f2e2a8" opacity="0.08"/>`;
  return svgDoc(inner);
}

function bgSearchlight() {
  const inner = `
  <rect width="${S}" height="${S}" fill="#0d1018"/>
  <defs>
    <linearGradient id="sl" x1="0.5" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#f2e2a8" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#f2e2a8" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <polygon points="1100,-40 1450,-40 820,2088 360,2088" fill="url(#sl)"/>
  <polygon points="620,-40 820,-40 420,2088 120,2088" fill="url(#sl)" opacity="0.5"/>
  <g fill="#161b26">
    <rect x="0" y="1760" width="${S}" height="288"/>
  </g>`;
  return svgDoc(inner);
}

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------

async function main() {
  const jobs = [
    // bodies
    ['body/pose-standing.png', bodyStanding()],
    ['body/pose-crouch.png', bodyCrouch()],
    ['body/pose-peek.png', bodyPeek()],
    ['body/pose-loot-shoulder.png', bodyLootShoulder()],
    ['body/pose-hands-up.png', bodyHandsUp()],
    ['body/pose-vault-crack.png', bodyVaultCrack()],
    // masks
    ['mask/mask-bandit.png', maskBandit()],
    ['mask/mask-gold.png', maskGold()],
    ['mask/mask-respirator.png', maskRespirator()],
    // held items
    ['item/crowbar.png', itemCrowbar()],
    ['item/loot-bag.png', itemLootBag()],
    ['item/lockpick.png', itemLockpick()],
    ['item/key.png', itemKey()],
    ['item/dynamite.png', itemDynamite()],
    // backgrounds
    ['background/vault-door.png', bgVaultDoor()],
    ['background/searchlight.png', bgSearchlight()],
    ['background/corner.png', bgCorner()],
  ];

  fs.mkdirSync(path.join(LAYERS, 'item'), { recursive: true });

  for (const [rel, svg] of jobs) {
    const out = path.join(LAYERS, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await rasterize(svg, out);
    console.log('wrote', rel);
  }
  console.log('done:', jobs.length, 'new trait files');
}

main().catch((e) => { console.error(e); process.exit(1); });

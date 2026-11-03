#!/usr/bin/env node
/*
 * PASS 2 trait authoring for Vault Robbers.
 *
 * Builds on author-sample-traits.js (pass 1). Same approach: author each trait
 * as SVG in the ink-outline / flat-fill house style, rasterize with sharp to a
 * 2048x2048 transparent PNG that drops straight into the manifest z-order and
 * the render.js compositor (fit:cover).
 *
 * ANCHOR GRID (measured from the real art, normalized to 2048; see bbox-probe.js):
 *   skull head   x 0.368..0.538  y 0.246..0.390   jaw bottom y~0.390 (800px)
 *   mask / eyes  over x 0.36..0.53  y 0.26..0.35   eye centers ~ (0.45,0.32)
 *   jacket       x 0.353..0.673  y 0.306..0.699    collar y~0.306 (626) hem y~0.699 (1431)
 *   hat          sits above skull crown (skull top y~0.246 / 504px)
 *   ground dash  y ~ 0.86
 *
 * DESIGN LAW (from pass 1, kept):
 *   The jacket (z4) is drawn OVER the body (z2) and is the dominant silhouette.
 *   Anything the body draws inside the jacket box (x 723..1378, y 626..1431) is
 *   HIDDEN. A body therefore expresses its stance only where it pokes OUT of the
 *   jacket: the LEGS + FEET below the hem (y>1431) and the NECK + SHOULDER nubs
 *   at the collar line (y~620). So distinct body silhouettes come from leg
 *   stance + leg mass + height, and distinct torso silhouettes come from the
 *   JACKET outline (which this script redraws in varied widths and shapes).
 *   Every head layer lands on the skull anchor, so bodies keep that zone clear.
 *
 * Standalone. Writes only into layers/. Does NOT touch render.js, config, the
 * live mint artifact, deployed metadata, or any contract.
 *
 * Run: node author-pass2.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = __dirname;
const LAYERS = path.join(ROOT, 'layers');
const S = 2048;

// ---------------------------------------------------------------------------
// House style
// ---------------------------------------------------------------------------
const INK = '#141414';
const STROKE = 12;
const STROKE_THIN = 7;
const GHOST_BODY = '#33333a';   // charcoal ghost body fill
const GHOST_SH = '#26262c';     // body shadow
const BONE = '#d9d2c4';
const BONE_SH = '#b8ae9c';

function rasterize(svg, outPath) {
  return sharp(Buffer.from(svg), { density: 300 })
    .resize(S, S, { fit: 'cover' })
    .png()
    .toFile(outPath);
}
function svgDoc(inner, extraDefs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="5"/></filter>
    ${extraDefs}
  </defs>
  ${inner}
</svg>`;
}

// Floating ground dash + puddle shadow, matched to the original silhouette motif.
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

// Charcoal neck stub that meets the skull jaw (~y 790). cx shifts the head/stance.
function neck(cx = 930, w = 72) {
  return `<path d="M${cx - w} 730 q${w} 66 ${w * 2} 0 l10 96 q-${w + 12} 56 -${w * 2 + 24} 0 z"
    fill="${GHOST_BODY}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round"/>`;
}

// ---------------------------------------------------------------------------
// BODY SILHOUETTES
//
// Three base builds. Each takes the jacket box as given and draws:
//   - a hidden torso inside the box (kept slim so nothing leaks past a vest)
//   - SHOULDER NUBS just above the collar line (read beside the neck)
//   - a pair of LEGS + FEET below the hem that define the stance
// Poses are composed on top of each base by swapping the legs + adding arms.
// cx = horizontal centre of the figure (jacket centre is ~ x 1050).
// ---------------------------------------------------------------------------

const CX = 1050; // jacket horizontal centre

// hidden torso that stays well inside the jacket box
function hiddenTorso(cx, halfW) {
  return `<path d="M${cx - halfW} 760 q0 -30 ${halfW} -34 q${halfW} 4 ${halfW} 34
    l0 560 q0 40 -${halfW} 44 q-${halfW} -4 -${halfW} -44 z"
    fill="${GHOST_BODY}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round"/>`;
}

// shoulder nubs that peek above the jacket collar (read as the shoulders)
function shoulders(cx, spread, lift) {
  return `<g fill="${GHOST_BODY}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M${cx - spread} ${660 + lift} q-70 -${60 + lift} 10 -${96 + lift} q70 -20 96 40 z"/>
    <path d="M${cx + spread} ${660 + lift} q70 -${60 + lift} -10 -${96 + lift} q-70 -20 -96 40 z"/>
  </g>`;
}

// leg + foot. x = inner edge, len = length below hem, thick = leg width, foot = foot direction (+1 forward, -1 back)
function leg(x, topY, len, thick, dir) {
  const footW = 86;
  const footDx = dir * footW;
  return `<path d="M${x} ${topY} l${thick} 0 l6 ${len} q${footDx > 0 ? '' : ''}${footDx} 44 ${footDx + (dir > 0 ? 70 : -70)} 38
    q-${Math.abs(footDx) + 20} 34 -${thick + Math.abs(footDx) + 10} -8 l4 -${len} z"
    fill="${GHOST_BODY}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round"/>`;
}

// simple clean leg (rounded) - more reliable than the parametric one above
function legSimple(cx, topY, len, thick, footDir) {
  const fw = 96;
  const fx = cx + footDir * 10;
  return `<g fill="${GHOST_BODY}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M${cx - thick / 2} ${topY} h${thick} v${len} h-${thick} z"/>
    <path d="M${fx - fw / 2} ${topY + len - 6} h${fw} q26 0 26 48 q0 34 -40 34 h-${fw + 8} q-30 0 -30 -40 q0 -42 18 -42 z"/>
  </g>`;
}

function baseLegs(cx, build) {
  // build: 'lean' | 'broad' | 'hunched'
  if (build === 'lean') {
    return legSimple(cx - 78, 1360, 300, 70, -1) + legSimple(cx + 78, 1360, 300, 70, 1);
  }
  if (build === 'broad') {
    return legSimple(cx - 128, 1380, 230, 112, -1) + legSimple(cx + 128, 1380, 230, 112, 1);
  }
  // hunched / small
  return legSimple(cx - 72, 1400, 190, 84, -1) + legSimple(cx + 80, 1410, 170, 84, 1);
}

function baseBuild(cx, build) {
  const cfg = {
    lean:    { half: 92,  spread: 118, lift: 0,  neckW: 60 },
    broad:   { half: 118, spread: 172, lift: 14, neckW: 86 },
    hunched: { half: 96,  spread: 108, lift: 26, neckW: 70 },
  }[build];
  return {
    cfg,
    torso: hiddenTorso(cx, cfg.half),
    shoulders: shoulders(cx, cfg.spread, cfg.lift),
    neck: neck(cx - 120 + (build === 'broad' ? 0 : 0), cfg.neckW),
  };
}

// Arm that rests at the side (hand peeks below the jacket cuff near the hem).
// Kept INSIDE the jacket footprint (x < 1360) so it never floats off to the side.
function armResting(cx, side) {
  const s = side === 'left' ? -1 : 1;
  const hx = cx + s * 150;
  return `<g fill="${GHOST_SH}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M${hx - 34} 1372 q-6 58 10 104 q14 40 54 28 q38 -12 28 -56 l-12 -82 z"/>
  </g>`;
}
// Arm raised high (hands-up / caught). Forearm + open hand clears the collar and
// reads above the jacket shoulders near the head.
function armUp(cx, side) {
  const s = side === 'left' ? -1 : 1;
  const sx = cx + s * 210;   // shoulder root (near the jacket edge)
  const hx = cx + s * 300;   // raised hand
  return `<g fill="${GHOST_SH}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M${sx} 760 q${s * 20} -160 ${s * 90} -230 q40 -40 76 -8 q32 28 2 70 q-60 84 -60 198 z"/>
    <circle cx="${hx}" cy="520" r="52"/>
  </g>`;
}
// Hand raised near the jaw (peek / shush).
function handAtJaw(cx) {
  return `<path d="M${cx + 140} 820 q90 -34 128 28 q24 48 -26 74 q-48 24 -88 -16 q-30 -30 -14 -86 z"
    fill="${GHOST_SH}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round"/>`;
}
// Reaching hand up-right (vault crack toward a dial).
function handReach(cx) {
  return `<path d="M${cx + 170} 880 q150 -74 236 10 q36 42 -16 78 q-48 34 -90 -6
    q-42 -40 -128 -6 z" fill="${GHOST_SH}" stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round"/>`;
}

// --- Pose builders over each base build ------------------------------------

function makeBody(build, pose) {
  const cx = CX;
  const b = baseBuild(cx, build);
  let legs, extra = '';
  switch (pose) {
    case 'standing':
      legs = baseLegs(cx, build);
      extra = armResting(cx, 'left') + armResting(cx, 'right');
      break;
    case 'crouch':
      // lower, knees bent: shorter legs set wider, feet forward
      legs = legSimple(cx - 110, 1420, 150, 92, -1) + legSimple(cx + 110, 1420, 150, 92, 1);
      extra = armResting(cx, 'right');
      break;
    case 'peek':
      legs = baseLegs(cx, build);
      extra = handAtJaw(cx) + armResting(cx, 'left');
      break;
    case 'loot':
      legs = baseLegs(cx, build);
      // loot sack riding on the right shoulder, pulled IN so it sits over the
      // collar rather than floating off the side.
      extra = `<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
        <path d="M1160 520 q140 -40 196 70 q50 104 6 206 q-38 86 -138 86 q-108 0 -136 -110
          q-30 -140 72 -252 z" fill="${GHOST_BODY}"/>
        <path d="M1188 526 q66 -32 136 4 l-14 -52 q-62 -24 -126 8 z" fill="${GHOST_SH}"/>
      </g>` + armResting(cx, 'left');
      break;
    case 'handsup':
      legs = baseLegs(cx, build);
      extra = armUp(cx, 'left') + armUp(cx, 'right');
      break;
    case 'vault':
      legs = legSimple(cx - 92, 1390, 210, 90, -1) + legSimple(cx + 120, 1400, 190, 90, 1);
      extra = armResting(cx, 'left') + armResting(cx, 'right');
      break;
    default:
      legs = baseLegs(cx, build);
  }
  const inner = `
  ${groundDash()}
  ${legs}
  ${b.torso}
  ${b.neck}
  ${b.shoulders}
  ${extra}`;
  return svgDoc(inner);
}

// ---------------------------------------------------------------------------
// JACKETS  (z4, the dominant silhouette). Footprint anchored to the jacket box
// x 723..1378, y 626..1431. Each is a distinct garment OUTLINE in the ink style,
// drawn so the collar opens around the neck (x 930..1120 at y 626) and the hem
// lands near y 1400. Colorways are passed in so one shape yields several traits.
// ---------------------------------------------------------------------------

// shared seam/stitch detail helper
function seams(d, color = 'rgba(0,0,0,0.18)') {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${STROKE_THIN}" stroke-linecap="round"/>`;
}

// TRENCH: long straight coat, lapels, belt, reaches lowest.
function jacketTrench(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M820 700 q210 -90 440 0 q70 30 86 120 l34 560 q4 60 -70 62 l-540 0 q-74 -2 -70 -62 l34 -560 q16 -92 92 -120 z" fill="${fill}"/>
    <!-- lapels -->
    <path d="M1000 700 l-70 230 l80 40 l60 -270 z" fill="${sh}"/>
    <path d="M1100 700 l70 230 l-80 40 l-60 -270 z" fill="${sh}"/>
    <!-- belt -->
    <rect x="770" y="1120" width="560" height="56" rx="10" fill="${sh}"/>
    <rect x="1020" y="1116" width="80" height="64" rx="8" fill="${fill}" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    ${seams('M1050 940 l0 440')}
  </g>`;
  return svgDoc(inner);
}

// BOMBER: cropped, puffy, ribbed cuffs + hem, zip.
function jacketBomber(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M800 720 q250 -96 500 0 q90 34 96 150 l10 380 q0 70 -90 76 q-266 30 -532 0
      q-90 -6 -90 -76 l10 -380 q6 -116 86 -150 z" fill="${fill}"/>
    <!-- ribbed hem -->
    <rect x="740" y="1300" width="620" height="90" rx="30" fill="${sh}"/>
    ${seams('M770 1320 h560 M770 1348 h560', 'rgba(0,0,0,0.25)')}
    <!-- ribbed collar -->
    <path d="M900 700 q150 -40 300 0 l-10 60 q-140 -34 -280 0 z" fill="${sh}"/>
    ${seams('M1050 760 l0 540')}
    <!-- puff lines -->
    ${seams('M880 900 q170 50 340 0 M860 1080 q190 54 380 0', 'rgba(255,255,255,0.12)')}
  </g>`;
  return svgDoc(inner);
}

// HOODIE (hood down): drawstrings, kangaroo pocket.
function jacketHoodie(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M790 740 q260 -110 520 0 q84 36 86 150 l6 470 q0 60 -74 62 l-556 0 q-74 -2 -74 -62
      l6 -470 q2 -114 80 -150 z" fill="${fill}"/>
    <!-- hood roll behind the neck -->
    <path d="M900 720 q150 -70 300 0 q40 70 -20 120 q-130 -60 -260 0 q-60 -50 -20 -120 z" fill="${sh}"/>
    <!-- drawstrings -->
    <path d="M980 800 l-14 150 M1120 800 l14 150" stroke="#e9e4d8" stroke-width="10" fill="none" stroke-linecap="round"/>
    <circle cx="966" cy="956" r="14" fill="#e9e4d8"/><circle cx="1134" cy="956" r="14" fill="#e9e4d8"/>
    <!-- kangaroo pocket -->
    <path d="M870 1150 q180 46 360 0 l0 150 q-180 44 -360 0 z" fill="${sh}"/>
  </g>`;
  return svgDoc(inner);
}

// HOOD UP: a big hood wraps the head opening; dark cavity around the skull.
function jacketHoodUp(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <!-- body -->
    <path d="M800 820 q250 -70 500 0 q84 36 86 150 l6 390 q0 60 -74 62 l-556 0 q-74 -2 -74 -62
      l6 -390 q2 -114 80 -150 z" fill="${fill}"/>
    <!-- hood arcing over the crown, opening around the face anchor -->
    <path d="M770 560 q280 -300 560 0 q70 90 40 300 q-40 -140 -150 -150 l-340 0
      q-110 10 -150 150 q-30 -210 40 -300 z" fill="${sh}"/>
    <path d="M770 560 q280 -300 560 0 q70 90 40 300" fill="none" stroke="${INK}" stroke-width="${STROKE}"/>
    ${seams('M1050 900 l0 480')}
  </g>`;
  return svgDoc(inner);
}

// VARSITY: contrast sleeves, snap placket, striped rib.
function jacketVarsity(fill, sleeve) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <!-- torso -->
    <path d="M860 740 q190 -80 380 0 l0 640 q-190 40 -380 0 z" fill="${fill}"/>
    <!-- contrast sleeves -->
    <path d="M860 760 q-120 20 -150 150 l40 440 q80 30 150 10 l0 -600 z" fill="${sleeve}"/>
    <path d="M1240 760 q120 20 150 150 l-40 440 q-80 30 -150 10 l0 -600 z" fill="${sleeve}"/>
    <!-- snap placket -->
    ${seams('M1050 760 l0 620', 'rgba(0,0,0,0.3)')}
    <g fill="#e9e4d8"><circle cx="1050" cy="860" r="10"/><circle cx="1050" cy="980" r="10"/><circle cx="1050" cy="1100" r="10"/><circle cx="1050" cy="1220" r="10"/></g>
    <!-- striped rib hem -->
    <rect x="840" y="1360" width="420" height="60" rx="16" fill="${sleeve}"/>
    ${seams('M860 1390 h380', 'rgba(255,255,255,0.4)')}
  </g>`;
  return svgDoc(inner);
}

// PEACOAT: double-breasted, broad collar, big buttons.
function jacketPeacoat(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M820 720 q230 -90 460 0 q74 30 84 128 l18 520 q4 58 -70 60 l-524 0 q-74 -2 -70 -60
      l18 -520 q10 -98 84 -128 z" fill="${fill}"/>
    <!-- broad collar -->
    <path d="M950 710 l-120 150 l70 56 l120 -170 z" fill="${sh}"/>
    <path d="M1150 710 l120 150 l-70 56 l-120 -170 z" fill="${sh}"/>
    <!-- double-breasted buttons -->
    <g fill="${sh}"><circle cx="960" cy="1000" r="20"/><circle cx="1140" cy="1000" r="20"/>
      <circle cx="960" cy="1140" r="20"/><circle cx="1140" cy="1140" r="20"/></g>
    ${seams('M1050 920 l0 460')}
  </g>`;
  return svgDoc(inner);
}

// RAINCOAT: glossy, hooded shoulders, toggle front, slight sheen.
function jacketRaincoat(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M800 730 q250 -100 500 0 q84 34 90 150 l20 500 q4 60 -70 62 l-560 0 q-74 -2 -70 -62
      l20 -500 q6 -116 90 -150 z" fill="${fill}"/>
    <!-- storm flap -->
    <path d="M900 720 q150 -46 300 0 l-10 90 q-140 -40 -280 0 z" fill="${sh}"/>
    <!-- toggles -->
    <g fill="${sh}"><rect x="1020" y="960" width="60" height="22" rx="10"/>
      <rect x="1020" y="1080" width="60" height="22" rx="10"/><rect x="1020" y="1200" width="60" height="22" rx="10"/></g>
    <!-- sheen -->
    ${seams('M900 860 q60 400 20 500', 'rgba(255,255,255,0.18)')}
  </g>`;
  return svgDoc(inner);
}

// VEST: sleeveless, shows the charcoal body arms; tactical pockets.
function jacketVest(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <!-- sleeveless torso only, narrower so the body arms show at the sides -->
    <path d="M890 720 q160 -70 320 0 q50 26 54 120 l10 520 q2 56 -60 58 l-328 0 q-62 -2 -60 -58
      l10 -520 q4 -94 54 -120 z" fill="${fill}"/>
    <!-- zip -->
    ${seams('M1050 740 l0 640', 'rgba(0,0,0,0.3)')}
    <!-- tactical pockets -->
    <rect x="910" y="1040" width="120" height="120" rx="12" fill="${sh}"/>
    <rect x="1070" y="1040" width="120" height="120" rx="12" fill="${sh}"/>
    <rect x="950" y="880" width="80" height="70" rx="10" fill="${sh}"/>
    <rect x="1070" y="880" width="80" height="70" rx="10" fill="${sh}"/>
  </g>`;
  return svgDoc(inner);
}

// SUIT JACKET: sharp lapels, pocket square, buttoned.
function jacketSuit(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M850 730 q200 -84 400 0 q60 26 68 120 l16 540 q2 56 -64 58 l-440 0 q-66 -2 -64 -58
      l16 -540 q8 -94 68 -120 z" fill="${fill}"/>
    <!-- open V with lapels -->
    <path d="M1050 740 l-150 120 l60 70 l90 -110 z" fill="${sh}"/>
    <path d="M1050 740 l150 120 l-60 70 l-90 -110 z" fill="${sh}"/>
    <path d="M980 1000 l70 -120 l70 120 l-70 360 z" fill="#1c1c20"/>
    <!-- button -->
    <circle cx="1050" cy="1120" r="16" fill="${sh}"/>
    <!-- pocket square -->
    <path d="M1180 960 l60 0 l-20 54 l-30 -20 z" fill="#e9e4d8"/>
  </g>`;
  return svgDoc(inner);
}

// JAILBIRD: striped prison outfit, horizontal bands.
function jacketJailbird(fill, band) {
  let stripes = '';
  for (let i = 0; i < 9; i++) {
    const y = 780 + i * 72;
    if (i % 2 === 1) stripes += `<rect x="800" y="${y}" width="500" height="36" fill="${band}"/>`;
  }
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M810 730 q240 -94 480 0 q70 30 76 130 l14 520 q2 58 -70 60 l-520 0 q-72 -2 -70 -60
      l14 -520 q6 -100 76 -130 z" fill="${fill}"/>
    <clipPath id="jb"><path d="M810 730 q240 -94 480 0 q70 30 76 130 l14 520 q2 58 -70 60 l-520 0 q-72 -2 -70 -60 l14 -520 q6 -100 76 -130 z"/></clipPath>
    <g clip-path="url(#jb)">${stripes}</g>
    <path d="M810 730 q240 -94 480 0 q70 30 76 130 l14 520 q2 58 -70 60 l-520 0 q-72 -2 -70 -60 l14 -520 q6 -100 76 -130 z" fill="none" stroke="${INK}" stroke-width="${STROKE}"/>
    <!-- collar -->
    <path d="M940 720 q110 -34 220 0 l-10 70 q-100 -30 -200 0 z" fill="${band}"/>
  </g>`;
  return svgDoc(inner);
}

// DENIM JACKET: trucker denim, chest pockets, contrast stitch.
function jacketDenim(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M830 730 q220 -86 440 0 q66 28 74 124 l16 530 q2 56 -66 58 l-472 0 q-68 -2 -66 -58
      l16 -530 q8 -96 74 -124 z" fill="${fill}"/>
    <!-- yoke -->
    <path d="M830 860 q220 50 440 0" fill="none" stroke="#e8b24a" stroke-width="6" stroke-dasharray="18 14"/>
    <!-- button placket -->
    <path d="M1050 740 l0 620" stroke="${sh}" stroke-width="${STROKE_THIN}" fill="none"/>
    <g fill="#d9a528"><circle cx="1050" cy="920" r="10"/><circle cx="1050" cy="1040" r="10"/><circle cx="1050" cy="1160" r="10"/></g>
    <!-- chest pockets -->
    <rect x="890" y="920" width="110" height="130" rx="8" fill="${sh}"/>
    <rect x="1100" y="920" width="110" height="130" rx="8" fill="${sh}"/>
    <path d="M890 960 h110 M1100 960 h110" stroke="#e8b24a" stroke-width="5" stroke-dasharray="14 10"/>
  </g>`;
  return svgDoc(inner);
}

// PUFFER (keep the house look, redrawn clean; this matches the legacy puffer feel).
function jacketPuffer(fill, sh) {
  const inner = `
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M800 740 q250 -104 500 0 q92 36 96 158 l6 420 q0 64 -84 66 q-268 28 -536 0
      q-84 -2 -84 -66 l6 -420 q4 -122 100 -158 z" fill="${fill}"/>
    <!-- horizontal baffles -->
    ${seams('M800 900 q250 60 500 0 M800 1040 q250 60 500 0 M800 1180 q250 60 500 0 M800 1320 q250 56 500 0', 'rgba(0,0,0,0.22)')}
    <!-- collar -->
    <path d="M910 720 q140 -40 280 0 l-10 70 q-130 -34 -260 0 z" fill="${sh}"/>
    ${seams('M1050 760 l0 600', 'rgba(0,0,0,0.25)')}
  </g>`;
  return svgDoc(inner);
}

// ---------------------------------------------------------------------------
// MASKS  (z5). DISCIPLINE: the legacy mask-black is a SMALL eye-band domino
// hugging the skull sockets (box x 746..1085 y 541..725). Every mask here stays
// in that band so the skull crown and jaw still read; "full-face" variants may
// cover down to the jaw (y~780) but NEVER balloon below it or wider than the
// skull (x 753..1101). Eye centres: left ~(812,634) right ~(968,622).
// ---------------------------------------------------------------------------
const EYE_L = { x: 812, y: 634 };
const EYE_R = { x: 968, y: 622 };

// A tidy eye-band strap shape (the domino footprint), reused by most masks.
function bandPath() {
  return 'M742 606 q140 -58 258 -42 q120 16 128 56 q8 54 -116 84 q-146 34 -278 -6 q-56 -38 8 -76 z';
}
function eyeHole(e, rx, ry, fill = '#ffffff') {
  return `<ellipse cx="${e.x}" cy="${e.y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${INK}" stroke-width="${STROKE_THIN}"/>`;
}
function maskBand(fill, inner, extra = '') {
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="${bandPath()}" fill="${fill}"/>
    ${inner}
    ${extra}
  </g>`);
}

function maskDomino(fill) {
  return maskBand(fill, eyeHole(EYE_L, 46, 36) + eyeHole(EYE_R, 50, 38));
}
function maskOpera(fill) {
  return maskBand(fill, eyeHole(EYE_L, 48, 38) + eyeHole(EYE_R, 52, 40),
    `<path d="M742 606 q140 -58 258 -42 q120 16 128 56" fill="none" stroke="#f3d87a" stroke-width="7"/>
     <path d="M742 606 l-56 -16 l34 46 z" fill="${fill}"/>`);
}
function maskBandana(fill) {
  // bandana over the lower face: covers nose + jaw (y 680..790), eyes stay open
  // above it; a knot points off to the left but stays within the skull width.
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M760 680 q150 -26 290 -6 q60 10 56 60 q-10 70 -150 94 q-150 20 -224 -40 q-40 -56 28 -108 z" fill="${fill}"/>
    <path d="M760 680 l-54 -12 l34 48 z" fill="${fill}"/>
    ${seams('M790 716 q130 24 250 6', 'rgba(0,0,0,0.2)')}
  </g>`);
}
function maskRespirator(fill) {
  // lower-face half respirator with a side filter; eyes stay open above.
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M770 678 q140 -24 270 -4 q54 10 50 58 q-8 72 -150 96 q-150 20 -220 -42 q-34 -54 50 -106 z" fill="${fill}"/>
    <circle cx="905" cy="748" r="26" fill="#2b2b2f" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <circle cx="1030" cy="716" r="34" fill="#3a4240" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <circle cx="1030" cy="716" r="14" fill="#1f1f1f"/>
  </g>`);
}
function maskGas(fill) {
  // full gas mask on the skull box (x 753..1101, y 504..798): two round goggles
  // + a single filter snout. Stays inside the skull footprint.
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M760 546 q150 -44 290 -14 q66 16 64 110 q-4 110 -70 150 l-30 70 q-26 48 -74 6 l-24 -70 q-150 -30 -176 -150 q-10 -80 20 -102 z" fill="${fill}"/>
    <circle cx="818" cy="628" r="48" fill="#bfe3df" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <circle cx="968" cy="618" r="50" fill="#bfe3df" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <circle cx="896" cy="752" r="40" fill="#3a4240" stroke="${INK}" stroke-width="${STROKE_THIN}"/>
    <circle cx="896" cy="752" r="16" fill="#1f1f1f"/>
  </g>`);
}
function maskBalaclava(fill) {
  // knit hood hugging the skull box; two eye holes, a mouth slit at the jaw.
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M756 520 q150 -48 296 -18 q74 16 72 140 q-4 150 -176 168 q-170 -14 -196 -150 q-12 -92 ${4} -140 z" fill="${fill}"/>
    ${eyeHole(EYE_L, 50, 32, '#161616')} ${eyeHole(EYE_R, 54, 34, '#161616')}
    <path d="M846 748 q74 -20 154 0 q-18 30 -82 30 q-62 0 -72 -30 z" fill="#161616"/>
    ${seams('M780 582 q140 -22 280 0', 'rgba(255,255,255,0.1)')}
  </g>`);
}
function maskSki(fill, stripe) {
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M756 520 q150 -46 296 -16 q74 16 72 138 q-4 148 -176 166 q-170 -14 -196 -148 q-12 -92 4 -140 z" fill="${fill}"/>
    <rect x="746" y="670" width="360" height="40" fill="${stripe}"/>
    ${eyeHole(EYE_L, 48, 32, '#161616')} ${eyeHole(EYE_R, 52, 34, '#161616')}
    <ellipse cx="905" cy="756" rx="78" ry="30" fill="#161616"/>
  </g>`);
}
function maskSurgical(fill) {
  // lower-face surgical mask; eyes open above. Ear loops hook up the sides.
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M772 676 q138 -22 266 0 q40 8 36 56 q-8 84 -168 100 q-160 -12 -168 -94 q-4 -48 34 -62 z" fill="${fill}"/>
    ${seams('M792 704 q134 -16 252 0 M792 736 q134 -16 252 0 M792 768 q134 -12 252 0', 'rgba(0,0,0,0.14)')}
    <path d="M778 684 q-56 -20 -70 24 M1038 680 q56 -20 70 24" fill="none" stroke="${INK}" stroke-width="7"/>
  </g>`);
}
function maskHockey(fill) {
  // Jason-style vent-holed plate across the skull face.
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M760 540 q150 -44 290 -14 q62 14 60 120 q-4 130 -150 152 q-170 -14 -190 -150 q-12 -86 ${-10} -108 z" fill="${fill}"/>
    ${eyeHole(EYE_L, 38, 26, '#161616')} ${eyeHole(EYE_R, 42, 28, '#161616')}
    <g fill="#161616"><circle cx="905" cy="556" r="11"/><circle cx="905" cy="712" r="11"/><circle cx="830" cy="760" r="9"/><circle cx="980" cy="760" r="9"/><circle cx="905" cy="650" r="9"/></g>
    <path d="M858 744 q60 16 120 0" fill="none" stroke="#161616" stroke-width="8"/>
  </g>`);
}
function maskPlague(fill, sh) {
  // beak mask: eye goggles in the band + a long beak dropping to the jaw.
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M754 580 q150 -46 296 -16 q66 16 62 120 q-6 70 -96 104 l-40 140 q-24 50 -72 8 l-30 -132 q-150 -30 -172 -140 q-8 -70 22 -92 z" fill="${fill}"/>
    <path d="M896 788 l70 120 q-50 40 -86 0 z" fill="${sh}"/>
    ${eyeHole(EYE_L, 44, 34, '#cfe7e8')} ${eyeHole(EYE_R, 48, 36, '#cfe7e8')}
  </g>`);
}
function maskGoldVault(fill) {
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M748 606 q138 -62 262 -46 q122 16 126 60 q4 62 -124 90 q-148 32 -278 -8 q-54 -40 14 -96 z" fill="${fill}"/>
    <path d="M748 606 q138 -62 262 -46 q122 16 126 60 q4 62 -124 90 q-148 32 -278 -8 q-54 -40 14 -96 z" fill="none" stroke="#8a6410" stroke-width="${STROKE_THIN}"/>
    ${eyeHole(EYE_L, 40, 32, '#1b1b1b')} ${eyeHole(EYE_R, 44, 34, '#1b1b1b')}
    <path d="M780 572 q120 -24 206 6" fill="none" stroke="#f3d87a" stroke-width="8" stroke-linecap="round"/>
  </g>`);
}

// ---------------------------------------------------------------------------
// EYES  (z6, over the skull sockets but typically under masks visually; drawn to
//        sit in the socket zone x 804..1022 y 597..694). Expressions / glow.
// ---------------------------------------------------------------------------
function eyesBase(inner) { return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE_THIN}" stroke-linejoin="round">${inner}</g>`); }

function eyesGlow(color) {
  return eyesBase(`
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="34" fill="${color}"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="36" fill="${color}"/>
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="60" fill="${color}" opacity="0.25"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="62" fill="${color}" opacity="0.25"/>`);
}
function eyesShifty() {
  return eyesBase(`
    <ellipse cx="${EYE_L.x}" cy="${EYE_L.y}" rx="46" ry="26" fill="#fff"/>
    <ellipse cx="${EYE_R.x}" cy="${EYE_R.y}" rx="50" ry="26" fill="#fff"/>
    <circle cx="${EYE_L.x + 22}" cy="${EYE_L.y}" r="14" fill="#141414"/>
    <circle cx="${EYE_R.x + 24}" cy="${EYE_R.y}" r="14" fill="#141414"/>`);
}
function eyesDollar() {
  return eyesBase(`
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="40" fill="#fff"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="42" fill="#fff"/>
    <text x="${EYE_L.x}" y="${EYE_L.y + 24}" font-family="Georgia,serif" font-size="66" font-weight="bold" fill="#1f7a3d" text-anchor="middle">$</text>
    <text x="${EYE_R.x}" y="${EYE_R.y + 24}" font-family="Georgia,serif" font-size="70" font-weight="bold" fill="#1f7a3d" text-anchor="middle">$</text>`);
}
function eyesXout() {
  return eyesBase(`
    <g stroke="#141414" stroke-width="16" stroke-linecap="round">
      <path d="M${EYE_L.x - 30} ${EYE_L.y - 30} l60 60 M${EYE_L.x + 30} ${EYE_L.y - 30} l-60 60"/>
      <path d="M${EYE_R.x - 32} ${EYE_R.y - 32} l64 64 M${EYE_R.x + 32} ${EYE_R.y - 32} l-64 64"/>
    </g>`);
}
function eyesHalfLid() {
  return eyesBase(`
    <path d="M${EYE_L.x - 46} ${EYE_L.y} a46 30 0 0 1 92 0 z" fill="#fff"/>
    <path d="M${EYE_R.x - 50} ${EYE_R.y} a50 32 0 0 1 100 0 z" fill="#fff"/>
    <circle cx="${EYE_L.x}" cy="${EYE_L.y - 2}" r="12" fill="#141414"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y - 2}" r="12" fill="#141414"/>
    <path d="M${EYE_L.x - 48} ${EYE_L.y - 6} h96 M${EYE_R.x - 52} ${EYE_R.y - 8} h104" stroke="#141414" stroke-width="12"/>`);
}
function eyesWide() {
  return eyesBase(`
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="48" fill="#fff"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="52" fill="#fff"/>
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="18" fill="#141414"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="20" fill="#141414"/>`);
}
function eyesRoundGlasses() {
  return eyesBase(`
    <circle cx="${EYE_L.x}" cy="${EYE_L.y}" r="56" fill="rgba(180,220,255,0.25)" stroke="#141414" stroke-width="12"/>
    <circle cx="${EYE_R.x}" cy="${EYE_R.y}" r="58" fill="rgba(180,220,255,0.25)" stroke="#141414" stroke-width="12"/>
    <path d="M${EYE_L.x + 56} ${EYE_L.y} h40 M${EYE_R.x + 58} ${EYE_R.y} h30" stroke="#141414" stroke-width="12"/>`);
}
function eyesShades() {
  return eyesBase(`
    <path d="M740 600 q80 -30 150 -10 q20 50 -10 86 q-90 24 -130 -16 q-20 -36 -10 -60 z" fill="#15151a"/>
    <path d="M910 596 q86 -30 160 -8 q20 54 -12 90 q-96 24 -138 -18 q-20 -38 -10 -64 z" fill="#15151a"/>
    <path d="M888 614 h28" stroke="#141414" stroke-width="12"/>
    <path d="M740 606 l-56 -14 M1072 602 l56 -14" stroke="#141414" stroke-width="12"/>
    <path d="M760 616 q40 -14 80 -4" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="8"/>`);
}
function eyesVisorGlow(color) {
  return eyesBase(`
    <path d="M720 596 q190 -40 360 0 q20 10 10 56 q-10 44 -40 50 q-150 26 -300 0 q-30 -6 -40 -50 q-10 -46 10 -56 z" fill="#101016" stroke="#141414" stroke-width="12"/>
    <path d="M760 626 q140 -16 260 0" stroke="${color}" stroke-width="14" fill="none" stroke-linecap="round"/>
    <path d="M760 626 q140 -16 260 0" stroke="${color}" stroke-width="30" fill="none" stroke-linecap="round" opacity="0.25"/>`);
}

// ---------------------------------------------------------------------------
// HATS / HEADWEAR  (z7, above the skull crown at y~504; keep OFF the face).
// Footprint target: roughly x 640..1300, bottom edge no lower than y~560 so the
// face stays clear. Crown centre ~ x 930.
// ---------------------------------------------------------------------------
const HATCX = 930;
function hatBase(inner) { return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">${inner}</g>`); }

function hatFedora(fill, band) {
  return hatBase(`
    <ellipse cx="${HATCX}" cy="520" rx="330" ry="66" fill="${fill}"/>
    <path d="M${HATCX - 210} 500 q0 -210 210 -220 q210 10 210 220 q-210 70 -420 0 z" fill="${fill}"/>
    <path d="M${HATCX - 210} 500 q210 66 420 0 l-6 40 q-210 60 -408 0 z" fill="${band}"/>
    <path d="M${HATCX - 210} 300 q210 -60 420 0" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="7"/>`);
}
function hatNewsboy(fill) {
  return hatBase(`
    <path d="M${HATCX - 240} 520 q-30 -230 240 -250 q270 20 240 250 q-240 70 -480 0 z" fill="${fill}"/>
    <path d="M${HATCX - 250} 516 q250 70 500 0 l40 20 q-20 44 -70 44 l-440 0 q-50 0 -70 -44 z" fill="${fill}"/>
    ${seams('M690 440 l480 0 M' + HATCX + ' 300 l0 220', 'rgba(0,0,0,0.18)')}
    <circle cx="${HATCX}" cy="300" r="16" fill="${fill}" stroke="${INK}" stroke-width="7"/>`);
}
function hatBeanie(fill, cuff) {
  return hatBase(`
    <path d="M${HATCX - 220} 540 q-20 -270 220 -284 q240 14 220 284 q-220 60 -440 0 z" fill="${fill}"/>
    <rect x="${HATCX - 236}" y="500" width="472" height="74" rx="30" fill="${cuff}"/>
    ${seams('M' + (HATCX - 120) + ' 290 l-30 230 M' + HATCX + ' 274 l0 236 M' + (HATCX + 120) + ' 290 l30 230', 'rgba(0,0,0,0.18)')}`);
}
function hatBucket(fill) {
  return hatBase(`
    <path d="M${HATCX - 200} 500 q-10 -200 200 -214 q210 14 200 214 q-200 56 -400 0 z" fill="${fill}"/>
    <path d="M${HATCX - 280} 500 q280 80 560 0 q10 54 -60 70 q-220 50 -440 0 q-70 -16 -60 -70 z" fill="${fill}"/>
    ${seams('M650 520 q280 60 560 0', 'rgba(0,0,0,0.2)')}`);
}
function hatCap(fill, brim) {
  // baseball cap: crown on top of the skull, brim points LEFT so it never covers the face
  return hatBase(`
    <path d="M${HATCX - 190} 516 q-10 -200 190 -214 q200 14 190 214 q-190 56 -380 0 z" fill="${fill}"/>
    <path d="M${HATCX - 190} 516 q-150 -4 -230 44 q-16 30 16 46 q140 10 220 -40 z" fill="${brim}"/>
    <circle cx="${HATCX}" cy="300" r="16" fill="${brim}"/>
    ${seams('M' + HATCX + ' 302 l0 214', 'rgba(0,0,0,0.18)')}`);
}
function hatCapBack(fill, brim) {
  // cap worn backwards: snap strap shows at front, no brim over face
  return hatBase(`
    <path d="M${HATCX - 190} 516 q-10 -200 190 -214 q200 14 190 214 q-190 56 -380 0 z" fill="${fill}"/>
    <rect x="${HATCX - 70}" y="486" width="140" height="44" rx="10" fill="${brim}"/>
    <g fill="${fill}"><circle cx="${HATCX - 36}" cy="508" r="8"/><circle cx="${HATCX}" cy="508" r="8"/><circle cx="${HATCX + 36}" cy="508" r="8"/></g>`);
}
function hatCrown(fill) {
  return hatBase(`
    <path d="M${HATCX - 220} 510 l40 -210 l80 120 l100 -170 l100 170 l80 -120 l40 210 q-220 70 -440 0 z" fill="${fill}"/>
    <g fill="#c0392b"><circle cx="${HATCX - 180}" cy="300" r="18"/><circle cx="${HATCX}" cy="270" r="20"/><circle cx="${HATCX + 180}" cy="300" r="18"/></g>
    <rect x="${HATCX - 224}" y="500" width="448" height="40" rx="12" fill="#d9a528"/>`);
}
function hatTophat(fill, band) {
  return hatBase(`
    <ellipse cx="${HATCX}" cy="524" rx="300" ry="54" fill="${fill}"/>
    <rect x="${HATCX - 170}" y="190" width="340" height="340" rx="14" fill="${fill}"/>
    <rect x="${HATCX - 170}" y="470" width="340" height="56" fill="${band}"/>`);
}
function hatVisor(fill) {
  // sun visor: band around the crown + brim to the LEFT (off face), open top
  return hatBase(`
    <path d="M${HATCX - 200} 510 q200 60 400 0 q10 40 -30 56 q-170 44 -340 0 q-40 -16 -30 -56 z" fill="${fill}"/>
    <path d="M${HATCX - 200} 516 q-150 -4 -230 40 q-16 30 16 46 q140 10 220 -36 z" fill="${fill}"/>`);
}
function hatHoodUpHat() {
  // a soft hood pulled up as headwear (reads over the crown, open at the face)
  return hatBase(`
    <path d="M700 520 q230 -300 460 0 q40 60 20 120 q-60 -90 -140 -96 l-220 0 q-80 6 -140 96 q-20 -60 20 -120 z" fill="#2a2a30"/>
    <path d="M700 520 q230 -300 460 0 q40 60 20 120" fill="none" stroke="${INK}" stroke-width="${STROKE}"/>`);
}

// ---------------------------------------------------------------------------
// HEADS  (z3). Redraw of the legacy off-anchor droopy-brute into a proper
// on-anchor skull. Target the skull box x 753..1101 y 504..798 so masks/eyes/
// hats all land correctly. Bone tone + ink outline to match classic-skull.
// ---------------------------------------------------------------------------
function headBruteSkull() {
  // heavy square-jawed brute skull, on-anchor
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M770 560 q160 -70 320 -36 q60 14 58 150 q-2 70 -40 110 l0 60 q0 40 -40 42 l-250 0 q-40 -2 -40 -42 l0 -70 q-50 -40 -54 -150 q-2 -84 86 -114 z" fill="${BONE}"/>
    <path d="M1070 620 q24 90 -20 150" fill="none" stroke="${BONE_SH}" stroke-width="18"/>
    <ellipse cx="820" cy="634" rx="58" ry="50" fill="#1a1a1a"/>
    <ellipse cx="984" cy="624" rx="62" ry="52" fill="#1a1a1a"/>
    <path d="M900 690 l-24 44 l48 0 z" fill="#1a1a1a"/>
    <!-- heavy jaw teeth -->
    <g stroke="${INK}" stroke-width="7">
      <path d="M812 788 l0 -30 M858 792 l0 -34 M904 794 l0 -34 M950 792 l0 -34 M996 788 l0 -30" />
    </g>
    ${seams('M800 582 q130 -30 250 -6', 'rgba(0,0,0,0.12)')}
  </g>`);
}
function headCrackedSkull() {
  // classic round skull with a crack across the crown (adds variety)
  return svgDoc(`
  <g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round">
    <path d="M760 630 q0 -130 165 -140 q165 10 165 140 q0 70 -46 112 l0 56 q0 36 -40 38 l-158 0 q-40 -2 -40 -38 l0 -56 q-46 -42 -46 -112 z" fill="${BONE}"/>
    <ellipse cx="822" cy="636" rx="54" ry="48" fill="#1a1a1a"/>
    <ellipse cx="978" cy="626" rx="58" ry="50" fill="#1a1a1a"/>
    <path d="M900 684 l-22 42 l44 0 z" fill="#1a1a1a"/>
    <g stroke="${INK}" stroke-width="7"><path d="M840 790 l0 -28 M884 792 l0 -30 M928 790 l0 -30 M972 788 l0 -28"/></g>
    <!-- crack -->
    <path d="M905 510 l-26 60 l30 40 l-18 50" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
  </g>`);
}

// ---------------------------------------------------------------------------
// ITEMS  (z above clothes, held in the lower-left hand zone).
// ---------------------------------------------------------------------------
function itemBase(inner) { return svgDoc(`<g stroke="${INK}" stroke-width="${STROKE}" stroke-linejoin="round" stroke-linecap="round">${inner}</g>`); }

function itemDrill() {
  return itemBase(`
    <rect x="720" y="1120" width="150" height="120" rx="18" fill="#e0a21e"/>
    <rect x="770" y="1240" width="60" height="150" rx="16" fill="#3a3a40"/>
    <rect x="860" y="1150" width="160" height="50" rx="12" fill="#55555c"/>
    <path d="M1020 1175 l120 0" stroke="#9a9aa2" stroke-width="18"/>
    <path d="M1140 1165 l0 20 l24 -10 z" fill="#9a9aa2"/>`);
}
function itemSafeDial() {
  return itemBase(`
    <circle cx="800" cy="1180" r="110" fill="#2f2f36"/>
    <circle cx="800" cy="1180" r="76" fill="#4a4a52"/>
    <circle cx="800" cy="1180" r="18" fill="#d9a528"/>
    <g stroke="#d9d2c4" stroke-width="7">
      <path d="M800 1104 l0 24 M876 1180 l-24 0 M800 1256 l0 -24 M724 1180 l24 0"/>
    </g>
    <path d="M800 1180 l44 -30" stroke="#d9a528" stroke-width="10"/>`);
}
function itemFlashlight() {
  return itemBase(`
    <rect x="770" y="1140" width="70" height="240" rx="18" fill="#3a3a40"/>
    <path d="M770 1140 l70 0 l40 -60 l-150 0 z" fill="#55555c"/>
    <path d="M760 1080 l-120 -70 l0 140 z" fill="#f2e2a8" opacity="0.5"/>
    <ellipse cx="755" cy="1080" rx="14" ry="46" fill="#f3e9c4"/>`);
}
function itemGrapple() {
  return itemBase(`
    <path d="M820 1120 q-30 90 -40 240" fill="none" stroke="#9a7b45" stroke-width="14"/>
    <g fill="#8a8f96">
      <path d="M800 1120 l-60 -60 l24 -24 l60 60 z"/>
      <path d="M800 1120 l60 -60 l24 24 l-60 60 z"/>
      <path d="M800 1120 l0 -84 l0 84 z" stroke="#8a8f96" stroke-width="24"/>
    </g>
    <circle cx="786" cy="1360" r="20" fill="#9a7b45"/>`);
}
function itemSprayCan() {
  return itemBase(`
    <rect x="760" y="1150" width="110" height="230" rx="24" fill="#c0392b"/>
    <rect x="786" y="1110" width="58" height="50" rx="10" fill="#3a3a40"/>
    <ellipse cx="815" cy="1100" rx="26" ry="12" fill="#55555c"/>
    <g fill="#f2e2a8" opacity="0.8"><circle cx="760" cy="1070" r="8"/><circle cx="720" cy="1050" r="6"/><circle cx="740" cy="1030" r="5"/></g>
    ${seams('M780 1210 h70', 'rgba(255,255,255,0.3)')}`);
}
function itemBriefcase() {
  return itemBase(`
    <rect x="700" y="1200" width="260" height="190" rx="18" fill="#6a4a2a"/>
    <rect x="700" y="1200" width="260" height="60" rx="18" fill="#7a5a36"/>
    <rect x="810" y="1160" width="40" height="60" rx="10" fill="none" stroke="#3a2a18" stroke-width="16"/>
    <rect x="810" y="1270" width="40" height="30" rx="6" fill="#d9a528"/>
    ${seams('M700 1290 h260', 'rgba(0,0,0,0.25)')}`);
}
function itemGoldBar() {
  return itemBase(`
    <path d="M720 1240 l230 -40 l40 70 l-230 40 z" fill="#f3d150"/>
    <path d="M720 1240 l40 70 l230 -40 l0 90 l-230 40 l-40 -70 z" fill="#d9a528"/>
    ${seams('M780 1232 l180 -30', 'rgba(255,255,255,0.4)')}`);
}

// ---------------------------------------------------------------------------
// Jacket colorways: [id, name, tier, weight, shapeFn, fill, shade]
// ---------------------------------------------------------------------------
const C_COMMON = { tier: 'common', weight: 100 };
const C_RARE = { tier: 'rare', weight: 28 };
const C_ULTRA = { tier: 'ultra-rare', weight: 6 };

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------
async function main() {
  const jobs = [];

  // BODIES: 3 builds x poses -> ~10 options
  const bodyDefs = [
    ['body/b-lean-standing.png', makeBody('lean', 'standing')],
    ['body/b-lean-crouch.png', makeBody('lean', 'crouch')],
    ['body/b-lean-peek.png', makeBody('lean', 'peek')],
    ['body/b-broad-standing.png', makeBody('broad', 'standing')],
    ['body/b-broad-handsup.png', makeBody('broad', 'handsup')],
    ['body/b-broad-loot.png', makeBody('broad', 'loot')],
    ['body/b-hunched-standing.png', makeBody('hunched', 'standing')],
    ['body/b-hunched-crouch.png', makeBody('hunched', 'crouch')],
    ['body/b-hunched-peek.png', makeBody('hunched', 'peek')],
    ['body/b-lean-vault.png', makeBody('lean', 'vault')],
  ];
  jobs.push(...bodyDefs);

  // JACKETS: shape x colorway -> ~14 options
  const jackets = [
    ['clothes/j-trench-charcoal.png', jacketTrench('#3c3f46', '#2a2c31')],
    ['clothes/j-trench-tan.png', jacketTrench('#9a8762', '#7c6c4c')],
    ['clothes/j-bomber-olive.png', jacketBomber('#5c6346', '#454b34')],
    ['clothes/j-bomber-blood.png', jacketBomber('#7a2f2a', '#5c231f')],
    ['clothes/j-hoodie-grey.png', jacketHoodie('#565a63', '#42454c')],
    ['clothes/j-hoodup-black.png', jacketHoodUp('#2c2e34', '#1d1f24')],
    ['clothes/j-varsity-navy.png', jacketVarsity('#2f3a56', '#b9a05a')],
    ['clothes/j-peacoat-slate.png', jacketPeacoat('#44505c', '#333c46')],
    ['clothes/j-raincoat-yellow.png', jacketRaincoat('#cdae3c', '#a98f2c')],
    ['clothes/j-vest-tactical.png', jacketVest('#3a4038', '#2a2f29')],
    ['clothes/j-suit-black.png', jacketSuit('#23242a', '#15151a')],
    ['clothes/j-jailbird.png', jacketJailbird('#d9d2c4', '#2a2a30')],
    ['clothes/j-denim.png', jacketDenim('#3f5a78', '#2f4660')],
    ['clothes/j-puffer-plum.png', jacketPuffer('#5a3f5c', '#452f46')],
    ['clothes/j-puffer-ice.png', jacketPuffer('#acc4d6', '#89a3b8')],
    ['clothes/j-trench-gold.png', jacketTrench('#d9a528', '#a87f17')],
  ];
  jobs.push(...jackets);

  // MASKS: ~12
  const masks = [
    ['mask/m-domino-black.png', maskDomino('#26262c')],
    ['mask/m-domino-crimson.png', maskDomino('#7a1f22')],
    ['mask/m-opera.png', maskOpera('#3a2a52')],
    ['mask/m-bandana-red.png', maskBandana('#9a2b26')],
    ['mask/m-bandana-navy.png', maskBandana('#2a3550')],
    ['mask/m-respirator.png', maskRespirator('#4a5250')],
    ['mask/m-gas.png', maskGas('#5c6346')],
    ['mask/m-balaclava.png', maskBalaclava('#232327')],
    ['mask/m-ski.png', maskSki('#2f3a56', '#d9d2c4')],
    ['mask/m-surgical.png', maskSurgical('#bcd6d0')],
    ['mask/m-hockey.png', maskHockey('#d9d2c4')],
    ['mask/m-plague.png', maskPlague('#2a2a30', '#1b1b1f')],
    ['mask/m-gold-vault.png', maskGoldVault('#d9a528')],
  ];
  jobs.push(...masks);

  // EYES: ~10
  const eyes = [
    ['eyes/e-glow-blue.png', eyesGlow('#4ea3ff')],
    ['eyes/e-glow-gold.png', eyesGlow('#f3d150')],
    ['eyes/e-shifty.png', eyesShifty()],
    ['eyes/e-dollar.png', eyesDollar()],
    ['eyes/e-xout.png', eyesXout()],
    ['eyes/e-halflid.png', eyesHalfLid()],
    ['eyes/e-wide.png', eyesWide()],
    ['eyes/e-round-glasses.png', eyesRoundGlasses()],
    ['eyes/e-shades.png', eyesShades()],
    ['eyes/e-visor-glow.png', eyesVisorGlow('#4effc8')],
  ];
  jobs.push(...eyes);

  // HATS: ~12
  const hats = [
    ['headwear/h-fedora.png', hatFedora('#2c2c32', '#d9a528')],
    ['headwear/h-newsboy.png', hatNewsboy('#6a5c44')],
    ['headwear/h-beanie.png', hatBeanie('#3a4a5c', '#2d3a48')],
    ['headwear/h-bucket.png', hatBucket('#5c6346')],
    ['headwear/h-cap.png', hatCap('#7a2f2a', '#5c231f')],
    ['headwear/h-cap-back.png', hatCapBack('#2f3a56', '#1f2740')],
    ['headwear/h-crown.png', hatCrown('#d9a528')],
    ['headwear/h-tophat.png', hatTophat('#1f1f24', '#7a1f22')],
    ['headwear/h-visor.png', hatVisor('#2f7a52')],
    ['headwear/h-hood-up.png', hatHoodUpHat()],
    ['headwear/h-fedora-tan.png', hatFedora('#9a8762', '#5c4a2c')],
    ['headwear/h-beanie-rust.png', hatBeanie('#8a4326', '#6c331c')],
  ];
  jobs.push(...hats);

  // ITEMS: ~7 new (plus the 5 from pass 1 already present = 12 total)
  const items = [
    ['item/drill.png', itemDrill()],
    ['item/safe-dial.png', itemSafeDial()],
    ['item/flashlight.png', itemFlashlight()],
    ['item/grappling-hook.png', itemGrapple()],
    ['item/spray-can.png', itemSprayCan()],
    ['item/briefcase.png', itemBriefcase()],
    ['item/gold-bar.png', itemGoldBar()],
  ];
  jobs.push(...items);

  // HEADS: redraw the broken legacy droopy-brute on-anchor + one new skull
  const heads = [
    ['head/droopy-brute.png', headBruteSkull()],
    ['head/cracked-skull.png', headCrackedSkull()],
  ];
  jobs.push(...heads);

  for (const d of ['body', 'clothes', 'mask', 'eyes', 'headwear', 'item', 'head']) {
    fs.mkdirSync(path.join(LAYERS, d), { recursive: true });
  }

  for (const [rel, svg] of jobs) {
    const out = path.join(LAYERS, rel);
    await rasterize(svg, out);
    console.log('wrote', rel);
  }
  console.log('done:', jobs.length, 'pass-2 trait files');
}

main().catch((e) => { console.error(e); process.exit(1); });

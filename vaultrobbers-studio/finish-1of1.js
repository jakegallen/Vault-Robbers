'use strict';

/* One-of-one finisher: normalizes any 1/1 character art to a 2048 square on a
   shared dark-vault backdrop with a faint gold rim, and an optional gold nameplate.
   This gives the ten unique robbers a cohesive legendary-tier presentation.

   Usage: SRC=path/to/art.png NAME="The Gentleman" OUT=render-out/mythic/990.png node finish-1of1.js
*/

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const S = 2048;
const SRC = process.env.SRC;
const OUT = process.env.OUT || 'finished.png';
const NAME = process.env.NAME || '';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function backdropSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
    <defs>
      <radialGradient id="vault" cx="50%" cy="42%" r="70%">
        <stop offset="0%" stop-color="#161a24"/>
        <stop offset="72%" stop-color="#0b0d13"/>
        <stop offset="100%" stop-color="#05060a"/>
      </radialGradient>
    </defs>
    <rect width="${S}" height="${S}" fill="url(#vault)"/>
    <circle cx="${S / 2}" cy="${S * 0.44}" r="${S * 0.40}" fill="none" stroke="#cfa23b" stroke-opacity="0.22" stroke-width="3"/>
    <circle cx="${S / 2}" cy="${S * 0.44}" r="${S * 0.46}" fill="none" stroke="#cfa23b" stroke-opacity="0.10" stroke-width="2"/>
  </svg>`;
}

function nameplateSvg(name) {
  const w = Math.min(1500, 520 + name.length * 46);
  const x = (S - w) / 2, y = S - 300, h = 150;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#0b0d13" stroke="#cfa23b" stroke-width="3"/>
    <text x="${S / 2}" y="${y + h / 2 + 18}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
      font-size="58" fill="#e7c972" letter-spacing="2">${esc(name.toUpperCase())}</text>
    <text x="${S / 2}" y="${y + h + 54}" text-anchor="middle" font-family="Arial, sans-serif"
      font-size="30" fill="#9aa4b2" letter-spacing="8">ONE OF ONE</text>
  </svg>`;
}

(async () => {
  if (!SRC || !fs.existsSync(SRC)) { console.error('set SRC to an existing image'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const subject = await sharp(SRC)
    .resize(Math.round(S * 0.80), Math.round(S * 0.80), { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const layers = [
    { input: subject, gravity: 'north', top: Math.round(S * 0.08), left: null },
  ];
  // center the subject horizontally; sharp needs explicit left when top is set
  const meta = await sharp(subject).metadata();
  layers[0].left = Math.round((S - meta.width) / 2);
  layers[0].top = Math.round(S * 0.09);
  delete layers[0].gravity;
  const comps = [{ input: Buffer.from(backdropSvg()) }, layers[0]];
  if (NAME) comps.push({ input: Buffer.from(nameplateSvg(NAME)) });
  await sharp({ create: { width: S, height: S, channels: 4, background: { r: 5, g: 6, b: 10, alpha: 1 } } })
    .composite(comps).png().toFile(OUT);
  console.log('wrote ' + OUT + (NAME ? '  (' + NAME + ')' : ''));
})();

'use strict';

/* Build the ten one-of-ones to final spec:
   - real base (body + skull) edited into each famous-robber costume + props
   - body footprint scaled to match the generative Robbers exactly
   - no legs, uniform sizing
   - custom background per robber
   - a subtle gold legend seal in the corner (no name in the art)
   The inspiration is carried in config.mythic (name, lore, inspiredBy, klass),
   which render.js turns into metadata attributes.

   Run: node build-1of1.js   (uses X_API_KEY via the server routes)
*/

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const R = __dirname;
const TOK = process.env.DASHBOARD_TOKEN;
const APIE = 'http://localhost:4000/pub/main/vaultrobbers-studio/api/edit-1of1';
const APIG = 'http://localhost:4000/pub/main/vaultrobbers-studio/api/generate-1of1';
const S = 2048;

const CHAR = "Keep the exact same chibi skeleton robber body shape and the rounded hooded lower body, do NOT add legs or feet. Keep the solid flat magenta background, do not add any scenery. ";
const STYLE = " Flat hand drawn cartoon, bold black outlines, flat colors, no text, no watermark.";
const BGS = " flat hand drawn cartoon background scene, bold outlines, atmospheric, empty with no characters, no text.";

// index, name, class, inspiredBy, costume prompt, background prompt
const ROBBERS = [
  [990, 'The Prince of Thieves', 'Fictional', 'Robin Hood', 'Dress it as Robin Hood: a green pointed hood with a small red feather, a green cloak, holding a wooden longbow and a quiver of arrows, a gold coin.', 'a misty green forest with soft golden godrays,' + BGS],
  [991, 'The Gentleman', 'Fictional', 'Arsene Lupin', 'Dress it as an elegant gentleman thief: a black tailcoat, a white bow tie, a tall black top hat, a gold monocle, white gloves, holding a slim black cane, a fan of playing cards.', 'a luxurious deep burgundy and gold art deco hall with a soft spotlight,' + BGS],
  [992, 'The Vanisher', 'Real', 'D.B. Cooper', 'Dress it in a tan trench coat and tiny dark sunglasses, holding a briefcase stuffed with cash, edges dissolving into teal smoke.', 'an eerie teal foggy night sky with swirling mist,' + BGS],
  [993, 'The Outlaw', 'Real', 'Jesse James', 'Dress it as a Wild West bandit: a red bandana over the lower face, a brown cowboy hat, two tiny revolvers.', 'a warm dusty desert town street at golden hour with long shadows,' + BGS],
  [994, 'The Ironclad', 'Real', 'Ned Kelly', 'Dress it in a homemade grey iron armor suit and a square iron bucket helmet with a narrow horizontal eye slit, holding an old revolver with a muzzle flash.', 'a dark smoky bushland at night with an orange gun-flash glow,' + BGS],
  [995, 'The Mastermind', 'Fictional', 'Danny Ocean', 'Dress it in a slick black tuxedo and bow tie, holding a fan of gold casino chips and a keycard, confident.', 'a glamorous neon casino vault with gold and blue lights,' + BGS],
  [996, 'The Cat', 'Fictional', 'Catwoman', 'Dress it in a sleek black catsuit with a mask and small cat ears, reaching for a giant sparkling blue diamond, thin red laser beams.', 'a dark high tech vault with neon red and cyan accents,' + BGS],
  [997, 'Public Enemy', 'Real', 'John Dillinger', 'Dress it as a 1930s gangster: a charcoal pinstripe suit, a grey fedora, holding a violin case and a cigar.', 'a smoky amber 1930s jazz speakeasy,' + BGS],
  [998, 'The Professor', 'Fictional', 'Money Heist', 'Dress it in a bright red jumpsuit and a pale surrealist mask with a curled mustache, holding a small tablet.', 'a grand mint vault interior with stacks of gold bars and warm light,' + BGS],
  [999, 'The Lovers', 'Real', 'Bonnie and Clyde', 'Dress it as a romantic 1930s outlaw: a tilted fedora and a pinstripe vest with a red rose in the lapel, holding a revolver and a stack of cash.', 'a 1930s getaway scene with a vintage car on a dusty road at dusk,' + BGS],
];

const LORE = {
  990: 'Steals from the vault, gives to the mob.',
  991: 'He left a thank you note where the diamonds used to be.',
  992: 'Jumped with the bag and was never seen again.',
  993: 'Dead or alive, the reward keeps going up.',
  994: 'Bullets bounce, the vault does not.',
  995: 'He already left with it before you noticed.',
  996: 'Nine lives, one diamond at a time.',
  997: 'The feds have a file, and it is very thick.',
  998: 'The whole city is watching, and he planned on that.',
  999: 'They robbed together, and they ran together.',
};

async function post(url, body) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOK }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok) return j;
      console.log('  err', JSON.stringify(j).slice(0, 90));
    } catch (e) { console.log('  retry', a, String(e).slice(0, 40)); }
    await new Promise(z => setTimeout(z, 7000));
  }
  return null;
}

function keyMagenta(data, w, h) {
  // remove magenta-ish background pixels (high R, high B, low G)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (r > 150 && b > 110 && g < 105 && (r - g) > 60 && (b - g) > 30) data[i * 4 + 3] = 0;
  }
  return data;
}
function bbox(data, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return { minX, minY, maxX, maxY };
}

function sealSvg() {
  const cx = S - 190, cy = S - 190, r = 110;
  const pts = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const rr = i % 2 ? r * 0.42 : r * 0.9; pts.push((cx + Math.cos(a) * rr).toFixed(1) + ',' + (cy + Math.sin(a) * rr).toFixed(1)); }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#0b0d13" fill-opacity="0.55" stroke="#cfa23b" stroke-width="5"/>
    <circle cx="${cx}" cy="${cy}" r="${r - 16}" fill="none" stroke="#cfa23b" stroke-opacity="0.55" stroke-width="2"/>
    <polygon points="${pts.join(' ')}" fill="#e7c972"/>
  </svg>`;
}

(async () => {
  // base body+skull on magenta
  const SB = 1024;
  const mbg = await sharp({ create: { width: SB, height: SB, channels: 3, background: { r: 255, g: 0, b: 255 } } }).png().toBuffer();
  const bparts = [];
  for (const f of ['layers/body/shadow-silhouette.png', 'layers/head/classic-skull.png']) bparts.push({ input: await sharp(path.join(R, f)).resize(SB, SB, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer() });
  const base = await sharp(mbg).composite(bparts).png().toBuffer();
  const baseUri = 'data:image/png;base64,' + base.toString('base64');

  // target footprint = generative silhouette bbox at 2048
  const sil = await sharp(path.join(R, 'layers/body/shadow-silhouette.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sb = bbox(sil.data, sil.info.width, sil.info.height);
  const targetH = (sb.maxY - sb.minY) * 1.14;   // allow hats a little headroom
  const targetCX = S / 2, targetCY = (sb.minY + sb.maxY) / 2 * (S / sil.info.width);

  const seal = Buffer.from(sealSvg());
  const mythic = [];

  for (const [idx, name, klass, insp, costume, bgPrompt] of ROBBERS) {
    console.log(idx, name);
    // 1) edit base -> costumed char on magenta
    const e = await post(APIE, { index: 7000 + (idx - 990), prompt: CHAR + costume + STYLE, image: baseUri });
    if (!e) { console.log('  EDIT FAILED'); continue; }
    // 2) key out magenta, find bbox
    const cm = await sharp(path.join(R, `mythic-src/${7000 + (idx - 990)}-0.png`)).resize(S, S, { fit: 'contain', background: { r: 255, g: 0, b: 255 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    keyMagenta(cm.data, cm.info.width, cm.info.height);
    const cb = bbox(cm.data, cm.info.width, cm.info.height);
    const charPng = await sharp(Buffer.from(cm.data), { raw: { width: cm.info.width, height: cm.info.height, channels: 4 } })
      .extract({ left: cb.minX, top: cb.minY, width: Math.max(1, cb.maxX - cb.minX), height: Math.max(1, cb.maxY - cb.minY) }).png().toBuffer();
    // 3) scale char to target height, center on a transparent 2048
    const ch = cb.maxY - cb.minY, cw = cb.maxX - cb.minX;
    const scale = targetH / ch; const nw = Math.round(cw * scale), nh = Math.round(ch * scale);
    const scaled = await sharp(charPng).resize(nw, nh).png().toBuffer();
    const charLayer = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: scaled, left: Math.round(targetCX - nw / 2), top: Math.round(targetCY - nh / 2) }]).png().toBuffer();
    // 4) custom background
    const g = await post(APIG, { index: 7500 + (idx - 990), prompt: bgPrompt + STYLE });
    let bgBuf;
    if (g) bgBuf = await sharp(path.join(R, `mythic-src/${7500 + (idx - 990)}-0.png`)).resize(S, S, { fit: 'cover' }).toBuffer();
    else bgBuf = await sharp({ create: { width: S, height: S, channels: 3, background: { r: 20, g: 22, b: 28 } } }).png().toBuffer();
    // 5) composite bg + char + seal
    await sharp(bgBuf).composite([{ input: charLayer }]).png().toFile(path.join(R, `layers/mythic/${idx}.png`));
    mythic.push({ name, lore: LORE[idx], inspiredBy: insp, klass, image: `layers/mythic/${idx}.png` });
    console.log('  done');
  }

  // write config.mythic
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(R, 'data/config.json'), 'utf8')); } catch (e) {}
  cfg.mythic = mythic;
  fs.mkdirSync(path.join(R, 'data'), { recursive: true });
  fs.writeFileSync(path.join(R, 'data/config.json'), JSON.stringify(cfg, null, 2));
  console.log('ALL DONE,', mythic.length, 'one-of-ones built');
})();

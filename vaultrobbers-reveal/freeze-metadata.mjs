#!/usr/bin/env node
/* Vault Robbers — REVEAL freeze metadata generator (DRY-RUN).
 *
 * Produces the final static metadata set to pin to IPFS AFTER reveal().
 * Read-only against the chain/filesystem sources; the ONLY things it writes are
 * local .json output files. It does NOT pin to IPFS, does NOT call any chain,
 * does NOT need keys. Pinning + setBaseURI + freezeMetadata are later manual steps.
 *
 * Output is keyed BY ART INDEX ({A}.json), because the contract fetches:
 *   tokenURI(tokenId) = baseURI + ((tokenId + startingIndex) % MAX) + ".json"
 *                     = baseURI + art + ".json"
 * So the file an owner's wallet requests for their token is the ART-INDEX file.
 * Inside each file the NAME is "Vault Robber #{tokenId}" where
 *   tokenId = artToToken(A, si)  (same gate.js math the live server uses),
 * so mint-order identity is preserved and mythic identity lives ONLY in
 * traits + image, never the name.
 *
 * Usage:
 *   node freeze-metadata.mjs --si 418 --out ./frozen
 *   node freeze-metadata.mjs --si 418 --out ./frozen --images-cid bafy...IMAGES
 *
 * Required:  --si <int>        final on-chain startingIndex() value
 * Optional:  --out <dir>       output directory (default ./frozen)
 *            --images-cid <c>  IPFS CID of the pinned images dir; image becomes
 *                              ipfs://<cid>/{A}.png   (default placeholder IMAGES_CID)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { MAX, artToToken } = require('./gate.js');

// ---- arg parsing ----------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--si') out.si = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--images-cid') out.imagesCid = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const USAGE = `Usage: node freeze-metadata.mjs --si <startingIndex> [--out <dir>] [--images-cid <cid>]

Required:
  --si <int>         final on-chain startingIndex() value (refuses to run without it)
Optional:
  --out <dir>        output directory (default ./frozen)
  --images-cid <c>   pinned images IPFS CID -> image = ipfs://<cid>/{A}.png
                     (default placeholder "IMAGES_CID" for a first dry run)`;

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(USAGE); process.exit(0); }

if (args.si === undefined || args.si === '') {
  console.error('ERROR: --si <startingIndex> is required.\n');
  console.error(USAGE);
  process.exit(1);
}
const si = Number(args.si);
if (!Number.isInteger(si) || si < 0 || si >= MAX) {
  console.error(`ERROR: --si must be an integer in [0, ${MAX - 1}]. Got: ${args.si}`);
  process.exit(1);
}
const outDir = path.resolve(args.out || './frozen');
const imagesCid = args.imagesCid || 'IMAGES_CID';
const usingPlaceholderCid = imagesCid === 'IMAGES_CID';

// ---- sources (read-only) --------------------------------------------------
const METADATA_PATH = '/data/app-groups/main/_vr-art/collection/metadata.json';
const ATTRS = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
const byArt = {};
for (const r of ATTRS) byArt[r.tokenId] = r;  // metadata.json keys rows by ART INDEX under its own "tokenId" field

// 1/1 SCATTER: must match the live reveal server's SWAP exactly (art 990-999 <-> ten hash-derived unminted indices)
// so the frozen IPFS set is identical to what holders already see. See reveal/server.js for the derivation.
const MYTHIC_SWAP_TARGETS = [263, 304, 348, 394, 446, 523, 646, 774, 902, 36];
const SWAP = {}; MYTHIC_SWAP_TARGETS.forEach((t, i) => { const m = 990 + i; SWAP[m] = t; SWAP[t] = m; });

// ---- realMeta(A): replicates the live reveal server EXACTLY ----------------
// (server.js realMeta, hardened description clause so a missing Inspired By/Class
//  can never emit "undefined")
function realMeta(A) {
  const eff = (SWAP[A] !== undefined) ? SWAP[A] : A;   // effective art (image+traits+mythic) after the 1/1 scatter
  const row = byArt[eff];
  if (!row) throw new Error(`metadata.json missing art index ${eff}`);
  const mythic = eff >= 990;
  const by = (row.attributes.find(a => a.trait_type === 'Inspired By') || {}).value;
  const kl = (row.attributes.find(a => a.trait_type === 'Class') || {}).value;
  const clause = by ? (kl ? `, inspired by ${by} (${kl}).` : `, inspired by ${by}.`) : '.';
  const desc = mythic
    ? `A 1 of 1 Vault Robber. ${row.name}${clause} One of ten legendary robbers hidden in the 1,000.`
    : 'One of 1,000 Vault Robbers, cracked from the Robbing the Vault heist on Robinhood Chain.';
  const tokenId = artToToken(A, si);           // on-chain token id this art maps to; NAME follows mint order, not art index
  const name = 'Vault Robber #' + tokenId;
  let attrs = row.attributes.slice();   // real traits only — no redundant "Token ID" trait (matches the live server)
  if (mythic) attrs = [{ trait_type: 'Legendary 1/1', value: row.name }].concat(attrs);
  // image points at the FINAL pinned IPFS images dir, keyed by the EFFECTIVE art (post-scatter) to match the live server
  const image = `ipfs://${imagesCid}/${eff}.png`;
  return { name, description: desc, image, attributes: attrs, _tokenId: tokenId, _mythic: mythic };
}

// ---- generate -------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });

const seenTokenIds = new Set();
let mythicCount = 0;
let undefinedHits = 0;
const tokenByArt = {};

for (let A = 0; A < MAX; A++) {
  const meta = realMeta(A);
  const { _tokenId, _mythic, ...fileObj } = meta;
  tokenByArt[A] = _tokenId;
  if (_mythic) mythicCount++;
  seenTokenIds.add(_tokenId);
  // guard: no "undefined" string anywhere in the emitted JSON
  const json = JSON.stringify(fileObj, null, 2);
  if (json.includes('undefined')) {
    undefinedHits++;
    console.error(`WARN: art ${A} produced a literal "undefined" in output`);
  }
  fs.writeFileSync(path.join(outDir, `${A}.json`), json + '\n');
}

// ---- bijection self-check -------------------------------------------------
// The 1000 produced tokenIds must be EXACTLY the set {1..1000}, no dupes/gaps.
let missing = [];
for (let t = 1; t <= MAX; t++) if (!seenTokenIds.has(t)) missing.push(t);
const dupes = MAX - seenTokenIds.size;   // Set collapses dupes; size < MAX means collisions
const bijectionOk = missing.length === 0 && seenTokenIds.size === MAX;

const files = fs.readdirSync(outDir).filter(f => /^\d+\.json$/.test(f));
const totalFiles = files.length;

const manifest = {
  generatedAt: new Date().toISOString(),
  startingIndex: si,
  maxSupply: MAX,
  imagesCid,
  usingPlaceholderCid,
  outDir,
  totalFiles,
  mythicCount,
  mythicArtRange: '990..999',
  bijection: {
    ok: bijectionOk,
    distinctTokenIds: seenTokenIds.size,
    expected: MAX,
    dupes,
    missing,
  },
  undefinedHits,
  sampleTokenByArt: { 0: tokenByArt[0], 990: tokenByArt[990], 999: tokenByArt[999] },
};
fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ---- report ---------------------------------------------------------------
const ok = totalFiles === MAX && bijectionOk && mythicCount === 10 && undefinedHits === 0;
console.log('--- Vault Robbers freeze-metadata (DRY RUN) ---');
console.log(`startingIndex (si) : ${si}`);
console.log(`out dir            : ${outDir}`);
console.log(`images CID         : ${imagesCid}${usingPlaceholderCid ? '  (PLACEHOLDER — re-run with --images-cid after pinning images)' : ''}`);
console.log(`total files        : ${totalFiles}   ${totalFiles === MAX ? 'OK' : 'FAIL (expected ' + MAX + ')'}`);
console.log(`mythics            : ${mythicCount}   ${mythicCount === 10 ? 'OK' : 'FAIL (expected 10)'}`);
console.log(`bijection 1..${MAX}  : ${bijectionOk ? 'OK' : 'FAIL'}  (distinct=${seenTokenIds.size}, dupes=${dupes}, missing=${missing.length})`);
if (missing.length) console.log(`  missing tokenIds : ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`);
console.log(`"undefined" hits   : ${undefinedHits}   ${undefinedHits === 0 ? 'OK' : 'FAIL'}`);
console.log(`manifest           : ${path.join(outDir, '_manifest.json')}`);
console.log('');
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
console.log('');
console.log('--- Next steps (manual, in order) ---');
console.log('1. Pin the FINAL images dir to IPFS:');
console.log('     /data/app-groups/main/_vr-art/reveal/images/  (0.png .. 999.png)');
console.log('   -> record the returned directory CID as IMAGES_CID.');
console.log('2. Re-run this script with the real CID so each image becomes ipfs://IMAGES_CID/{A}.png:');
console.log(`     node freeze-metadata.mjs --si ${si} --out ${args.out || './frozen'} --images-cid <IMAGES_CID>`);
console.log('3. Pin the regenerated metadata out dir to IPFS -> record that directory CID as METADATA_CID.');
console.log('4. Via the Safe, call setBaseURI("ipfs://METADATA_CID/") then freezeMetadata() on the contract.');
console.log('   (baseURI MUST end with a trailing slash; the contract appends ((tokenId+si)%1000)+".json".)');

if (!ok) process.exit(1);

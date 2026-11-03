#!/usr/bin/env node
/*
 * Vault Robbers — IPFS pin pipeline (Pinata).
 *
 * Two-phase pin, BAYC-style:
 *   1. Pin render-out/images/  -> CID_A   (the art files 0.png..999.png)
 *   2. Rewrite every render-out/metadata/<n>.json `image` field:
 *         ipfs://REPLACE_CID/<n>.png   ->   ipfs://CID_A/<n>.png
 *   3. Pin render-out/metadata/  -> CID_B
 *         => the contract baseURI = ipfs://CID_B/
 *
 * tokenURI resolves to  ipfs://CID_B/<art>.json  whose `image` is ipfs://CID_A/<art>.png.
 *
 * Auth: reads the Pinata JWT from env PINATA_PK (never hardcoded, never logged).
 * Idempotent: re-running re-pins (Pinata dedupes identical content to the same CID)
 *   and the metadata rewrite is written only from the ORIGINAL placeholder OR an
 *   already-injected CID, so repeated runs converge. Logs both CIDs to
 *   render-out/_pin.json so the reveal step can read baseURI without re-pinning.
 *
 * NETWORK: needs outbound HTTPS to api.pinata.cloud + uploads.pinata.cloud. Confirmed
 * reachable from this sandbox (testAuthentication returns 401 without a token, 200 with).
 * If run from a host without egress, it will fail at auth — run it where Pinata is reachable.
 *
 * Usage:
 *   PINATA_PK=<jwt> node pin-to-pinata.mjs                 # pin full render-out/
 *   PINATA_PK=<jwt> node pin-to-pinata.mjs --images-only   # phase 1 only (get CID_A)
 *   PINATA_PK=<jwt> node pin-to-pinata.mjs --dir <path>    # pin an arbitrary folder (sample test), prints CID, no rewrite
 *
 * Env:
 *   PINATA_PK          (required) Pinata JWT
 *   PIN_NAME_PREFIX    (optional) pin label prefix, default "vaultrobbers"
 */

'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'render-out');
const IMAGES_DIR = path.join(OUT_DIR, 'images');
const METADATA_DIR = path.join(OUT_DIR, 'metadata');
const PIN_LOG = path.join(OUT_DIR, '_pin.json');

const PLACEHOLDER = 'REPLACE_CID';
const API = 'https://api.pinata.cloud';
const PREFIX = process.env.PIN_NAME_PREFIX || 'vaultrobbers';

const JWT = process.env.PINATA_PK;
if (!JWT) {
  console.error('FATAL: PINATA_PK (Pinata JWT) not set in env. Aborting — nothing pinned.');
  process.exit(1);
}
const AUTH = { Authorization: `Bearer ${JWT}` };

// ---- helpers ---------------------------------------------------------------

async function testAuth() {
  const r = await fetch(`${API}/data/testAuthentication`, { headers: AUTH });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Pinata auth failed (HTTP ${r.status}). Check PINATA_PK. ${body.slice(0, 200)}`);
  }
  return true;
}

/**
 * Pin a directory to Pinata as a single folder (so children are addressed by name:
 * ipfs://<CID>/<file>). Uses pinFileToIPFS with multipart; each file keeps its
 * relative path under a wrapping directory named `wrapName`.
 */
async function pinDirectory(dir, wrapName) {
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (files.length === 0) throw new Error(`No files to pin in ${dir}`);

  const form = new FormData();
  for (const f of files) {
    const abs = path.join(dir, f);
    if (!fs.statSync(abs).isFile()) continue;
    const buf = fs.readFileSync(abs);
    // filepath forces Pinata to wrap into a directory; children addressable by name.
    form.append('file', new Blob([buf]), `${wrapName}/${f}`);
  }
  form.append('pinataMetadata', JSON.stringify({ name: `${PREFIX}-${wrapName}` }));
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1, wrapWithDirectory: false }));

  const r = await fetch(`${API}/pinning/pinFileToIPFS`, {
    method: 'POST',
    headers: AUTH, // do NOT set Content-Type; fetch sets the multipart boundary
    body: form,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`pinFileToIPFS failed (HTTP ${r.status}) for ${dir}: ${body.slice(0, 300)}`);
  }
  const j = await r.json();
  return j.IpfsHash; // the directory CID
}

/**
 * Rewrite metadata image fields to point at CID_A. Accepts rewriting from the
 * original placeholder OR from a previously-injected CID (idempotent re-point).
 */
function injectImageCid(cidA) {
  const files = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.json'));
  let changed = 0;
  const reImage = /"image"\s*:\s*"ipfs:\/\/[^/"]+\/(\d+)\.png"/;
  for (const f of files) {
    const abs = path.join(METADATA_DIR, f);
    const raw = fs.readFileSync(abs, 'utf8');
    const m = raw.match(reImage);
    if (!m) {
      console.warn(`  WARN: ${f} has no recognizable ipfs image field, left untouched`);
      continue;
    }
    const n = m[1];
    const next = raw.replace(reImage, `"image": "ipfs://${cidA}/${n}.png"`);
    if (next !== raw) {
      fs.writeFileSync(abs, next);
      changed++;
    }
  }
  return { total: files.length, changed };
}

function readPinLog() {
  try { return JSON.parse(fs.readFileSync(PIN_LOG, 'utf8')); } catch { return {}; }
}
function writePinLog(obj) {
  fs.writeFileSync(PIN_LOG, JSON.stringify(obj, null, 2) + '\n');
}

// ---- main ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const imagesOnly = args.includes('--images-only');
  const dirIdx = args.indexOf('--dir');

  await testAuth();
  console.log('Pinata auth OK.');

  // Arbitrary-folder sample test: pin one dir, print CID, no metadata rewrite.
  if (dirIdx !== -1) {
    const dir = args[dirIdx + 1];
    if (!dir || !fs.existsSync(dir)) { console.error('FATAL: --dir path missing or not found'); process.exit(1); }
    const wrap = path.basename(dir.replace(/\/$/, '')) || 'sample';
    console.log(`Pinning sample dir ${dir} ...`);
    const cid = await pinDirectory(dir, wrap);
    console.log(`SAMPLE_CID ${cid}`);
    console.log(`Gateway check: https://gateway.pinata.cloud/ipfs/${cid}/`);
    return;
  }

  if (!fs.existsSync(IMAGES_DIR)) { console.error(`FATAL: ${IMAGES_DIR} not found. Run render.js first.`); process.exit(1); }

  // Phase 1 — pin images -> CID_A
  const imgCount = fs.readdirSync(IMAGES_DIR).filter((f) => f.endsWith('.png')).length;
  console.log(`Phase 1: pinning ${imgCount} images from ${IMAGES_DIR} ...`);
  const cidA = await pinDirectory(IMAGES_DIR, 'images');
  console.log(`CID_A (images) = ${cidA}`);

  const log = readPinLog();
  log.cidImages = cidA;
  log.imagesCount = imgCount;
  log.pinnedAt = new Date().toISOString();
  writePinLog(log);

  if (imagesOnly) {
    console.log('--images-only: stopping after image pin. Metadata not rewritten/pinned.');
    return;
  }

  // Phase 2 — inject CID_A into metadata
  console.log('Phase 2: injecting CID_A into metadata image fields ...');
  const inj = injectImageCid(cidA);
  console.log(`  rewrote ${inj.changed}/${inj.total} metadata files`);

  // Phase 3 — pin metadata -> CID_B
  const metaCount = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.json')).length;
  console.log(`Phase 3: pinning ${metaCount} metadata files from ${METADATA_DIR} ...`);
  const cidB = await pinDirectory(METADATA_DIR, 'metadata');
  console.log(`CID_B (metadata) = ${cidB}`);

  log.cidMetadata = cidB;
  log.metadataCount = metaCount;
  log.baseURI = `ipfs://${cidB}/`;
  log.pinnedAt = new Date().toISOString();
  writePinLog(log);

  console.log('');
  console.log('========================================');
  console.log(`CID_A (images)   = ${cidA}`);
  console.log(`CID_B (metadata) = ${cidB}`);
  console.log(`baseURI (reveal) = ipfs://${cidB}/`);
  console.log(`Logged to ${PIN_LOG}`);
  console.log('Sanity: open https://gateway.pinata.cloud/ipfs/' + cidB + '/0.json');
  console.log('========================================');
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

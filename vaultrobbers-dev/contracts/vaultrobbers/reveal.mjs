#!/usr/bin/env node
/*
 * Vault Robbers — REVEAL (single owner-signed transaction).
 *
 * Mirrors set-unrevealed.mjs. Calls reveal(baseURI_) on the VaultRobbers contract.
 * reveal() is onlyOwner and, in the SAME tx, derives startingIndex from the previous
 * block hash:  si = keccak256(blockhash(block.number-1), address(this), totalMinted) % 1000.
 * This is the provably-fair, unpredictable art offset — no metadata server, no controlled placement.
 *
 * It flips `revealed = true` and sets the revealed art base to `baseURI_`
 * (= ipfs://CID_B/ from pin-to-pinata.mjs). After this tx, tokenURI(id) returns
 *   ipfs://CID_B/<(id + startingIndex) % 1000>.json
 * and the mint site auto-flips to real art (no site change needed).
 *
 * SAFETY:
 *   - NEVER hardcodes a key. Signer key is read from env only.
 *   - DRY-RUN by default: reads owner/revealed/state and STATICCALLs reveal to confirm it
 *     would succeed, but sends NO transaction unless --broadcast is passed.
 *   - The real mainnet reveal is Jake's / the owner's signed tx. If the owner is the Safe
 *     (0x3290...3665), this script cannot broadcast it at all — it prints the exact calldata
 *     to submit through the Safe UI instead.
 *
 * Usage:
 *   # DRY RUN (default) — reads state, simulates, prints calldata. No tx.
 *   REVEAL_PRIVATE_KEY=<k> node reveal.mjs --net testnet --base ipfs://CID_B/
 *   node reveal.mjs --net mainnet --base ipfs://CID_B/        # dry run needs no key
 *
 *   # BROADCAST (only works if owner == the key's address; otherwise prints Safe calldata)
 *   REVEAL_PRIVATE_KEY=<k> node reveal.mjs --net testnet --base ipfs://CID_B/ --broadcast
 *
 * Env:
 *   REVEAL_PRIVATE_KEY   signer key (ONLY required for --broadcast; must resolve to owner)
 *   REVEAL_BASE_URI      alternative to --base
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- networks -------------------------------------------------------------
const NETS = {
  mainnet: {
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    chainId: 4663,
    addr: '0xABC6c4F5d1F31326b419c2645C981743a845313a',
    explorer: 'https://explorer.chain.robinhood.com',
  },
  testnet: {
    rpc: 'https://rpc.testnet.chain.robinhood.com',
    chainId: 46630,
    // deployment.testnet.json address. (set-unrevealed.mjs used 0x7313A9...; override with --addr if needed.)
    addr: '0x23371ca4608F1942a68435d51484ca71f9fFd0F6',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
  },
};

function arg(flag, fallbackEnv) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallbackEnv ? process.env[fallbackEnv] : undefined;
}

const netName = (arg('--net') || 'testnet').toLowerCase();
const net = NETS[netName];
if (!net) { console.error(`FATAL: unknown --net "${netName}" (use mainnet|testnet)`); process.exit(1); }
const ADDR = arg('--addr') || net.addr;
const BASE = arg('--base', 'REVEAL_BASE_URI');
const BROADCAST = process.argv.includes('--broadcast');

if (!BASE) { console.error('FATAL: --base ipfs://CID_B/ (or REVEAL_BASE_URI) is required'); process.exit(1); }
if (!/^ipfs:\/\/.+\/$/.test(BASE)) {
  console.error(`FATAL: --base must be ipfs://<CID>/ with a trailing slash (got "${BASE}")`);
  process.exit(1);
}

const ABI = [
  'function owner() view returns (address)',
  'function revealed() view returns (bool)',
  'function metadataFrozen() view returns (bool)',
  'function startingIndex() view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function provenanceHash() view returns (bytes32)',
  'function tokenURI(uint256) view returns (string)',
  'function reveal(string baseURI_) external',
  'event Revealed(string baseURI, uint256 startingIndex)',
];

const provider = new ethers.JsonRpcProvider(net.rpc, net.chainId);

async function main() {
  console.log(`Network   : ${netName} (chainId ${net.chainId})`);
  console.log(`Contract  : ${ADDR}`);
  console.log(`baseURI   : ${BASE}`);
  console.log(`Mode      : ${BROADCAST ? 'BROADCAST' : 'DRY RUN (no tx)'}`);
  console.log('');

  const ro = new ethers.Contract(ADDR, ABI, provider);
  const [owner, revealed, frozen, totalMinted, maxSupply, provenance] = await Promise.all([
    ro.owner(), ro.revealed(), ro.metadataFrozen(), ro.totalMinted(), ro.MAX_SUPPLY(), ro.provenanceHash(),
  ]);
  console.log('owner          :', owner);
  console.log('revealed       :', revealed);
  console.log('metadataFrozen :', frozen);
  console.log('totalMinted    :', totalMinted.toString());
  console.log('MAX_SUPPLY     :', maxSupply.toString());
  console.log('provenanceHash :', provenance);
  console.log('');

  if (revealed) { console.error('ABORT: already revealed. reveal() reverts "already revealed".'); process.exit(2); }
  if (frozen)   { console.error('ABORT: metadataFrozen is true. reveal() reverts "frozen".'); process.exit(2); }

  // Encode calldata (always useful; required for Safe submission).
  const iface = new ethers.Interface(ABI);
  const calldata = iface.encodeFunctionData('reveal', [BASE]);
  console.log('reveal() calldata:');
  console.log('  to  :', ADDR);
  console.log('  data:', calldata);
  console.log('');

  // Static simulation from the OWNER so a non-owner dry run still proves it would pass.
  try {
    await provider.call({ to: ADDR, from: owner, data: calldata });
    console.log('Static simulation from owner: OK (reveal would succeed).');
  } catch (e) {
    console.error('Static simulation FAILED:', e.shortMessage || e.message);
    process.exit(3);
  }

  if (!BROADCAST) {
    console.log('');
    console.log('DRY RUN complete. No transaction sent.');
    console.log('To execute: have the OWNER submit the calldata above.');
    console.log(' - If owner is an EOA you control: REVEAL_PRIVATE_KEY=<k> node reveal.mjs --net ' + netName + ' --base ' + BASE + ' --broadcast');
    console.log(' - If owner is a Safe: submit {to, data} above as a contract interaction in the Safe UI.');
    return;
  }

  // BROADCAST path
  const PK = process.env.REVEAL_PRIVATE_KEY;
  if (!PK) { console.error('FATAL: --broadcast needs REVEAL_PRIVATE_KEY in env'); process.exit(1); }
  const wallet = new ethers.Wallet(PK, provider);
  console.log('signer         :', wallet.address);
  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    console.error(`FATAL: signer ${wallet.address} is NOT the owner ${owner}.`);
    console.error('reveal() is onlyOwner. If owner is a Safe, submit the calldata above via the Safe UI instead. No tx sent.');
    process.exit(4);
  }
  const bal = await provider.getBalance(wallet.address);
  console.log('signer gas     :', ethers.formatEther(bal), 'ETH');
  if (bal === 0n) { console.error('FATAL: signer has no gas'); process.exit(4); }

  const c = new ethers.Contract(ADDR, ABI, wallet);
  console.log('\nSending reveal() ...');
  const tx = await c.reveal(BASE);
  console.log('tx hash :', tx.hash);
  const rcpt = await tx.wait();
  console.log('mined in block', rcpt.blockNumber);

  // Read back the fair offset + prove a tokenURI resolves.
  const si = await ro.startingIndex();
  console.log('startingIndex  :', si.toString());
  for (const id of [1n, totalMinted > 0n ? totalMinted : 1n]) {
    try { console.log(`tokenURI(${id}) :`, await ro.tokenURI(id)); } catch (e) { console.log(`tokenURI(${id}) : (not minted)`); }
  }
  // Decode Revealed event for the log.
  for (const lg of rcpt.logs) {
    try {
      const p = iface.parseLog(lg);
      if (p && p.name === 'Revealed') console.log('Revealed event :', p.args.baseURI, '| startingIndex', p.args.startingIndex.toString());
    } catch {}
  }
  console.log('\nREVEAL DONE. Mint site auto-flips to real art.');
}

main().catch((e) => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });

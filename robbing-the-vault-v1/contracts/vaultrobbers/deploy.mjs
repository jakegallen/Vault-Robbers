import { ethers } from 'ethers';
import fs from 'fs';

const RPC   = 'https://rpc.testnet.chain.robinhood.com';
const TRVLT = '0x2B21e55fB7A84a500B23396a57D4dbA456c145b3'; // testnet ROBINVAULT (public mint)
const SAC_IMPL = process.env.SAC_IMPL || '0xFA39cFc3D81F12F7E02Ee800849e4CE67aD2Df85'; // RobberSAC account implementation
const PK    = process.env.DEPLOYER_PRIVATE_KEY;             // tiered price is baked into the contract (50,000 / 75,000 / 100,000 / 150,000)
if (!PK) { console.error('DEPLOYER_PRIVATE_KEY missing'); process.exit(1); }

// --- self-contained UNREVEALED placeholder (data: URI, needs no hosting) — the hooded robber ---
const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='700' height='980' viewBox='0 0 168 236'>`
 + `<defs><radialGradient id='g' cx='50%' cy='33%' r='72%'><stop offset='0%' stop-color='#173d24'/><stop offset='100%' stop-color='#040e08'/></radialGradient></defs>`
 + `<rect width='168' height='236' fill='url(#g)'/>`
 + `<polygon points='84,0 128,236 40,236' fill='#ffcf5a' opacity='0.10'/>`
 + `<path d='M34 236 q-2 -74 50 -92 q52 18 50 92 z' fill='#0a1710' stroke='#1f7a3a' stroke-width='1.6'/>`
 + `<path d='M44 104 q0 -46 40 -50 q40 4 40 50 q-18 -16 -40 -16 q-22 0 -40 16z' fill='#08130d' stroke='#1f7a3a' stroke-width='1.4'/>`
 + `<ellipse cx='84' cy='104' rx='27' ry='29' fill='#0d1c14'/>`
 + `<path d='M56 98 q28 -10 56 0 l0 15 q-28 9 -56 0 z' fill='#03100a' stroke='#e8c66a' stroke-width='1.2'/>`
 + `<circle cx='72' cy='106' r='3.4' fill='#3dff8f'/><circle cx='96' cy='106' r='3.4' fill='#3dff8f'/>`
 + `<ellipse cx='84' cy='70' rx='30' ry='7' fill='#1f7a3a'/>`
 + `<path d='M56 70 q28 -22 56 0 q-10 -8 -28 -8 q-18 0 -28 8z' fill='#25904a' stroke='#123f1e' stroke-width='1'/>`
 + `<path d='M58 68 q-12 -30 -2 -46 q12 14 9 46z' fill='#e23b3b' stroke='#5a0f0f' stroke-width='1'/>`
 + `<text x='84' y='18' font-family='Georgia,serif' font-size='9' fill='#e8c66a' text-anchor='middle' letter-spacing='1'>VAULT ROBBERS</text>`
 + `<rect x='50' y='212' width='68' height='16' rx='3' fill='#000' fill-opacity='0.45' stroke='#d9b45a' stroke-width='1'/>`
 + `<text x='84' y='223' font-family='monospace' font-size='9' fill='#e8c66a' text-anchor='middle' letter-spacing='3'>UNREVEALED</text>`
 + `</svg>`;
const imgUri  = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const meta = {
  name: 'Vault Robbers (Unrevealed)',
  description: 'One of 1,000 Vault Robbers, cracked from the Robbing the Vault heist. The artwork is sealed until reveal.',
  image: 'https://robbingthevault.com/robber-unrevealed.jpg',
  attributes: [{ trait_type: 'Status', value: 'Unrevealed' }]
};
const unrevealedURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(meta)).toString('base64');

const provenanceHash = ethers.keccak256(ethers.toUtf8Bytes('VaultRobbers::testnet::placeholder-provenance-v1'));

const artifact = JSON.parse(fs.readFileSync(new URL('./out/VaultRobbers.sol/VaultRobbers.json', import.meta.url)));
const provider = new ethers.JsonRpcProvider(RPC, 46630);
const wallet   = new ethers.Wallet(PK, provider);
const sink     = wallet.address; // TESTNET sink = deployer (observe funds); MAINNET will be the 0x888 ROBINVAULT wallet

console.log('deployer :', wallet.address);
const bal = await provider.getBalance(wallet.address);
console.log('gas bal  :', ethers.formatEther(bal), 'ETH');
if (bal === 0n) { console.error('NO GAS on testnet deployer — fund it first.'); process.exit(2); }

console.log('DEPLOY SUMMARY — token:', TRVLT, '| sink:', sink, '| tiered price: 50,000 / 75,000 / 100,000 / 150,000 | royalty: 200bps (2%)');

// Voucher signer = the website's backend key. The server signs mint vouchers with DEPLOYER_PRIVATE_KEY
// (the operator), so the on-chain signer is the deployer address unless SIGNER_ADDRESS overrides it.
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS || wallet.address;
console.log('voucher signer:', SIGNER_ADDRESS, '(website backend must sign with the matching key)');

const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
const c = await factory.deploy(TRVLT, sink, provenanceHash, unrevealedURI, SAC_IMPL, SIGNER_ADDRESS);
console.log('deploy tx:', c.deploymentTransaction().hash);
await c.waitForDeployment();
const addr = await c.getAddress();
console.log('VaultRobbers deployed at:', addr);

const tx = await c.setMintActive(true);
await tx.wait();
console.log('mintActive = true (tx', tx.hash + ')');

const out = { address: addr, chainId: 46630, payToken: TRVLT, sink, signer: SIGNER_ADDRESS, sacImplementation: SAC_IMPL, sacRegistry: '0x000000006551c19487814612e58FE06813775758', tieredPrice: { tier1: '50000', tier2: '75000', tier3: '100000', tier4: '150000', tier1End: 250, tier2End: 500, tier3End: 750 }, maxSupply: 1000, maxPerWallet: 3, royaltyBps: 200, explorer: 'https://explorer.testnet.chain.robinhood.com/address/' + addr };
fs.writeFileSync(new URL('./deployment.testnet.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('wrote deployment.testnet.json');
console.log(JSON.stringify(out));

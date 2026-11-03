// Deploy the ERC721C VaultRobbers (v7) + a testnet TransferValidator on Robinhood testnet (46630), wire them,
// and PROVE end-to-end: ERC-6551 loot bags, ERC2981 2% royalty, and ERC721C enforcement. Testnet only.
import { ethers } from 'ethers';
import fs from 'fs';

const RPC   = 'https://rpc.testnet.chain.robinhood.com';
const TRVLT = '0x2B21e55fB7A84a500B23396a57D4dbA456c145b3';
const SAC_IMPL = process.env.SAC_IMPL || '0xFA39cFc3D81F12F7E02Ee800849e4CE67aD2Df85';
const SAC_REGISTRY = '0x000000006551c19487814612e58FE06813775758';
const PK    = process.env.DEPLOYER_PRIVATE_KEY;
if (!PK) { console.error('DEPLOYER_PRIVATE_KEY missing'); process.exit(1); }

const meta = { name: 'Vault Robbers (Unrevealed)', description: 'One of 1,000 Vault Robbers, cracked from the Robbing the Vault heist. The artwork is sealed until reveal.', image: 'https://robbingthevault.com/robber-unrevealed.jpg', attributes: [{ trait_type: 'Status', value: 'Unrevealed' }] };
const unrevealedURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(meta)).toString('base64');
const provenanceHash = ethers.keccak256(ethers.toUtf8Bytes('VaultRobbers::testnet::placeholder-provenance-v1'));

const vr  = JSON.parse(fs.readFileSync(new URL('./out/VaultRobbers.sol/VaultRobbers.json', import.meta.url)));
const tv  = JSON.parse(fs.readFileSync(new URL('./out/TransferValidator.sol/TransferValidator.json', import.meta.url)));

const provider = new ethers.JsonRpcProvider(RPC, 46630);
const wallet   = new ethers.Wallet(PK, provider);
const sink     = wallet.address;
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS || wallet.address;

console.log('deployer :', wallet.address);
const bal = await provider.getBalance(wallet.address);
console.log('gas bal  :', ethers.formatEther(bal), 'ETH');
if (bal === 0n) { console.error('NO GAS on testnet deployer — fund it first.'); process.exit(2); }

// 1) TransferValidator
const tvF = new ethers.ContractFactory(tv.abi, tv.bytecode.object, wallet);
const validator = await tvF.deploy(); await validator.waitForDeployment();
const validatorAddr = await validator.getAddress();
console.log('TransferValidator:', validatorAddr);

// 2) VaultRobbers v7 (ERC721C)
const vrF = new ethers.ContractFactory(vr.abi, vr.bytecode.object, wallet);
const c = await vrF.deploy(TRVLT, sink, provenanceHash, unrevealedURI, SAC_IMPL, SIGNER_ADDRESS);
await c.waitForDeployment();
const addr = await c.getAddress();
console.log('VaultRobbers v7 :', addr);

// 3) wire + open mint
await (await c.setMintActive(true)).wait();
await (await c.setTransferValidator(validatorAddr)).wait();
console.log('mintActive=true, transferValidator wired');

// ── PROOFS ──────────────────────────────────────────────────────────────────
const R = new ethers.Contract(addr, vr.abi, wallet);
const V = new ethers.Contract(validatorAddr, tv.abi, wallet);
const out = { pass: [], fail: [] };
const ok  = (n) => out.pass.push(n);
const bad = (n, e) => out.fail.push(n + ' :: ' + (e && e.message || e));

// ERC721C surface
try { const gv = await R.getTransferValidator(); (gv.toLowerCase() === validatorAddr.toLowerCase()) ? ok('getTransferValidator == validator') : bad('getTransferValidator', gv); } catch (e) { bad('getTransferValidator', e); }
try { const [sig, isView] = await R.getTransferValidationFunction(); (sig === '0xcaee23ea' && isView === true) ? ok('getTransferValidationFunction (0xcaee23ea, view)') : bad('getTransferValidationFunction', sig + '/' + isView); } catch (e) { bad('getTransferValidationFunction', e); }
try { const ic = await R.supportsInterface('0xad0d7f6c'); ic === true ? ok('supportsInterface(ICreatorToken=0xad0d7f6c)') : bad('supportsInterface ICreatorToken', 'returned ' + ic); } catch (e) { bad('supportsInterface ICreatorToken', e); }
// ERC2981
try { const [rcv, amt] = await R.royaltyInfo(1, 10000n); (rcv.toLowerCase() === sink.toLowerCase() && amt === 200n) ? ok('royaltyInfo = (sink, 2%)') : bad('royaltyInfo', rcv + '/' + amt); } catch (e) { bad('royaltyInfo', e); }

// ERC-6551 loot bag: reserveMint token 1 (free, no voucher) then check the SAC opened
try {
  await (await R.reserveMint(wallet.address, 1)).wait();
  const owner1 = await R.ownerOf(1);
  const sac1 = await R.tokenAccount(1);
  const code = await provider.getCode(sac1);
  (owner1.toLowerCase() === wallet.address.toLowerCase()) ? ok('reserveMint token #1') : bad('ownerOf(1)', owner1);
  (code && code !== '0x') ? ok('ERC-6551 SAC opened at ' + sac1 + ' (has code)') : bad('SAC not created', sac1 + ' code=' + code);
} catch (e) { bad('ERC-6551 mint/SAC', e); }

// ERC721C enforcement
try {
  await (await V.setEnforce(true)).wait();
  // a) owner moving their own token passes even under enforcement (caller==from). Self-transfer exercises _update+validator.
  await (await R.transferFrom(wallet.address, wallet.address, 1)).wait();
  ok('enforced: owner direct transfer allowed');
  // b) an operator that is NOT whitelisted is blocked (validator staticcall reverts)
  let blocked = false;
  try { await V.validateTransfer.staticCall('0x000000000000000000000000000000000000dEaD', wallet.address, wallet.address, 1); } catch (_) { blocked = true; }
  blocked ? ok('enforced: unlisted operator BLOCKED (royalty-skip prevented)') : bad('operator not blocked', 'validateTransfer did not revert');
  // c) a whitelisted operator passes
  await (await V.setOperator('0x000000000000000000000000000000000000dEaD', true)).wait();
  let allowed = true;
  try { await V.validateTransfer.staticCall('0x000000000000000000000000000000000000dEaD', wallet.address, wallet.address, 1); } catch (_) { allowed = false; }
  allowed ? ok('enforced: whitelisted operator allowed') : bad('whitelisted operator blocked', '');
  // leave the collection OPEN for now (validator wired but not enforcing) so testnet play/marketplace is unrestricted
  await (await V.setEnforce(false)).wait();
  ok('enforcement toggled back OFF (validator wired, unenforced default)');
} catch (e) { bad('enforcement test', e); }

console.log('\n=== PROOFS ===');
out.pass.forEach(p => console.log('  ✓ ' + p));
out.fail.forEach(f => console.log('  ✗ ' + f));

const dep = { address: addr, transferValidator: validatorAddr, chainId: 46630, payToken: TRVLT, sink, signer: SIGNER_ADDRESS, sacImplementation: SAC_IMPL, sacRegistry: SAC_REGISTRY, erc721c: true, royaltyBps: 200, maxSupply: 1000, maxPerWallet: 3, tieredPrice: { tier1: '50000', tier2: '75000', tier3: '100000', tier4: '150000', tier1End: 250, tier2End: 500, tier3End: 750 }, explorer: 'https://explorer.testnet.chain.robinhood.com/address/' + addr };
fs.writeFileSync(new URL('./deployment.testnet.json', import.meta.url), JSON.stringify(dep, null, 2));
console.log('\nwrote deployment.testnet.json');
console.log(JSON.stringify({ robbers: addr, validator: validatorAddr }));

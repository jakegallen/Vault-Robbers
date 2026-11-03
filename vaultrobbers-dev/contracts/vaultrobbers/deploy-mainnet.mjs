// MAINNET deploy (Robinhood Chain 4663): RobberSAC implementation + VaultRobbers (ERC721C) against the REAL
// ROBINVAULT token. Two-treasury model: mint proceeds -> dev/token sink (0xe8886, burnable); ERC-2981 royalties
// + team reserve -> NFT treasury (0x96bc). Owner transferred to the Safe. NO TransferValidator on mainnet
// (none deployed there) -> ERC-2981 2% signal-only. mintActive stays FALSE (owner/Safe flips at launch).
// Broadcasts with DEPLOYER_PRIVATE_KEY_2 and HARD-ASSERTS it resolves to the expected deployer before anything.
import { ethers } from 'ethers';
import fs from 'fs';

const RPC       = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN     = 4663;
const RVLT      = '0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04'; // ROBINVAULT (18dp)
const SINK      = '0xe8886FD4863855884D5F1FFfA38F8C1c8502Ec8c'; // chapter-1 dev/token treasury (mint proceeds; burnable)
const ROYALTY   = '0x96bcfdb15b65245F5B9796C7A0587b3649f52432'; // chapter-2 NFT treasury (royalties + reserve)
const SIGNER    = '0xa6b827aB57907f394704c08a17F737C1da3417C9'; // mint-voucher signer (server)
const SAFE      = '0x2aA3936C0312f3604982B2504BeE7ad8c88e9397'; // owner multisig (2-of-2) — NOT used this deploy (owner stays EOA per Jake 2026-09-05)
const VALIDATOR = '0xA000027A9B2802E1ddf7000061001e5c005A0000'; // live CreatorTokenTransferValidator on 4663 -> enforced 2% royalties
const REGISTRY  = '0x000000006551c19487814612e58FE06813775758'; // canonical ERC-6551 registry (confirmed on 4663)
const EXPECT_DEPLOYER = '0x8444149B8E5eD771607452FB133d8803A3F02D0e';
const PK = process.env.DEPLOYER_PRIVATE_KEY_2;
if (!PK) { console.error('FATAL: DEPLOYER_PRIVATE_KEY_2 not set'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC, CHAIN);
const wallet   = new ethers.Wallet(PK, provider);
if (wallet.address.toLowerCase() !== EXPECT_DEPLOYER.toLowerCase()) {
  console.error(`FATAL: DEPLOYER_PRIVATE_KEY_2 resolves to ${wallet.address}, expected ${EXPECT_DEPLOYER}. Aborting, no tx sent.`);
  process.exit(2);
}
const net = await provider.getNetwork();
if (Number(net.chainId) !== CHAIN) { console.error(`FATAL: RPC chainId ${net.chainId} != ${CHAIN}`); process.exit(3); }
const bal = await provider.getBalance(wallet.address);
console.log('deployer :', wallet.address, '| gas:', ethers.formatEther(bal), 'ETH | chain:', CHAIN);
if (bal === 0n) { console.error('FATAL: deployer has no gas'); process.exit(4); }

// Unrevealed metadata: Jake's Robber image for all 1,000 until the Halloween reveal.
const meta = { name: 'Vault Robbers (Unrevealed)', description: 'One of 1,000 Vault Robbers from the Robbing the Vault heist. The artwork is sealed until the reveal.', image: 'https://robbingthevault.com/robber-unrevealed.jpg', attributes: [{ trait_type: 'Status', value: 'Unrevealed' }] };
const unrevealedURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(meta)).toString('base64');
// Provenance: final art is not ready (reveal is at Halloween); this is a documented mainnet placeholder. Fair
// distribution at reveal comes from the on-chain blockhash startingIndex, independent of this hash.
const provenanceHash = ethers.keccak256(ethers.toUtf8Bytes('VaultRobbers::mainnet::4663::provenance::pending-final-art-2026'));

const vr  = JSON.parse(fs.readFileSync(new URL('./out/VaultRobbers.sol/VaultRobbers.json', import.meta.url)));
const sacArt = JSON.parse(fs.readFileSync(new URL('./out/LootBag.sol/LootBag.json', import.meta.url)));

// 1) RobberSAC implementation (no constructor args)
const sacF = new ethers.ContractFactory(sacArt.abi, sacArt.bytecode.object, wallet);
const sac = await sacF.deploy(); await sac.waitForDeployment();
const SAC_IMPL = await sac.getAddress();
console.log('LootBag impl     :', SAC_IMPL);

// 2) VaultRobbers (payToken, sink, provenanceHash, unrevealedURI, sacImplementation, signer, royaltyReceiver)
const vrF = new ethers.ContractFactory(vr.abi, vr.bytecode.object, wallet);
const c = await vrF.deploy(RVLT, SINK, provenanceHash, unrevealedURI, SAC_IMPL, SIGNER, ROYALTY);
await c.waitForDeployment();
const ROBBERS = await c.getAddress();
console.log('VaultRobbers     :', ROBBERS);

// 3) turn ON enforced 2% royalties (point at the live 4663 CreatorTokenTransferValidator). Owner STAYS the deployer EOA
//    (Jake 2026-09-05) so OpenSea collection admin + setPrices() work directly; can transfer to the Safe later.
await (await c.setTransferValidator(VALIDATOR)).wait();
console.log('transferValidator ->', VALIDATOR);

// 4) verify
const R = new ethers.Contract(ROBBERS, vr.abi, provider);
const out = { chain: CHAIN, LootBag: SAC_IMPL, VaultRobbers: ROBBERS, deployer: wallet.address };
const chk = async (label, got, want) => { const ok = String(got).toLowerCase() === String(want).toLowerCase(); console.log(`${ok ? 'OK ' : 'BAD'} ${label}: ${got}${ok ? '' : ' (want ' + want + ')'}`); out[label] = got; return ok; };
await chk('owner', await R.owner(), EXPECT_DEPLOYER);
await chk('transferValidator', await R.getTransferValidator(), VALIDATOR);
await chk('sink', await R.sink(), SINK);
await chk('signer', await R.signer(), SIGNER);
const [rr, ra] = await R.royaltyInfo(1, 10000n);
await chk('royaltyReceiver', rr, ROYALTY); console.log('royaltyAmount(10000)=', ra.toString(), '(want 200)');
console.log('mintActive=', await R.mintActive(), '(want false)');
console.log('MAX_SUPPLY=', (await R.MAX_SUPPLY()).toString(), 'PRICE1=', (await R.priceForToken(1)).toString());

fs.writeFileSync(new URL('./deployment.mainnet.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nMAINNET_RESULT ' + JSON.stringify(out));

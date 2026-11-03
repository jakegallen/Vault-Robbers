import { ethers } from 'ethers';
import fs from 'fs';

const RPC = 'https://rpc.testnet.chain.robinhood.com';
const REGISTRY = '0x000000006551c19487814612e58FE06813775758'; // canonical ERC-6551 registry (already on RH testnet)
const ROBBERS  = '0x7A2318478feE6873bDBcD9ba4b2600203a136c5A'; // our VaultRobbers NFT
const TOKEN_ID = 2n;                                            // a Robber the deployer owns
const SALT = '0x' + '00'.repeat(32);
const PK = process.env.DEPLOYER_PRIVATE_KEY;

const p = new ethers.JsonRpcProvider(RPC, 46630);
const w = new ethers.Wallet(PK, p);
const art = JSON.parse(fs.readFileSync(new URL('./out/RobberSAC.sol/RobberSAC.json', import.meta.url)));

const regAbi = [
  'function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)',
  'function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)'
];
const sacAbi = [
  'function token() view returns (uint256,address,uint256)',
  'function owner() view returns (address)',
  'function state() view returns (uint256)',
  'function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)'
];

console.log('deployer:', w.address, '| gas:', ethers.formatEther(await p.getBalance(w.address)), 'ETH');

// 1) deploy the SAC implementation
const factory = new ethers.ContractFactory(art.abi, art.bytecode.object, w);
const impl = await factory.deploy();
await impl.waitForDeployment();
const IMPL = await impl.getAddress();
console.log('RobberSAC implementation deployed:', IMPL);

// 2) compute the deterministic SAC address for Robber #2
const reg = new ethers.Contract(REGISTRY, regAbi, w);
const predicted = await reg.account(IMPL, SALT, 46630, ROBBERS, TOKEN_ID);
console.log('predicted SAC address for Robber #' + TOKEN_ID + ':', predicted);

// 3) create it
const tx = await reg.createAccount(IMPL, SALT, 46630, ROBBERS, TOKEN_ID);
await tx.wait();
console.log('createAccount tx:', tx.hash);

// 4) verify the binding
const sac = new ethers.Contract(predicted, sacAbi, w);
const [cid, tc, tid] = await sac.token();
const sacOwner = await sac.owner();
console.log('SAC.token()  ->', cid.toString(), tc, tid.toString());
console.log('SAC.owner()  ->', sacOwner, '(== deployer:', sacOwner.toLowerCase() === w.address.toLowerCase(), ')');

// 5) prove control: fund the SAC, then move ETH OUT via execute() (only the Robber owner can)
const fund = ethers.parseEther('0.0004');
console.log('FUND LOG -> sending', ethers.formatEther(fund), 'ETH to SAC', predicted);
await (await w.sendTransaction({ to: predicted, value: fund })).wait();
console.log('SAC balance after fund:', ethers.formatEther(await p.getBalance(predicted)), 'ETH');
const pull = ethers.parseEther('0.00025');
console.log('EXECUTE LOG -> SAC.execute(to=' + w.address + ', value=' + ethers.formatEther(pull) + ' ETH) as Robber owner');
await (await sac.execute(w.address, pull, '0x', 0)).wait();
console.log('SAC balance after owner-controlled withdraw:', ethers.formatEther(await p.getBalance(predicted)), 'ETH');
console.log('SAC.state() (exec counter):', (await sac.state()).toString());

const out = { registry: REGISTRY, implementation: IMPL, robbers: ROBBERS, exampleTokenId: Number(TOKEN_ID), exampleSac: predicted, chainId: 46630, salt: SALT };
fs.writeFileSync(new URL('./sac.testnet.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('wrote sac.testnet.json:', JSON.stringify(out));

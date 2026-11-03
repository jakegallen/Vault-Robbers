import { ethers } from 'ethers';
const RPC = 'https://rpc.testnet.chain.robinhood.com';
const ADDR = '0x7313A9502e77A5F23dEDC8f6f0B17b799695f860';
const PK = process.env.DEPLOYER_PRIVATE_KEY;
if (!PK) { console.error('no key'); process.exit(1); }
const meta = {
  name: 'Vault Robbers (Unrevealed)',
  description: 'One of 1,000 Vault Robbers, cracked from the Robbing the Vault heist. The artwork is sealed until reveal.',
  image: 'https://robbingthevault.com/robber-unrevealed.jpg',
  attributes: [{ trait_type: 'Status', value: 'Unrevealed' }]
};
const uri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(meta)).toString('base64');
const provider = new ethers.JsonRpcProvider(RPC, 46630);
const wallet = new ethers.Wallet(PK, provider);
const abi = ['function setUnrevealedURI(string) external', 'function unrevealedURI() view returns (string)', 'function owner() view returns (address)', 'function revealed() view returns (bool)'];
const c = new ethers.Contract(ADDR, abi, wallet);
console.log('owner   :', await c.owner(), '| me:', wallet.address);
console.log('revealed:', await c.revealed());
const tx = await c.setUnrevealedURI(uri);
console.log('tx      :', tx.hash);
await tx.wait();
const now = await c.unrevealedURI();
console.log('OK. new unrevealedURI starts:', now.slice(0, 60), '...');

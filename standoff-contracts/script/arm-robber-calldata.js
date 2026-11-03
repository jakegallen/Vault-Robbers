// Arming calldata generator for the Vault Robbers airdrop (StandoffEscrow V9).
// FULL 6% rake to one random robber => robberShareBps = 10000 (Jake 2026-10-22).
// Run at mint close with the FINAL minted supply:  SUPPLY=<N> node script/arm-robber-calldata.js
const { ethers } = require('ethers');
const PROXY='0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5';      // StandoffEscrow proxy (4663)
const NFT='0xABC6c4F5d1F31326b419c2645C981743a845313a';        // Vault Robbers ERC721
const REGISTRY='0x000000006551c19487814612e58FE06813775758';   // ERC-6551 registry (live 4663)
const IMPL='0x41C8f39463A868d3A88af00cd0fe7102F30E44eC';        // AccountV3 v0.3.1 (live 4663)
const SALT='0x'+'0'.repeat(64);
const SUPPLY = parseInt(process.env.SUPPLY||'0',10);            // FINAL minted count at close
const SHARE=10000;                                             // 100% of rake -> the drawn robber
const RAKE=600, BURN=10000;                                    // 6% rake; burn-share of remainder (moot at 100% robber)
const iface=new ethers.Interface([
  'function setRobberConfig(address nft,address registry,address accountImpl,bytes32 salt,uint32 supply,uint16 shareBps)',
  'function setRake(uint16 r,uint16 bShare)',
  'function setHolderDiscountBps(uint16 bps)'
]);
const cfg=iface.encodeFunctionData('setRobberConfig',[NFT,REGISTRY,IMPL,SALT,SUPPLY,SHARE]);
const rake=iface.encodeFunctionData('setRake',[RAKE,BURN]);
const disc=iface.encodeFunctionData('setHolderDiscountBps',[0]);
console.log(JSON.stringify({ proxy:PROXY, supply:SUPPLY, shareBps:SHARE, note:'regenerate with final SUPPLY at mint close',
  calls:[
    { label:'1) arm airdrop (setRobberConfig, shareBps=10000)', to:PROXY, data:cfg },
    { label:'2) raise rake 5%->6% (setRake 600)', to:PROXY, data:rake },
    { label:'3) retire holder discount (setHolderDiscount 0,false)', to:PROXY, data:disc }
  ]}, null, 2));

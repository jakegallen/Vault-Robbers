// emblem-wallet-connector.js
// ─────────────────────────────────────────────────────────────────────────────
// Emblem Wallet Connector — the shared, app-agnostic multi-chain wallet layer used
// across Emblem front-ends (EmblemWrap / vault-mint, and any
// other Emblem team project). It handles DISCOVERY, CONNECT, CHAIN-SWITCH and SIGNING
// only. It has NO DOM and NO server calls, so it drops into any page: your app keeps
// its own server/holdings/wrap logic and asks this connector for an address + signer.
//
// Chains: EVM (EIP-6963 + injected: MetaMask/Rabby/Coinbase/OKX/Rainbow/Phantom/
// Robinhood/… with Base/Polygon/Shape/Robinhood chain add+switch), Solana (Phantom/
// Solflare/Backpack/OKX), Bitcoin Ordinals (Unisat + Xverse via sats-connect), and
// Counterparty (XCP Wallet).
//
// Usage (ES module):
//   import { createEmblemWallet } from './emblem-wallet-connector.js';
//   const wallet = createEmblemWallet({ onWalletChange:(chain,addr)=>{...} });
//   const addr = await wallet.connectEvm('metamask');
//   await wallet.ensureChain(wallet.CHAIN_HEX.Base);
//   const client = wallet.emblemClient();          // feeds emblem-vault-sdk mint/claim
//
// A ready singleton is also exposed as window.EmblemWallet.
// Version is exported as EMBLEM_WALLET_CONNECTOR_VERSION; bump on every change.
// ─────────────────────────────────────────────────────────────────────────────
// VENDORED (vaultrobbers-mint): ethers comes from the locally-served UMD global (window.ethers, loaded before this
// module in index.html) instead of a third-party esm.sh/jsdelivr import, so the CSP needs no external script origin
// for the always-on EVM path.
const { BrowserProvider, isAddress, getAddress } = (typeof window !== 'undefined' && window.ethers) ? window.ethers : {};

// v1.10.0 (2026-08-21): unified single source across EmblemWrapped (vault-mint) and the
//   standalone module. Adds Relay funding — relayToUsdc / relayToNative / detectAssets (pay from any chain into mainnet
//   USDC or native gas) — and hardens connectEvm (30s timeout + "use Phantom (EVM)" guidance so a dead extension stub
//   can't hang the connect). Previously the three copies had drifted while all still labelled 1.9.2.
// v1.11.0 (2026-08-21): added connectStacks (Xverse via sats-connect, mainnet SP address) so EmblemWrapped can route
//   Stacks connect through the shared engine. Connect-only; Stacks signing stays app-side. Inert for apps that never call it.
// v1.11.1 (2026-08-21): app-neutral Horizon connect prompt ("Connect to Counterparty" instead of an app name).
// v1.12.0 (2026-08-21): added Tezos — connectTezos / ensureTezosWallet / tezosWallet / tezosForget. The connector owns the
//   single BeaconWallet (pairing is per-instance); the Taquito lib is shared via window.__tezos so the app's toolkit+signer
//   match. App still drives the FA2 wrap/sweep. Lazily imports ./vendor/tezos.mjs only when connectTezos is called.
// v1.13.0 (2026-08-21): added ensureGas(destChain, needWei, opts) — gas-minimum enforcement. Reads what the wallet already
//   holds on the destination chain and tops up only the shortfall (+headroom) via Relay, no-op when already covered. The
//   buy/mint/escrow funding primitive the wrapping companion builds on. Foundation for the two-layer split (Emblem
//   Connector = wallet + funding; Wrapping Companion = lifecycle + auto-send + deposit detection + media + unwrap).
export const EMBLEM_WALLET_CONNECTOR_VERSION = '1.18.1-rvmint';   // 1.18.1-rvmint: supply-chain hardening — ethers via local UMD window.ethers, Solana web3/spl via ./vendor, sats-connect + mpl-token-metadata neutralized (hub mint is EVM+Solana only); zero esm.sh/jsdelivr. 1.18.0: heal broken wallet RPC on ensureChain; 1.17.0: wrappingOwner() strict EVM-only vault-owner rule

// sats-connect is only needed for Xverse/Horizon (Bitcoin + Counterparty + Stacks + Tezos legs). The vaultrobbers-mint
// hub mints an EVM NFT on Robinhood and pays from EVM or Solana only — it never touches a BTC/CP/Stacks/Tezos wallet.
// So its esm.sh import is NEUTRALIZED to keep the CSP free of third-party script origins. To re-enable, vendor
// sats-connect locally the same way the Solana web3 bundle is (esbuild + node polyfills) and import it here.
let _scMod = null;
async function loadSatsConnect(){
  throw new Error('Bitcoin wallet support is not enabled in this build.');
}

export function createEmblemWallet(ctx){
  const { onWalletChange = ()=>{} } = ctx || {};

  // Connected wallet state. Full addresses are kept for holdings + sends; evmSigner is the
  // ethers v6 signer reused for message signing and transactions.
  let evmProvider=null, evmSigner=null, evmEip1193=null, evmAddress=null, evmWalletId=null,
      solAddress=null, solWalletId=null,
      btcAddress=null, btcOrdinalsPubkey=null, btcPaymentAddress=null, btcPaymentPubkey=null, btcWalletId=null,
      xcpAddrs=[], xcpProviderId=null;

  // ── EVM: EIP-6963 discovery ──────────────────────────────────────────────
  // With several wallets installed, window.ethereum and the spoofable isMetaMask flag are
  // unreliable (e.g. Temple sets isMetaMask=true). EIP-6963 has each wallet announce a unique
  // rdns, so we select the exact wallet unspoofably. Legacy injected pick is the fallback.
  const _eip6963 = new Map();   // rdns(lower) → provider
  try{ window.addEventListener('eip6963:announceProvider', e=>{ try{ const d=e&&e.detail; if(d&&d.info&&d.info.rdns&&d.provider) _eip6963.set(String(d.info.rdns).toLowerCase(), d.provider); }catch(_){} }); window.dispatchEvent(new Event('eip6963:requestProvider')); }catch(_){}
  const EVM_RDNS = { metamask:['io.metamask','io.metamask.flask','io.metamask.mmi'], rabby:['io.rabby'], phantom:['app.phantom'], coinbase:['com.coinbase.wallet'], okx:['com.okex.wallet'], trust:['com.trustwallet.app'], rainbow:['me.rainbow'], zerion:['io.zerion.wallet'], brave:['com.brave.wallet'], frame:['sh.frame'], bitget:['com.bitget.web3'], enkrypt:['com.enkrypt'], taho:['com.taho','com.tahowallet'], robinhood:['com.robinhood.wallet'] };
  function findEip6963(id){ try{ window.dispatchEvent(new Event('eip6963:requestProvider')); }catch(_){} const keys=EVM_RDNS[id]; if(!keys) return null; for(const k of keys){ const p=_eip6963.get(k); if(p) return p; } return null; }
  function findInjectedEvm(id){
    const p6963 = findEip6963(id); if(p6963) return p6963;
    const eth = window.ethereum;
    const list = (eth && eth.providers) || [];
    const pick = pred => list.find(pred) || (eth && pred(eth) ? eth : null);
    if(id==='robinhood') return pick(p=>p&&(p.isRobinhood||p.isRobinhoodWallet)) || window.robinhoodWallet || null;
    if(id==='metamask') return pick(p=>p&&p.isMetaMask&&!p.isRabby);
    if(id==='rabby')    return pick(p=>p&&p.isRabby) || window.rabby || null;
    if(id==='phantom')  return (window.phantom&&window.phantom.ethereum) || pick(p=>p&&p.isPhantom) || null;
    if(id==='coinbase') return pick(p=>p&&p.isCoinbaseWallet) || window.coinbaseWalletExtension || null;
    if(id==='okx')      return window.okxwallet || pick(p=>p&&p.isOkxWallet) || null;
    if(id==='trust')    return window.trustwallet || pick(p=>p&&p.isTrust) || null;
    if(id==='brave')    return pick(p=>p&&p.isBraveWallet) || null;
    if(id==='rainbow')  return pick(p=>p&&p.isRainbow) || null;
    if(id==='zerion')   return pick(p=>p&&p.isZerion) || null;
    if(id==='frame')    return pick(p=>p&&p.isFrame) || null;
    if(id==='bitget')   return (window.bitkeep&&window.bitkeep.ethereum) || pick(p=>p&&p.isBitKeep) || null;
    if(id==='enkrypt')  return (window.enkrypt&&window.enkrypt.providers&&window.enkrypt.providers.ethereum) || null;
    if(id==='taho')     return window.tally || pick(p=>p&&p.isTally) || null;
    return eth || null;
  }
  // Which of the known EVM wallets are actually present right now (for building a connect menu).
  function discoverEvm(){ return Object.keys(EVM_RDNS).filter(id=>{ try{ return !!findInjectedEvm(id); }catch(e){ return false; } }); }

  function wireEvmAccountEvents(eip){
    if(!eip || !eip.on || eip._embAcctWired) return;
    eip._embAcctWired = true;
    eip.on('accountsChanged', async (accts)=>{
      try{
        const raw = (accts && accts[0]) || null;
        // Some wallets emit a lowercase address; Emblem's index is case-sensitive, so ALWAYS store EIP-55 checksummed.
        let a = null; if(raw){ try{ a = getAddress(raw); }catch(e){ a = raw; } }
        if(a){ evmAddress = a; try{ evmProvider = new BrowserProvider(eip); evmSigner = await evmProvider.getSigner(a); }catch(e){} }
        else { evmAddress = null; evmSigner = null; }
        try{ onWalletChange('eth', a); }catch(_){}
      }catch(_){}
    });
  }
  async function connectEvm(id){
    const eip1193 = findInjectedEvm(id);
    if(!eip1193) throw new Error(`${id[0].toUpperCase()+id.slice(1)} is not installed. Use Phantom (EVM) instead, or install ${id}.`);
    // A broken/absent extension stub can leave eth_requestAccounts hanging forever with no popup — time it out and guide.
    await Promise.race([
      eip1193.request({ method:'eth_requestAccounts' }),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error(`${id[0].toUpperCase()+id.slice(1)} did not respond. Open the extension and unlock it, or use Phantom (EVM) instead.`)), 30000))
    ]);
    try{ await eip1193.request({ method:'wallet_switchEthereumChain', params:[{ chainId:'0x1' }] }); }
    catch(e){ throw new Error(`Switch ${id} to Ethereum mainnet`); }
    evmEip1193 = eip1193;
    evmProvider = new BrowserProvider(eip1193);
    evmSigner = await evmProvider.getSigner();
    const a = await evmSigner.getAddress();
    if(!isAddress(a)) throw new Error('Invalid EVM address');
    evmAddress = a; evmWalletId = id;
    wireEvmAccountEvents(eip1193);
    try{ onWalletChange('eth', a); }catch(_){}
    return a;
  }
  // Re-attach an already-authorized injected wallet WITHOUT a popup (eth_accounts returns granted account, [] if not).
  async function attachEvmSilently(id){
    if(!id) return null;
    const eip = findInjectedEvm(id);
    if(!eip || !eip.request) return null;
    const accs = await eip.request({ method:'eth_accounts' });
    if(!accs || !accs.length) return null;
    evmEip1193 = eip;
    evmProvider = new BrowserProvider(eip);
    evmSigner = await evmProvider.getSigner(accs[0]);
    const a = await evmSigner.getAddress();
    if(!isAddress(a)) return null;
    evmAddress = a; evmWalletId = id;
    wireEvmAccountEvents(eip);
    try{ onWalletChange('eth', a); }catch(_){}
    return a;
  }
  async function ensureEvm(){
    if(!evmAddress){ if(evmWalletId){ try{ await attachEvmSilently(evmWalletId); }catch(e){} } return evmAddress; }
    try{
      if(evmEip1193){
        const accs = await evmEip1193.request({ method:'eth_accounts' });
        const cur = accs && accs[0];
        if(cur && cur.toLowerCase() !== evmAddress.toLowerCase()){
          evmProvider = new BrowserProvider(evmEip1193);
          evmSigner = await evmProvider.getSigner(cur);
          evmAddress = await evmSigner.getAddress();
        }
      }
    }catch(e){}
    return evmAddress;
  }

  // ── The wrapping wallet ──
  // STRICT RULE: an Emblem vault is ALWAYS created under the connected EVM wallet. The other chains (Solana, Bitcoin,
  // Ordinals, Counterparty, Tezos, Stacks) are ONLY sending wallets — where the asset is transferred FROM — and must
  // NEVER own a vault. Owning a vault with a sending wallet's address strands it: it gets filed under an address the
  // user does not recognize and no lookup queries (this is how two funded Collector Crypt vaults went invisible when a
  // Solana wrap grabbed Phantom's injected EVM address as the owner). Every wrap/create path should resolve the owner
  // through THIS helper so the rule is enforced in one place. Returns the checksummed EVM address, or throws.
  async function wrappingOwner(){
    await ensureEvm();
    if(!evmAddress || !isAddress(evmAddress)) throw new Error('Connect an Ethereum (EVM) wallet to wrap. Your Solana/Bitcoin wallet is only the sending wallet; the vault is always created under your EVM wallet.');
    try{ return getAddress(evmAddress); }catch(e){ return evmAddress; }
  }

  // ── EVM chain switching (source chain for a send, ETH mainnet for the mint) ──
  const CHAIN_HEX = { Ethereum:'0x1', Base:'0x2105', Polygon:'0x89', Shape:'0x168', Robinhood:'0x1237' };
  const CHAIN_ADD_PARAMS = {
    '0x168':  { chainId:'0x168',  chainName:'Shape',          nativeCurrency:{ name:'Ether', symbol:'ETH', decimals:18 }, rpcUrls:['https://mainnet.shape.network'],           blockExplorerUrls:['https://shapescan.xyz'] },
    '0x1237': { chainId:'0x1237', chainName:'Robinhood Chain', nativeCurrency:{ name:'Ether', symbol:'ETH', decimals:18 }, rpcUrls:['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls:['https://robin.etherscan.io'] },
    '0x2105': { chainId:'0x2105', chainName:'Base',           nativeCurrency:{ name:'Ether', symbol:'ETH', decimals:18 }, rpcUrls:['https://mainnet.base.org'],                blockExplorerUrls:['https://basescan.org'] },
    // Polygon: keyless public RPCs. polygon-rpc.com now round-robins to key-gated backends (Ankr) that 401 on
    // eth_getBlockByNumber, which breaks sends INSIDE the wallet. publicnode + drpc are keyless and reliable.
    '0x89':   { chainId:'0x89',   chainName:'Polygon',        nativeCurrency:{ name:'POL',   symbol:'POL', decimals:18 }, rpcUrls:['https://polygon-bor-rpc.publicnode.com','https://polygon.drpc.org'], blockExplorerUrls:['https://polygonscan.com'] },
  };
  // A wallet-configured RPC that now needs an API key (stale keyless Ankr, etc.) fails DEEP inside the wallet on
  // eth_getBlockByNumber / eth_sendTransaction — our page fetch proxy can't intercept it. Probe the active chain with a
  // cheap read; if it errors auth/key-gated, (re)assert our reliable endpoint via wallet_addEthereumChain so the wallet
  // has a working RPC to select. Silent when the RPC is healthy (no extra prompt); only prompts when it's actually broken.
  async function healChainRpc(hex){
    if(!CHAIN_ADD_PARAMS[hex]) return;
    try{ await evmEip1193.request({ method:'eth_getBlockByNumber', params:['latest', false] }); return; }
    catch(perr){
      const msg = String((perr && (perr.message || (perr.data && (perr.data.message || (perr.data.originalError && perr.data.originalError.message))))) || '');
      if(!/unauthor|api key|apikey|forbidden|\b401\b|ankr\.com|must authenticate|access key/i.test(msg)) return;   // unrelated error, leave it
      try{ await evmEip1193.request({ method:'wallet_addEthereumChain', params:[ CHAIN_ADD_PARAMS[hex] ] }); }catch(e2){}
    }
  }
  async function ensureChain(hex){
    if(!evmEip1193) throw new Error('Connect an EVM wallet');
    const cur = await evmEip1193.request({ method:'eth_chainId' });
    if(cur !== hex){
      try{ await evmEip1193.request({ method:'wallet_switchEthereumChain', params:[{ chainId:hex }] }); }
      catch(err){
        const code = (err && (err.code ?? (err.data && err.data.originalError && err.data.originalError.code)));
        if((code===4902 || /unrecogni[sz]ed|add[^.]*chain|not been added/i.test(String((err&&err.message)||''))) && CHAIN_ADD_PARAMS[hex]){
          await evmEip1193.request({ method:'wallet_addEthereumChain', params:[ CHAIN_ADD_PARAMS[hex] ] });
          await evmEip1193.request({ method:'wallet_switchEthereumChain', params:[{ chainId:hex }] });
        } else throw err;
      }
    }
    await healChainRpc(hex);   // fix a broken wallet RPC before any read/send on this chain
    evmProvider = new BrowserProvider(evmEip1193);
    evmSigner = await evmProvider.getSigner();
  }

  // SDK client adapter: an ethers v6 Signer satisfies emblem-vault-sdk's EvmSigner; add the setChainId()
  // the SDK expects, and coerce ethers-v5 BigNumber-like tx fields to native bigint (the claim/unwrap path).
  function emblemClient(){
    return { async toEthersWallet(){
      if(!evmSigner) throw new Error('Connect an EVM wallet first');
      evmSigner.setChainId = async ()=>{};
      if(!evmSigner._embBnWrapped){
        const orig = evmSigner.sendTransaction.bind(evmSigner);
        evmSigner.sendTransaction = (tx)=>{
          if(tx && typeof tx==='object'){
            for(const k of ['value','gasLimit','gasPrice','maxFeePerGas','maxPriorityFeePerGas','nonce']){
              const v=tx[k];
              if(v!=null && typeof v==='object' && typeof v.toString==='function'){ try{ tx[k]=BigInt(v.toString()); }catch(e){} }
            }
          }
          return orig(tx);
        };
        evmSigner._embBnWrapped = true;
      }
      return evmSigner;
    } };
  }

  // ── Solana (injected) ────────────────────────────────────────────────────
  const SOL = {
    phantom: ()=> (window.phantom&&window.phantom.solana) || (window.solana&&window.solana.isPhantom?window.solana:null),
    solflare:()=> window.solflare || null,
    backpack:()=> window.backpack || (window.xnft&&window.xnft.solana) || null,
    okx:     ()=> (window.okxwallet&&window.okxwallet.solana) || null,
  };
  function discoverSolana(){ return Object.keys(SOL).filter(id=>{ try{ return !!SOL[id](); }catch(e){ return false; } }); }
  function solProvider(){ return (solWalletId && SOL[solWalletId] && SOL[solWalletId]()) || SOL.phantom() || window.solflare || window.backpack || window.solana || null; }
  async function connectSolana(id){
    const prov = (SOL[id]||(()=>null))();
    if(!prov) throw new Error(`${id} (Solana) not found. Is it installed?`);
    const res = await prov.connect();
    const pk = (res&&res.publicKey) || prov.publicKey;
    if(!pk) throw new Error('Solana wallet did not return an address (is it unlocked?)');
    const s = pk.toString();
    solAddress = s; solWalletId = id;
    _extSolProv = null; _extSolAddr = null;   // a fresh in-connector connect always wins over any external context override
    try{ onWalletChange('sol', s); }catch(_){}
    return s;
  }
  // Reattach a previously-authorized Solana wallet WITHOUT a popup (Phantom/Solflare/Backpack onlyIfTrusted). null if not trusted.
  async function attachSolanaSilently(id){
    try{ const prov=(SOL[id]||(()=>null))(); if(!prov||!prov.connect) return null;
      const res=await prov.connect({ onlyIfTrusted:true }); const pk=(res&&res.publicKey)||prov.publicKey; if(!pk) return null;
      const s=pk.toString(); solAddress=s; solWalletId=id; _extSolProv=null; _extSolAddr=null; try{ onWalletChange('sol', s); }catch(_){} return s;
    }catch(e){ return null; }
  }

  // ── Bitcoin Ordinals: Unisat + Xverse (sats-connect) ─────────────────────
  async function connectBtc(id){
    btcWalletId = id;
    if(id==='unisat') return connectUnisat();
    return connectXverse();
  }
  async function connectUnisat(){
    if(!window.unisat || !window.unisat.requestAccounts) throw new Error('Unisat not detected. Is it installed?');
    const accts = await window.unisat.requestAccounts();
    const addr = accts && accts[0];
    if(!addr) throw new Error('Unisat connection was denied or cancelled');
    if(!/^bc1p/i.test(addr)) throw new Error('Switch Unisat to a Taproot (bc1p) address for ordinals, then reconnect');
    let pub=''; try{ pub = await window.unisat.getPublicKey(); }catch(e){}
    btcAddress = addr; btcOrdinalsPubkey = pub; btcPaymentAddress = addr; btcPaymentPubkey = pub;
    try{ onWalletChange('btc', addr); }catch(_){}
    return addr;
  }
  async function ensureBtc(){
    if(btcAddress) return btcAddress;
    if(btcWalletId){ try{ return await connectBtc(btcWalletId); }catch(e){} }
    return btcAddress;
  }
  // Reattach a previously-authorized Bitcoin wallet WITHOUT a popup. Unisat's getAccounts is prompt-free when already
  // authorized; Xverse (sats-connect) has no clean silent path, so it returns null and the user reconnects it once.
  async function attachBtcSilently(id){
    try{
      if(id==='unisat'){ if(!window.unisat || !window.unisat.getAccounts) return null;
        const accts=await window.unisat.getAccounts(); const addr=accts && accts[0];
        if(!addr || !/^bc1p/i.test(addr)) return null;
        let pub=''; try{ pub=await window.unisat.getPublicKey(); }catch(e){}
        btcWalletId='unisat'; btcAddress=addr; btcOrdinalsPubkey=pub; btcPaymentAddress=addr; btcPaymentPubkey=pub;
        try{ onWalletChange('btc', addr); }catch(_){} return addr; }
      return null;
    }catch(e){ return null; }
  }
  async function connectXverse(){
    const sc = await loadSatsConnect();
    const request = sc.request || (sc.default && sc.default.request);
    const AP = sc.AddressPurpose || { Ordinals:'ordinals', Payment:'payment' };
    if(!request) throw new Error('sats-connect request() not available');
    const isTap = a => /^bc1p/i.test((a&&a.address)||'');
    const pick = (res)=>{
      if(!res || res.status!=='success') return null;
      const addrs = (res.result && res.result.addresses) || [];
      const ord = addrs.find(a=>/ordinal/i.test(a.purpose) && isTap(a))
               || addrs.find(a=>isTap(a))
               || addrs.find(a=>/p2tr|taproot/i.test(a.addressType||''));
      const pay = addrs.find(a=>/payment/i.test(a.purpose)) || addrs.find(a=>/^(bc1q|3)/i.test(a.address||''));
      return ord ? { ord:ord.address, ordPub:ord.publicKey||'', pay:(pay&&pay.address)||null, payPub:(pay&&pay.publicKey)||'' } : null;
    };
    let hit=null, lastErr='';
    try{ const r=await request('wallet_connect', { addresses:[AP.Ordinals, AP.Payment], message:'Connect to Emblem' }); hit=pick(r); lastErr=r&&r.error&&r.error.message; }catch(e){ lastErr=e&&e.message; }
    if(!hit){ try{ const r=await request('wallet_connect', null); hit=pick(r); lastErr=(r&&r.error&&r.error.message)||lastErr; }catch(e){} }
    if(!hit){ try{ const r=await request('getAddresses', { purposes:[AP.Ordinals, AP.Payment], message:'Connect to Emblem' }); hit=pick(r); lastErr=(r&&r.error&&r.error.message)||lastErr; }catch(e){} }
    if(!hit) throw new Error(lastErr || 'Xverse connection was denied or cancelled');
    btcWalletId = 'xverse';   // route signing/sends to Xverse (sats-connect), not the Unisat fallback
    btcAddress = hit.ord; btcOrdinalsPubkey = hit.ordPub; btcPaymentAddress = hit.pay; btcPaymentPubkey = hit.payPub;
    try{ onWalletChange('btc', hit.ord); }catch(_){}
    return hit.ord;
  }

  // ── Counterparty: XCP Wallet (EIP-1193 style, window.xcpwallet) ──────────
  function xcpProvider(){ try{ return (window.xcpwallet && typeof window.xcpwallet.request==='function') ? window.xcpwallet : null; }catch(e){ return null; } }
  function xcpAvailable(){ return !!xcpProvider(); }
  // Returns [{address, purpose, type}] with the legacy (1.../3...) address first — Counterparty assets live there.
  async function connectXcp(silent){
    const P = xcpProvider();
    if(!P || typeof P.request!=='function'){ if(silent) return []; throw new Error('XCP Wallet not detected. Install the XCP Wallet extension (desktop) and reload.'); }
    const _emb = (()=>{ try{ return window.top!==window.self; }catch(_){ return true; } })();
    const _isCancel = e=> (e&&e.code)===4001 || /reject|denied|cancel|\buser\b|4001/i.test((e&&(e.message||e.reason))||String(e));
    const _req = (args,ms)=> Promise.race([ P.request(args), new Promise((_,rej)=>setTimeout(()=>{ const t=new Error('timed out'); t.__to=true; rej(t); }, ms||45000)) ]);
    const RX=/(bc1[a-z0-9]{20,}|[13][a-km-zA-HJ-NP-Z1-9]{20,})/;
    const seen=new Set(); const addrs=[];
    const push=s=>{ const m=String(s||'').match(RX); if(!m) return; const a=m[0]; if(!seen.has(a)){ seen.add(a); addrs.push({ address:a, purpose:/^bc1/i.test(a)?'ordinals':'payment', type:/^bc1/i.test(a)?'segwit':'legacy' }); } };
    const asAddr=o=> (o && (o.address||o.addr||o.value||o.p2pkh||o.legacy))||'';
    const collect=v=>{ if(v==null) return;
      if(typeof v==='string'){ push(v); return; }
      if(Array.isArray(v)){ v.forEach(collect); return; }
      if(typeof v==='object'){ const d=asAddr(v); if(d) push(d); for(const k of Object.keys(v)){ const val=v[k]; if(typeof val==='string') push(val); else if(val && typeof val==='object') collect(val); } }
    };
    const haveLegacy=()=> addrs.some(a=>/^[13]/.test(a.address));
    let ac=null; try{ ac = await _req({ method:'xcp_accounts' }, 15000); }catch(e){} collect((ac&&ac.result)||ac);
    let g=null;
    if(!haveLegacy()){ try{ g = await _req({ method:'xcp_getAddresses' }, 15000); }catch(e){} collect((g&&g.result)||g); }
    let ra=null;
    if(!addrs.length && silent) return [];
    if(!addrs.length){
      try{ ra = await _req({ method:'xcp_requestAccounts', params:[{ capabilities:{ pairedAddresses:true } }] }, 120000); }
      catch(e){
        if(_isCancel(e)) throw new Error('__CP_CANCELLED__');
        try{ ra = await _req({ method:'xcp_requestAccounts' }, 120000); }
        catch(e2){
          if(_isCancel(e2)) throw new Error('__CP_CANCELLED__');
          const em2=(e2&&(e2.message||e2.reason))||String(e2);
          if((e2&&e2.__to) || _emb || /storage is not allowed|not allowed from this context/i.test(em2))
            throw new Error('XCP Wallet approved but the connection never came back. Open the site in its own browser tab, unlock the extension, and reconnect.');
          throw new Error('XCP Wallet could not complete the request ('+em2+'). Make sure the extension is unlocked and a Legacy (1…) account is enabled, then reconnect.');
        }
      }
      collect((ra&&ra.result)||ra);
      if(!haveLegacy()){ try{ g = await _req({ method:'xcp_getAddresses' }, 15000); }catch(e){} collect((g&&g.result)||g); }
      // xcp_requestAccounts can resolve before the user finishes unlocking; poll ~60s so the grant lands with one click.
      for(let i=0;i<24 && !addrs.length;i++){
        await new Promise(r=>setTimeout(r,2500));
        try{ const a2=await _req({ method:'xcp_accounts' }, 8000); collect((a2&&a2.result)||a2); }catch(e){}
        if(!haveLegacy()){ try{ const g2=await _req({ method:'xcp_getAddresses' }, 8000); collect((g2&&g2.result)||g2); }catch(e){} }
      }
    }
    if(!addrs.length) throw new Error('XCP Wallet connected but no Bitcoin address could be read from its reply.');
    addrs.sort((a,b)=> (a.type==='legacy'?0:1) - (b.type==='legacy'?0:1));
    xcpAddrs = addrs; xcpProviderId = 'xcpwallet';
    try{ localStorage.setItem('emblem-wallet:xcpAddrs', JSON.stringify(addrs)); localStorage.setItem('emblem-wallet:xcpProviderId','xcpwallet'); }catch(e){}
    try{ onWalletChange('xcp', addrs[0] && addrs[0].address); }catch(_){}
    return addrs;
  }

  // ── Counterparty: Horizon Wallet (sats-connect provider, window.btc_providers / window.HorizonWalletProvider) ──
  // Horizon registers as "HorizonWalletProvider" in the sats-connect registry and speaks the sats-connect standard
  // (same contract as Xverse). We select it EXPLICITLY by id so we never sign through the wrong Bitcoin wallet.
  // Desktop-only browser extension. Populates the SHARED xcpAddrs (legacy-first) so the CP reader/wrap paths are wallet-agnostic.
  function horizonProvider(){ try{
    const g = window.HorizonWalletProvider; if(g && typeof g.request==='function') return g;
    const e = Array.isArray(window.btc_providers) && window.btc_providers.find(p=>p&&p.id==='HorizonWalletProvider');
    if(e){ if(typeof e.request==='function') return e; if(e.provider && typeof e.provider.request==='function') return e.provider; }
    return (g && typeof g.request==='function') ? g : null;
  }catch(e){ return null; } }
  async function cpSignMessage(address, message){
    const P = (xcpProviderId==='horizon') ? horizonProvider() : (xcpProvider() || horizonProvider());
    if(!P) throw new Error('No Counterparty wallet connected.');
    const pull = r=>{ const v=(r&&(r.result||r.signature||r.sig))||r; if(v==null) return null; if(typeof v==='string') return v; return v.signature||v.sig||v.result||null; };
    // sats-connect style (Horizon): request('signMessage', { address, message, protocol:'BIP322' })
    if(xcpProviderId==='horizon'){
      try{ const r = await P.request('signMessage', { address, message, protocol:'BIP322' }); const s = pull(r); if(s) return s; }catch(e){ if(/reject|denied|cancel|\buser\b|4001/i.test(String((e&&(e.message||e.reason))||e))) throw new Error('__CP_CANCELLED__'); }
    }
    // EIP-1193 style (XCP Wallet): request({ method, params }). Try the CP-native name first, then generic fallbacks.
    if(typeof P.request==='function'){
      for(const attempt of [ { method:'xcp_signMessage', params:[{ address, message }] }, { method:'signMessage', params:[{ address, message }] }, { method:'personal_sign', params:[message, address] } ]){
        try{ const r = await P.request(attempt); const s = pull(r); if(s) return s; }
        catch(e){ const em=String((e&&(e.message||e.reason))||e); if(/reject|denied|cancel|\buser\b|4001/i.test(em)) throw new Error('__CP_CANCELLED__'); /* method missing → try next */ }
      }
    }
    throw new Error('__CP_NO_MSGSIGN__');
  }
  async function connectCp(silent){
    if(horizonAvailable()){ try{ return await connectHorizon(); }catch(e){ if(String((e&&e.message)||e)==='__CP_CANCELLED__') throw e; } }
    return connectXcp(silent);
  }
  function horizonAvailable(){ try{ return !!(horizonProvider() || (Array.isArray(window.btc_providers) && window.btc_providers.find(p=>p&&p.id==='HorizonWalletProvider'))); }catch(e){ return false; } }
  async function connectHorizon(){
    const P = horizonProvider();
    if(!P || typeof P.request!=='function') throw new Error('Horizon Wallet not detected. Install the Horizon extension (desktop) and reload.');
    const _isCancel = e=> (e&&e.code)===4001 || /reject|denied|cancel|\buser\b|4001/i.test((e&&(e.message||e.reason))||String(e));
    let res=null, err1='';
    try{ res = await P.request('getAddresses', { purposes:['payment','ordinals'], message:'Connect to Counterparty' }); }
    catch(e){ if(_isCancel(e)) throw new Error('__CP_CANCELLED__'); err1=(e&&(e.message||e.reason))||String(e);
      try{ res = await P.request('wallet_connect', { addresses:['payment','ordinals'] }); }
      catch(e2){ if(_isCancel(e2)) throw new Error('__CP_CANCELLED__'); throw new Error('Horizon connect failed: '+err1+' / '+((e2&&(e2.message||e2.reason))||e2)); } }
    const r = (res&&res.result) || res || {};
    const raw = r.addresses || (r.result&&r.result.addresses) || [];
    let addrs = raw.map(a=>({ address:a.address||a.addr, purpose:a.purpose||a.type||'', type:(/^[13]/.test(a.address||a.addr||'')?'legacy':(a.addressType||a.type||'')) })).filter(a=>a.address);
    if(!addrs.length) throw new Error('Horizon returned no addresses. Re-open the connect prompt and choose “All Addresses in Account”.');
    addrs.sort((a,b)=> (/^[13]/.test(a.address)?0:1) - (/^[13]/.test(b.address)?0:1));   // legacy (Counterparty-capable) first
    xcpAddrs = addrs; xcpProviderId = 'horizon';
    try{ localStorage.setItem('emblem-wallet:xcpAddrs', JSON.stringify(addrs)); localStorage.setItem('emblem-wallet:xcpProviderId','horizon'); }catch(e){}
    try{ onWalletChange('xcp', addrs[0] && addrs[0].address); }catch(_){}
    return addrs;
  }
  // Sign a PSBT with Horizon (sats-connect). Accepts hex OR base64; Horizon wants base64. signInputs is { addr:[indices] }.
  // Horizon SIGNS ONLY (broadcast:false) and reports failures as a resolved value with an .error field, so we check it.
  // Returns the signed PSBT (base64) for our server to finalize+broadcast, unless Horizon already returned a txid.
  async function horizonSignPsbt(psbtHexOrB64, signInputs, opts){
    const P = horizonProvider(); if(!P) throw new Error('Horizon Wallet not detected.');
    const looksHex = /^[0-9a-fA-F]+$/.test(String(psbtHexOrB64||'')) && (String(psbtHexOrB64).length % 2 === 0);
    const b64 = looksHex ? hexToB64(psbtHexOrB64) : psbtHexOrB64;   // same bytes, re-encoded — no bitcoinjs needed
    let s;
    try{ s = await P.request('signPsbt', Object.assign({ psbt:b64, signInputs, broadcast:false }, opts||{})); }
    catch(e){ const em=(e&&(e.message||e.reason))||String(e); if(/reject|denied|cancel|\buser\b|4001|ACTION_REJECTED/i.test(em)) throw new Error('__CP_CANCELLED__'); throw e; }
    if(s && s.error){ const em=String((s.error&&s.error.message)||JSON.stringify(s.error)); if(/reject|denied|cancel|\buser\b|4001/i.test(em)) throw new Error('__CP_CANCELLED__'); throw new Error('Horizon could not sign the send: '+em); }
    const sr = (s&&s.result)||s||{};
    const txid = sr.txid||sr.txId||sr.txHash||sr.transactionId||sr.tx_hash||sr.tx||sr.id||null;
    const signed = sr.psbt||sr.signedPsbt||sr.signedPsbtBase64||sr.psbtBase64||sr.signedPsbtHex||sr.hex||(typeof sr==='string'?sr:null);
    return { txid, signed };
  }
  function hexToB64(hex){ const s=String(hex); let bin=''; for(let i=0;i<s.length;i+=2){ bin+=String.fromCharCode(parseInt(s.substr(i,2),16)); } return btoa(bin); }
  // Route a CP sign to whichever Counterparty wallet is connected: XCP Wallet (hex) or Horizon (base64 sats-connect).
  async function cpSignPsbt(psbtHex, signInputs, opts){
    if(xcpProviderId==='horizon') return horizonSignPsbt(psbtHex, signInputs, opts);
    const raw = await xcpSignPsbtHex(psbtHex, signInputs, opts);   // XCP Wallet: returns a hex string (or a wrapper object)
    const signed = (raw && (raw.hex||raw.signedPsbtHex||raw.psbt||raw.signedPsbt||raw.psbtBase64))||(typeof raw==='string'?raw:null);
    return { txid:(raw&&(raw.txid||raw.txId))||null, signed };
  }
  // Sign a PSBT with XCP Wallet. `signInputs` is an object keyed by owning address: { addr:[indices] }.
  async function xcpSignPsbtHex(psbtHex, signInputs, opts){
    const P = xcpProvider(); if(!P) throw new Error('XCP Wallet not detected.');
    const params = Object.assign({ hex:psbtHex, signInputs }, opts||{});   // XCP Wallet expects { hex, signInputs } (per XCP/extension PROVIDER.md)
    const r = await P.request({ method:'xcp_signPsbt', params:[params] });
    return (r && (r.result || r.psbt || r)) || r;
  }

  // Send an ordinal/inscription to `toAddress` via the connected BTC wallet's high-level API (no PSBT building).
  // Map raw Xverse/Unisat wallet errors to something a user can act on. The most common one is a LOCKED wallet
  // (Xverse throws "Vault not ready ... restoreVault()"); we turn that into a plain "unlock your wallet" message.
  function btcErrMsg(e){ const m=String((e&&(e.message||e.reason))||e||'');
    if(_btcLocked(m)) return 'Your Bitcoin wallet is locked. Open the extension, unlock it, then try again.';
    if(/reject|denied|cancel|4001|\buser\b/i.test(m)) return '__CP_CANCELLED__';
    return m || 'Bitcoin wallet request failed.'; }
  function _btcLocked(m){ return /vault not ready|restorevault|seed\s*vault|is locked|not unlocked|please unlock|not connected|no account|account not|unauthorized|no address/i.test(String(m||'')); }
  // Run a BTC wallet op; if it fails because the wallet is LOCKED or not connected, force the wallet open to unlock +
  // reconnect (connectBtc opens the extension, which prompts unlock), then retry ONCE. Never leaves it on the user.
  async function _btcWithUnlock(fn){
    try{ return await fn(); }
    catch(e){ const m=String((e&&(e.message||e.reason))||e||'');
      if(_btcLocked(m)){
        try{ await connectBtc(btcWalletId || (window.unisat && window.unisat.requestAccounts ? 'unisat' : 'xverse')); }
        catch(ce){ throw new Error(btcErrMsg(ce)); }
        try{ return await fn(); }catch(e2){ throw new Error(btcErrMsg(e2)); }
      }
      throw new Error(btcErrMsg(e));
    }
  }
  async function sendOrdinal(toAddress, inscriptionId, feeRate){
    const idStr = String(inscriptionId||''); if(!toAddress || !idStr) throw new Error('Missing destination or inscription id');
    return _btcWithUnlock(async()=>{
      if((btcWalletId==='unisat') || (!btcWalletId && window.unisat && window.unisat.sendInscription)){
        if(!window.unisat || !window.unisat.sendInscription) throw new Error('Unisat is not available for sending.');
        const r = await window.unisat.sendInscription(toAddress, idStr, feeRate?{ feeRate }:undefined);
        return (r && (r.txid || r)) || r;
      }
      const sc = await loadSatsConnect(); const request = sc.request || (sc.default && sc.default.request);
      if(!request) throw new Error('Xverse is not available for sending.');
      const r = await request('ord_sendInscriptions', { transfers:[{ address:toAddress, inscriptionId:idStr }] });
      if(!r || r.status!=='success') throw new Error((r && r.error && r.error.message) || 'Inscription send was cancelled.');
      return (r.result && (r.result.txid || r.result.txId)) || r.result;
    });
  }

  // ── Bitcoin: BIP-322 message signing + marketplace buy-PSBT signing (Xverse / Unisat) ─────────
  // Shared so Emblem front-ends both auth to ord.net and sign Ordinals buys the same way.
  function _b64ToHex(b64){ const bin=atob(b64); let h=''; for(let i=0;i<bin.length;i++){ h+=('0'+bin.charCodeAt(i).toString(16)).slice(-2); } return h; }
  function _hexToB64(hex){ let bin=''; const s=String(hex); for(let i=0;i<s.length;i+=2){ bin+=String.fromCharCode(parseInt(s.substr(i,2),16)); } return btoa(bin); }
  // BIP-322 simple message signature, returned as HEX (ord.net expects hex). Xverse/Unisat return base64 → convert.
  async function btcSignMessage(address, message){
    return _btcWithUnlock(async()=>{
      if((btcWalletId==='unisat') || (!btcWalletId && window.unisat && window.unisat.signMessage)){
        if(!window.unisat || !window.unisat.signMessage) throw new Error('Unisat is not available for signing.');
        const sig=await window.unisat.signMessage(message, 'bip322-simple');
        return /^[0-9a-fA-F]+$/.test(sig) ? sig : _b64ToHex(sig);
      }
      const sc=await loadSatsConnect(); const request=sc.request || (sc.default && sc.default.request);
      if(!request) throw new Error('Xverse is not available for signing.');
      const r=await request('signMessage', { address, message, protocol:'BIP322' });
      if(!r || r.status!=='success') throw new Error((r && r.error && r.error.message) || 'Message signing cancelled.');
      const sig=(r.result && (r.result.signature || r.result)) || r.result;
      return /^[0-9a-fA-F]+$/.test(sig) ? sig : _b64ToHex(sig);
    });
  }
  // Sign a marketplace buy PSBT (broadcast:false). signMap = { address: [inputIndexes] }. Returns SIGNED psbt as base64.
  async function signBtcPsbt(psbtBase64, signMap){
    return _btcWithUnlock(async()=>{
      if((btcWalletId==='unisat') || (!btcWalletId && window.unisat && window.unisat.signPsbt)){
        if(!window.unisat || !window.unisat.signPsbt) throw new Error('Unisat is not available for signing.');
        const toSignInputs=[]; Object.keys(signMap||{}).forEach(addr=>{ (signMap[addr]||[]).forEach(index=>toSignInputs.push({ index, address:addr })); });
        const signedHex=await window.unisat.signPsbt(_b64ToHex(psbtBase64), { autoFinalized:false, toSignInputs });
        const looksHex=/^[0-9a-fA-F]+$/.test(signedHex) && signedHex.length % 2 === 0;   // even-length guard: never half-parse a byte
        return looksHex ? _hexToB64(signedHex) : signedHex;
      }
      const sc=await loadSatsConnect(); const request=sc.request || (sc.default && sc.default.request);
      if(!request) throw new Error('Xverse is not available for signing.');
      const r=await request('signPsbt', { psbt:psbtBase64, signInputs:signMap, broadcast:false });
      if(!r || r.status!=='success') throw new Error((r && r.error && r.error.message) || 'Purchase signing cancelled.');
      return (r.result && (r.result.psbt || r.result.signedPsbt)) || r.result;
    });
  }

  // ── Solana: buy-and-wrap primitives (ported from vault-mint, the original wallet home) ───────
  // Kept in the shared connector so Emblem front-ends drive the same sign/transfer code.
  let _solWeb3=null, _solSpl=null, _solMpl=null;
  // VENDORED (vaultrobbers-mint): Solana libs are bundled locally (public/vendor/, esbuild + node polyfills) so the CSP
  // needs no esm.sh. Paths are relative to this module's URL (/pub/.../vaultrobbers-mint/).
  async function loadSolWeb3(){ if(!_solWeb3) _solWeb3=await import('./vendor/solana-web3-1.98.4.esm.js'); return _solWeb3; }
  async function loadSolSpl(){ if(!_solSpl) _solSpl=await import('./vendor/solana-spl-0.4.15.esm.js'); return _solSpl; }
  // External Solana context: lets a host that manages its OWN wallet (e.g. EmblemWrapped's BK) drive these shared
  // buy-and-wrap functions with its provider+address, so both apps run ONE implementation. Falls back to connector state.
  let _extSolProv=null, _extSolAddr=null;
  function setSolanaContext(ctx){ _extSolProv=(ctx&&ctx.provider)||null; _extSolAddr=(ctx&&ctx.address)||null; }
  function clearSolanaContext(){ _extSolProv=null; _extSolAddr=null; }   // call on disconnect so a stale address can't sign/swap
  function solCtxProv(){ return _extSolProv || solProvider(); }
  function solCtxAddr(){ return _extSolAddr || solAddress; }
  const SOL_MPL_CORE='CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
  function solCoreCollectionFromData(PublicKey, raw){ try{ if(raw && raw.length>=66 && raw[0]===1 && raw[33]===2) return new PublicKey(raw.slice(34,66)); }catch(e){} return null; }
  // MPL Core TransferV1 (owner -> newOwner). WRAP: payer==authority==user (authority collapses to None). Layout: disc 14, data [14,0], 7 accounts.
  function solCoreTransferIx(web3, asset, collection, payer, authority, newOwner){
    const CORE=new web3.PublicKey(SOL_MPL_CORE); const sepAuth=!!(authority && payer && !authority.equals(payer));
    const keys=[ {pubkey:asset,isSigner:false,isWritable:true}, {pubkey:collection||CORE,isSigner:false,isWritable:false},
      {pubkey:payer,isSigner:true,isWritable:true}, {pubkey:sepAuth?authority:CORE,isSigner:sepAuth,isWritable:false},
      {pubkey:newOwner,isSigner:false,isWritable:false}, {pubkey:CORE,isSigner:false,isWritable:false}, {pubkey:CORE,isSigner:false,isWritable:false} ];
    return new web3.TransactionInstruction({ programId:CORE, keys, data:new Uint8Array([14,0]) });
  }
  function solErrText(err){ try{ if(err==null)return 'unknown error'; if(typeof err==='string')return err; const ie=err.InstructionError; if(Array.isArray(ie)){ const ix=ie[0],d=ie[1]; if(d&&typeof d==='object'&&d.Custom!=null){ const k={17:'the token account is frozen (custodied by its issuer)',1:'insufficient funds'}; return 'instruction '+ix+' failed (program error '+d.Custom+(k[d.Custom]?': '+k[d.Custom]:'')+')'; } return 'instruction '+ix+' failed'; } if(err.InsufficientFundsForRent!=null)return 'insufficient SOL for rent/fees'; return JSON.stringify(err).slice(0,120); }catch(e){ return 'unknown error'; } }

  // Sign + broadcast a marketplace-built serialized Solana transaction (base64). Serialization is undocumented per
  // marketplace, so deserialize defensively (Versioned first, legacy fallback). Returns the tx signature.
  async function signAndSendSol(txBase64, rpcUrl){
    const web3=await loadSolWeb3(); const prov=solCtxProv(); if(!prov) throw new Error('Solana wallet not connected.');
    try{ if(!prov.publicKey && prov.connect) await prov.connect(); }catch(e){}
    const rawTx=Uint8Array.from(atob(txBase64), c=>c.charCodeAt(0));
    let tx; try{ tx=web3.VersionedTransaction.deserialize(rawTx); }catch(e){ try{ tx=web3.Transaction.from(rawTx); }catch(e2){ throw new Error('Could not read the buy transaction from the marketplace.'); } }
    if(prov.signAndSendTransaction){ const res=await prov.signAndSendTransaction(tx); const sig=(res&&res.signature)||res; if(rpcUrl) await confirmSol(web3, rpcUrl, sig); return sig; }
    if(prov.signTransaction){ const signed=await prov.signTransaction(tx); const conn=new web3.Connection(rpcUrl,'confirmed'); const sig=await conn.sendRawTransaction(signed.serialize(),{maxRetries:3}); await confirmSol(web3, rpcUrl, sig); return sig; }
    throw new Error('Your Solana wallet cannot sign transactions.');
  }
  // Sign (no broadcast) a marketplace-built serialized Solana tx (base64) and return the SIGNED tx as base64, so a
  // marketplace's own broadcast endpoint (e.g. Collector Crypt /marketplace/broadcast) can submit + book the sale.
  async function signSolOnly(txBase64){
    const web3=await loadSolWeb3(); const prov=solCtxProv(); if(!prov) throw new Error('Solana wallet not connected.');
    try{ if(!prov.publicKey && prov.connect) await prov.connect(); }catch(e){}
    if(!prov.signTransaction) throw new Error('Your Solana wallet cannot sign this purchase. Use Phantom.');
    const rawTx=Uint8Array.from(atob(txBase64), c=>c.charCodeAt(0));
    let tx; try{ tx=web3.VersionedTransaction.deserialize(rawTx); }catch(e){ try{ tx=web3.Transaction.from(rawTx); }catch(e2){ throw new Error('Could not read the buy transaction from the marketplace.'); } }
    const signed=await prov.signTransaction(tx);
    const bytes=signed.serialize(); return btoa(String.fromCharCode.apply(null, bytes));
  }
  async function confirmSol(web3, rpcUrl, sig){ const conn=new web3.Connection(rpcUrl,'confirmed');
    for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,1500)); let st=null; try{ st=(await conn.getSignatureStatuses([sig])).value[0]; }catch(e){} if(!st)continue; if(st.err) throw new Error('Transaction failed on-chain: '+solErrText(st.err)); if(st.confirmationStatus==='confirmed'||st.confirmationStatus==='finalized') return sig; } return sig; }

  // Transfer a Solana asset (MPL Core / pNFT / plain SPL) FROM the connected wallet TO a deposit address. Ported from
  // vault-mint sendSol. Returns the tx signature once confirmed. `mintStr` = the asset mint, `depAddr` = vault deposit.
  async function sendSolanaAsset(mintStr, depAddr, rpcUrl, onStage){
    const S=(m)=>{ try{ onStage&&onStage(m); }catch(e){} };
    if(!mintStr) throw new Error('No mint address for this asset.');
    const prov=solCtxProv(); if(!prov) throw new Error('Solana wallet not connected.');
    try{ if(!prov.publicKey && prov.connect) await prov.connect(); }catch(e){}
    const web3=await loadSolWeb3(); const spl=await loadSolSpl();
    const { Connection, PublicKey, Transaction } = web3;
    const conn=new Connection(rpcUrl,'confirmed');
    let owner,to,mint; try{ owner=new PublicKey(solCtxAddr()); to=new PublicKey(depAddr); mint=new PublicKey(mintStr); }
    catch(e){ throw new Error('Invalid Solana address in the transfer (owner/deposit/mint).'); }
    let TOKEN_PROGRAM=spl.TOKEN_PROGRAM_ID, isCore=false, coreColl=null;
    try{ const mi=await conn.getAccountInfo(mint);
      if(mi&&mi.owner&&mi.owner.toBase58()===SOL_MPL_CORE){ isCore=true; coreColl=solCoreCollectionFromData(PublicKey, mi.data); }
      else if(mi&&mi.owner&&spl.TOKEN_2022_PROGRAM_ID&&mi.owner.equals(spl.TOKEN_2022_PROGRAM_ID)) TOKEN_PROGRAM=spl.TOKEN_2022_PROGRAM_ID;
    }catch(e){}
    const fromAta=await spl.getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM);
    const toAta=await spl.getAssociatedTokenAddress(mint, to, true, TOKEN_PROGRAM);
    const MPL_ID=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'); const enc=s=>new TextEncoder().encode(s);
    let isFrozen=false, detected=false;
    for(let a=0;a<4 && !detected && !isCore;a++){ try{ const acc=await spl.getAccount(conn, fromAta, 'confirmed', TOKEN_PROGRAM); isFrozen=!!acc.isFrozen; detected=true; }catch(e){ if(a<3) await new Promise(r=>setTimeout(r,300*(a+1))); } }
    if(!detected && !isCore){ try{ const trPda=PublicKey.findProgramAddressSync([enc('metadata'),MPL_ID.toBuffer(),mint.toBuffer(),enc('token_record'),fromAta.toBuffer()],MPL_ID)[0]; isFrozen=!!(await conn.getAccountInfo(trPda)); }catch(e){} }
    const tx=new Transaction();
    if(isCore){ tx.add(web3.ComputeBudgetProgram.setComputeUnitLimit({units:300000})); tx.add(solCoreTransferIx(web3, mint, coreColl, owner, owner, to)); }
    else if(isFrozen){ const mpl=_solMpl||(_solMpl=await (async()=>{ throw new Error('Frozen (pNFT) Solana transfers are not enabled in this build.'); })());
      const pda=seeds=>PublicKey.findProgramAddressSync(seeds,MPL_ID)[0];
      const metadata=pda([enc('metadata'),MPL_ID.toBuffer(),mint.toBuffer()]); const edition=pda([enc('metadata'),MPL_ID.toBuffer(),mint.toBuffer(),enc('edition')]);
      const tokenRecord=ata=>pda([enc('metadata'),MPL_ID.toBuffer(),mint.toBuffer(),enc('token_record'),ata.toBuffer()]);
      tx.add(web3.ComputeBudgetProgram.setComputeUnitLimit({units:400000}));
      tx.add(mpl.createTransferInstruction({ token:fromAta, tokenOwner:owner, destination:toAta, destinationOwner:to, mint, metadata, edition,
        ownerTokenRecord:tokenRecord(fromAta), destinationTokenRecord:tokenRecord(toAta), authority:owner, payer:owner,
        systemProgram:web3.SystemProgram.programId, sysvarInstructions:web3.SYSVAR_INSTRUCTIONS_PUBKEY, splTokenProgram:TOKEN_PROGRAM, splAtaProgram:spl.ASSOCIATED_TOKEN_PROGRAM_ID },
        { transferArgs:{ __kind:'V1', amount:1, authorizationData:null } })); }
    else { if(!(await conn.getAccountInfo(toAta))) tx.add(spl.createAssociatedTokenAccountInstruction(owner, toAta, to, mint, TOKEN_PROGRAM)); tx.add(spl.createTransferInstruction(fromAta, toAta, owner, 1, [], TOKEN_PROGRAM)); }
    tx.feePayer=owner; tx.recentBlockhash=(await conn.getLatestBlockhash()).blockhash;
    S('Approve the transfer in your wallet…');
    let sig;
    if(prov.signAndSendTransaction){ const res=await Promise.race([prov.signAndSendTransaction(tx), new Promise((_,rej)=>setTimeout(()=>rej(new Error('Your Solana wallet did not respond (no approval within 90s).')),90000))]); sig=(res&&res.signature)||res; }
    else if(prov.signTransaction){ const signed=await prov.signTransaction(tx); sig=await conn.sendRawTransaction(signed.serialize(),{maxRetries:3}); }
    else throw new Error('Your Solana wallet cannot sign transactions.');
    S('Sent. Confirming on-chain…');
    for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,1500)); let st=null; try{ st=(await conn.getSignatureStatuses([sig])).value[0]; }catch(e){} if(!st)continue;
      if(st.err){ const es=JSON.stringify(st.err); if(/frozen/i.test(es)||/"Custom":17\b/.test(es)) throw new Error('This asset is frozen by its issuer, so a standard wallet transfer cannot move it.'); throw new Error('The Solana transfer failed on-chain: '+solErrText(st.err)); }
      if(st.confirmationStatus==='confirmed'||st.confirmationStatus==='finalized') return sig; }
    return sig;
  }

  // ── Relay: same-chain SOL -> USDC swap so USDC-priced buys (Collector Crypt) work from a SOL balance ──────────
  const SOL_USDC_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';   // Solana USDC (6 decimals)
  const RELAY_SOL_CHAIN=792703809;                                      // Relay's Solana mainnet chain id
  const RELAY_SOL_NATIVE='11111111111111111111111111111111';           // SOL placeholder currency
  // USDC (or any SPL) balance of the connected Solana wallet, as a float. Uses the app's sol-rpc proxy.
  async function solTokenBalance(mintStr, rpcUrl){
    try{ const web3=await loadSolWeb3(); const conn=new web3.Connection(rpcUrl,'confirmed');
      const owner=new web3.PublicKey(solCtxAddr()); const mint=new web3.PublicKey(mintStr||SOL_USDC_MINT);
      const r=await conn.getParsedTokenAccountsByOwner(owner,{mint}); let amt=0;
      (r&&r.value||[]).forEach(a=>{ try{ amt+=Number(a.account.data.parsed.info.tokenAmount.uiAmount||0); }catch(e){} }); return amt;
    }catch(e){ return 0; }
  }
  // Swap SOL -> `usdcAmount` USDC on Solana via Relay (EXACT_OUTPUT), signing the returned tx(s) with the wallet.
  // Resolves once Relay reports the swap filled. `relayQuote`/`relayStatus` are the app's server proxies to api.relay.link.
  async function relaySolToUsdc(usdcAmount, rpcUrl, onStage){
    const S=m=>{ try{ onStage&&onStage(m); }catch(e){} };
    const atomic=Math.ceil(Number(usdcAmount)*1e6); if(!(atomic>0)) return true;
    const body={ user:solCtxAddr(), recipient:solCtxAddr(), originChainId:RELAY_SOL_CHAIN, destinationChainId:RELAY_SOL_CHAIN,
      originCurrency:RELAY_SOL_NATIVE, destinationCurrency:SOL_USDC_MINT, amount:String(atomic), tradeType:'EXACT_OUTPUT' };
    S('Getting a SOL → USDC quote…');
    const q=await fetch('api/relay/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>null);
    if(!q||q.error||!Array.isArray(q.steps)) throw new Error('Could not get a SOL to USDC swap quote from Relay.');
    let rid=q.requestId||null;
    for(const st of q.steps){ for(const it of (st.items||[])){
      if(!rid && it.check && it.check.endpoint){ try{ rid=new URLSearchParams(it.check.endpoint.split('?')[1]||'').get('requestId'); }catch(e){} }
      const d=it.data||{}; const txB64=d.transaction||d.tx||d.serializedTransaction||d.psbt||(typeof d==='string'?d:null);
      if(txB64){ S('Approve the swap in your wallet…'); await signAndSendSol(txB64, rpcUrl); }
    } }
    S('Swapping SOL to USDC…');
    for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,2500)); if(!rid) break;
      try{ const j=await fetch('api/relay/status?requestId='+encodeURIComponent(rid)).then(r=>r.json());
        const s=String((j&&j.status)||''); if(/success|complete|filled|refund/i.test(s)) return true; if(/failed|error/i.test(s)) throw new Error('The SOL to USDC swap did not complete.'); }
      catch(e){ if(/did not complete/.test(e&&e.message||'')) throw e; } }
    return true;
  }
  // One-call preflight: ensure the wallet holds >= `usdcNeeded` USDC; if short, Relay-swap the shortfall (+2% buffer) from SOL.
  async function ensureSolUsdc(usdcNeeded, rpcUrl, onStage){
    const have=await solTokenBalance(SOL_USDC_MINT, rpcUrl); if(have>=Number(usdcNeeded)) return { swapped:false, have };
    await relaySolToUsdc((Number(usdcNeeded)-have)*1.02, rpcUrl, onStage); return { swapped:true, have };
  }

  // ── Relay: swap ETH (EVM) or SOL (Solana) -> BTC so Ordinals buyers short on Bitcoin can still buy. ─────────────
  const RELAY_BTC_CHAIN=8253038;                                          // Relay's Bitcoin mainnet chain id
  const RELAY_BTC_CCY='bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8';        // Relay's canonical BTC currency address
  const RELAY_EVM_NATIVE='0x0000000000000000000000000000000000000000';
  // Confirmed BTC (sats) at an address, via the app's keyless mempool utxo proxy.
  async function btcBalanceSats(address){ try{ const j=await fetch('api/btc-utxos?address='+encodeURIComponent(address)).then(r=>r.json()); return ((j&&j.utxos)||[]).reduce((a,u)=>a+(Number(u.valueSats)||0),0); }catch(e){ return 0; } }
  // Relay swap -> `btcSats` BTC (EXACT_OUTPUT) delivered to `btcRecipient`, funded from EVM native or Solana SOL. Signs the
  // origin-chain tx(s) with the connected wallet and polls the fill. Bitcoin settlement is slow (~1 block), so callers should
  // message accordingly. opts: { origin:'evm'|'sol', onStage, rpcUrl (for the sol-rpc proxy) }.
  async function relayToBtc(btcSats, btcRecipient, opts){
    opts=opts||{}; const S=m=>{ try{ opts.onStage&&opts.onStage(m); }catch(e){} };
    const sats=Math.ceil(Number(btcSats)); if(!(sats>0)) return true; if(!btcRecipient) throw new Error('No BTC destination address.');
    let originChainId, originCurrency, user, kind;
    if(opts.origin==='sol' || (opts.origin!=='evm' && !evmAddress && solAddress)){ kind='sol'; originChainId=RELAY_SOL_CHAIN; originCurrency=RELAY_SOL_NATIVE; user=solCtxAddr(); }
    else { kind='evm'; user=evmAddress; originCurrency=RELAY_EVM_NATIVE; let cid=1; try{ cid=parseInt(await evmEip1193.request({ method:'eth_chainId' }),16)||1; }catch(e){} originChainId=cid; }
    if(!user) throw new Error('Connect an Ethereum or Solana wallet to swap into BTC.');
    const body={ user, recipient:btcRecipient, originChainId, destinationChainId:RELAY_BTC_CHAIN, originCurrency, destinationCurrency:RELAY_BTC_CCY, amount:String(sats), tradeType:'EXACT_OUTPUT' };
    S('Getting a swap quote to BTC…');
    const q=await fetch('api/relay/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>null);
    if(!q||q.error||!Array.isArray(q.steps)) throw new Error('Could not get a swap quote to BTC'+((q&&q.message)?': '+q.message:'')+'.');
    let rid=q.requestId||null;
    for(const st of q.steps){ for(const it of (st.items||[])){
      if(!rid && it.check && it.check.endpoint){ try{ rid=new URLSearchParams(it.check.endpoint.split('?')[1]||'').get('requestId'); }catch(e){} }
      const d=it.data||{};
      if(kind==='evm'){ if(d.to){ S('Approve the swap in your wallet…'); await evmEip1193.request({ method:'eth_sendTransaction', params:[{ from:user, to:d.to, value:d.value?('0x'+BigInt(d.value).toString(16)):'0x0', data:d.data||'0x' }] }); } }
      else { const b64=d.transaction||d.tx||d.serializedTransaction||(typeof d==='string'?d:null); if(b64){ S('Approve the swap in your wallet…'); await signAndSendSol(b64, opts.rpcUrl); } }
    } }
    S('Swapping to BTC. Bitcoin can take a few minutes to land…');
    for(let i=0;i<60 && rid;i++){ await new Promise(r=>setTimeout(r,3000)); try{ const j=await fetch('api/relay/status?requestId='+encodeURIComponent(rid)).then(r=>r.json()); const s=String((j&&j.status)||''); if(/success|complete|filled|refund/i.test(s)) return true; if(/failed|error/i.test(s)) throw new Error('The swap to BTC did not complete.'); }catch(e){ if(/did not complete/.test(e&&e.message||'')) throw e; } }
    return true;
  }
  // Ensure `btcRecipient` holds >= needSats BTC; if short, Relay-swap the shortfall (+5% for the miner fee) from ETH/SOL.
  async function ensureBtcFunds(needSats, btcRecipient, opts){
    const have=await btcBalanceSats(btcRecipient); if(have>=Number(needSats)) return { swapped:false, have };
    await relayToBtc((Number(needSats)-have)*1.05, btcRecipient, opts); return { swapped:true, have };
  }

  // ── Relay: pay from ANY chain into USDC on Ethereum mainnet, delivered to `recipientEvm`. ─────────────────────────
  // This funds a buyer's mainnet USDC so they can enter a raffle from BTC, SOL, or any EVM chain. `usdcAtomic` is USDC
  // base units (6 decimals). opts: { origin:'evm'|'sol'|'btc', originChainId?, originCurrency?, onStage?, rpcUrl? }.
  // EVM + SOL are signed programmatically (proven step-executor). BTC uses a deposit address: Unisat sends it
  // automatically if available, otherwise the caller is told where to send (Bitcoin can take a few minutes to confirm).
  const RELAY_MAINNET_USDC='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  async function relayToUsdc(usdcAtomic, recipientEvm, opts){
    opts=opts||{}; const S=m=>{ try{ opts.onStage&&opts.onStage(m); }catch(e){} };
    const amount=String(Math.ceil(Number(usdcAtomic))); if(!(Number(amount)>0)) return true;
    if(!recipientEvm) throw new Error('No Ethereum address to receive USDC.');
    const kind=opts.origin||'evm';
    let originChainId, originCurrency, user;
    if(kind==='sol'){ originChainId=RELAY_SOL_CHAIN; originCurrency=opts.originCurrency||RELAY_SOL_NATIVE; user=solCtxAddr(); }
    else if(kind==='btc'){ originChainId=RELAY_BTC_CHAIN; originCurrency=RELAY_BTC_CCY; user=btcPaymentAddress||btcAddress; }
    else { user=evmAddress; originCurrency=opts.originCurrency||RELAY_EVM_NATIVE; let cid=1; try{ cid=parseInt(await evmEip1193.request({ method:'eth_chainId' }),16)||1; }catch(e){} originChainId=opts.originChainId||cid; }
    if(!user) throw new Error('Connect a '+(kind==='sol'?'Solana':kind==='btc'?'Bitcoin':'Ethereum')+' wallet to pay.');
    const body={ user, recipient:recipientEvm, originChainId, destinationChainId:1, originCurrency, destinationCurrency:RELAY_MAINNET_USDC, amount, tradeType:'EXACT_OUTPUT' };
    S('Getting a payment quote…');
    const q=await fetch('api/relay/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>null);
    if(!q||q.error||!Array.isArray(q.steps)) throw new Error('Could not get a payment route to USDC'+((q&&q.message)?': '+q.message:'')+'.');
    let rid=q.requestId||null;
    for(const st of q.steps){ for(const it of (st.items||[])){
      if(!rid && it.check && it.check.endpoint){ try{ rid=new URLSearchParams(it.check.endpoint.split('?')[1]||'').get('requestId'); }catch(e){} }
      const d=it.data||{};
      if(kind==='evm'){ if(d.to){ S('Approve the payment in your wallet…'); await evmEip1193.request({ method:'eth_sendTransaction', params:[{ from:user, to:d.to, value:d.value?('0x'+BigInt(d.value).toString(16)):'0x0', data:d.data||'0x' }] }); } }
      else if(kind==='sol'){ const b64=d.transaction||d.tx||d.serializedTransaction||(typeof d==='string'?d:null); if(b64){ S('Approve in your Solana wallet…'); await signAndSendSol(b64, opts.rpcUrl); } }
      else if(kind==='btc'){
        // Deposit model: send BTC (d.value sats) to the Relay deposit address (d.to). Unisat can do it in-wallet.
        const to=d.to||d.recipient||null, sats=Number(d.value||d.amount||0);
        if(!to) throw new Error('No Bitcoin deposit address returned by the route.');
        if(window.unisat && btcWalletId==='unisat' && window.unisat.sendBitcoin && sats>0){ S('Confirm the Bitcoin payment in Unisat…'); await window.unisat.sendBitcoin(to, sats); }
        else { throw new Error('Send '+(sats?(sats/1e8)+' BTC':'the quoted BTC')+' to '+to+' from your Bitcoin wallet to complete. It auto-detects after 1 confirmation.'); }
      }
    } }
    S(kind==='btc'?'Waiting for Bitcoin to confirm (this can take a few minutes)…':'Delivering USDC to your wallet…');
    const tries=kind==='btc'?90:50;
    for(let i=0;i<tries && rid;i++){ await new Promise(r=>setTimeout(r,3000));
      try{ const j=await fetch('api/relay/status?requestId='+encodeURIComponent(rid)).then(r=>r.json()); const s=String((j&&j.status)||'');
        if(/success|complete|filled|refund/i.test(s)) return true; if(/failed|error/i.test(s)) throw new Error('The payment route did not complete.'); }
      catch(e){ if(/did not complete/.test(e&&e.message||'')) throw e; } }
    return true;
  }

  // ── Relay: swap any coin the user holds into NATIVE gas on `destChain` (for minting/escrow/wrap when short on gas). ──
  // Auto-picks the largest detected asset that isn't the destination chain's native coin. `targetWei` = native wanted.
  const CHAIN_ID_BY_LABEL={ Ethereum:1, Base:8453, Polygon:137 };
  async function relayToNative(targetWei, destChain, opts){
    opts=opts||{}; const S=m=>{ try{ opts.onStage&&opts.onStage(m); }catch(e){} };
    const destCid=(typeof destChain==='number')?destChain:(CHAIN_ID_BY_LABEL[destChain]||1);
    const wei=BigInt(Math.ceil(Number(targetWei))); if(!(wei>0n)) return true;
    const recipient=evmAddress; if(!recipient) throw new Error('Connect an Ethereum wallet to receive gas.');
    let assets=[]; try{ assets=await detectAssets(); }catch(e){}
    const isDestNative=a=>(a.key==='eth'&&destCid===1)||(a.key==='evm:'+destCid);
    const src=(opts.source?assets.find(a=>a.key===opts.source):null) || assets.filter(a=>!isDestNative(a)).sort((a,b)=>(b.amount||0)-(a.amount||0))[0];
    if(!src) throw new Error('No other coin found to swap for gas. Add a little native gas and retry.');
    const parts=String(src.key).split(':'); let kind, originChainId, originCurrency, user;
    if(parts[0]==='sol'){ kind='sol'; originChainId=RELAY_SOL_CHAIN; originCurrency=parts[1]||RELAY_SOL_NATIVE; user=solCtxAddr(); }
    else if(parts[0]==='btc'){ kind='btc'; originChainId=RELAY_BTC_CHAIN; originCurrency=RELAY_BTC_CCY; user=btcPaymentAddress||btcAddress; }
    else if(parts[0]==='evm'){ kind='evm'; originChainId=parseInt(parts[1],10)||1; originCurrency=parts[2]||RELAY_EVM_NATIVE; user=evmAddress; }
    else { kind='evm'; originChainId=1; originCurrency=RELAY_EVM_NATIVE; user=evmAddress; }
    if(!user) throw new Error('Connect the wallet holding '+(src.symbol||'that coin')+' to swap for gas.');
    const body={ user, recipient, originChainId, destinationChainId:destCid, originCurrency, destinationCurrency:RELAY_EVM_NATIVE, amount:String(wei), tradeType:'EXACT_OUTPUT' };
    S('Swapping '+(src.symbol||'a coin')+' for gas…');
    const q=await fetch('api/relay/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(()=>null);
    if(!q||q.error||!Array.isArray(q.steps)) throw new Error('No route to swap for gas'+((q&&q.message)?': '+q.message:'')+'.');
    let rid=q.requestId||null;
    for(const st of q.steps){ for(const it of (st.items||[])){
      if(!rid && it.check && it.check.endpoint){ try{ rid=new URLSearchParams(it.check.endpoint.split('?')[1]||'').get('requestId'); }catch(e){} }
      const d=it.data||{};
      if(kind==='evm'){ if(d.to){ S('Approve the swap in your wallet…'); await evmEip1193.request({ method:'eth_sendTransaction', params:[{ from:user, to:d.to, value:d.value?('0x'+BigInt(d.value).toString(16)):'0x0', data:d.data||'0x' }] }); } }
      else if(kind==='sol'){ const b64=d.transaction||d.tx||d.serializedTransaction||(typeof d==='string'?d:null); if(b64){ S('Approve in your Solana wallet…'); await signAndSendSol(b64, opts.rpcUrl); } }
      else if(kind==='btc'){ const to=d.to||null, sats=Number(d.value||d.amount||0); if(to && window.unisat && btcWalletId==='unisat' && window.unisat.sendBitcoin && sats>0){ S('Confirm the Bitcoin payment…'); await window.unisat.sendBitcoin(to, sats); } else if(to){ throw new Error('Send '+(sats?(sats/1e8)+' BTC':'the quoted BTC')+' to '+to+' to fund gas.'); } }
    } }
    S('Waiting for gas to arrive…');
    for(let i=0;i<50 && rid;i++){ await new Promise(r=>setTimeout(r,3000)); try{ const j=await fetch('api/relay/status?requestId='+encodeURIComponent(rid)).then(r=>r.json()); const s=String((j&&j.status)||''); if(/success|complete|filled|refund/i.test(s)) return true; if(/failed|error/i.test(s)) throw new Error('The swap for gas did not complete.'); }catch(e){ if(/did not complete/.test(e&&e.message||'')) throw e; } }
    return true;
  }

  // ── Gas-minimum enforcement: guarantee at least `needWei` native gas on `destChain`, topping up via Relay only if short. ──
  // The buy/mint/escrow-adjacent primitive the wrapping companion leans on. Reads what the wallet already holds on the
  // destination chain (via detectAssets) and only swaps the shortfall + a headroom buffer, so a fee wobble can't leave the
  // user just-short. Returns {ok, already?:true, swapped?:true, have, need}. No-op when the balance already covers `needWei`.
  async function ensureGas(destChain, needWei, opts){
    opts=opts||{}; const S=m=>{ try{ opts.onStage&&opts.onStage(m); }catch(e){} };
    const destCid=(typeof destChain==='number')?destChain:(/^0x/i.test(String(destChain))?parseInt(destChain,16):(CHAIN_ID_BY_LABEL[destChain]||1));
    const need=BigInt(Math.ceil(Number(needWei||0))); if(!(need>0n)) return { ok:true, already:true, have:0n, need:0n };
    if(!evmAddress) throw new Error('Connect an Ethereum wallet to fund gas.');
    const headroom=(opts.headroom!=null)?BigInt(Math.ceil(Number(opts.headroom))):(need/5n); // default +20%
    let have=0n;
    try{ const assets=await detectAssets(); const isDestNative=a=>(a.key==='eth'&&destCid===1)||(a.key==='evm:'+destCid);
      const n=(assets||[]).find(isDestNative); if(n && n.amount) have=BigInt(Math.floor(Number(n.amount)*1e18)); }catch(e){}
    if(have>=need) return { ok:true, already:true, have, need };
    S('Topping up gas…');
    await relayToNative((need-have)+headroom, destCid, { onStage:opts.onStage, source:opts.source, rpcUrl:opts.rpcUrl });
    return { ok:true, swapped:true, have, need };
  }

  // Auto-detect which payable coins the connected wallets actually hold (native + common stablecoins on ETH/Base/
  // Polygon, SOL + USDC, BTC), via the server's /api/pay-assets. Returns [{key,chain,symbol,label,amount}] where `key`
  // is a source string for relayToUsdc ('eth'|'sol'|'sol:<mint>'|'btc'|'evm:<cid>'|'evm:<cid>:<token>'). Both apps use this.
  async function detectAssets(){
    const evm=evmAddress||'', sol=solAddress||'', btc=btcPaymentAddress||btcAddress||'';
    const qs=[]; if(evm)qs.push('evm='+encodeURIComponent(evm)); if(sol)qs.push('sol='+encodeURIComponent(sol)); if(btc)qs.push('btc='+encodeURIComponent(btc));
    if(!qs.length) return [];
    try{ const j=await fetch('api/pay-assets?'+qs.join('&')).then(r=>r.json()); return (j&&Array.isArray(j.assets))?j.assets:[]; }catch(e){ return []; }
  }

  // ── Stacks (Xverse via sats-connect) ──────────────────────────────────────────────────────────────────────────
  // CONNECT only (returns the mainnet SP… address). The wrap/sweep SIGNING (stx_callContract with post-conditions +
  // the network-mismatch resync) stays in the app, which re-detects the same Xverse extension session. Xverse routes
  // ALL sats-connect RPC through its namespaced BitcoinProvider.request(); the legacy window StacksProvider has no request().
  let stxAddress = null;
  async function _stxReq(){
    const sc = await loadSatsConnect(); const request = sc.request || (sc.default && sc.default.request);
    if(!request) throw new Error('Could not load the Xverse wallet library. Check your connection and retry.');
    const AP = sc.AddressPurpose || { Stacks:'stacks' };
    const xv = (typeof window!=='undefined' && window.XverseProviders && window.XverseProviders.BitcoinProvider) || null;
    const norm = r=>{ if(!r) return { status:'error', error:{ message:'empty response' } }; if(r.status) return r; if(r.result) return { status:'success', result:r.result }; if(r.error) return { status:'error', error:r.error }; return { status:'success', result:r }; };
    const stxReq = async(method, params)=>{ if(xv && typeof xv.request==='function') return norm(await xv.request(method, params)); return await request(method, params); };
    return { stxReq, AP };
  }
  async function connectStacks(){
    const { stxReq, AP } = await _stxReq();
    const pick = res=>{ if(!res || res.status!=='success') return ''; const a=((res.result && res.result.addresses)||[]).find(x=>/stacks/i.test(x.purpose||'')||/^SP/i.test(x.address||'')); return (a&&a.address)||''; };
    let addr='', lastErr='';
    try{ const r=await stxReq('wallet_connect', { addresses:[AP.Stacks||'stacks'], message:'Connect Stacks to Emblem' }); addr=pick(r); lastErr=r&&r.error&&r.error.message; }catch(e){ lastErr=e&&e.message; }
    if(!addr){ try{ const r=await stxReq('stx_getAddresses', null); addr=pick(r); lastErr=(r&&r.error&&r.error.message)||lastErr; }catch(e){} }
    if(!/^SP/i.test(addr)) throw new Error(lastErr || 'Xverse did not return a mainnet Stacks address. Switch Xverse to a Stacks account and retry.');
    stxAddress = addr; try{ onWalletChange('stx', addr); }catch(_){}
    return addr;
  }

  // ── Tezos (Beacon via the self-hosted Taquito bundle) ─────────────────────────────────────────────────────────
  // Tezos connect AND sign share ONE stateful BeaconWallet (pairing lives on the instance), so the connector owns that
  // single wallet. The Taquito/Beacon LIB is cached on the global `window.__tezos` (same key the app uses), so the app's
  // TezosToolkit + InMemorySigner come from the SAME module instance as this BeaconWallet (no cross-instance mismatch).
  // The app still drives the FA2 wrap/sweep (which contract, params, vault key) — it just uses THIS wallet to sign.
  let _tezWallet = null, xtzAddress = null;
  // Tezos is not part of the hub mint flow (EVM + Solana only), so the Taquito/Beacon bundle is NOT vendored here and
  // this loader is neutralized. To enable Tezos, vendor tezos.mjs into public/vendor/ and restore the import.
  async function _loadTezos(){ throw new Error('Tezos wallet support is not enabled in this build.'); }
  async function connectTezos(appName){
    const L = await _loadTezos();
    if(!_tezWallet) _tezWallet = new L.BeaconWallet({ name: appName || 'Emblem', network:{ type:'mainnet' }, preferredNetwork:'mainnet' });
    let addr=''; try{ const act = await _tezWallet.client.getActiveAccount(); if(act) addr = act.address; }catch(e){}
    if(!addr){ await _tezWallet.requestPermissions(); addr = await _tezWallet.getPKH(); }   // network is on the ctor; passing it here is rejected by newer Beacon
    if(!/^tz[123]/.test(String(addr||''))) throw new Error('No Tezos address returned. Approve the connection in your wallet.');
    xtzAddress = addr; try{ onWalletChange('xtz', addr); }catch(_){}
    return addr;
  }
  // Rebuild the BeaconWallet after a reload (the address is restored from app storage but the instance is gone, so a bare
  // setWalletProvider would throw). Reuses the cached active account (no popup); prompts only on a truly fresh browser.
  async function ensureTezosWallet(appName){
    const L = await _loadTezos();
    if(!_tezWallet) _tezWallet = new L.BeaconWallet({ name: appName || 'Emblem', network:{ type:'mainnet' }, preferredNetwork:'mainnet' });
    let act=null; try{ act = await _tezWallet.client.getActiveAccount(); }catch(e){}
    if(!act){ await connectTezos(appName); }
    return _tezWallet;
  }
  function tezosWallet(){ return _tezWallet; }
  async function tezosForget(){ xtzAddress=null; try{ if(_tezWallet) await _tezWallet.clearActiveAccount(); }catch(e){} _tezWallet=null; }

  return {
    version: EMBLEM_WALLET_CONNECTOR_VERSION,
    // Stacks (connect only)
    connectStacks, get stxAddress(){ return stxAddress; },
    // Tezos (shared BeaconWallet; the app signs FA2 ops with the shared window.__tezos lib)
    connectTezos, ensureTezosWallet, tezosWallet, tezosForget, get xtzAddress(){ return xtzAddress; },
    // EVM
    discoverEvm, findInjectedEvm, connectEvm, attachEvmSilently, ensureEvm, wrappingOwner, ensureChain, emblemClient, CHAIN_HEX, CHAIN_ADD_PARAMS,
    // Solana
    discoverSolana, solProvider, connectSolana, attachSolanaSilently,
    // Solana buy-and-wrap (shared)
    loadSolWeb3, signAndSendSol, signSolOnly, sendSolanaAsset, setSolanaContext, clearSolanaContext, solTokenBalance, relaySolToUsdc, ensureSolUsdc,
    relayToUsdc, relayToNative, detectAssets, ensureGas,
    // Relay swap -> BTC (for Ordinals buyers short on Bitcoin)
    btcBalanceSats, relayToBtc, ensureBtcFunds,
    // Bitcoin
    connectBtc, connectUnisat, connectXverse, ensureBtc, attachBtcSilently, sendOrdinal, btcSignMessage, signBtcPsbt,
    // Counterparty
    xcpAvailable, connectXcp, xcpSignPsbtHex,
    horizonAvailable, connectHorizon, cpSignMessage, connectCp, cpSignMessage, cpSignPsbt,
    get xcpProviderId(){ return xcpProviderId; },
    // state getters (read-only snapshots)
    get evmAddress(){ return evmAddress; }, get evmSigner(){ return evmSigner; }, get evmProvider(){ return evmProvider; }, get evmEip1193(){ return evmEip1193; }, get evmWalletId(){ return evmWalletId; },
    get solAddress(){ return solAddress; }, get solWalletId(){ return solWalletId; },
    get btcAddress(){ return btcAddress; }, get btcPaymentAddress(){ return btcPaymentAddress; }, get btcOrdinalsPubkey(){ return btcOrdinalsPubkey; }, get btcPaymentPubkey(){ return btcPaymentPubkey; }, get btcWalletId(){ return btcWalletId; },
    get xcpAddrs(){ return xcpAddrs.slice(); },
    get state(){ return { evmAddress, evmWalletId, solAddress, solWalletId, btcAddress, btcPaymentAddress, btcWalletId, xcpAddrs:xcpAddrs.slice() }; },
  };
}

// Ready-to-use singleton for script-tag / non-bundler consumers.
try{ if(typeof window!=='undefined' && !window.EmblemWallet){ window.EmblemWallet = createEmblemWallet({}); } }catch(e){}

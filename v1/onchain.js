/* Robbing the Vault — DEV on-chain layer (Robinhood testnet 46630).
   Exposes window.RTV_OC for the game to drive real entries/settlements, plus a floating console.
   Multi-wallet: EIP-6963 discovery (MetaMask / Rabby / Rainbow / Coinbase / Phantom-EVM / OKX / …).
   Loads ethers from CDN. Play-money fallback remains if a wallet isn't connected. */
(function () {
  const RVLT_ABI = [
    "function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"
  ];
  const VAULT_ABI = [
    "function enter(bytes32,bytes32)", "function settle(bytes32,uint8,bool,bytes32,bytes)",
    "function crackCore(bytes32,bool,bytes32,bytes)",   // V2: core crack pays ETH-or-pot by the player's choice (dormant until the V2 upgrade is live)
    "function potRvlt() view returns (uint256)", "function vaultEth() view returns (uint256)"
  ];
  const ROBBERS_ABI = [
    "function mint(uint256,uint256,bytes)", "function totalMinted() view returns (uint256)", "function mintActive() view returns (bool)",
    "function mintedBy(address) view returns (uint256)", "function MAX_SUPPLY() view returns (uint256)", "function MAX_PER_WALLET() view returns (uint256)",
    "function ownerOf(uint256) view returns (address)", "function tokenURI(uint256) view returns (string)",
    "function currentPrice() view returns (uint256)", "function quote(uint256) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
  ];
  const FAUCET = 'https://faucet.testnet.chain.robinhood.com';
  let cfg = null, provider = null, signer = null, addr = null, elLog = null;
  let injected = null;           // the chosen EIP-1193 provider
  let pickedRdns = null;         // rdns of the chosen wallet, persisted so we can silently reconnect after a refresh
  let roProvider = null;         // read-only RPC provider (pot/vault reads without a wallet)
  const OC_WALLET_KEY = 'rtv_oc_wallet';
  // Shared i18n: read the active language from the same localStorage key the game uses ('rtv_lang'),
  // then look up window.RTV_I18N (loaded by i18n.js). Falls back to English, then the key itself.
  function oct(k) {
    try {
      let lang = localStorage.getItem('rtv_lang');
      if (!lang) lang = ((navigator.language || 'en').slice(0, 2) || 'en').toLowerCase();
      const D = window.RTV_I18N || {};
      if (D[lang] && D[lang][k] != null) return D[lang][k];
      if (D.en && D.en[k] != null) return D.en[k];
    } catch (_) {}
    return k;
  }
  const $ = s => document.querySelector(s);
  const api = (p, b) => fetch(p, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined).then(r => r.json());
  const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  function log(m) { if (elLog) elLog.innerHTML = '<div>' + m + '</div>' + elLog.innerHTML; }

  /* ---------- EIP-6963 multi-wallet discovery ---------- */
  const discovered = new Map();  // rdns(lower) -> { info, provider }
  try {
    window.addEventListener('eip6963:announceProvider', e => {
      try { const d = e && e.detail; if (d && d.info && d.info.rdns && d.provider) discovered.set(String(d.info.rdns).toLowerCase(), d); } catch (_) {}
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch (_) {}
  // Nice icons/labels for the well-known wallets even if a wallet announces sparse info.
  const KNOWN = [
    { rdns: 'io.metamask',        name: 'MetaMask',  emoji: '🦊' },
    { rdns: 'io.rabby',           name: 'Rabby',     emoji: '🐰' },
    { rdns: 'me.rainbow',         name: 'Rainbow',   emoji: '🌈' },
    { rdns: 'com.coinbase.wallet',name: 'Coinbase',  emoji: '🔵' },
    { rdns: 'app.phantom',        name: 'Phantom',   emoji: '👻' },
    { rdns: 'com.okex.wallet',    name: 'OKX',       emoji: '⭕' },
    { rdns: 'com.binance.wallet', name: 'Binance',   emoji: '🟡' },
    { rdns: 'com.trustwallet.app',name: 'Trust',     emoji: '🛡' },
    { rdns: 'io.zerion.wallet',   name: 'Zerion',    emoji: '⚡' },
    { rdns: 'com.brave.wallet',   name: 'Brave',     emoji: '🦁' },
    { rdns: 'com.bitget.web3',    name: 'Bitget',    emoji: '🌀' },
    { rdns: 'com.robinhood.wallet',name:'Robinhood', emoji: '🪶' }
  ];
  // Wallets that expose an EVM shim but CANNOT add a custom EVM network (Robinhood Chain). Solana/BTC-first wallets.
  const NO_CUSTOM_EVM = [
    { rdns: 'app.phantom', flag: 'isPhantom', name: 'Phantom' },
    { rdns: 'io.xverse',   flag: 'isXverse',  name: 'Xverse' },
    { rdns: 'me.rainbow',  flag: 'isRainbow', name: 'Rainbow' }   // Rainbow can't add the Robinhood custom EVM network (same limitation as Phantom)
  ];
  function incompatWallet(provider, rdns) {
    for (const w of NO_CUSTOM_EVM) { if ((rdns && rdns === w.rdns) || (provider && provider[w.flag])) return w.name; }
    return null;
  }
  // Prominent, persistent, dismissible banner for wallet-limitation notices (so users know it is the wallet, not the site).
  function walletWarn(msg) {
    let b = document.getElementById('ocWalletWarn');
    if (!b) {
      b = document.createElement('div'); b.id = 'ocWalletWarn';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:250;display:flex;align-items:center;justify-content:center;padding:13px 46px;background:linear-gradient(180deg,rgba(62,18,20,.98),rgba(40,10,12,.98));border-bottom:1px solid rgba(255,120,120,.5);color:#ffdede;font-family:\'Space Mono\',monospace;font-size:13px;line-height:1.55;text-align:center;box-shadow:0 6px 30px rgba(0,0,0,.5)';
      document.body.appendChild(b);
    }
    b.innerHTML = '<span style="max-width:780px">' + msg + '</span><button id="ocWarnX" style="position:absolute;right:12px;top:9px;all:unset;cursor:pointer;color:#ffb4b4;font-size:16px">✕</button>';
    b.querySelector('#ocWarnX').onclick = () => b.remove();
  }
  // ── Wrong-network guard (2026-09-04, Jake) ── Proactively detect when the connected wallet is on the wrong chain and offer a
  // one-tap switch (entry already auto-switches via ensureChain, but a silent mobile reconnect or a manual network change in the
  // wallet would otherwise go unnoticed until you press Enter). Green banner to read as guidance, not an error.
  function netBanner(show, onSwitch) {
    let b = document.getElementById('ocNetWarn');
    if (!show) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'ocNetWarn';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:251;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:12px 20px;background:linear-gradient(180deg,rgba(8,26,18,.98),rgba(4,16,11,.98));border-bottom:1px solid rgba(61,255,143,.5);color:#d6ffe9;font-family:\'Space Mono\',monospace;font-size:13px;line-height:1.5;text-align:center;box-shadow:0 6px 30px rgba(0,0,0,.5)';
      document.body.appendChild(b); }
    b.innerHTML = '<span>Wrong network. Switch to <b>' + (cfg.chainName || ('Robinhood Chain ' + cfg.chainId)) + '</b> to play.</span>' +
      '<button id="ocNetSwitch" style="all:unset;cursor:pointer;background:rgba(61,255,143,.16);border:1px solid rgba(61,255,143,.5);border-radius:9px;color:#3dff8f;font-weight:700;padding:7px 14px">Switch network</button>';
    const sw = b.querySelector('#ocNetSwitch'); if (sw) sw.onclick = onSwitch;
  }
  async function currentChainId() { try { const h = await injected.request({ method: 'eth_chainId' }); return parseInt(h, 16); } catch (_) { return null; } }
  // autoSwap=true attempts one silent switch (used after a silent reconnect); otherwise just surfaces the banner + one-tap switch.
  async function checkNetwork(autoSwap) {
    if (!injected) { netBanner(false); return true; }
    let cur = await currentChainId();
    if (cur == null) return true;   // can't read the chain — don't nag
    if (cur !== Number(cfg.chainId) && autoSwap) { try { await ensureChain(); cur = await currentChainId(); } catch (_) {} }
    if (cur === Number(cfg.chainId)) {
      netBanner(false);
      try { if (signer) { provider = new window.ethers.BrowserProvider(injected); signer = await provider.getSigner(); addr = await signer.getAddress(); } } catch (_) {}   // rebuild so ethers reads the now-correct chain
      return true;
    }
    netBanner(true, async () => { try { await ensureChain(); await checkNetwork(false); } catch (_) {} });
    return false;
  }

  function walletList() {
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
    const out = [];
    // announced wallets first (real, installed), enriched with our known emoji/name
    discovered.forEach((d, rdns) => {
      const k = KNOWN.find(w => w.rdns === rdns);
      out.push({ rdns, name: (d.info && d.info.name) || (k && k.name) || rdns, icon: d.info && d.info.icon, emoji: k ? k.emoji : '🔗', provider: d.provider });
    });
    // Explicit injected fallbacks for wallets whose MOBILE in-app browsers don't always fire EIP-6963 (Jake 2026-09-07): OKX
    // (window.okxwallet) and Binance (window.BinanceChain). Surface them alongside any announced wallets so the picker shows
    // them on both mobile and desktop. Both support wallet_addEthereumChain, so they can add the Robinhood custom EVM network.
    const _seen = new Set(out.map(o => o.provider));
    const _addInj = (prov, name, emoji, rdns) => { try { if (prov && !_seen.has(prov) && !out.some(o => (o.rdns || '') === rdns)) { _seen.add(prov); out.push({ rdns: rdns || 'injected', name, emoji, provider: prov }); } } catch (_) {} };
    try { if (window.okxwallet) _addInj(window.okxwallet, 'OKX', '⭕', 'com.okex.wallet'); } catch (_) {}
    try { if (window.BinanceChain) _addInj(window.BinanceChain, 'Binance', '🟡', 'com.binance.wallet'); } catch (_) {}
    // legacy injected fallback if nothing announced (e.g. old MetaMask, or a lone in-app provider)
    if (!out.length && window.ethereum) {
      const eth = window.ethereum;
      const name = eth.isOkxWallet ? 'OKX' : (eth.isBinance || eth.isBinanceWallet) ? 'Binance' : eth.isRabby ? 'Rabby' : eth.isRainbow ? 'Rainbow' : eth.isCoinbaseWallet ? 'Coinbase' : eth.isPhantom ? 'Phantom' : eth.isMetaMask ? 'MetaMask' : 'Browser Wallet';
      out.push({ rdns: 'injected', name, emoji: '🔗', provider: eth });
    }
    return out;
  }

  function pickWallet(force) {
    const list = walletList();
    if (!list.length) return Promise.reject(new Error('No EVM wallet detected. Install MetaMask, Rabby, or Coinbase.'));
    if (list.length === 1 && !force) { pickedRdns = list[0].rdns || 'injected'; return Promise.resolve(list[0].provider); }
    return new Promise((resolve, reject) => {
      const back = document.createElement('div');
      back.style.cssText = 'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:radial-gradient(700px 460px at 50% 45%,rgba(4,14,10,.9),rgba(0,3,8,.97));backdrop-filter:blur(4px)';
      const card = document.createElement('div');
      card.style.cssText = 'width:min(360px,92vw);background:rgba(3,10,7,.96);border:1px solid rgba(61,255,143,.28);border-radius:16px;padding:22px 20px;box-shadow:0 0 60px rgba(61,255,143,.12)';
      let rows = list.map((w, i) => {
        const bad = incompatWallet(w.provider, w.rdns);
        return '<button data-i="' + i + '" class="wpick" style="display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:rgba(61,255,143,.06);border:1px solid rgba(61,255,143,.18);border-radius:12px;padding:12px 14px;margin:8px 0;cursor:pointer;color:#cdead9;font-family:\'Space Mono\',monospace;font-size:14px;transition:.13s">' +
        (w.icon ? '<img src="' + w.icon + '" style="width:26px;height:26px;border-radius:7px"/>' : '<span style="font-size:22px;width:26px;text-align:center">' + w.emoji + '</span>') +
        '<span>' + w.name + (bad ? '<div style="font-size:9px;color:#ff9c9c;margin-top:2px;letter-spacing:.02em">cannot add Robinhood Chain</div>' : '') + '</span></button>';
      }).join('');
      card.innerHTML =
        '<div style="font-family:\'Cinzel\',serif;font-weight:700;font-size:20px;color:#eafff3;letter-spacing:.04em;text-shadow:0 0 22px rgba(61,255,143,.4)">' + oct('chooseWallet') + '</div>' +
        '<div style="font-family:\'Space Mono\',monospace;font-size:11px;color:#4e6857;margin:6px 0 6px">' + oct('walletHint') + '</div>' +
        rows +
        '<button id="wpickCancel" style="all:unset;cursor:pointer;display:block;text-align:center;width:100%;margin-top:6px;font-family:\'Space Mono\',monospace;font-size:11px;color:#4e6857;text-decoration:underline;text-underline-offset:3px">' + oct('cancel') + '</button>';
      back.appendChild(card); document.body.appendChild(back);
      const done = v => { try { document.body.removeChild(back); } catch (_) {} v(); };
      card.querySelectorAll('.wpick').forEach(b => {
        b.onmouseenter = () => b.style.background = 'rgba(61,255,143,.14)';
        b.onmouseleave = () => b.style.background = 'rgba(61,255,143,.06)';
        b.onclick = () => { const w = list[+b.getAttribute('data-i')]; pickedRdns = w.rdns || 'injected'; done(() => resolve(w.provider)); };
      });
      card.querySelector('#wpickCancel').onclick = () => done(() => reject(new Error('Wallet selection cancelled')));
      back.onclick = e => { if (e.target === back) done(() => reject(new Error('Wallet selection cancelled'))); };
    });
  }

  async function loadEthers() {
    if (window.ethers) return;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  // Canonical Robinhood Chain params so a wallet WITHOUT the network can add it in one click (the wallet's "Add network → Continue" prompt).
  // Mainnet-ready: falls back to the known-good values per chainId if the server config is sparse. Matches EmblemWrapped/vault-mint.
  const RH_CHAIN = {
    4663:  { chainName: 'Robinhood Chain',         rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com' },
    46630: { chainName: 'Robinhood Chain Testnet', rpc: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com' }
  };
  async function addChain() {
    const hexId = '0x' + cfg.chainId.toString(16);
    const k = RH_CHAIN[cfg.chainId] || {};
    await injected.request({ method: 'wallet_addEthereumChain', params: [{
      chainId: hexId,
      chainName: cfg.chainName || k.chainName || ('Robinhood Chain ' + cfg.chainId),
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: [cfg.rpc || k.rpc],
      blockExplorerUrls: [cfg.explorer || k.explorer]
    }] });
  }
  async function ensureChain() {
    const hexId = '0x' + cfg.chainId.toString(16);
    try { await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] }); }
    catch (e) {
      if (e && e.code === 4001) throw new Error('Network switch rejected. Approve the switch to Robinhood Chain (' + cfg.chainId + ').');
      // Chain not in the wallet (usually 4902): add it in one click, then make sure we land on it (some wallets do not auto-switch after adding).
      try { await addChain(); try { await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] }); } catch (_) {} }
      catch (e2) {
        if (e2 && e2.code === 4001) throw new Error('Adding Robinhood Chain was rejected.');
        const nm = incompatWallet(injected) || 'This wallet';
        walletWarn('<b>' + nm + ' cannot connect to Robinhood Chain.</b> ' + nm + ' does not support adding custom EVM networks, so it will not work on testnet or mainnet. Use <b>MetaMask, Rabby, or Coinbase</b> instead.');
        throw new Error(nm + ' cannot add Robinhood Chain (chain ' + cfg.chainId + '). Use MetaMask, Rabby, or Coinbase; ' + nm + ' does not support custom EVM networks.');
      }
    }
  }
  // Fully drop the current wallet so the next connect starts clean and can choose a DIFFERENT wallet. Self-heal for the
  // multi-extension "Cannot redefine property ethereum / could not coalesce" glitch: a wedged provider gets cleared here.
  function disconnect() {
    try { if (injected && injected.removeAllListeners) injected.removeAllListeners(); } catch (_) {}
    injected = null; provider = null; signer = null; addr = null; pickedRdns = null;
    try { localStorage.removeItem(OC_WALLET_KEY); } catch (_) {}
    try { if ($('#ocAddr')) $('#ocAddr').textContent = ''; } catch (_) {}
    try { const b = document.getElementById('ocWalletWarn'); if (b) b.remove(); } catch (_) {}
    try { const n = document.getElementById('ocNetWarn'); if (n) n.remove(); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('rtv-oc-disconnected')); } catch (_) {}
  }
  // Disconnect, then reconnect forcing the wallet picker (so the user can back out or pick another wallet).
  async function switchWallet() { disconnect(); return connect(true); }
  async function connect(force) {
    await loadEthers();
    if (force) injected = null;               // force a fresh pick (used to switch wallets / recover from a glitch)
    if (!injected) injected = await pickWallet(force);
    try {
      const inc = incompatWallet(injected);
      if (inc) walletWarn('<b>' + inc + ' detected.</b> ' + inc + ' cannot add custom EVM networks like Robinhood Chain (testnet or mainnet). If the connection fails, switch to <b>MetaMask, Rabby, or Coinbase</b>.');
      await injected.request({ method: 'eth_requestAccounts' });
      await ensureChain();
      walletWarn && (function(){ const b = document.getElementById('ocWalletWarn'); if (b) b.remove(); })();  // chain added/switched OK — clear any earlier warning
      provider = new window.ethers.BrowserProvider(injected);
      signer = await provider.getSigner();
      addr = await signer.getAddress();
      if ($('#ocAddr')) $('#ocAddr').textContent = short(addr);
      try { injected.on && injected.on('accountsChanged', () => location.reload()); injected.on && injected.on('chainChanged', () => { checkNetwork(false).catch(() => {}); }); } catch (_) {}
      try { localStorage.setItem(OC_WALLET_KEY, pickedRdns || 'injected'); } catch (_) {}   // remember the wallet so we can silently reconnect after a refresh
      await refresh();
      checkNetwork(false).catch(() => {});   // connect() already ensured the chain; this just clears/keeps the wrong-network banner in sync
      return addr;
    } catch (e) {
      // Self-heal: on the multi-extension glitch, drop the wedged provider so the very next attempt can pick a clean/other wallet.
      const g = _walletGlitch(e);
      if (g) { disconnect(); const err = new Error(g.message + ' Tap "Use a different wallet" to pick another, or disable the extra extension.'); err.walletGlitch = true; throw err; }
      throw e;
    }
  }
  // Silent reconnect after a page refresh: re-attach the previously-chosen wallet via eth_accounts (NO popup). OneShot-style persistence.
  async function silentReconnect() {
    try {
      const saved = localStorage.getItem(OC_WALLET_KEY);
      if (!saved) return;
      await loadEthers();
      // EIP-6963 wallets announce asynchronously — give discovery a few beats to find the saved one.
      let prov = null;
      for (let i = 0; i < 8 && !prov; i++) {
        const hit = walletList().find(w => (w.rdns || 'injected') === saved);
        if (hit && hit.provider) { prov = hit.provider; break; }
        await new Promise(r => setTimeout(r, 150));
      }
      if (!prov && (saved === 'injected') && window.ethereum) prov = window.ethereum;
      if (!prov) return;
      const accts = await prov.request({ method: 'eth_accounts' });   // SILENT — returns [] if the wallet is locked or the site was revoked
      if (!accts || !accts.length) return;
      injected = prov;
      provider = new window.ethers.BrowserProvider(injected);
      signer = await provider.getSigner();
      addr = await signer.getAddress();
      if ($('#ocAddr')) $('#ocAddr').textContent = short(addr);
      try { injected.on && injected.on('accountsChanged', () => location.reload()); injected.on && injected.on('chainChanged', () => { checkNetwork(false).catch(() => {}); }); } catch (_) {}
      await refresh();
      checkNetwork(true).catch(() => {});   // silent reconnect skips ensureChain — attempt one auto-switch, else surface the wrong-network banner
      log('Reconnected ' + short(addr));
      try { window.dispatchEvent(new CustomEvent('rtv-oc-reconnected', { detail: { address: addr } })); } catch (_) {}
    } catch (_) {}
  }
  async function ensureReady() {
    if (!signer) await connect();
    // MOBILE FIX (2026-09-04): silentReconnect() re-attaches the wallet WITHOUT switching networks and ensureReady skips connect()
    // when a signer already exists, so a mobile in-app wallet can still be on Ethereum mainnet here. Guarantee Robinhood Chain,
    // then rebuild provider/signer (BrowserProvider caches the network at construction).
    await ensureChain();
    try { provider = new window.ethers.BrowserProvider(injected); signer = await provider.getSigner(); addr = await signer.getAddress(); } catch (_) {}
    const need = window.ethers.parseUnits(cfg.fee, 18);
    const isMainnet = Number(cfg.chainId) === 4663;
    // READ balance / gas / allowance from the SERVER (reliable FallbackProvider), NOT the wallet. This is the real mobile fix:
    // mobile wallets frequently return 0x for eth_call on a custom-added chain like Robinhood → ethers "could not decode result
    // data", which aborted entry even when the wallet was on the right chain. The wallet is now used ONLY for the chain switch
    // above and the approve/enter WRITES below. If the server read fails, we don't hard-block — the tx will surface any real error.
    let st = null; try { st = await api('api/onchain/chainstate?address=' + addr); } catch (_) {}
    if (st && !st.error) {
      if ((st.ethGas || 0) <= 0) throw new Error(oct('noGas'));   // no ETH for gas — clear message, not a raw wallet error
      const bal = st.tRvlt || 0;
      if (bal < Number(cfg.fee)) {
        if (isMainnet) throw new Error('You need at least ' + Number(cfg.fee).toLocaleString() + ' ROBINVAULT to enter.');
        log('Minting test tRVLT…'); const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, signer); const m = await rvlt.mint(addr, window.ethers.parseUnits('100000', 18)); await m.wait();   // testnet only — public faucet token
      }
    }
    // Approve ONCE, then never again (Jake 2026-09-07). The approval is a bounded 1,000,000 ROBINVAULT (never unlimited), which
    // covers ~1000 entries. The old bug: it keyed only off the server-read allowance, so if that read was missing/flaky it
    // re-approved EVERY game. Now: prefer the server read; if it's absent or short, CONFIRM the real allowance on-chain before
    // spending a tx — so an existing allowance is respected and we only ever approve when the chain says it is genuinely short.
    let allow = null; try { if (st && st.allowanceWei != null) allow = BigInt(st.allowanceWei); } catch (_) {}
    if (allow === null || allow < need) {
      try { const oc = await new window.ethers.Contract(cfg.rvlt, RVLT_ABI, provider).allowance(addr, cfg.vault); if (typeof oc === 'bigint') allow = oc; } catch (_) {}
    }
    if (allow === null || allow < need) { log('Approving ROBINVAULT (one time)…'); const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, signer); const tx = await rvlt.approve(cfg.vault, window.ethers.parseUnits('1000000', 18)); await tx.wait(); }
  }
  // Live setup checklist: tick each step as its condition is satisfied, and mark the matching button done.
  let _setupPoll = null, _setupBtn = null, _setupPanel = null;
  function hasWallet() { try { return !!(window.ethereum || (typeof walletList === 'function' && walletList().length)); } catch (_) { return !!window.ethereum; } }
  function mmDeepLink() { return 'https://metamask.app.link/dapp/' + location.host + location.pathname.replace(/\/$/, '') + '/'; }
  function markSteps(conn, gas, rvlt) {
    const set = (id, on, bid) => { const el = document.getElementById(id); if (el) el.classList.toggle('done', !!on); const b = bid && document.getElementById(bid); if (b) b.classList.toggle('done', !!on); };
    set('ocs1', conn, 'ocConnect'); set('ocs2', gas, 'ocFaucet'); set('ocs3', rvlt, 'ocMint');
    const allDone = conn && gas && rvlt;
    // Once fully set up, get out of the way: hide the launcher chip and slide the sheet away after a beat.
    if (_setupBtn) _setupBtn.style.display = allDone ? 'none' : '';
    if (allDone && _setupPanel && _setupPanel.style.display !== 'none' && !_setupPanel._hideT) {
      const rd = _setupPanel.querySelector('#ocReady'); if (rd) rd.style.display = 'block';
      _setupPanel._hideT = setTimeout(() => { if (_setupPanel) _setupPanel.style.display = 'none'; }, 1800);
    }
    if (!allDone && _setupPanel) { if (_setupPanel._hideT) { clearTimeout(_setupPanel._hideT); _setupPanel._hideT = null; } const rd = _setupPanel.querySelector('#ocReady'); if (rd) rd.style.display = 'none'; }
  }
  async function refresh() {
    if (!signer) { markSteps(false, false, false); return; }
    try {
      if ($('#ocAddr')) $('#ocAddr').textContent = short(addr);
      const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, provider);
      const vault = new window.ethers.Contract(cfg.vault, VAULT_ABI, provider);
      const [bal, pot, veth, eth] = await Promise.all([rvlt.balanceOf(addr), vault.potRvlt(), vault.vaultEth(), provider.getBalance(addr)]);
      if ($('#ocBal')) $('#ocBal').textContent = (+window.ethers.formatUnits(bal, 18)).toLocaleString() + ' tRVLT · ' + (+window.ethers.formatEther(eth)).toFixed(4) + ' ETH';
      if ($('#ocPot')) $('#ocPot').textContent = (+window.ethers.formatUnits(pot, 18)).toLocaleString() + ' tRVLT pot · ' + (+window.ethers.formatEther(veth)).toFixed(4) + ' ETH vault';
      markSteps(true, eth > 0n, bal > 0n);
    } catch (e) {}
  }
  async function getTestRvlt() {
    if (!signer) await connect();
    const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, signer);
    const tx = await rvlt.mint(addr, window.ethers.parseUnits('100000', 18)); await tx.wait(); await refresh();
  }

  // read-only snapshot of the contract (pot + prize vault always; wallet balances when connected) — server-proxied (no browser RPC)
  async function chainState() {
    try {
      const out = await api('api/onchain/chainstate' + (addr ? ('?address=' + addr) : ''));
      if (!out || out.error) return null;
      out.connected = !!addr; out.address = addr;
      return out;
    } catch (e) { return null; }
  }

  // ── Practice Arcade pass: one-time 10,000 ROBINVAULT unlock, tied to the wallet forever (half burns, half feeds the pot) ──
  async function arcadeStatus() { return api('api/arcade/status?address=' + (addr || '')); }   // { paid, fee, burn, pot, sink }
  async function payArcade() {
    try {
      await ensureReady();
      const pre = await arcadeStatus().catch(() => null);
      if (pre && pre.paid) return { paid: true };   // already unlocked — no second charge
      const fee = String((pre && pre.fee) || 25000);   // server-driven fee (currently 25,000); one place to change the price later
      const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, signer);
      log('Paying ' + Number(fee).toLocaleString() + ' ROBINVAULT for the arcade pass…');
      const tx = await rvlt.transfer(cfg.vault, window.ethers.parseUnits(fee, 18));
      // Don't block on the client's slow tx.wait() (that was the ~20s hang). Hand the hash to the server, which confirms via
      // the Alchemy WS fast-path; retry a few times only while the node is still indexing the tx.
      log('Confirming payment…');
      let r = null;
      for (let i = 0; i < 10; i++) {
        r = await api('api/arcade/pass', { address: addr, txHash: tx.hash }).catch(() => null);
        if (r && r.paid) break;
        if (r && r.error && !/not confirmed|receipt|bad tx/i.test(r.error)) throw new Error(r.error);
        await new Promise(res => setTimeout(res, 1500));
      }
      if (!r || !r.paid) throw new Error('Payment sent but not confirmed yet. Give it a moment and reopen the arcade — you will not be charged again.');
      await refresh();
      return { paid: true };
    } catch (e) { throw (_walletGlitch(e) || e); }
  }

  // ---- exposed API the game calls ----
  // Translate the opaque ethers/provider errors that a multi-wallet-extension conflict throws into a real instruction.
  function _walletGlitch(e) {
    const m = String((e && (e.shortMessage || e.message || e.reason)) || e);
    if (/coalesce|only a getter|could not detect network|missing provider|already pending|-32603/i.test(m))
      return new Error('Wallet connection glitched. If more than one wallet extension is installed, keep only one enabled (or set your wallet as default), then reload and reconnect.');
    return null;
  }
  // Cryptographically-strong player entropy, chosen locally AFTER the server has committed its seed — this is what makes the
  // luck draws grind-proof (see /api/onchain/bind-seed). 16 random bytes → 32 hex chars.
  function _genClientSeed() {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function enterRun() {
    try { await ensureReady(); } catch (e) { throw (_walletGlitch(e) || e); }
    if (!window.RTV_PAGE_NONCE) window.RTV_PAGE_NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);   // in-memory page nonce; a mid-run refresh regenerates it and the server forfeits the run
    const run = await api('api/onchain/newrun', { player: addr, pageNonce: window.RTV_PAGE_NONCE });
    if (run.error) throw new Error(run.error);
    // GRIND-PROOF SEED: pick our OWN entropy now that the server is locked to run.commit, and bind it BEFORE we pay entry.
    // Neither side can grind the other (server blind to us at commit; we're blind to its seed, holding only the hash). Binding
    // before the on-chain enter() also means a bind failure costs no gas.
    run.clientSeed = _genClientSeed();
    try {
      const b = await api('api/onchain/bind-seed', { runId: run.runId, clientSeed: run.clientSeed });
      if (!b || b.error || !b.clientSeed) throw new Error((b && b.error) || 'seed bind failed');
      run.clientSeed = b.clientSeed;
      // BREADCRUMB (Jake 2026-09-07): persist the runId BEFORE we pay, so if the wallet broadcasts enter() then hangs and loses
      // the tx hash, the page can still recover the PAID run by runId (verify-enter now confirms from the contract, no hash needed).
      try { localStorage.setItem('rtv_pending_entry', JSON.stringify({ runId: run.runId, player: addr, ts: Date.now() })); } catch (_) {}
    } catch (e) { throw new Error('Could not secure a fair seed. Reload and try again.'); }
    const vault = new window.ethers.Contract(cfg.vault, VAULT_ABI, signer);
    let tx;
    // NONCE HARDENING: custom Orbit chains (Robinhood 4663) frequently leave the wallet's cached account nonce out of sync
    // with the chain -> "invalid nonce / Fail to create" before the tx is even built. Pre-read the real on-chain nonce and
    // pass it explicitly so the wallet can't use a stale one (best-effort; if the read fails we just let the wallet manage it).
    let ov = {};
    // TIMEOUT-GUARDED (2026-09-04 regression fix): on a wallet provider being fought over by multiple extensions, getTransactionCount
    // can HANG (never resolves — try/catch doesn't help), which froze entry before the wallet even prompted. Race it; if it doesn't
    // answer in 4s, skip the explicit nonce and let the wallet manage it (exactly the behavior before the nonce-hardening was added).
    try { ov = { nonce: await Promise.race([ provider.getTransactionCount(addr, 'pending'), new Promise((_, r) => setTimeout(() => r(new Error('nonce-timeout')), 4000)) ]) }; } catch (_) { ov = {}; }
    const _errStr = (e) => String((e && (e.shortMessage || e.message || e.reason || (e.info && e.info.error && e.info.error.message))) || e);
    // SUBMIT the entry — we only need the tx HASH here. CRITICAL (2026-09-04 fix): do NOT `await tx.wait()`.
    // Under a multi-wallet-extension conflict the injected provider's receipt polling can hang FOREVER even though the tx
    // mines perfectly (robinscan confirms the RVLT transfer lands). That hang left the game stuck on "Confirm in your wallet…"
    // with the fee already paid. The SERVER confirms the tx from its OWN RPC/Alchemy socket in verify-enter below (independent
    // of the user's wallet), so the wallet's wait() is redundant. Same fix already shipped for the arcade pass.
    try { tx = await vault.enter(run.runId, run.commit, ov); }
    catch (e) {
      const m = _errStr(e);
      // Nonce desync -> re-read the confirmed nonce and retry once with it explicitly.
      if (/nonce|already known|replacement transaction underpriced/i.test(m)) {
        try {
          const n = await Promise.race([ provider.getTransactionCount(addr, 'latest'), new Promise((_, r) => setTimeout(() => r(new Error('nonce-timeout')), 4000)) ]);
          tx = await vault.enter(run.runId, run.commit, { nonce: n });
        } catch (e2) {
          if (/nonce|already known|replacement/i.test(_errStr(e2)))
            throw new Error("Your wallet's transaction count is out of sync with Robinhood Chain. Fix: MetaMask -> Settings -> Advanced -> Clear activity tab data (Rabby usually self-heals on reload), then reload this page and re-enter. No ROBINVAULT is spent until entry succeeds.");
          throw e2;
        }
      // "could not coalesce error" / a locked window.ethereum getter = two wallet extensions fighting for control. Give a real instruction, not the cryptic ethers text.
      } else if (/coalesce|only a getter|could not detect network|missing provider|already pending|-32603/i.test(m)) {
        throw new Error('Wallet connection glitched. If more than one wallet extension is installed, keep only one enabled (or set your wallet as default), then reload and reconnect.');
      } else { throw e; }
    }
    // Tell the server the on-chain entry landed so this run counts as PAID (gates mini/start on mainnet + the Robbers teller).
    // verify-enter does its OWN mined-tx wait (Alchemy WS) + receipt read server-side, so we don't touch the flaky wallet
    // provider at all here. Retry: the first calls may land before the tx is mined/indexed — the server bounds each wait and
    // we poll until it confirms rather than starting an unpaid run that jams at the first door.
    run.txHash = tx.hash;
    let paid = false;
    for (let i = 0; i < 10 && !paid; i++) {
      try { const v = await api('api/onchain/verify-enter', { runId: run.runId, txHash: tx.hash }); if (v && v.paid) { paid = true; break; } } catch (_) {}
      if (!paid) await new Promise(r => setTimeout(r, 1500));
    }
    // OPTIMISTIC START (do NOT throw on !paid): the payment is irreversible and there is no resume, so we must let the player
    // into the run once the entry tx is submitted. If verify-enter is still lagging, the run starts anyway and the FIRST DOOR
    // re-verifies payment (door-jam retry) — that self-heals a slow node without stranding a paid player on a frozen screen.
    run.paid = paid;
    // Keep confirming in the BACKGROUND if the tx has not indexed yet (launch RPC lag): poll verify-enter for up to ~2.5min so
    // a slow-to-mine PAID entry still registers server-side and the first door never jams a player who already paid. (Jake 2026-09-07)
    if (!paid) { (async () => { for (let i = 0; i < 50 && !run.paid; i++) { await new Promise(r => setTimeout(r, 3000)); try { const v = await api('api/onchain/verify-enter', { runId: run.runId, txHash: tx.hash }); if (v && v.paid) { run.paid = true; break; } } catch (_) {} } })(); }
    await refresh();
    return run; // {runId, commit, clientSeed, doors, txHash, paid}
  }
  // House-sponsored COMP entry (make-good free run): same newrun + grind-proof bind-seed as enterRun, but instead of the
  // player paying enter() on-chain, the player signs a no-gas redemption message and the SERVER sponsors enterFor() from the
  // dedicated comp wallet — so the run is credited to the player and plays/settles identically. Returns the same run shape.
  async function compEnterRun() {
    try { await ensureReady(); } catch (e) { throw (_walletGlitch(e) || e); }
    if (!window.RTV_PAGE_NONCE) window.RTV_PAGE_NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const run = await api('api/onchain/newrun', { player: addr, pageNonce: window.RTV_PAGE_NONCE });
    if (run.error) throw new Error(run.error);
    run.clientSeed = _genClientSeed();
    const b = await api('api/onchain/bind-seed', { runId: run.runId, clientSeed: run.clientSeed });
    if (!b || b.error || !b.clientSeed) throw new Error((b && b.error) || 'seed bind failed');
    run.clientSeed = b.clientSeed;
    try { localStorage.setItem('rtv_pending_entry', JSON.stringify({ runId: run.runId, player: addr, ts: Date.now() })); } catch (_) {}
    // No-gas wallet-ownership signature authorizing the free run — MUST match the server's COMP_MSG byte-for-byte.
    const msg = 'Robbing the Vault\nRedeem free run:\n' + run.runId;
    let sig; try { sig = await signer.signMessage(msg); } catch (e) { throw new Error(/reject|denied|cancel/i.test(String(e && e.message || e)) ? 'Signature cancelled.' : 'Could not sign the free-run redemption.'); }
    const r = await api('api/onchain/comp-enter', { runId: run.runId, sig });
    if (!r || r.error || !r.paid) throw new Error((r && r.error) || 'free run could not be redeemed');
    run.txHash = r.txHash || ''; run.paid = true; run.comp = true;
    await refresh();
    return run; // {runId, commit, clientSeed, doors, txHash, paid, comp:true}
  }
  async function compStatus() { try { return await api('api/comp/status?player=' + (addr || '')); } catch (_) { return { freeRuns: 0 }; } }
  // ── Cloudflare Turnstile human-firewall (mint gate + cash-out). Renders a managed widget on demand and resolves its token.
  // No-op (returns '') when cfg.turnstileSiteKey is unset, so nothing shows until the Turnstile keypair is configured. ──
  let _tsReady = null;
  function _loadTurnstile() { if (_tsReady) return _tsReady; _tsReady = new Promise((res) => { if (window.turnstile) return res(); const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.onload = () => res(); s.onerror = () => res(); document.head.appendChild(s); }); return _tsReady; }
  async function turnstileToken() {
    const key = cfg && cfg.turnstileSiteKey; if (!key) return '';   // not configured -> no captcha
    await _loadTurnstile(); if (!window.turnstile) return '';
    return await new Promise((resolve) => {
      let done = false; const finish = (v) => { if (done) return; done = true; resolve(v || ''); try { box.remove(); } catch (e) {} };
      let box = document.createElement('div'); box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,3,8,.72)';
      const inner = document.createElement('div'); inner.style.cssText = 'background:#04140c;border:1px solid rgba(61,255,143,.35);border-radius:14px;padding:18px;text-align:center;max-width:92vw';
      inner.innerHTML = '<div style="font-family:monospace;color:#8fe;font-size:12px;margin-bottom:10px">Quick human check</div><div id="tsMount"></div><div style="font-family:monospace;color:#5c8a76;font-size:10px;margin-top:9px">Verify to continue. This keeps bots out of the vault.</div><button id="tsCancel" style="all:unset;cursor:pointer;color:#9fb;opacity:.85;font-family:monospace;font-size:11px;margin-top:10px;border:1px solid rgba(159,208,255,.3);border-radius:8px;padding:5px 12px">Cancel</button>';
      box.appendChild(inner); document.body.appendChild(box);
      let wid = null;
      // A transient challenge error/expiry must NOT silently fail the paid action — reset the widget so a real human can pass on
      // the next attempt. Only an explicit Cancel or the hard cap resolves '' (server then fails closed, so bots still can't pass).
      try { wid = window.turnstile.render(inner.querySelector('#tsMount'), { sitekey: key, callback: (tok) => finish(tok),
        'error-callback': () => { try { window.turnstile.reset(wid); } catch (e) {} },
        'expired-callback': () => { try { window.turnstile.reset(wid); } catch (e) {} },
        'timeout-callback': () => { try { window.turnstile.reset(wid); } catch (e) {} } }); }
      catch (e) { finish(''); }
      try { inner.querySelector('#tsCancel').onclick = () => finish(''); } catch (e) {}
      setTimeout(() => finish(''), 120000);   // generous hard cap: a genuine human who pauses at the check isn't cut off after a few seconds
    });
  }
  let _settling = false;
  async function settleRun(runId, stage, robbed) {
    if (_settling) throw new Error('settlement already in progress');   // in-flight guard: a slow settle tx can't be double-submitted
    _settling = true;
    try { return await _settleRun(runId, stage, robbed); } finally { _settling = false; }
  }
  async function _settleRun(runId, stage, robbed) {
    if (!signer) await connect();   // resume-after-refresh safety net: restore the wallet before settling if silent reconnect did not run
    // MOBILE FIX (2026-09-04): guarantee Robinhood Chain before the settle write + rebuild the cached provider (same class of bug
    // as entry — a settle on the wrong chain, or its display reads, would fail on a mobile in-app wallet).
    await ensureChain(); try { provider = new window.ethers.BrowserProvider(injected); signer = await provider.getSigner(); addr = await signer.getAddress(); } catch (_) {}
    const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, provider);
    // balance snapshots are DISPLAY-ONLY (to show how much you won) — never let a flaky mobile eth_call ("could not decode result
    // data") abort a settle that actually lands on-chain. Default to 0 on read failure; the on-chain settle is authoritative.
    let b0 = 0n, e0 = 0n; try { b0 = await rvlt.balanceOf(addr); } catch (_) {} try { e0 = await provider.getBalance(addr); } catch (_) {}
    const cap = robbed ? '' : await turnstileToken();   // human check on cash-out only (a core-crack jackpot is never captcha-gated)
    const s = await api('api/onchain/settle-sig', { runId, stage, robbed, captcha: cap });
    if (s.error) throw new Error(s.error);
    // The server signs the AUTHORITATIVE outcome from its run state; use those exact values so the on-chain
    // settle matches the signature (the client can no longer inflate stage or claim a rob it did not earn).
    const useStage = (s.stage != null) ? s.stage : stage;
    const useRobbed = (s.robbed != null) ? s.robbed : robbed;
    const vault = new window.ethers.Contract(cfg.vault, VAULT_ABI, signer);
    const tx = await vault.settle(runId, useStage, useRobbed, s.serverSeed, s.sig); await tx.wait();
    let b1 = b0, e1 = e0; try { b1 = await rvlt.balanceOf(addr); } catch (_) {} try { e1 = await provider.getBalance(addr); } catch (_) {}
    await refresh();
    return { rvltWon: +window.ethers.formatUnits(b1 - b0, 18), ethWon: +window.ethers.formatEther(e1 > e0 ? e1 - e0 : 0n), serverSeed: s.serverSeed };
  }

  // V2 CORE CRACK (Jake 2026-09-07): at chamber 10 the winner CHOOSES one prize — takeEth => 100% ETH vault, else => 100% RVLT
  // pot. Reuses the SAME operator settle-sig the server already issues for (runId, 10, robbed=true); only the on-chain call
  // differs (crackCore instead of settle) plus the takeEth flag. Dormant until the RobbingTheVaultV2 upgrade is live on-chain.
  async function crackCore(runId, takeEth) {
    if (_settling) throw new Error('settlement already in progress');
    _settling = true;
    try {
      if (!signer) await connect();
      await ensureChain(); try { provider = new window.ethers.BrowserProvider(injected); signer = await provider.getSigner(); addr = await signer.getAddress(); } catch (_) {}
      const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, provider);
      let b0 = 0n, e0 = 0n; try { b0 = await rvlt.balanceOf(addr); } catch (_) {} try { e0 = await provider.getBalance(addr); } catch (_) {}
      const s = await api('api/onchain/settle-sig', { runId, stage: 10, robbed: true, captcha: '' });   // core is never captcha-gated
      if (s.error) throw new Error(s.error);
      const vault = new window.ethers.Contract(cfg.vault, VAULT_ABI, signer);
      const tx = await vault.crackCore(runId, !!takeEth, s.serverSeed, s.sig); await tx.wait();
      let b1 = b0, e1 = e0; try { b1 = await rvlt.balanceOf(addr); } catch (_) {} try { e1 = await provider.getBalance(addr); } catch (_) {}
      await refresh();
      return { rvltWon: +window.ethers.formatUnits(b1 - b0, 18), ethWon: +window.ethers.formatEther(e1 > e0 ? e1 - e0 : 0n), serverSeed: s.serverSeed, tookEth: !!takeEth };
    } finally { _settling = false; }
  }

  function ui() {
    const isMob = matchMedia('(pointer:coarse)').matches || innerWidth < 760;
    const btn = document.createElement('button');
    btn.id = 'ocSetupBtn';
    btn.textContent = '⛓ Setup';
    btn.style.cssText = 'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:61;background:rgba(0,3,8,.92);color:#3dff8f;border:1px solid rgba(61,255,143,.4);border-radius:20px;font-family:monospace;font-size:12px;padding:8px 14px;cursor:pointer';
    const panel = document.createElement('div');
    panel.id = 'ocSetupPanel';
    panel.style.cssText = isMob
      ? 'position:fixed;left:0;right:0;bottom:0;z-index:62;display:none;width:100%;max-height:78vh;overflow:auto;background:rgba(3,10,7,.985);border-top:1px solid rgba(61,255,143,.35);border-radius:18px 18px 0 0;padding:8px 16px calc(18px + env(safe-area-inset-bottom,0px));color:#cdead9;font-family:monospace;font-size:13px;box-shadow:0 -14px 44px rgba(0,0,0,.65)'
      : 'position:fixed;left:14px;bottom:56px;z-index:62;display:none;width:min(340px,92vw);max-height:82vh;overflow:auto;background:rgba(3,10,7,.97);border:1px solid rgba(61,255,143,.3);border-radius:12px;padding:14px;color:#cdead9;font-family:monospace;font-size:12px';
    panel.innerHTML =
      (isMob ? '<div style="width:38px;height:4px;border-radius:3px;background:rgba(61,255,143,.35);margin:2px auto 10px"></div>' : '') +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
        '<div style="font-family:\'Cinzel\',serif;font-weight:700;color:#3dff8f;font-size:15px">Testnet Setup</div>' +
        '<button id="ocClose" style="all:unset;cursor:pointer;color:#7fae93;font-size:20px;line-height:1;padding:2px 6px">×</button>' +
      '</div>' +
      '<div style="font-size:10.5px;color:#4e6857;margin-bottom:10px">Robinhood testnet · 3 steps to play</div>' +
      '<div id="ocReady" style="display:none;margin:0 0 10px;padding:9px 11px;border:1px solid rgba(61,255,143,.5);border-radius:9px;background:rgba(61,255,143,.12);color:#3dff8f;font-size:12px">✓ You are all set. Close this and play.</div>' +
      '<div style="margin:0 0 2px">' +
        '<div class="ocstep" id="ocs1"><span class="ock"></span><span><b>Connect</b> wallet (adds the network)</span></div>' +
        '<div class="ocstep" id="ocs2"><span class="ock"></span><span><b>Get gas ETH</b> (needed for every action)</span></div>' +
        '<div class="ocstep" id="ocs3"><span class="ock"></span><span><b>Get ROBINVAULT</b> (play-money token)</span></div>' +
      '</div>' +
      '<div style="font-size:10px;color:#4e6857;margin:6px 0 10px">Use MetaMask, Rabby or Coinbase.</div>' +
      ((isMob && !hasWallet()) ? '<button id="ocMM" class="ocb" style="width:100%;margin-bottom:10px;background:linear-gradient(180deg,#f6851b,#c65f0a);color:#fff;border-color:#f6851b;font-size:13px;padding:13px">📱 Open in MetaMask app ↗</button><div style="font-size:10px;color:#4e6857;margin:-4px 0 10px">No in-browser wallet detected. Tap above to open inside MetaMask, or use your wallet app\'s browser.</div>' : '') +
      '<div style="display:flex;gap:7px;flex-wrap:wrap">' +
      '<button id="ocConnect" class="ocb">1 · Connect</button><button id="ocFaucet" class="ocb">2 · Get gas</button><button id="ocMint" class="ocb">3 · ROBINVAULT</button>' +
      '<button id="ocAddNet" class="ocb ocb2">Add network</button><button id="ocRefresh" class="ocb ocb2">Refresh</button></div>' +
      '<div style="margin-top:12px;font-size:11px;color:#7fae93">wallet: <b id="ocAddr">not connected</b> <button id="ocSwitch" style="all:unset;cursor:pointer;color:#3dff8f;text-decoration:underline;text-underline-offset:2px;font-size:10px;margin-left:5px">switch</button></div><div id="ocBal" style="margin:3px 0;font-size:11px">—</div><div id="ocPot" style="color:#5f8a72;font-size:10.5px">—</div>' +
      '<div id="ocLog" style="margin-top:10px;max-height:110px;overflow:auto;font-size:10px;color:#7fae93;line-height:1.55"></div>';
    document.body.appendChild(btn); document.body.appendChild(panel);
    _setupBtn = btn; _setupPanel = panel;
    const bw = isMob ? 'flex:1 1 44%;min-width:120px;padding:12px 10px;font-size:12px;text-align:center' : '';
    const style = document.createElement('style'); style.textContent = '.ocb{background:rgba(61,255,143,.12);color:#3dff8f;border:1px solid rgba(61,255,143,.35);border-radius:9px;font-family:monospace;font-size:11px;padding:8px 11px;cursor:pointer;' + bw + '}.ocb.ocb2{background:rgba(61,255,143,.06);color:#7fae93}.ocb:active{background:rgba(61,255,143,.24)}.ocb.done{background:rgba(61,255,143,.22);border-color:#3dff8f}.ocstep{display:flex;align-items:flex-start;gap:9px;margin:6px 0;line-height:1.45;transition:color .25s}.ocstep b{color:#cdead9}.ock{flex:none;width:18px;height:18px;margin-top:1px;border:1.5px solid rgba(61,255,143,.4);border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#02140b;transition:.2s}.ocstep.done .ock{background:#3dff8f;border-color:#3dff8f}.ocstep.done .ock::after{content:"\\2713"}.ocstep.done{color:#5f8a72}.ocstep.done b{color:#7fae93}'; document.head.appendChild(style);
    const openPanel = v => { panel.style.display = v ? 'block' : 'none'; if (v && signer) refresh(); };
    btn.onclick = () => openPanel(panel.style.display === 'none');
    panel.querySelector('#ocClose').onclick = () => openPanel(false);
    { const sw = panel.querySelector('#ocSwitch'); if (sw) sw.onclick = () => { log('Disconnecting, choose a wallet…'); switchWallet().then(a => log('Switched to ' + short(a) + ' ✓')).catch(e => { if (/cancel/i.test(String(e && e.message || ''))) { log('Kept current wallet.'); return; } log('Error: ' + (e.shortMessage || e.message)); }); }; }
    elLog = panel.querySelector('#ocLog');
    markSteps();   // initial state (all unchecked)
    if (!_setupPoll) _setupPoll = setInterval(() => { if (signer) refresh(); }, 6000);   // poll while connected so the checklist ticks and the launcher auto-hides even if the sheet is closed
    const mmBtn = panel.querySelector('#ocMM'); if (mmBtn) mmBtn.onclick = () => { log('Opening in MetaMask…'); location.href = mmDeepLink(); };
    panel.querySelector('#ocConnect').onclick = () => {
      if (isMob && !hasWallet()) { log('No in-browser wallet, opening MetaMask…'); location.href = mmDeepLink(); return; }
      connect().then(a => log('Connected ' + short(a) + ' · network ready ✓')).catch(e => log('Error: ' + (e.shortMessage || e.message)));
    };
    panel.querySelector('#ocFaucet').onclick = async () => {
      try { if (addr) { await navigator.clipboard.writeText(addr); log('Address copied ✓ Paste it in the faucet, request ETH, then Refresh.'); } else { log('Connect first (step 1), then Get gas.'); } } catch (_) { log('Faucet opened. Paste your wallet address, request ETH, then Refresh.'); }
      window.open(FAUCET, '_blank', 'noopener');
    };
    panel.querySelector('#ocMint').onclick = () => { log('Minting 100,000 test ROBINVAULT…'); getTestRvlt().then(() => log('Got 100,000 ROBINVAULT ✓')).catch(e => log('Error: ' + (e.shortMessage || e.message) + (/gas|funds|insufficient/i.test(String(e.message || '')) ? ' - get gas ETH first (step 2).' : ''))); };
    panel.querySelector('#ocAddNet').onclick = async () => { try { await loadEthers(); if (!injected) injected = await pickWallet(); await addChain(); try { await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + cfg.chainId.toString(16) }] }); } catch (_) {} log('Robinhood testnet added to your wallet ✓'); } catch (e) { log('Error: ' + (e.shortMessage || e.message)); } };
    panel.querySelector('#ocRefresh').onclick = () => refresh();
    try { if (!localStorage.getItem('rtv_setup_seen')) { panel.style.display = 'block'; localStorage.setItem('rtv_setup_seen', '1'); } } catch (_) {}   // auto-open the setup panel on a teammate's first visit
  }

  // ── Vault Robbers NFT mint (easter egg at the teller desk, chamber 5) ──
  // Read-only snapshot for the overlay: supply minted, this wallet's count, whether mint is open.
  async function robbersState() {
    if (!cfg || !cfg.robbers) return null;
    try { const s = await api('api/onchain/robbers-state' + (addr ? ('?address=' + addr) : '')); return (s && !s.error) ? s : null; }   // server-proxied read (no browser RPC)
    catch (e) { return null; }
  }
  // The mint itself: ensure wallet + chain, top up test tRVLT if short, bounded approve, then mint(qty).
  async function mintRobbers(qty) {
    if (!cfg || !cfg.robbers) throw new Error('Vault Robbers mint is not configured');
    qty = Math.max(1, Math.min(cfg.robbersMax || 3, qty | 0));
    if (!signer) await connect();
    await ensureChain();
    const gasBal = await provider.getBalance(addr).catch(() => null);   // gas is pushed to the user; warn early if they have none
    if (gasBal === 0n) throw new Error('You need ETH for gas on Robinhood Chain. Fund your wallet, then mint.');
    const robbers = new window.ethers.Contract(cfg.robbers, ROBBERS_ABI, signer);
    // exact cost across any tier boundary, read on-chain; approval bounded to the max any 3 could cost
    let cost; try { cost = await robbers.quote(qty); } catch (_) { cost = window.ethers.parseUnits(String(cfg.robbersPrice || '77777'), 18) * BigInt(qty); }
    const capApprove = window.ethers.parseUnits('150000', 18) * BigInt(cfg.robbersMax || 3); // highest tier × max mint — bounded, never unlimited
    const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, signer);
    let bal = 0n; try { bal = await rvlt.balanceOf(addr); } catch (_) {}   // a flaky mobile eth_call returning 0x must not brick the mint before the tx; the tx itself stays authoritative
    if (bal < cost) { try { log('Minting test tRVLT…'); const m = await rvlt.mint(addr, capApprove); await m.wait(); } catch (_) {} }
    let curAllow = 0n; try { curAllow = await rvlt.allowance(addr, cfg.robbers); } catch (_) {}
    if (curAllow < cost) { log('Approving ROBINVAULT…'); const tx = await rvlt.approve(cfg.robbers, capApprove); await tx.wait(); }
    // WEBSITE GATE: the contract rejects any mint without a fresh voucher signed by our backend. Ask the
    // server to authorize this wallet — it only signs if you actually reached the teller in a real run.
    log('Authorizing at the teller…');
    const _capM = await turnstileToken();   // human check at the mint gate
    const v = await api('api/onchain/robbers-voucher', { minter: addr, qty, captcha: _capM });
    if (!v || v.error || !v.signature) throw new Error((v && v.error) || 'The teller would not authorize this mint.');
    qty = v.qty || qty;   // server may trim to your remaining wallet cap
    log('Minting ' + qty + ' Vault Robber' + (qty > 1 ? 's' : '') + '…');
    const tx = await robbers.mint(qty, v.deadline, v.signature); await tx.wait();
    log('Robbed ✓ ' + short(tx.hash));
    return { hash: tx.hash, qty };
  }

  // The Vault Robbers this wallet owns, with each token's on-chain image (for the in-game gallery).
  async function myRobbers() {
    if (!cfg || !cfg.robbers || !addr) return [];
    try { const r = await api('api/onchain/robbers-gallery?address=' + addr); return (r && r.items) || []; }   // server-proxied read (no browser RPC)
    catch (e) { return []; }
  }

  // ── ERC-6551 SAC (token-bound loot wallet per Robber) ──
  const REG6551_ABI = [
    'function account(address,bytes32,uint256,address,uint256) view returns (address)',
    'function createAccount(address,bytes32,uint256,address,uint256) returns (address)'
  ];
  const SALT6551 = '0x' + '00'.repeat(32);
  async function sacAddress(tokenId) {   // deterministic ERC-6551 address — server-proxied read (no browser RPC)
    if (!cfg || !cfg.sacRegistry || !cfg.sacImpl) return null;
    try { const r = await api('api/onchain/sac-address?tokenId=' + encodeURIComponent(tokenId)); return (r && r.addr) || null; }
    catch (e) { return null; }
  }
  async function sacInfo(tokenId) {   // server-proxied read (no browser RPC)
    try { const r = await api('api/onchain/sac-info?tokenId=' + encodeURIComponent(tokenId)); return (r && r.addr) ? r : null; }
    catch (e) { return null; }
  }
  async function createSac(tokenId) {
    if (!cfg || !cfg.sacRegistry || !cfg.sacImpl) throw new Error('SAC not configured');
    if (!signer) await connect();
    await ensureChain();
    const reg = new window.ethers.Contract(cfg.sacRegistry, REG6551_ABI, signer);
    log('Opening SAC for Robber #' + tokenId + '…');
    const tx = await reg.createAccount(cfg.sacImpl, SALT6551, cfg.chainId, cfg.robbers, tokenId); await tx.wait();
    log('SAC opened ✓ ' + short(tx.hash));
    return await sacAddress(tokenId);
  }

  // Deposit ROBINVAULT into a Robber's SAC (just an ERC-20 transfer to the SAC address).
  async function sacDepositRvlt(tokenId, amount) {
    if (!signer) await connect(); await ensureChain();
    const a = await sacAddress(tokenId);
    const amt = window.ethers.parseUnits(String(amount), 18);
    const rvlt = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, signer);
    log('Depositing ' + amount + ' ROBINVAULT into SAC…');
    const tx = await rvlt.transfer(a, amt); await tx.wait(); log('Deposited ✓ ' + short(tx.hash));
    return tx.hash;
  }
  // Deposit ETH into a Robber's SAC (a plain value transfer to the SAC address).
  async function sacDepositEth(tokenId, amount) {
    if (!signer) await connect(); await ensureChain();
    const a = await sacAddress(tokenId);
    log('Depositing ' + amount + ' ETH into SAC…');
    const tx = await signer.sendTransaction({ to: a, value: window.ethers.parseEther(String(amount)) }); await tx.wait();
    log('Deposited ✓ ' + short(tx.hash));
    return tx.hash;
  }
  // "Empty the sack" — the Robber owner pulls all ROBINVAULT + ETH out of its SAC via execute().
  async function sacWithdraw(tokenId) {
    if (!signer) await connect(); await ensureChain();
    const a = await sacAddress(tokenId);
    const rp = provider;   // withdraw requires a connected wallet, so read via the user's own wallet provider (acceptable — not an app-constructed RPC)
    const code = await rp.getCode(a);
    if (!code || code === '0x') throw new Error('Open the SAC first');
    const sac = new window.ethers.Contract(a, ['function execute(address,uint256,bytes,uint8) payable returns (bytes)'], signer);
    const rvltRo = new window.ethers.Contract(cfg.rvlt, RVLT_ABI, rp);
    const bal = await rvltRo.balanceOf(a);
    if (bal > 0n) { const data = new window.ethers.Interface(RVLT_ABI).encodeFunctionData('transfer', [addr, bal]); log('Emptying ROBINVAULT from SAC…'); await (await sac.execute(cfg.rvlt, 0, data, 0)).wait(); }
    const eth = await rp.getBalance(a);
    if (eth > 0n) { log('Emptying ETH from SAC…'); await (await sac.execute(addr, eth, '0x', 0)).wait(); }
    if (bal === 0n && eth === 0n) throw new Error('SAC is already empty');
    log('SAC emptied ✓');
    return true;
  }

  window.RTV_OC = { enabled: false, connect, disconnect, switchWallet, ensureReady, enterRun, compEnterRun, compStatus, settleRun, crackCore, getTestRvlt, refresh, chainState, log, pickWallet, walletList, silentReconnect, robbersState, mintRobbers, myRobbers, sacAddress, sacInfo, createSac, sacDepositRvlt, sacDepositEth, sacWithdraw, arcadeStatus, payArcade, get connected() { return !!signer; }, get address() { return addr; }, get cfg() { return cfg; } };
  api('api/onchain/config').then(async c => {
    cfg = c; window.RTV_OC.enabled = true;
    // Setup panel (⛓ Setup, bottom-left) is a TESTNET onboarding helper (connect / faucet gas / mint 100k test tokens).
    // Only render it on the real testnet (46630); never on mainnet (4663) where it's just clutter. AUDIT (2026-09-04): its
    // scariest surface, the "Get ROBINVAULT" mint, calls rvlt.mint() which REVERTS on the mainnet token (fixed/finalized
    // supply — static-called mint() reverts for both a random caller AND the deployer), so it was never exploitable for free
    // tokens; this is a cleanliness removal, not a security patch. The testnet twin still needs the helper. Reads stay guarded
    // (log/markSteps/refresh all no-op without the panel), so skipping ui() on mainnet is safe.
    if (Number(cfg && cfg.chainId) === 46630) ui();
    try { await loadEthers(); } catch (e) {}   // ethers loaded for signing/writes only; all reads are server-proxied now (no browser RPC)
    silentReconnect();   // restore a prior wallet session on refresh (no popup) so on-chain runs can be resumed and settled
  }).catch(() => {});
})();

// Vault Robbers mint hub — server (testnet scaffold, Jake 2026-09-20 retirement pivot).
// Pay in any currency (Wrapping Companion + Relay, client side) -> Robinhood ETH -> RVLT -> mint on the EXISTING
// Vault Robbers contract. This server does the read-only + signing side: live tier/quote (contract + RVLT price +
// runtime USD buffer), a runtime-CONFIGURABLE config store (buffer %, skim address, price override, enabled) so we
// can change the buffer without a redeploy, and EIP-712 mint-voucher signing. NEVER serves its own source dir.
const express = require('express');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
// SECURITY HEADERS (mirrors the Vault Standoff M-1 block, tuned for the hub's external loads: Twitter embeds,
// Google Fonts, and browser wallet RPC/Relay calls — the client is vendored locally so no module CDN is allowed in
// script-src). Anti-clickjacking (frame-ancestors
// + X-Frame-Options), anti-MIME-sniff, tight referrer, and a CSP that blocks EXTERNAL script injection beyond the
// known origins. The proxied /play/* games set their OWN headers, so we skip them here to avoid double/conflicting CSP.
const HUB_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; script-src 'self' 'unsafe-inline' https://platform.twitter.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://platform.twitter.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' ws: wss: https:; frame-src https://platform.twitter.com https://twitter.com https://x.com;";
app.use((req, res, next) => {
  if ((req.path || '').indexOf('/play/') === 0) return next();   // proxied games set their own security headers
  res.setHeader('Content-Security-Policy', HUB_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ── PRE-LAUNCH PASSWORD GATE (config-driven, upgradable via admin) ──────────────────────────────
// One shared password protects the ENTIRE site (hub + both games + every API) until launch. Runs
// before the game proxies so nothing is reachable un-authed. The password is submitted by POSTing
// to whatever URL you are on, so it works at the root, on a custom domain, and on deep /play links.
const crypto = require('crypto');
const fs0 = require('fs');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
// Server-held random secret for deriving session cookie tokens via HMAC (NOT from the password hash, so a leaked
// pw hash can't be turned into a valid cookie). Persisted to a sibling file so sessions survive a restart; falls
// back to a per-boot random value if the file can't be written (sessions then reset on restart — acceptable).
const SECRET_FILE = require('path').join(__dirname, '.gate-secret');
const GATE_SECRET = (() => {
  try { const s = fs0.readFileSync(SECRET_FILE, 'utf8').trim(); if (s && s.length >= 32) return s; } catch (_) {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs0.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); } catch (_) {}
  return s;
})();
// Password hashing: scrypt with a random salt, stored as 'scrypt$<saltHex>$<hashHex>'. Legacy bare-SHA256 hashes
// are still accepted (one-way upgrade on next password change) so an already-set password keeps working.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    let salt, want;
    try { salt = Buffer.from(parts[1], 'hex'); want = Buffer.from(parts[2], 'hex'); } catch (_) { return false; }
    let got; try { got = crypto.scryptSync(String(pw), salt, want.length); } catch (_) { return false; }
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  // Legacy single-round SHA-256 (constant-time compare).
  const got = Buffer.from(sha(pw), 'hex'); const want = Buffer.from(String(stored), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Cookie token = HMAC-SHA256(secret, storedHash) — bound to the current password (changing it invalidates old
// cookies) but NOT derivable from the password hash alone. Compared constant-time.
function gateToken(pwHash) { return crypto.createHmac('sha256', GATE_SECRET).update(String(pwHash) + ':vr-gate-v2').digest('hex'); }
function gateTokenOk(got, pwHash) {
  const want = gateToken(pwHash);
  if (typeof got !== 'string' || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}
function parseCookies(req) { const h = req.headers.cookie || ''; const o = {}; h.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
// The GATE now serves the PUBLIC landing page (ported from robbingthevault.com) to un-authed visitors: animated
// masks, cycling whispers, a LIVE ROBINVAULT burn counter (fed by the ungated /api/landing-burns), fee-burn line,
// chips, and social buttons. A SUBTLE "Enter the vault" link near the bottom (and clicking the center mask) reveals
// an inline password field; submitting it POSTs {password} as JSON to the current URL, which the gate middleware
// below handles (sets the vr_gate cookie, returns {ok:true}), then the client reloads into the real app.
const GATE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault Robbers</title>
<meta name="description" content="Something is moving behind the vault door. 1,000 masks, one vault, and the burn never stops.">
<meta property="og:title" content="Vault Robbers">
<meta property="og:description" content="The old game is ash. Something wears its mask now. ROBINVAULT is burning right now.">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Londrina+Solid:wght@400;900&family=Patrick+Hand&display=swap" rel="stylesheet">
<style>
  :root{--paper:#f3e3ca;--paper2:#eedaba;--ink:#17130d;--muted:#7c6f5a;--blue:#2ea65a;--blue-d:#1f7d43;--tee:#fbfaf6;--ember:#e07a3c}
  *{box-sizing:border-box}html,body{margin:0}
  body{min-height:100vh;overflow-x:hidden;color:var(--ink);
    background:radial-gradient(130% 120% at 50% -10%,#f8ecd6 0%,var(--paper) 52%,#e6cfa6 100%);
    font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
  body:before{content:"";position:fixed;inset:0;pointer-events:none;z-index:1;opacity:.05;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
  body:after{content:"";position:fixed;inset:0;pointer-events:none;z-index:1;
    background:radial-gradient(120% 90% at 50% 40%,transparent 52%,rgba(23,19,13,.18) 100%)}
  .bg{position:fixed;inset:-40px;overflow:hidden;z-index:0;pointer-events:none;transition:transform .3s ease-out}
  .gm{position:absolute;border-radius:50%;background:var(--blue);border:3px solid var(--ink);opacity:.08}
  .gm:before,.gm:after{content:"";position:absolute;top:38%;width:16%;height:18%;background:var(--tee);border:2px solid var(--ink);border-radius:50%}
  .gm:before{left:24%}.gm:after{right:24%}
  .gm1{width:150px;height:150px;left:6%;top:12%;animation:drift1 22s ease-in-out infinite}
  .gm2{width:90px;height:90px;right:9%;top:20%;animation:drift2 18s ease-in-out infinite}
  .gm3{width:210px;height:210px;right:4%;bottom:8%;animation:drift1 27s ease-in-out infinite}
  .gm4{width:70px;height:70px;left:12%;bottom:14%;animation:drift2 15s ease-in-out infinite}
  @keyframes drift1{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-26px) rotate(4deg)}}
  @keyframes drift2{0%,100%{transform:translateY(0) rotate(5deg)}50%{transform:translateY(22px) rotate(-5deg)}}
  .snd{position:fixed;top:14px;right:14px;z-index:6;width:44px;height:44px;border-radius:50%;border:2.5px solid var(--ink);
    background:var(--tee);box-shadow:3px 3px 0 var(--ink);cursor:pointer;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;transition:transform .06s,box-shadow .06s}
  .snd:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--ink)}
  .snd.hint{animation:sndhint 2.2s ease-in-out infinite}
  @keyframes sndhint{0%,100%{box-shadow:3px 3px 0 var(--ink)}50%{box-shadow:3px 3px 0 var(--ink),0 0 0 6px rgba(46,166,90,.25)}}
  .wrap{position:relative;z-index:2;max-width:660px;margin:0 auto;padding:52px 18px 74px}
  .kick{font-family:'Patrick Hand',cursive;font-size:14px;letter-spacing:4px;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
  .hero{position:relative;width:150px;height:150px;margin:0 auto}
  .dial{position:absolute;inset:-14px;border-radius:50%;border:3px dashed var(--ink);opacity:.4;animation:spin 26s linear infinite}
  .dial:before{content:"";position:absolute;top:-7px;left:50%;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:var(--blue);border:2px solid var(--ink)}
  @keyframes spin{to{transform:rotate(360deg)}}
  .robber{width:150px;height:150px;margin:0 auto;display:block;cursor:pointer;animation:bob 4.2s ease-in-out infinite;filter:drop-shadow(5px 6px 0 rgba(23,19,13,.22))}
  .robber svg{width:100%;height:100%;display:block}
  @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
  h1{font-family:'Londrina Solid',cursive;font-weight:900;font-size:clamp(36px,8.5vw,60px);line-height:.92;margin:22px 0 6px;letter-spacing:.5px;transform:rotate(-1.2deg)}
  .whisper{font-family:'Patrick Hand',cursive;font-size:20px;color:var(--blue-d);min-height:30px;margin:6px auto 20px;max-width:500px;transition:opacity .5s}
  .redact{font-family:'Patrick Hand',cursive;font-size:16px;color:var(--muted);margin:0 auto 26px;max-width:520px;letter-spacing:.3px}
  .redact .lbl{color:var(--blue-d)}
  .rd{background:var(--ink);color:transparent;border-radius:4px;padding:0 7px;margin:0 2px;user-select:none;box-shadow:2px 2px 0 rgba(23,19,13,.2);transition:color .25s,background .25s}
  .rd:hover{background:#2a2318;color:rgba(251,250,246,.35)}
  .cx{position:relative;background:var(--tee);border:3px solid var(--ink);border-radius:20px;box-shadow:7px 7px 0 var(--ink);padding:22px 18px 46px;margin:0 auto 16px;max-width:560px;overflow:hidden}
  .cx .tag{display:inline-flex;align-items:center;gap:8px;font-family:'Patrick Hand',cursive;font-size:14px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  .dot{width:9px;height:9px;border-radius:50%;background:#c2432f;box-shadow:0 0 0 0 rgba(194,67,47,.6);animation:pulse 1.6s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(194,67,47,.6)}70%{box-shadow:0 0 0 10px rgba(194,67,47,0)}100%{box-shadow:0 0 0 0 rgba(194,67,47,0)}}
  .big{font-family:'Londrina Solid',cursive;font-size:clamp(38px,10vw,68px);line-height:1;color:var(--ink);letter-spacing:1px;position:relative;z-index:1;text-shadow:0 0 16px rgba(224,122,60,.5),0 0 30px rgba(194,67,47,.32)}
  .big.flick{animation:flick .5s}
  @keyframes flick{0%{color:var(--ink)}30%{color:var(--ember)}100%{color:var(--ink)}}
  .bigsub{font-family:'Patrick Hand',cursive;font-size:15px;color:var(--muted);margin-top:4px;position:relative;z-index:1}
  .rate{font-family:'Patrick Hand',cursive;font-size:14px;color:var(--blue-d);margin-top:8px;position:relative;z-index:1}
  .tag{position:relative;z-index:1}
  .ember{position:absolute;bottom:14px;width:7px;height:7px;border-radius:50%;background:var(--ember);opacity:0;pointer-events:none;filter:blur(.3px)}
  @keyframes rise{0%{opacity:0;transform:translateY(0) scale(1)}12%{opacity:.85}100%{opacity:0;transform:translateY(-90px) scale(.3)}}
  .cx:before{content:"";position:absolute;left:50%;bottom:-30px;transform:translateX(-50%);width:70%;height:120px;z-index:0;pointer-events:none;
    background:radial-gradient(ellipse at 50% 100%,rgba(224,122,60,.55) 0%,rgba(194,67,47,.28) 40%,transparent 72%);animation:heat 2.4s ease-in-out infinite}
  @keyframes heat{0%,100%{opacity:.7;transform:translateX(-50%) scaleY(1)}50%{opacity:1;transform:translateX(-50%) scaleY(1.12)}}
  .fire{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);display:flex;align-items:flex-end;gap:5px;z-index:0;pointer-events:none;filter:blur(.6px)}
  .flame{width:16px;height:34px;border-radius:50% 50% 50% 50%/62% 62% 40% 40%;transform-origin:50% 100%;opacity:.9;
    background:radial-gradient(circle at 50% 78%,#ffe07a 0%,#f5a623 38%,#e07a3c 62%,#c2432f 82%,transparent 100%);
    animation:flame 1.05s ease-in-out infinite}
  .flame:nth-child(2){height:48px;width:20px;animation-duration:.9s;animation-delay:.15s}
  .flame:nth-child(3){height:60px;width:24px;animation-duration:1.2s;animation-delay:.35s}
  .flame:nth-child(4){height:48px;width:20px;animation-duration:.85s;animation-delay:.1s}
  .flame:nth-child(5){height:34px;animation-duration:1.15s;animation-delay:.25s}
  @keyframes flame{0%,100%{transform:scaleY(1) scaleX(1) skewX(0);opacity:.85}25%{transform:scaleY(1.28) scaleX(.9) skewX(3deg);opacity:1}50%{transform:scaleY(.92) scaleX(1.06) skewX(-3deg);opacity:.8}75%{transform:scaleY(1.18) scaleX(.94) skewX(2deg);opacity:.95}}
  .burns{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin:0 auto 8px;max-width:560px}
  .b{background:var(--tee);border:2.5px solid var(--ink);border-radius:14px;padding:13px 9px;box-shadow:4px 4px 0 var(--ink);transition:transform .1s}
  .b:hover{transform:translateY(-3px)}
  .b .k{font-family:'Patrick Hand',cursive;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .b .v{font-family:'Londrina Solid',cursive;font-size:clamp(19px,5vw,27px);color:var(--ink);margin-top:3px}
  .b .u{font-size:11px;color:var(--muted);margin-top:2px}
  @media(max-width:480px){.burns{grid-template-columns:1fr;max-width:280px}}
  .feeburn{margin:16px auto 0;max-width:560px;font-family:'Patrick Hand',cursive;font-size:clamp(16px,4vw,20px);
    background:linear-gradient(180deg,#fff3df,#ffe4c2);border:2.5px solid var(--ink);border-radius:13px;padding:12px 16px;box-shadow:5px 5px 0 var(--ink)}
  .feeburn b{color:#c2432f}
  .chips{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;margin:24px auto 30px;max-width:600px}
  .chip{font-family:'Patrick Hand',cursive;font-size:15px;background:var(--paper2);border:2.5px solid var(--ink);border-radius:11px;padding:7px 13px;box-shadow:3px 3px 0 var(--ink);cursor:default;transition:transform .06s,box-shadow .06s}
  .chip:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--ink)}
  .chip b{color:var(--blue-d)}
  a.btn{display:inline-block;font-family:'Patrick Hand',cursive;font-size:20px;padding:14px 30px;border:3px solid var(--ink);border-radius:14px;
    text-decoration:none;background:var(--blue);color:var(--tee);box-shadow:6px 6px 0 var(--ink);transition:transform .07s,box-shadow .07s}
  a.btn:active{transform:translate(6px,6px);box-shadow:0 0 0 var(--ink)}
  .social{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:16px}
  .sbtn{display:inline-flex;align-items:center;gap:8px;font-family:'Patrick Hand',cursive;font-size:17px;padding:11px 20px;
    border:2.5px solid var(--ink);border-radius:12px;text-decoration:none;background:var(--tee);color:var(--ink);
    box-shadow:4px 4px 0 var(--ink);transition:transform .06s,box-shadow .06s}
  .sbtn:active{transform:translate(4px,4px);box-shadow:0 0 0 var(--ink)}
  .sbtn .ic{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;background:var(--ink);color:var(--tee);font-size:13px;font-weight:700}
  .sbtn.tg .ic{background:var(--blue)}
  .foot{margin-top:26px;font-family:'Patrick Hand',cursive;font-size:14px;color:var(--muted)}
  /* subtle, discoverable vault entry */
  .enter{margin-top:22px}
  .enterlink{font-family:'Patrick Hand',cursive;font-size:14px;color:var(--muted);background:none;border:none;cursor:pointer;
    letter-spacing:.5px;opacity:.55;transition:opacity .25s,color .25s;text-decoration:underline dotted}
  .enterlink:hover{opacity:1;color:var(--blue-d)}
  .vaultbox{display:none;max-width:320px;margin:14px auto 0;gap:8px;flex-direction:column;align-items:stretch}
  .vaultbox.open{display:flex}
  .vaultbox input{width:100%;padding:12px;border:2.5px solid var(--ink);border-radius:11px;background:var(--tee);color:var(--ink);font-size:16px;box-shadow:3px 3px 0 var(--ink);font-family:'Patrick Hand',cursive}
  .vaultbox button{padding:12px;border:2.5px solid var(--ink);border-radius:11px;background:var(--blue);color:var(--tee);font-family:'Patrick Hand',cursive;font-size:18px;cursor:pointer;box-shadow:4px 4px 0 var(--ink)}
  .vaultbox button:active{transform:translate(4px,4px);box-shadow:0 0 0 var(--ink)}
  #gmsg{font-family:'Patrick Hand',cursive;color:#c2432f;min-height:18px;font-size:14px}
</style>
</head>
<body>
  <div class="bg" id="bg"><div class="gm gm1"></div><div class="gm gm2"></div><div class="gm gm3"></div><div class="gm gm4"></div></div>
  <button class="snd hint" id="snd" title="Sound">&#128264;</button>
  <div class="wrap">
    <div class="kick">Robbing the Vault</div>
    <div class="hero"><div class="dial"></div><div class="robber" id="mask" title="Enter the vault"><svg viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg"><path d="M60 8 C95 8 108 36 108 70 L108 132 L12 132 L12 70 C12 36 25 8 60 8 Z" fill="#17130d"/><ellipse cx="60" cy="64" rx="34" ry="38" fill="#fbfaf6" stroke="#17130d" stroke-width="3"/><rect x="24" y="52" width="72" height="26" rx="9" fill="#2ea65a" stroke="#17130d" stroke-width="3"/><ellipse cx="46" cy="65" rx="8" ry="9" fill="#fbfaf6" stroke="#17130d" stroke-width="2.5"/><ellipse cx="74" cy="65" rx="8" ry="9" fill="#fbfaf6" stroke="#17130d" stroke-width="2.5"/><circle cx="46" cy="65" r="3" fill="#17130d"/><circle cx="74" cy="65" r="3" fill="#17130d"/><path d="M58 85 l2 -6 l2 6 z" fill="#17130d"/><g stroke="#17130d" stroke-width="2"><line x1="50" y1="95" x2="70" y2="95"/><line x1="56" y1="93" x2="56" y2="99"/><line x1="64" y1="93" x2="64" y2="99"/></g></svg></div></div>
    <h1>SOMETHING IS MOVING<br>BEHIND THE DOOR</h1>
    <div class="whisper" id="whisper">The old game is ash. Something wears its mask now.</div>

    <div class="redact"><span class="lbl">// intercepted:</span> "…the <span class="rd">house</span> is gone. now they play <span class="rd">each&nbsp;other</span>. <span class="rd">1,000</span> masks, one <span class="rd">vault</span>, and the burn never <span class="rd">stops</span>…"</div>

    <div class="cx" id="cx">
      <div class="tag"><span class="dot"></span> ROBINVAULT burning live</div>
      <div class="big" id="big">…</div>
      <div class="bigsub" id="bigsub">total burned</div>
      <div class="rate" id="rate"></div>
      <div class="fire"><span class="flame"></span><span class="flame"></span><span class="flame"></span><span class="flame"></span><span class="flame"></span></div>
    </div>
    <div class="burns">
      <div class="b"><div class="k">Burned today</div><div class="v" id="d">…</div><div class="u" id="dp">of supply</div></div>
      <div class="b"><div class="k">This week</div><div class="v" id="w">…</div><div class="u" id="wp">of supply</div></div>
      <div class="b"><div class="k">Total burned</div><div class="v" id="t">…</div><div class="u" id="tp">of supply</div></div>
    </div>

    <div class="feeburn">&#128293; <b>100% of creator fees</b> buy &amp; burn ROBINVAULT</div>

    <div class="chips">
      <div class="chip">Something wears the <b>mask</b></div>
      <div class="chip">No <b>house</b> to rob this time</div>
      <div class="chip"><b>Earned</b>, never gambled</div>
      <div class="chip"><b>1,000</b> will be chosen</div>
      <div class="chip">The burn <b>never sleeps</b></div>
    </div>

    <div><a class="btn" id="cta" href="https://x.com/Jakegallen/status/2100641797374631991" target="_blank" rel="noopener">Read the latest dispatch</a></div>
    <div class="social">
      <a class="sbtn xf" id="xf" href="https://x.com/intent/follow?screen_name=Jakegallen" target="_blank" rel="noopener"><span class="ic">&#120143;</span> Follow on X</a>
      <a class="sbtn tg" id="tg" href="https://t.me/vaultrobbers" target="_blank" rel="noopener"><span class="ic">&#9992;</span> Telegram</a>
      <a class="sbtn dx" id="dx" href="https://dexscreener.com/robinhood/0xcc31c5acf0db55d391a9d97171c6bcc549ec7974540e84dddaaf0cabd3384697" target="_blank" rel="noopener"><span class="ic">&#128200;</span> Dexscreener</a>
    </div>

    <div class="enter">
      <button class="enterlink" id="enterlink">enter the vault</button>
      <div class="vaultbox" id="vaultbox">
        <input id="pw" type="password" placeholder="password" autocomplete="current-password">
        <button id="go">Unlock</button>
        <div id="gmsg"></div>
      </div>
    </div>

    <div class="foot">Follow the crew. Watch the vault.</div>
  </div>
<script>
  var $=function(id){return document.getElementById(id);};
  var fmt=function(n){ n=n||0; var a=Math.abs(n);
    if(a>=1e9)return (n/1e9).toFixed(2)+'B'; if(a>=1e6)return (n/1e6).toFixed(2)+'M';
    if(a>=1e3)return (n/1e3).toFixed(1)+'K'; return Math.round(n).toLocaleString(); };
  var pctf=function(p){ if(p==null)return 'of supply'; return (p>=1?p.toFixed(0):p.toFixed(3))+'% of supply'; };

  /* ---- procedural sound (Web Audio, no files) ---- */
  var AC=null, master=null, soundOn=false;
  function ensureAC(){ if(AC)return; try{ AC=new (window.AudioContext||window.webkitAudioContext)(); master=AC.createGain(); master.gain.value=0; master.connect(AC.destination);
    var g=AC.createGain(); g.gain.value=0.05; var lp=AC.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=280;
    var o1=AC.createOscillator(); o1.type='sine'; o1.frequency.value=55; var o2=AC.createOscillator(); o2.type='triangle'; o2.frequency.value=55.4;
    o1.connect(g); o2.connect(g); g.connect(lp); lp.connect(master);
    var lfo=AC.createOscillator(); lfo.frequency.value=0.07; var lg=AC.createGain(); lg.gain.value=60; lfo.connect(lg); lg.connect(lp.frequency);
    o1.start(); o2.start(); lfo.start();
  }catch(e){} }
  function blip(freq,dur,vol){ if(!soundOn||!AC)return; try{ var o=AC.createOscillator(),g=AC.createGain(); o.frequency.value=freq; o.type='sine'; o.connect(g); g.connect(master); var t=AC.currentTime; g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(vol,t+0.008); g.gain.exponentialRampToValueAtTime(0.0001,t+dur); o.start(t); o.stop(t+dur+0.03);}catch(e){} }
  function noise(dur,vol,f,q){ if(!soundOn||!AC)return; try{ var nn=AC.createBufferSource(); var buf=AC.createBuffer(1,AC.sampleRate*dur,AC.sampleRate); var dd=buf.getChannelData(0); for(var i=0;i<dd.length;i++)dd[i]=(Math.random()*2-1); nn.buffer=buf; var bp=AC.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=f||1200; bp.Q.value=q||1; var g=AC.createGain(); var t=AC.currentTime; g.gain.setValueAtTime(vol,t); g.gain.exponentialRampToValueAtTime(0.0001,t+dur); nn.connect(bp); bp.connect(g); g.connect(master); nn.start(t); nn.stop(t+dur);}catch(e){} }
  function whoosh(){ if(!soundOn||!AC)return; try{ var nn=AC.createBufferSource(); var dur=0.5; var buf=AC.createBuffer(1,AC.sampleRate*dur,AC.sampleRate); var dd=buf.getChannelData(0); for(var i=0;i<dd.length;i++)dd[i]=(Math.random()*2-1); nn.buffer=buf; var bp=AC.createBiquadFilter(); bp.type='bandpass'; bp.Q.value=6; var t=AC.currentTime; bp.frequency.setValueAtTime(300,t); bp.frequency.exponentialRampToValueAtTime(2600,t+dur); var g=AC.createGain(); g.gain.setValueAtTime(0.09,t); g.gain.exponentialRampToValueAtTime(0.0001,t+dur); nn.connect(bp); bp.connect(g); g.connect(master); nn.start(t); nn.stop(t+dur);}catch(e){} }
  function setSound(on){ soundOn=on; if(on){ ensureAC(); if(AC&&AC.state==='suspended')AC.resume(); if(master)master.gain.linearRampToValueAtTime(0.5,AC.currentTime+0.4); $('snd').innerHTML='&#128266;'; $('snd').classList.remove('hint'); } else { if(master&&AC)master.gain.linearRampToValueAtTime(0,AC.currentTime+0.2); $('snd').innerHTML='&#128264;'; } try{localStorage.setItem('vr_snd',on?'1':'0');}catch(e){} }
  $('snd').onclick=function(){ setSound(!soundOn); if(soundOn)blip(660,0.12,0.12); };

  document.querySelectorAll('.chip').forEach(function(c){ c.addEventListener('pointerenter',function(){ blip(720+Math.random()*180,0.05,0.05); }); });
  $('cta').addEventListener('pointerenter',function(){ blip(520,0.07,0.06); });
  ['xf','tg','dx'].forEach(function(id){ var el=$(id); if(el)el.addEventListener('pointerenter',function(){ blip(600,0.06,0.05); }); });

  var bg=$('bg');
  window.addEventListener('pointermove',function(e){ var x=(e.clientX/window.innerWidth-0.5), y=(e.clientY/window.innerHeight-0.5); bg.style.transform='translate('+(-x*24)+'px,'+(-y*24)+'px)'; });

  var WH=['The old game is ash. Something wears its mask now.','They say the vault learned to fight back.','Not luck. Never luck.','You will not be robbing the house this time.','The door only opens for those who earn it.','1,000 will wear the mask. The rest will watch.','Every crew leaves its mark on-chain.','Watch the burn. It is counting toward something.'];
  var wi=0, wel=$('whisper');
  setInterval(function(){ wi=(wi+1)%WH.length; wel.style.opacity=0; whoosh(); setTimeout(function(){ wel.textContent=WH[wi]; wel.style.opacity=1; },500); },4200);

  var cx=$('cx');
  function ember(){ if(document.hidden)return; var e=document.createElement('span'); e.className='ember'; e.style.left=(12+Math.random()*76)+'%'; var dur=1.6+Math.random()*1.4; e.style.animation='rise '+dur+'s ease-out forwards'; cx.appendChild(e); setTimeout(function(){ e.remove(); },dur*1000+50); }
  setInterval(ember,600);

  function countTo(el,to,dur){ var t0=null; function step(ts){ if(!t0)t0=ts; var k=Math.min(1,(ts-t0)/dur); el.textContent=fmt(to*(0.15+0.85*k)); if(k<1)requestAnimationFrame(step); else el.textContent=fmt(to); } requestAnimationFrame(step); }
  fetch('api/landing-burns').then(function(r){return r.json();}).then(function(b){
    $('d').textContent=fmt(b.daily); $('w').textContent=fmt(b.weekly); $('t').textContent=fmt(b.total);
    $('dp').textContent=pctf(b.dailyPct); $('wp').textContent=pctf(b.weeklyPct); $('tp').textContent=pctf(b.totalPct);
    countTo($('big'),b.total,1200);
    $('bigsub').textContent=(b.totalPct?b.totalPct.toFixed(0)+'% of all ROBINVAULT gone forever':'total burned');
    var perSec=(b.daily||0)/86400, start=Date.now(), base=b.total||0, lastWhole=Math.floor(base);
    if(perSec>0){
      $('rate').textContent='+'+fmt(b.daily/1440)+' burned every minute';
      setInterval(function(){ var live=base+perSec*((Date.now()-start)/1000); $('big').textContent=fmt(live);
        var w=Math.floor(live); if(w>lastWhole){ lastWhole=w; if(soundOn){ noise(0.09,0.05,900+Math.random()*400,1.5); } var bigE=$('big'); bigE.classList.remove('flick'); void bigE.offsetWidth; bigE.classList.add('flick'); }
      },220);
    }
  }).catch(function(){ $('big').textContent='...'; $('d').textContent='...'; $('w').textContent='...'; $('t').textContent='...'; });

  try{ if(localStorage.getItem('vr_snd')==='1'){ $('snd').classList.add('hint'); } }catch(e){}

  /* ---- subtle vault entry: reveal the password field, POST to unlock ---- */
  function revealVault(){ var vb=$('vaultbox'); if(!vb.classList.contains('open')){ vb.classList.add('open'); blip(440,0.09,0.07); } setTimeout(function(){ try{$('pw').focus();}catch(e){} },30); }
  $('enterlink').onclick=revealVault;
  $('mask').addEventListener('click',revealVault);
  $('mask').addEventListener('pointerenter',function(){ noise(0.18,0.06,600,2); });
  async function unlock(){ var m=$('gmsg'); m.textContent=''; try{
    var r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('pw').value})});
    if(r.ok){ location.reload(); } else { m.textContent='Wrong password.'; $('pw').select(); }
  }catch(e){ m.textContent='Try again.'; } }
  $('go').onclick=unlock;
  $('pw').addEventListener('keydown',function(e){ if(e.key==='Enter')unlock(); });
</script>
</body>
</html>`;
// DEV ENVIRONMENT GATE: an INDEPENDENT password, always on, NOT tied to the shared DB config (so the dev site has
// its own password separate from the prod hub). The stored hash is derived from DEV_SITE_PASSWORD (group env) when
// present; the old hardcoded SHA-256 remains ONLY as a last-resort fallback for boxes where the env isn't set yet.
const DEV_PW_FALLBACK_HASH = '95b07445e194cf5c046719226c8006fdef1a8567931fdc87801603466a86eca3';   // legacy sha256('robbers-dev-2026') — fallback only
const DEV_PW_HASH = process.env.DEV_SITE_PASSWORD ? sha(String(process.env.DEV_SITE_PASSWORD)) : DEV_PW_FALLBACK_HASH;
app.use((req, res, next) => {
  const pwHash = DEV_PW_HASH;
  // PUBLIC bypass: the landing page (served below to un-authed visitors) needs live burn numbers, so this ONE
  // read-only endpoint is reachable without the gate cookie. It exposes nothing but on-chain burn totals.
  if ((req.path || '') === '/api/landing-burns') return next();
  if (gateTokenOk(parseCookies(req).vr_gate, pwHash)) return next();     // already unlocked (constant-time)
  if (req.method === 'POST') {                                           // password submission (any path)
    let b = ''; req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
    req.on('end', () => {
      let pw = ''; try { pw = (JSON.parse(b || '{}').password) || ''; } catch (_) { const m = /password=([^&]*)/.exec(b); pw = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; }
      if (verifyPassword(pw, pwHash)) { res.setHeader('Set-Cookie', `vr_gate=${gateToken(pwHash)}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`); res.json({ ok: true }); }
      else res.status(401).json({ ok: false, error: 'wrong password' });
    });
    return;
  }
  res.status(200).type('html').send(GATE_PAGE);                          // lock screen (200 so the health probe passes; APIs + static stay gated)
});

// ── CONSOLIDATION (Jake 2026-09-20): this single artifact IS the whole Vault Robbers site.
// It runs the two free-play games as internal child processes (byte-for-byte unchanged) on private
// loopback ports and reverse-proxies them under /play/v1 and /play/v2. One published artifact, one domain.
const { spawn } = require('child_process');
const http = require('http');
const GAMES = [
  { slug: 'v1', dir: path.join(__dirname, '..', 'robbing-the-vault-v1'), entry: 'start-v1free.js', port: 14311 },
  { slug: 'v2', dir: path.join(__dirname, '..', 'vaultrobbers-dev'),     entry: 'start-v2free.js', port: 14312 },
];
const _children = {};
function spawnGame(g) {
  try {
    const c = spawn('node', [g.entry], { cwd: g.dir, env: { ...process.env, PORT: String(g.port) }, stdio: 'ignore' });
    c.on('exit', () => { _children[g.slug] = null; setTimeout(() => spawnGame(g), 5000); }); // auto-restart if it dies
    _children[g.slug] = c;
  } catch (e) { setTimeout(() => spawnGame(g), 5000); }
}
// DEV: do NOT spawn duplicate free-game children — reuse the prod hub's already-running ones on 14311/14312
// (same host, same ports). Spawning here would collide (EADDRINUSE). The /play/v1 + /play/v2 proxies below still work.
// GAMES.forEach(spawnGame);
process.on('SIGTERM', () => { Object.values(_children).forEach(c => { try { c && c.kill(); } catch (e) {} }); process.exit(0); });
// AUDIT FIX (header hygiene): the free games (v1/v2) do NOT need the hub's auth. Strip the hub's own session
// cookie (vr_gate) and the hub/platform tokens so they can never leak into a child process or its logs. We keep
// everything the child legitimately needs (host, content-type, user-agent, accept, etc.).
function scrubChildHeaders(h) { const o = { ...h }; delete o.cookie; delete o['x-vs-token']; delete o.authorization; return o; }
function gameProxy(port) {
  return (req, res) => {
    const preq = http.request(
      { hostname: '127.0.0.1', port, path: req.url || '/', method: req.method, headers: scrubChildHeaders(req.headers) },
      (pr) => { res.writeHead(pr.statusCode || 502, pr.headers); pr.pipe(res); }
    );
    preq.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' }); res.end('game starting, refresh in a moment'); });
    req.pipe(preq);
  };
}
app.use('/play/v1', gameProxy(14311));
app.use('/play/v2', gameProxy(14312));

// ── V3 = VAULT STANDOFF (the real-money "pay & present" game). Unlike v1/v2 (free, spawned in-process), Standoff
// is a MONEY server with its own signing keys + boot-time env scrub, so it stays its OWN isolated artifact — we
// never hold its keys. We reverse-proxy it on loopback under /play/v3 and inject the group's platform token so its
// is_public=false backend treats the (already password-gated) hub as the trusted front door and skips its own
// password prompt. It advertises its assigned port to a sibling `.vs-port` file. Pre-launch -> dev/testnet
// Standoff; at go-live this dir flips to 'vaultstandoff-prod' (see the single promotion).
const fs = require('fs');
const STANDOFF_DIR = path.join(__dirname, '..', 'vaultstandoff-prod');   // GO-LIVE 2026-10-27: pointed at PROD Standoff (hub isV3Open() still gates /play/v3 until mint sell-out or Oct-31 04:00 UTC)
let _soPort = { v: 0, at: 0 };
function standoffPort() {
  if (_soPort.v && Date.now() - _soPort.at < 5000) return _soPort.v;
  let p = 0; try { p = parseInt(fs.readFileSync(path.join(STANDOFF_DIR, '.vs-port'), 'utf8').trim(), 10) || 0; } catch (_) {}
  _soPort = { v: p, at: Date.now() };
  return p;
}
// V3 LAUNCH GATE (server-side, authoritative). The mint is PUBLIC before Halloween, so the hub password gate comes
// off while Vault Standoff must stay locked. A hidden button isn't enough — someone could hit /play/v3 directly — so
// we refuse to proxy ANYTHING under /play/v3 until it's OPEN: open === mint sold out (totalMinted >= max) OR the
// Halloween cutoff passes. 30s cache on the on-chain read; Halloween is a pure time check (always works).
const V3_OPEN_MS = Date.parse('2026-10-30T00:00:00Z');
// AUDIT FIX (gate desync): the fallback max is ONLY used if the on-chain MAX_SUPPLY() read fails; the authoritative
// cap is read from the SAME contract the mint uses (c.MAX_SUPPLY()), so the launch gate can't drift from real supply.
const V3_MINT_MAX_FALLBACK = parseInt(process.env.VS_MINT_MAX || '1000', 10) || 1000;
let _v3 = { open: false, at: 0, max: 0 };
async function isV3Open() {
  if (Date.now() >= V3_OPEN_MS) return true;                       // Halloween cutoff
  if (_v3.at && Date.now() - _v3.at < 30000) return _v3.open;      // 30s cache
  _v3.at = Date.now();
  try {
    const { c } = contract(await cfg());
    const [tot, maxOnChain] = await Promise.all([c.totalMinted(), c.MAX_SUPPLY().catch(() => 0n)]);
    const n = Number(tot);
    const max = Number(maxOnChain) || _v3.max || V3_MINT_MAX_FALLBACK;   // authoritative on-chain cap; fall back only on read failure
    if (Number(maxOnChain) > 0) _v3.max = Number(maxOnChain);            // remember last good on-chain cap
    _v3.open = Number.isFinite(n) && n >= max;
  } catch (e) { /* RPC blip: keep last; Halloween still guarantees open */ }
  return _v3.open;
}
const V3_LOCKED_HTML = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Vault Standoff</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 28%,#2a1b33,#0c0910 75%);color:#f5ecd8;font-family:ui-sans-serif,system-ui;text-align:center;padding:24px}a{color:#ff9c2f}</style><div><div style="font-size:40px">🔒 🎃</div><h2>The Vault Standoff is locked</h2><p>V3 opens the moment the mint sells out, or on Halloween. Until then, mint a Vault Robber and watch the countdown.</p><p><a href="../">← Back to Vault Robbers</a></p></div>';
async function standoffProxy(req, res) {
  try { if (!(await isV3Open())) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end(V3_LOCKED_HTML); } } catch (_) {}
  const port = standoffPort();
  if (!port) { if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('v3 starting, refresh in a moment'); }
  const headers = { ...req.headers, authorization: 'Bearer ' + TOKEN };
  const preq = http.request({ hostname: '127.0.0.1', port, path: req.url || '/', method: req.method, headers },
    (pr) => { res.writeHead(pr.statusCode || 502, pr.headers); pr.pipe(res); });
  preq.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' }); res.end('v3 starting, refresh in a moment'); });
  req.pipe(preq);
}
app.use('/play/v3', standoffProxy);

app.use(express.json());

// ── Dashboard API (server-side DB) ──
const API = process.env.DASHBOARD_BASE || ('http://localhost:' + (process.env.DASHBOARD_PORT || 4000));
const TOKEN = process.env.DASHBOARD_TOKEN || '';
const GROUP = process.env.ARTIFACT_GROUP || 'main';
const AUTH = { headers: { Authorization: `Bearer ${TOKEN}` } };
async function dbQuery(sql, params = []) {
  const r = await fetch(`${API}/api/db/${GROUP}/database/query?sql=${encodeURIComponent(sql)}&params=${encodeURIComponent(JSON.stringify(params))}`, AUTH);
  if (!r.ok) return []; const j = await r.json(); return j.rows || j.results || [];
}
async function dbExec(sql, params = []) {
  const r = await fetch(`${API}/api/db/${GROUP}/database/execute`, {
    method: 'POST', headers: { ...AUTH.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }) });
  return r.ok;
}

// ── Networks + the EXISTING deployed contracts (no new contract; 12% already minted) ──
const NETS = {
  testnet: { chainId: 46630, rpc: 'https://rpc.testnet.chain.robinhood.com', robbers: process.env.ROBBERS_TESTNET || '0x23371ca4608F1942a68435d51484ca71f9fFd0F6' },
  mainnet: { chainId: 4663,  rpc: 'https://rpc.mainnet.chain.robinhood.com', robbers: process.env.ROBBERS_MAINNET || '0xABC6c4F5d1F31326b419c2645C981743a845313a' },
};
const VR_TREASURY = '0x3290f9cbF7bE7dEA11E7d482Ae0418b83E363665';   // NEW dedicated Vault Robbers 2-of-2 Safe — receives the mint ETH premium (old shared Safe retired 2026-10-10)

// Runtime config with safe defaults; DB overrides win so the buffer/skim can change with no redeploy.
const DEFAULTS = {
  network: process.env.VRM_NETWORK || 'testnet',   // testnet until Jake approves mainnet cutover
  buffer_pct: '100',                                 // TREASURY PREMIUM %: charged on top of the RVLT cost, delivered as Robinhood ETH to the treasury (game seed). 100 = match the RVLT USD 1:1.
  skim_address: VR_TREASURY,                         // NEW Vault Robbers treasury (0x3290…3665) — receives the mint ETH premium as native Robinhood ETH
  rvlt_usd_override: '',                              // testnet has no real RVLT market; set a number to demo USD math
  enabled: 'true',
};
let _cfgCache = { v: null, at: 0 };
async function cfg() {
  if (_cfgCache.v && Date.now() - _cfgCache.at < 10000) return _cfgCache.v;   // 10s cache: the gate checks this per request
  const rows = await dbQuery("SELECT key,value FROM vrmint_config").catch(() => []);
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  _cfgCache = { v: out, at: Date.now() };
  return out;
}
const ROBBERS_ABI = [
  'function mintActive() view returns (bool)',
  'function currentPrice() view returns (uint256)',
  'function quote(uint256 qty) view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function reserveMinted() view returns (uint256)',
  'function mintNonce(address) view returns (uint256)',
  'function mintedBy(address) view returns (uint256)',
  'function signer() view returns (address)',
  'function PRICE1() view returns (uint256)','function PRICE2() view returns (uint256)',
  'function PRICE3() view returns (uint256)','function PRICE4() view returns (uint256)',
  'function tokenURI(uint256) view returns (string)','function ownerOf(uint256) view returns (address)',
  'function revealed() view returns (bool)','function startingIndex() view returns (uint256)','function MAX_SUPPLY() view returns (uint256)',
];
function net(c) { return NETS[c.network] || NETS.testnet; }
function contract(c) { const n = net(c); return { n, c: new ethers.Contract(n.robbers, ROBBERS_ABI, new ethers.JsonRpcProvider(n.rpc, n.chainId)) }; }
// AUDIT FIX (efficiency): module-level JsonRpcProvider cache keyed by chainId+rpc, so read-heavy routes (/api/balances
// spun up ~7 providers PER request) reuse one static-network provider per chain instead of constructing on every call.
const _provCache = {};
function providerFor(chainId, rpc) {
  const key = chainId + '|' + rpc;
  if (!_provCache[key]) _provCache[key] = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  return _provCache[key];
}

// live RVLT/USD (mainnet market via Dexscreener); testnet uses the override so the USD math is demonstrable
let _px = { v: 0, at: 0 };
async function rvltUsd(c) {
  if (c.rvlt_usd_override) return Number(c.rvlt_usd_override) || 0;
  if (Date.now() - _px.at < 60000 && _px.v) return _px.v;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04', { signal: AbortSignal.timeout(8000) });
    const j = await r.json(); const p = (j.pairs || []).find(x => x.chainId === 'robinhood') || (j.pairs || [])[0];
    _px = { v: Number(p?.priceUsd || 0), at: Date.now() }; return _px.v;
  } catch { return _px.v || 0; }
}

// live ETH/USD (for sizing the premium leg, delivered as Robinhood ETH). Dexscreener WETH/mainnet.
let _eth = { v: 0, at: 0 };
async function ethUsd() {
  if (Date.now() - _eth.at < 60000 && _eth.v) return _eth.v;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const p = (j.pairs || []).filter(x => x.chainId === 'ethereum' && x.quoteToken && /USD/i.test(x.quoteToken.symbol))
      .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0] || (j.pairs || [])[0];
    _eth = { v: Number(p?.priceUsd || 0), at: Date.now() }; return _eth.v;
  } catch { return _eth.v || 0; }
}

// live SOL/USD and POL/USD for valuing the Pay-from balances in USD. Dexscreener wSOL / WPOL, cached 60s.
let _sol = { v: 0, at: 0 }, _pol = { v: 0, at: 0 };
async function dexPrice(cache, tokenAddr, chainMatch) {
  if (Date.now() - cache.at < 60000 && cache.v) return cache.v;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + tokenAddr, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const p = (j.pairs || []).filter(x => (!chainMatch || x.chainId === chainMatch) && x.quoteToken && /USD/i.test(x.quoteToken.symbol))
      .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0] || (j.pairs || [])[0];
    cache.v = Number(p?.priceUsd || 0); cache.at = Date.now(); return cache.v;
  } catch { return cache.v || 0; }
}
const solUsd = () => dexPrice(_sol, 'So11111111111111111111111111111111111111112', 'solana');
const polUsd = () => dexPrice(_pol, '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'polygon');
let _bnb = { v: 0, at: 0 };
const bnbUsd = () => dexPrice(_bnb, '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'bsc'); // WBNB
function premiumEthWeiFrom(rvltUsdVal, premiumPct, ethPx) {
  const premiumUsd = rvltUsdVal * (premiumPct / 100);
  const wei = (ethPx > 0 && premiumUsd > 0) ? BigInt(Math.round((premiumUsd / ethPx) * 1e18)) : 0n;
  return { premiumUsd, wei };
}

app.get('/api/config', async (req, res) => {
  try {
    const c = await cfg(); const { n, c: ct } = contract(c);
    const [active, tot, res_, p1, p2, p3, p4] = await Promise.all([
      ct.mintActive().catch(() => false), ct.totalMinted().catch(() => 0n), ct.reserveMinted().catch(() => 0n),
      ct.PRICE1().catch(() => 0n), ct.PRICE2().catch(() => 0n), ct.PRICE3().catch(() => 0n), ct.PRICE4().catch(() => 0n)]);
    const f = v => Number(ethers.formatUnits(v, 18));
    res.json({
      network: c.network, chainId: n.chainId, contract: n.robbers, enabled: c.enabled === 'true',
      rvlt: '0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04', rpc: n.rpc,
      explorer: n.chainId === 4663 ? 'https://robin.etherscan.io' : 'https://explorer.testnet.chain.robinhood.com',
      mintActive: active, buffer_pct: Number(c.buffer_pct), skim: c.skim_address,
      totalMinted: Number(tot), reserveMinted: Number(res_), publicSupply: 900, maxSupply: 1000, maxPerWallet: 3,
      tiersRvlt: [f(p1), f(p2), f(p3), f(p4)], tierBands: ['1-250', '251-500', '501-750', '751-1000'],
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/quote', async (req, res) => {
  try {
    const qty = Math.max(1, Math.min(3, parseInt(req.query.qty || '1', 10)));
    const c = await cfg(); const { c: ct } = contract(c);
    const rvltWei = await ct.quote(BigInt(qty));
    const rvlt = Number(ethers.formatUnits(rvltWei, 18));
    const px = await rvltUsd(c);
    const subtotal = rvlt * px;
    const premiumPct = Number(c.buffer_pct) || 0;
    const ethPx = await ethUsd();
    const { premiumUsd, wei: premiumEthWei } = premiumEthWeiFrom(subtotal, premiumPct, ethPx);
    const total = subtotal + premiumUsd;
    res.json({
      qty, rvlt, rvltWei: rvltWei.toString(), rvltUsd: px,
      // usdBuffer/bufferPct kept for back-compat; they now mean the treasury premium.
      usdSubtotal: subtotal, bufferPct: premiumPct, usdBuffer: premiumUsd, usdTotal: total,
      premiumPct, premiumUsd, premiumEthWei: premiumEthWei.toString(), ethUsd: ethPx,
      treasury: c.skim_address, skim: c.skim_address, priceKnown: px > 0,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── Live mint-proceeds projection (read-only). Remaining public revenue by tier band, off the real on-chain
// mint count + RVLT price, modeling the two reserve-timing options (mint reserve now = cheapest IDs, which pushes
// paid mints up the price curve; vs spread reserve across the mintout). Tiers priced by token-ID band. ──
const PUB_SUPPLY = 900, RES_MAX = 100, MAX_SUPPLY_N = 1000, BAND = 250;
app.get('/api/proceeds', async (req, res) => {
  try {
    const c = await cfg(); const { c: ct } = contract(c);
    const f = v => Number(ethers.formatUnits(v, 18));
    const [totB, resB, p1, p2, p3, p4, px] = await Promise.all([
      ct.totalMinted().catch(() => 0n), ct.reserveMinted().catch(() => 0n),
      ct.PRICE1().catch(() => 0n), ct.PRICE2().catch(() => 0n), ct.PRICE3().catch(() => 0n), ct.PRICE4().catch(() => 0n),
      rvltUsd(c),
    ]);
    const total = Number(totB), reserve = Number(resB);
    const buffer = Number(c.buffer_pct) || 0;
    const mult = 1 + buffer / 100;                       // all-in = base x mult
    const premiumFrac = mult > 0 ? (buffer / 100) / mult : 0;  // share of all-in that is the ETH premium
    const allIn = [f(p1), f(p2), f(p3), f(p4)].map(b => b * mult);   // per-band all-in RVLT
    const bandOf = id => id <= 250 ? 0 : id <= 500 ? 1 : id <= 750 ? 2 : 3;
    const sumAllIn = (from, to) => { let s = 0; for (let id = Math.max(1, from); id <= Math.min(MAX_SUPPLY_N, to); id++) s += allIn[bandOf(id)]; return s; };

    const pubMinted = Math.max(0, total - reserve);
    const pubRem = Math.max(0, PUB_SUPPLY - pubMinted);
    const resRem = Math.max(0, RES_MAX - reserve);
    const remCount = Math.max(0, MAX_SUPPLY_N - total);
    // already collected from public: minted IDs priced by band, minus the reserve freebies (assume reserve took the cheapest IDs)
    const already = Math.max(0, sumAllIn(1, total) - sumAllIn(1, reserve));
    const totalRem = sumAllIn(total + 1, MAX_SUPPLY_N);
    const optA = Math.max(0, totalRem - sumAllIn(total + 1, total + resRem));   // reserve now (cheapest remaining)
    const optB = remCount > 0 ? totalRem * (pubRem / remCount) : 0;             // reserve spread evenly
    const pack = (rvlt) => ({ rvlt, usd: px ? rvlt * px : null, premiumUsd: px ? rvlt * px * premiumFrac : null, treasuryRvltUsd: px ? rvlt * px * (1 - premiumFrac) : null });
    const mults = [1, 2, 5, 10];
    res.json({
      price: px, totalMinted: total, reserveMinted: reserve, publicMinted: pubMinted,
      publicRemaining: pubRem, reserveRemaining: resRem, bufferPct: buffer,
      tiersAllIn: allIn, bands: ['1-250', '251-500', '501-750', '751-1000'],
      alreadyCollected: pack(already),
      optionA_reserveNow: pack(optA),
      optionB_reserveSpread: pack(optB),
      reserveTimingDeltaUsd: px ? (optA - optB) * px : null,
      sensitivity: mults.map(m => ({ mult: m, price: px * m, remainingUsd: px ? optA * px * m : null, totalPublicUsd: px ? (already + optA) * px * m : null })),
      asOf: Date.now(),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── Admin: runtime-configurable (upgradable) params. Token-gated. ──
// Header-only (never query string, which leaks into logs/history/Referer), constant-time, fail-closed on short tokens.
function adminOk(req) {
  const t = process.env.VRM_ADMIN_TOKEN || '';
  if (!t || t.length < 16) return false;
  const g = req.headers['x-admin'];
  if (typeof g !== 'string' || g.length !== t.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(g), Buffer.from(t)); } catch (_) { return false; }
}
app.get('/api/admin/config', async (req, res) => { if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' }); const c = { ...(await cfg()) }; delete c.site_pw_hash; res.json(c); });
app.post('/api/admin/config', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const allowed = ['network', 'buffer_pct', 'skim_address', 'rvlt_usd_override', 'enabled', 'site_gate'];
  const set = {};
  for (const k of allowed) if (k in (req.body || {})) {
    const val = String(req.body[k]);
    // AUDIT FIX: the treasury (skim_address) receives the mint ETH premium — validate it is a well-formed EVM
    // address before accepting, so a malformed/garbage value can't quietly misroute premiums or brick verifyPremium.
    if (k === 'skim_address' && !ethers.isAddress(val)) return res.status(400).json({ error: 'skim_address must be a valid EVM address' });
    await dbExec("INSERT INTO vrmint_config (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')", [k, val]);
    set[k] = val;
  }
  // Site password: hashed server-side, never stored in plaintext. Empty string clears it.
  if ('site_password' in (req.body || {})) {
    const hash = req.body.site_password ? hashPassword(String(req.body.site_password)) : '';
    await dbExec("INSERT INTO vrmint_config (key,value,updated_at) VALUES ('site_pw_hash',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')", [hash]);
    set.site_pw_hash = hash ? '(set)' : '(cleared)';
  }
  _cfgCache = { v: null, at: 0 };   // bust cache so gate/config changes take effect immediately
  res.json({ ok: true, set, config: await cfg() });
});

// ── Premium enforcement (C1/H1/H2/H3 fix, no redeploy). The voucher is the ONLY on-chain mint gate, so we refuse to
// sign it until the treasury premium has actually been paid. The client must pass the Robinhood tx hash of a native-ETH
// transfer from the minter to the treasury (skim_address); we verify the receipt on-chain and recompute the required
// amount server-side (never trusting any client-supplied number). Each premium tx can back exactly one voucher. ──
let _premTableReady = false;
async function ensurePremiumTable() {
  if (_premTableReady) return;
  await dbExec("CREATE TABLE IF NOT EXISTS vrmint_premium_used (tx_hash TEXT PRIMARY KEY, minter TEXT, qty INTEGER, wei TEXT, used_at TEXT DEFAULT (datetime('now')))");
  _premTableReady = true;
}
async function requiredPremiumWei(c, qty) {
  const { c: ct } = contract(c);
  const costWei = await ct.quote(BigInt(qty));
  const premiumPct = Number(c.buffer_pct) || 0;
  if (premiumPct <= 0) return 0n;
  const rvltUsdVal = Number(ethers.formatUnits(costWei, 18)) * (await rvltUsd(c));
  const { wei } = premiumEthWeiFrom(rvltUsdVal, premiumPct, await ethUsd());
  return wei;
}
// Returns {ok:true} or {ok:false, error, code}. Enforces: valid hash, on-chain success, to===treasury, from===minter,
// value >= 90% of the server-recomputed premium (tolerance for price drift between quote and mint), <30 min old, unused.
async function verifyPremium(c, n, minter, qty, txHash) {
  const need = await requiredPremiumWei(c, qty);
  if (need <= 0n) return { ok: true };                                  // premium disabled -> nothing to verify
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) return { ok: false, error: 'premium payment tx hash required', code: 400 };
  const hash = txHash.toLowerCase();
  await ensurePremiumTable();
  const seen = await dbQuery("SELECT tx_hash FROM vrmint_premium_used WHERE tx_hash=?", [hash]).catch(() => []);
  if (seen.length) return { ok: false, error: 'premium payment already used', code: 409 };
  const prov = new ethers.JsonRpcProvider(n.rpc, n.chainId);
  const [tx, rcpt] = await Promise.all([prov.getTransaction(hash), prov.getTransactionReceipt(hash)]);
  if (!tx || !rcpt) return { ok: false, error: 'premium tx not found on Robinhood yet', code: 400 };
  if (rcpt.status !== 1) return { ok: false, error: 'premium tx failed', code: 400 };
  const treasury = String(c.skim_address || '').toLowerCase();
  if (!tx.to || tx.to.toLowerCase() !== treasury) return { ok: false, error: 'premium not sent to treasury', code: 400 };
  if (!tx.from || tx.from.toLowerCase() !== minter.toLowerCase()) return { ok: false, error: 'premium must be paid by the minting wallet', code: 400 };
  const minWei = need * 90n / 100n;                                     // 90% floor absorbs price drift; never trusts client amount
  if ((tx.value ?? 0n) < minWei) return { ok: false, error: 'premium underpaid', code: 402 };
  try { const blk = await prov.getBlock(rcpt.blockNumber); if (blk && (Date.now() - Number(blk.timestamp) * 1000) > 30 * 60 * 1000) return { ok: false, error: 'premium payment too old, mint again', code: 400 }; } catch (_) {}
  const marked = await dbExec("INSERT INTO vrmint_premium_used (tx_hash,minter,qty,wei) VALUES (?,?,?,?)", [hash, minter.toLowerCase(), qty, (tx.value ?? 0n).toString()]);
  if (!marked) return { ok: false, error: 'could not record premium payment, try again', code: 500 };
  return { ok: true };
}

// ── Server-side mint-eligibility enforcement (AUDIT FIX). The voucher is the website's gate, so the server — NOT the
// client — must enforce: (a) mint active + not sold out, (b) the per-wallet cap of 3, counting BOTH on-chain mints and
// still-outstanding vouchers this server already signed, (c) qty cannot exceed the remaining supply. Reads the
// authoritative on-chain counts fresh (no cache) and fails CLOSED on any read error. ──
const MINT_CAP = 3;
let _vTableReady = false;
async function ensureVoucherTable() {
  if (_vTableReady) return;
  await dbExec("CREATE TABLE IF NOT EXISTS vrmint_vouchers (minter TEXT, qty INTEGER, nonce TEXT, deadline INTEGER, issued_at TEXT DEFAULT (datetime('now')))");
  await dbExec("CREATE INDEX IF NOT EXISTS idx_vrmint_vouchers_minter ON vrmint_vouchers (minter)");
  _vTableReady = true;
}
// Vouchers this server issued that the chain has NOT yet consumed: a voucher at nonce N is spent once the on-chain
// mintNonce advances past N, so "outstanding" = rows with nonce >= the wallet's current on-chain mintNonce. Their qty
// is reserved against the cap so a wallet can't collect multiple full-cap vouchers before minting any of them.
async function outstandingVoucherQty(minterLc, currentNonce) {
  await ensureVoucherTable();
  const rows = await dbQuery(
    "SELECT COALESCE(SUM(qty),0) q FROM vrmint_vouchers WHERE minter=? AND CAST(nonce AS INTEGER) >= ?",
    [minterLc, Number(currentNonce)]
  ).catch(() => []);
  return Number((rows[0] && rows[0].q) || 0);
}
// Returns {ok:true, nonce, remainingSupply} or {ok:false, error, code}. Fails closed.
async function enforceMintEligibility(c, ct, minter, qty) {
  const minterLc = minter.toLowerCase();
  let active, totalMinted, maxSupply, mintedBy, nonce;
  try {
    [active, totalMinted, maxSupply, mintedBy, nonce] = await Promise.all([
      ct.mintActive(), ct.totalMinted(), ct.MAX_SUPPLY(), ct.mintedBy(minter), ct.mintNonce(minter),
    ]);
  } catch (e) { return { ok: false, error: 'could not verify mint state on-chain, try again', code: 503 }; }
  if (!active) return { ok: false, error: 'mint is not active', code: 403 };
  const total = Number(totalMinted), max = Number(maxSupply) || MAX_SUPPLY_N;
  const remaining = Math.max(0, max - total);
  if (remaining <= 0) return { ok: false, error: 'sold out', code: 409 };
  if (qty > remaining) return { ok: false, error: `only ${remaining} left`, code: 409 };
  const already = Number(mintedBy);
  const outstanding = await outstandingVoucherQty(minterLc, nonce);
  if (already + outstanding + qty > MINT_CAP) {
    const left = Math.max(0, MINT_CAP - already - outstanding);
    return { ok: false, error: left > 0 ? `wallet limit is ${MINT_CAP}; you can mint ${left} more` : `wallet limit of ${MINT_CAP} reached`, code: 403 };
  }
  return { ok: true, nonce, remaining };
}

// ── EIP-712 mint voucher (website gate). Signs MintVoucher(minter,qty,nonce,deadline). Gated on the signer key. ──
app.post('/api/voucher', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    // Per-IP bounded limiter (was a single global O(n) array filtered on every request — one caller could exhaust
    // everyone's budget, and the array grew unbounded). 30 voucher attempts / minute / IP.
    if (!rlHit(req, 'voucher', 30, 60000)) return res.status(429).json({ error: 'rate limited, try again shortly' });
    // Deterministic Halloween cutoff (defense in depth): mint hard-closes at V3_OPEN_MS even if the scheduled
    // enabled=false flip never fires. The voucher is the ONLY mint gate, so refusing here is a complete close.
    if (Date.now() >= V3_OPEN_MS) return res.status(403).json({ error: 'Minting has closed.' });
    const c = await cfg();
    if (c.enabled !== 'true') return res.status(403).json({ error: 'mint disabled' });
    // Network-aware signer: the contract's signer() differs by deployment. Testnet contract's signer is the deployer
    // (0x411f); mainnet contract's signer is the dedicated ROBBERS_SIGNER_PK (0xa6b8). Sign with the matching key.
    const pk = (c.network === 'mainnet')
      ? (process.env.ROBBERS_SIGNER_PK || '')
      : (process.env.DEPLOYER_PRIVATE_KEY || '');
    if (!pk) return res.status(501).json({ error: 'signer key not provisioned for ' + c.network });
    const minter = String(req.body?.minter || '');
    const qty = Math.max(1, Math.min(3, parseInt(req.body?.qty || '1', 10)));
    if (!ethers.isAddress(minter)) return res.status(400).json({ error: 'valid minter address required' });
    const { n, c: ct } = contract(c);
    // AUDIT FIX: enforce mint-active, sold-out, per-wallet cap (3) and remaining supply SERVER-SIDE, before asking for
    // or verifying payment. Never trust the client for any of these. Fails closed on an RPC read error.
    const elig = await enforceMintEligibility(c, ct, minter, qty);
    if (!elig.ok) return res.status(elig.code || 403).json({ error: elig.error });
    // C1/H1/H2/H3: do NOT sign the mint gate until the treasury premium is verifiably paid on-chain.
    const prem = await verifyPremium(c, n, minter, qty, req.body?.premiumTxHash);
    if (!prem.ok) return res.status(prem.code || 402).json({ error: prem.error });
    // Guard: refuse to hand out a voucher the contract would reject (wrong signer key for this network's contract).
    const wallet0 = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
    try { const onchain = await ct.signer(); if (onchain && onchain.toLowerCase() !== wallet0.address.toLowerCase()) return res.status(500).json({ error: 'signer key does not match contract signer', expected: onchain, got: wallet0.address }); } catch (_) {}
    const nonce = elig.nonce;   // reuse the on-chain nonce already read during eligibility (no double RPC)
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
    const domain = { name: 'Vault Robbers', version: '1', chainId: n.chainId, verifyingContract: n.robbers };
    const types = { MintVoucher: [
      { name: 'minter', type: 'address' }, { name: 'qty', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' } ] };
    const signature = await wallet.signTypedData(domain, types, { minter, qty, nonce, deadline });
    // Reserve this qty against the wallet cap until the chain consumes the nonce (see outstandingVoucherQty).
    await dbExec("INSERT INTO vrmint_vouchers (minter,qty,nonce,deadline) VALUES (?,?,?,?)", [minter.toLowerCase(), qty, nonce.toString(), deadline]).catch(() => {});
    res.json({ minter, qty, nonce: nonce.toString(), deadline, signature });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── Relay (cross-chain) proxy — keeps the Relay calls server-side (browser never calls Relay directly). The buyer's
// wallet still signs every returned step tx, and no key is ever exposed. Relay routes ANY origin currency to the EXACT
// RVLT the mint needs in one step (verified: destinationCurrency=RVLT + EXACT_OUTPUT). API key optional (rate limits only).
const RELAY_API = 'https://api.relay.link';
const RELAY_HEADERS = () => ({ 'Content-Type': 'application/json', ...(process.env.RELAY_API_KEY ? { 'x-api-key': process.env.RELAY_API_KEY } : {}) });
// PER-IP rate bucketing (was one shared global counter: a single caller could starve everyone, and a quiet
// attacker couldn't be isolated). Keyed on the client IP; bounded map size so it can't be used to exhaust memory.
const _RL = {}; const _RL_MAX_KEYS = 50000;
function rlIp(req) { let ip = req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'anon'; if (typeof ip === 'string' && ip.indexOf(',') >= 0) ip = ip.split(',')[0].trim(); return ip; }
function rlHit(req, pfx, max, winMs) {
  const key = pfx + ':' + rlIp(req); const now = Date.now();
  if (_RL[key] === undefined && Object.keys(_RL).length >= _RL_MAX_KEYS) return true;   // map full: fail open rather than block everyone
  const a = (_RL[key] || []).filter(t => now - t < winMs);
  if (a.length >= max) { _RL[key] = a; return false; }
  a.push(now); _RL[key] = a; return true;
}
setInterval(() => { const now = Date.now(); for (const k in _RL) { _RL[k] = _RL[k].filter(t => now - t < 120000); if (!_RL[k].length) delete _RL[k]; } }, 60000).unref();
function rlOk(req) { return rlHit(req, 'relay', 90, 60000); }   // 90 relay calls / minute / IP

app.get('/api/relay/chains', async (req, res) => {
  try { const r = await fetch(`${RELAY_API}/chains`, { headers: RELAY_HEADERS(), signal: AbortSignal.timeout(12000) }); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
// AUDIT FIX: this was an OPEN passthrough — a caller could set ANY destinationChainId/destinationCurrency and use our
// (optionally keyed) Relay access to route funds anywhere. We now PIN the destination to the Robinhood/RVLT chain
// server-side (mirrors vaultstandoff-prod /api/relay/entry-quote) and whitelist/validate the origin shapes the client
// may supply. The buyer still signs every returned step tx; this only constrains WHERE the swap can deliver.
const RELAY_NATIVE = '0x0000000000000000000000000000000000000000';
const RELAY_SOL_NATIVE = '11111111111111111111111111111111';
const RELAY_SOL_CHAIN = 792703809;
function validOriginCurrency(chainId, cur) {
  if (chainId === RELAY_SOL_CHAIN) return cur === RELAY_SOL_NATIVE || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cur);  // SOL sentinel or SPL mint
  return /^0x[0-9a-fA-F]{40}$/.test(cur);                                                                          // EVM native sentinel or ERC20 addr
}
app.post('/api/relay/quote', express.json({ limit: '16kb' }), async (req, res) => {
  if (!rlOk(req)) return res.status(429).json({ error: 'rate limited' });
  try {
    const c = await cfg(); const n = net(c);
    const b = req.body || {};
    const originChainId = parseInt(b.originChainId, 10);
    const originCurrency = String(b.originCurrency || RELAY_NATIVE);
    const amount = String(b.amount || '');
    const user = String(b.user || '');
    const recipient = String(b.recipient || user);
    const tradeType = (b.tradeType === 'EXACT_INPUT') ? 'EXACT_INPUT' : 'EXACT_OUTPUT';
    if (!originChainId) return res.status(400).json({ error: 'originChainId required' });
    if (!validOriginCurrency(originChainId, originCurrency)) return res.status(400).json({ error: 'invalid originCurrency' });
    if (!/^\d{1,40}$/.test(amount) || amount === '0') return res.status(400).json({ error: 'invalid amount' });
    if (!ethers.isAddress(recipient)) return res.status(400).json({ error: 'valid EVM recipient required' });
    if (originChainId === RELAY_SOL_CHAIN) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(user)) return res.status(400).json({ error: 'valid Solana user required' }); }
    else if (!ethers.isAddress(user)) return res.status(400).json({ error: 'valid user required' });
    // Destination is PINNED server-side: the RVLT token on the configured Robinhood chain. Client cannot override it.
    const body = {
      user, recipient, originChainId, originCurrency, amount, tradeType,
      destinationChainId: n.chainId, destinationCurrency: RVLT_TOKEN,
    };
    const r = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: RELAY_HEADERS(), body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.get('/api/relay/status', async (req, res) => {
  if (!rlOk(req)) return res.status(429).json({ error: 'rate limited' });
  try {
    const rid = String(req.query.requestId || '');
    // Validate shape: a plausible Relay request id is hex (0x… / bare hex) or base58, bounded length. Reject anything
    // else so the id can't be used to smuggle extra query params or oversized input into the upstream URL.
    if (!/^(0x)?[0-9a-fA-F]{16,80}$/.test(rid) && !/^[1-9A-HJ-NP-Za-km-z]{16,100}$/.test(rid)) return res.status(400).json({ error: 'invalid requestId' });
    const r = await fetch(`${RELAY_API}/intents/status?requestId=${encodeURIComponent(rid)}`, { headers: RELAY_HEADERS(), signal: AbortSignal.timeout(12000) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
// Build the mint-cost Relay quote body: pay `fromCurrency` on `fromChainId` -> EXACT RVLT (mint cost x (1+buffer)) to the
// buyer on Robinhood. The 25% buffer over-delivers RVLT; the client mints with the exact cost and forwards the surplus to
// the Safe skim address. Amount is server-computed from the live contract quote so the client cannot understate it.
app.post('/api/relay/mint-quote', express.json({ limit: '8kb' }), async (req, res) => {
  if (!rlOk(req)) return res.status(429).json({ error: 'rate limited' });
  try {
    const c = await cfg(); const { n, c: ct } = contract(c);
    const qty = Math.max(1, Math.min(3, parseInt(req.body?.qty || '1', 10)));
    // `user` is the ORIGIN signer (the wallet paying) — may be an EVM address OR a Solana base58 address.
    // `recipient` is ALWAYS the EVM address that receives the RVLT + premium on Robinhood and does the mint.
    // For an EVM origin they are the same; for a Solana origin they differ (Phantom pays, the EVM wallet mints).
    const user = String(req.body?.user || '');
    const recipient = String(req.body?.recipient || user);
    const fromChainId = parseInt(req.body?.fromChainId, 10);
    const fromCurrency = String(req.body?.fromCurrency || '0x0000000000000000000000000000000000000000');
    const isSolOrigin = fromChainId === 792703809;
    if (!ethers.isAddress(recipient)) return res.status(400).json({ error: 'valid EVM recipient address required' });
    if (isSolOrigin) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(user)) return res.status(400).json({ error: 'valid Solana user address required' }); }
    else if (!ethers.isAddress(user)) return res.status(400).json({ error: 'valid user address required' });
    if (!fromChainId) return res.status(400).json({ error: 'fromChainId required' });
    // Leg A: the exact ROBINVAULT the mint pulls. The contract forwards it to its sink (the RVLT
    // deployer/treasury 0xe888…Ec8c) — it is NOT swapped or over-delivered here. Tiny headroom so the
    // exact cost reliably lands on Robinhood after Relay's own slippage.
    const costWei = await ct.quote(BigInt(qty));
    const deliverWei = costWei * 1005n / 1000n;                        // +0.5% headroom (dust stays with buyer)
    // Leg B: the premium. 100% of the ROBINVAULT USD cost, delivered as native Robinhood ETH to the
    // game treasury (skim_address). Never swapped to RVLT.
    const premiumPct = Number(c.buffer_pct) || 0;
    const rvltPx = await rvltUsd(c);
    const rvltUsdVal = Number(ethers.formatUnits(costWei, 18)) * rvltPx;
    const ethPx = await ethUsd();
    const { premiumUsd, wei: premiumEthWei } = premiumEthWeiFrom(rvltUsdVal, premiumPct, ethPx);
    // RVLT + premium ALWAYS land on the EVM `recipient` on Robinhood (where the mint happens), regardless of origin chain.
    const mkBody = (destCur, amount) => ({
      user, recipient, originChainId: fromChainId, originCurrency: fromCurrency,
      destinationChainId: n.chainId, destinationCurrency: destCur, amount: amount.toString(), tradeType: 'EXACT_OUTPUT',
    });
    const rq = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: RELAY_HEADERS(), body: JSON.stringify(mkBody('0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04', deliverWei)), signal: AbortSignal.timeout(20000) });
    const rvltQuote = await rq.json();
    // Leg B delivers the premium (plus a little gas headroom) to the BUYER on Robinhood. The buyer then makes a
    // direct native-ETH transfer of premiumEthWei to the treasury, and that tx hash is what /api/voucher verifies.
    // This keeps the premium a first-party, on-chain-verifiable payment instead of a client-optional side effect.
    const GAS_HEADROOM = 300000000000000n; // ~0.0003 ETH so the buyer can forward + pay gas
    let premiumQuote = null;
    if (premiumEthWei > 0n && premiumPct > 0) {
      const pq = await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: RELAY_HEADERS(), body: JSON.stringify(mkBody('0x0000000000000000000000000000000000000000', premiumEthWei + GAS_HEADROOM)), signal: AbortSignal.timeout(20000) });
      premiumQuote = await pq.json();
    }
    res.status(rq.status).json({
      rvltQuote, premiumQuote,
      mintCostWei: costWei.toString(), deliverWei: deliverWei.toString(),
      premiumEthWei: premiumEthWei.toString(), premiumUsd, rvltUsd: rvltUsdVal, ethUsd: ethPx,
      treasury: c.skim_address, premiumPct,
    });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ── Reveal gallery: the minted crew, read from on-chain tokenURI. Works pre-reveal (sealed metadata) and
// auto-flips to real art + traits the moment the contract's reveal is switched on. Cached 5 min. ──
let _rob = { at: 0, data: null };
app.get('/api/robbers', async (req, res) => {
  try {
    if (_rob.data && Date.now() - _rob.at < 300000) return res.json(_rob.data);
    const c = await cfg(); const { c: ct } = contract(c);
    const total = Number(await ct.totalMinted().catch(() => 0));
    const N = Math.min(total, 1000);
    const ids = Array.from({ length: N }, (_, i) => i + 1);
    const out = []; const CH = 12;
    for (let i = 0; i < ids.length; i += CH) {
      const batch = await Promise.all(ids.slice(i, i + CH).map(id => resolveToken(ct, id)));   // dedup: single resolveToken()
      out.push(...batch);
    }
    const revealed = out.some(r => r.status && r.status.toLowerCase() !== 'unrevealed');
    const data = { total, count: out.length, maxSupply: 1000, revealed, robbers: out };
    _rob = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── Post-mint "your pull": resolve specific token ids' art/traits from on-chain tokenURI. Pre-reveal returns
// the sealed placeholder; post-reveal returns the real art so the mint success screen can show what you pulled. ──
async function resolveToken(ct, id) {
  try {
    const u = await ct.tokenURI(id);
    let meta = {};
    if (u && u.startsWith('data:application/json;base64,')) meta = JSON.parse(Buffer.from(u.split(',')[1], 'base64').toString());
    else if (u && u.startsWith('data:application/json,')) meta = JSON.parse(decodeURIComponent(u.split(',').slice(1).join(',')));
    else if (u) meta = { image: u };
    const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
    const st = attrs.find(a => String(a.trait_type || '').toLowerCase() === 'status');
    const status = st ? String(st.value) : (/unreveal/i.test(meta.name || '') ? 'Unrevealed' : 'Revealed');
    return { id, name: meta.name || ('Vault Robber #' + id), image: meta.image || '', status, traits: attrs.filter(a => String(a.trait_type || '').toLowerCase() !== 'status') };
  } catch { return { id, name: 'Vault Robber #' + id, image: '', status: 'Unrevealed', traits: [] }; }
}
app.get('/api/tokenart', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => parseInt(s, 10)).filter(n => n > 0 && n <= 1000).slice(0, 10);
    if (!ids.length) return res.json({ robbers: [] });
    const c = await cfg(); const { c: ct } = contract(c);
    const robbers = await Promise.all(ids.map(id => resolveToken(ct, id)));
    const revealed = robbers.some(r => r.status && r.status.toLowerCase() !== 'unrevealed');
    res.json({ revealed, robbers });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── The ten 1/1s, revealed PER-MINT like the Crew: a 1/1 only shows its art once (a) the collection is revealed
// and (b) the specific token the shuffle assigned it has actually been minted. Pre-reveal / un-minted = sealed. ──
// art indices 990..999 are the 1/1s; after reveal tokenId = ((art - startingIndex) mod MAX), with 0 -> MAX.
let _ones = { at: 0, data: null };
app.get('/api/oneofones', async (req, res) => {
  try {
    if (_ones.data && Date.now() - _ones.at < 120000) return res.json(_ones.data);
    const c = await cfg(); const { c: ct } = contract(c);
    const [revealed, siRaw, totalRaw, maxRaw] = await Promise.all([
      ct.revealed().catch(() => false), ct.startingIndex().catch(() => 0n),
      ct.totalMinted().catch(() => 0n), ct.MAX_SUPPLY().catch(() => 1000n),
    ]);
    const si = Number(siRaw), total = Number(totalRaw), MAX = Number(maxRaw) || 1000;
    const arts = Array.from({ length: 10 }, (_, i) => MAX - 10 + i); // 990..999
    const ones = await Promise.all(arts.map(async art => {
      if (!revealed) return { art, minted: false, revealed: false };
      let tokenId = ((art - si) % MAX + MAX) % MAX; if (tokenId === 0) tokenId = MAX;
      const minted = tokenId <= total;
      if (!minted) return { art, minted: false, revealed: true };
      const t = await resolveToken(ct, tokenId);
      return { art, minted: true, revealed: true, tokenId, name: t.name, image: t.image, traits: t.traits };
    }));
    const data = { revealed, total, ones };
    _ones = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── Live payable assets for a connected wallet: which of the Relay-supported origin chains the wallet actually
// holds a spendable balance on (so the "Pay from" list shows only what they can really mint with). Reports native +
// USDC per EVM chain, SOL + Solana-USDC for a Phantom address, and native ROBINVAULT on Robinhood (direct, no bridge).
// Each asset carries exactly what the client needs to build the Relay quote: { chainId, currency, symbol, label, balance }.
// `currency` is the Relay origin currency: a native sentinel (EVM 0x0…0 / Solana 1…1) or the token's mint/contract addr. ──
const EVM_NATIVE = '0x0000000000000000000000000000000000000000';
const SOL_NATIVE_SENTINEL = '11111111111111111111111111111111';   // Relay's SOL (native) origin currency
const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const PAYCHAINS = [
  { chainId: 8453,  symbol: 'ETH', label: 'Base',     rpc: 'https://mainnet.base.org',             usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { chainId: 1,     symbol: 'ETH', label: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com',  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { chainId: 42161, symbol: 'ETH', label: 'Arbitrum', rpc: 'https://arb1.arbitrum.io/rpc',         usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  { chainId: 10,    symbol: 'ETH', label: 'Optimism', rpc: 'https://mainnet.optimism.io',          usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  { chainId: 137,   symbol: 'POL', label: 'Polygon',  rpc: 'https://polygon-bor-rpc.publicnode.com', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  { chainId: 56,    symbol: 'BNB', label: 'BNB Chain', rpc: 'https://bsc-dataseed.binance.org',     usdc: null },
];
// Shared Solana RPC resolution (mirrors vault-mint): accept SOLANA_RPC or the Helius key under any of the secret
// names we use (full URL used as-is, raw key gets wrapped). Falls back to the public endpoint.
const _solRaw = (process.env.SOLANA_RPC || process.env.HELIUS_API_KEY || process.env.HELIUS || process.env.Helous || process.env.Helius || '').trim();
const SOL_RPC = !_solRaw ? 'https://api.mainnet-beta.solana.com' : (/^https?:\/\//.test(_solRaw) ? _solRaw : ('https://mainnet.helius-rpc.com/?api-key=' + _solRaw));
async function solRpc(method, params) {
  const r = await fetch(SOL_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message || 'solana rpc error'); return j.result;
}
app.get('/api/balances', async (req, res) => {
  try {
    // Back-compat: ?address= is treated as the EVM address. New: ?evm= and ?sol=.
    const evm = String(req.query.evm || req.query.address || '');
    const sol = String(req.query.sol || '');
    const out = [];
    if (evm && ethers.isAddress(evm)) {
      const rows = await Promise.all(PAYCHAINS.map(async pc => {
        const got = [];
        const p = providerFor(pc.chainId, pc.rpc);
        try { const b = await p.getBalance(evm); got.push({ chainId: pc.chainId, currency: EVM_NATIVE, symbol: pc.symbol, label: pc.label + ' (' + pc.symbol + ')', balance: Number(ethers.formatEther(b)), has: b > 0n }); } catch {}
        if (pc.usdc) { try { const u = new ethers.Contract(pc.usdc, ERC20_ABI, p); const b = await u.balanceOf(evm); const bal = Number(ethers.formatUnits(b, 6)); if (b > 0n) got.push({ chainId: pc.chainId, currency: pc.usdc, symbol: 'USDC', label: pc.label + ' (USDC)', balance: bal, has: true }); } catch {} }
        // Extra payable tokens on this chain (e.g. Wrapped Ether on mainnet).
        for (const ex of (pc.extra || [])) { try { const c = new ethers.Contract(ex.addr, ERC20_ABI, p); const b = await c.balanceOf(evm); if (b > 0n) got.push({ chainId: pc.chainId, currency: ex.addr, symbol: ex.symbol, label: pc.label + ' (' + ex.symbol + ')', balance: Number(ethers.formatUnits(b, ex.dec || 18)), has: true }); } catch {} }
        return got;
      }));
      rows.forEach(g => out.push(...g));
      // Robinhood Chain (4663) is the mint chain: native ETH there pays directly (no bridge), and holding
      // ROBINVAULT is the most direct path of all. Both surfaced for the connected EVM wallet.
      try {
        const n = NETS.mainnet; const rp = providerFor(n.chainId, n.rpc);
        try { const be = await rp.getBalance(evm); out.push({ chainId: 4663, currency: EVM_NATIVE, symbol: 'ETH', label: 'Robinhood (ETH)', balance: Number(ethers.formatEther(be)), has: be > 0n }); } catch {}
        const t = new ethers.Contract(RVLT_TOKEN, ERC20_ABI, rp);
        const b = await t.balanceOf(evm);
        out.push({ chainId: 4663, currency: RVLT_TOKEN, symbol: 'RVLT', label: 'Robinhood (ROBINVAULT)', balance: Number(ethers.formatUnits(b, 18)), has: b > 0n });
      } catch {}
    }
    if (sol && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sol)) {
      try { const lamports = await solRpc('getBalance', [sol]); const bal = Number((lamports && lamports.value) || 0) / 1e9; out.push({ chainId: 792703809, currency: SOL_NATIVE_SENTINEL, symbol: 'SOL', label: 'Solana (SOL)', balance: bal, has: bal > 0 }); } catch {}
      try {
        const r = await solRpc('getTokenAccountsByOwner', [sol, { mint: SOL_USDC_MINT }, { encoding: 'jsonParsed' }]);
        let amt = 0; for (const a of ((r && r.value) || [])) { try { amt += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0); } catch {} }
        out.push({ chainId: 792703809, currency: SOL_USDC_MINT, symbol: 'USDC', label: 'Solana (USDC)', balance: amt, has: amt > 0 });
      } catch {}
    }
    // Value each balance in USD so the UI can show USD everywhere (mint is quoted in USD).
    let pEth = 0, pSol = 0, pPol = 0, pRvlt = 0, pBnb = 0;
    try { const c = await cfg(); [pEth, pSol, pPol, pRvlt, pBnb] = await Promise.all([ethUsd(), solUsd(), polUsd(), rvltUsd(c), bnbUsd()]); } catch {}
    // WETH tracks ETH 1:1 for valuation.
    const pxFor = (a) => a.symbol === 'USDC' ? 1 : (a.symbol === 'ETH' || a.symbol === 'WETH') ? pEth : a.symbol === 'SOL' ? pSol : a.symbol === 'POL' ? pPol : a.symbol === 'BNB' ? pBnb : a.symbol === 'RVLT' ? pRvlt : 0;
    out.forEach(a => { const px = pxFor(a); a.usd = px > 0 ? a.balance * px : null; });
    res.json({ assets: out.filter(o => o.has), checked: out, prices: { ETH: pEth, WETH: pEth, SOL: pSol, POL: pPol, BNB: pBnb, RVLT: pRvlt, USDC: 1 } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Minimal Solana JSON-RPC proxy (server-side, keyless by default). The client needs a recent blockhash, the address
// lookup tables Relay references, and signature-status polling to build + confirm the Solana leg. Read-only passthrough,
// whitelisted methods only, so the browser never calls a Solana RPC directly.
const SOL_RPC_METHODS = new Set(['getLatestBlockhash', 'getMultipleAccounts', 'getAccountInfo', 'getSignatureStatuses', 'getBalance', 'getTokenAccountsByOwner']);
app.post('/api/sol-rpc', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const method = String(req.body?.method || '');
    if (!SOL_RPC_METHODS.has(method)) return res.status(400).json({ error: 'method not allowed' });
    const result = await solRpc(method, req.body?.params || []);
    res.json({ result });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ── Per-wallet mint state: how many this wallet has already minted vs the cap, and whether it holds any Robbers.
// Drives the "you can't mint" state on the button when a wallet has used its allocation. ──
app.get('/api/minted', async (req, res) => {
  try {
    const addr = String(req.query.address || '');
    if (!ethers.isAddress(addr)) return res.status(400).json({ error: 'valid address required' });
    const c = await cfg(); const n = net(c);
    const ct = new ethers.Contract(n.robbers, ['function mintedBy(address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'], providerFor(n.chainId, n.rpc));
    const [minted, balance] = await Promise.all([ct.mintedBy(addr).catch(() => 0n), ct.balanceOf(addr).catch(() => 0n)]);
    const cap = 3;
    res.json({ minted: Number(minted), balance: Number(balance), cap, remaining: Math.max(0, cap - Number(minted)) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Immortalized V1 + V2 stats for the showcase tabs. V1 = frozen archive totals (rtv_*_v1archive / V1-STATS.md,
// V1 retired 2026-09-15). V2 = live totals from the mainnet (net=4663) run table.
app.get('/api/legacy-stats', async (req, res) => {
  const v1 = { runs: 1918, players: 108, coreCracks: 1, rvltBurned: 945500, ethRobbed: 4, maxDepth: 10, window: '2026-09-07 to 2026-09-13' };
  let v2 = { runs: 0, players: 0, robs: 0, rvltBurned: 0, rvltWon: 0, ethRobbed: 0, maxDepth: 0, nftMinted: 136, potRecovered: 4076904 };
  try {
    const r = (await dbQuery("SELECT COUNT(*) runs, COUNT(DISTINCT player) players, SUM(CASE WHEN outcome IN ('rob','core') THEN 1 ELSE 0 END) robs, MAX(depth) maxdepth, ROUND(SUM(COALESCE(burned_rvlt,0))) burned, ROUND(SUM(COALESCE(won_rvlt,0))) won, SUM(COALESCE(robbed_eth,0)) eth FROM rtv_runs WHERE net=4663"))[0] || {};
    v2 = { runs: +r.runs || 0, players: +r.players || 0, robs: +r.robs || 0, rvltBurned: +r.burned || 0, rvltWon: +r.won || 0, ethRobbed: +r.eth || 0, maxDepth: +r.maxdepth || 0, nftMinted: 136, potRecovered: 4076904 };
  } catch (e) {}
  // Canonical immortalized display values (Jake 2026-09-21): V2 = 1 core crack, 1 ETH robbed.
  v2.robs = 1; v2.ethRobbed = 1;
  res.json({ v1, v2 });
});

// ── Live ROBINVAULT (RVLT) token stats for the showcase tab. Market data from Dexscreener (server-side),
// supply + burned read on-chain from the mainnet token. Burned = balance sitting in the dead/zero addresses.
const RVLT_TOKEN = '0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04';
const ERC20_ABI = ['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
// True LIFETIME trading volume: sum daily OHLCV across every RVLT pool on GeckoTerminal (network slug 'robinhood').
// Dexscreener only exposes 24h; GeckoTerminal daily candles summed = cumulative all-time. Cached 30 min (it's several calls).
const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const RVLT_MAIN_POOL = '0xcc31c5acf0db55d391a9d97171c6bcc549ec7974540e84dddaaf0cabd3384697';
// All-time volume is DISK-PERSISTED + background-refreshed. GeckoTerminal is the only all-time source (Dexscreener is
// 24h only), and GT rate-limits the shared host IP (the peg hits GT too), so a blocking per-request fetch would often
// return 0. Instead we serve the last-known value instantly and refresh in the background when stale (>30min).
const VOL_FILE = path.join(__dirname, '.vol-cache.json');
let _ltv = (() => { try { const j = JSON.parse(fs.readFileSync(VOL_FILE, 'utf8')); if (j && j.v > 0) return { v: j.v, at: j.at || 0, _refreshing: false }; } catch (_) {} return { v: 0, at: 0, _refreshing: false }; })();
async function _refreshLifetimeVolume() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    let pools = [];
    try {
      const pr = await fetch(`${GT}/tokens/${RVLT_TOKEN}/pools?page=1`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const pj = await pr.json();
      pools = (pj.data || []).map(p => p.attributes || {})
        .sort((a, b) => Number((b.volume_usd && b.volume_usd.h24) || 0) - Number((a.volume_usd && a.volume_usd.h24) || 0))
        .map(a => a.address).filter(Boolean);
    } catch (_) {}
    if (!pools.includes(RVLT_MAIN_POOL)) pools.unshift(RVLT_MAIN_POOL);
    pools = pools.slice(0, 8);
    let total = 0;
    for (const pool of pools) {
      try {
        const r = await fetch(`${GT}/pools/${pool}/ohlcv/day?limit=1000`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (r.status === 429) { await sleep(1500); continue; }
        const j = await r.json();
        const list = (j.data && j.data.attributes && j.data.attributes.ohlcv_list) || [];
        for (const row of list) total += Number(row[5] || 0);
      } catch (_) {}
      await sleep(300);   // gentle pacing so a burst never trips GeckoTerminal's rate limit
    }
    if (total > 0) { _ltv.v = total; _ltv.at = Date.now(); try { fs.writeFileSync(VOL_FILE, JSON.stringify({ v: total, at: _ltv.at })); } catch (_) {} }
  } catch (_) {}
}
// Sync accessor: return the last-known all-time volume immediately; kick off a background refresh when stale.
function lifetimeVolume() {
  if ((!_ltv.at || Date.now() - _ltv.at > 1800000) && !_ltv._refreshing) {
    _ltv._refreshing = true;
    _refreshLifetimeVolume().finally(() => { _ltv._refreshing = false; });
  }
  return _ltv.v;
}
let _tok = { v: null, at: 0 };
app.get('/api/token', async (req, res) => {
  try {
    if (_tok.v && Date.now() - _tok.at < 60000) return res.json(_tok.v);
    const n = NETS.mainnet;
    const t = new ethers.Contract(RVLT_TOKEN, ERC20_ABI, new ethers.JsonRpcProvider(n.rpc, n.chainId));
    const [supplyWei, deadWei, zeroWei] = await Promise.all([
      t.totalSupply().catch(() => 0n),
      t.balanceOf('0x000000000000000000000000000000000000dEaD').catch(() => 0n),
      t.balanceOf('0x0000000000000000000000000000000000000000').catch(() => 0n),
    ]);
    const f = v => Number(ethers.formatUnits(v, 18));
    // ROBINVAULT's 50% burn reduced token supply via burn(), so real burned = original supply - current supply
    // (plus anything parked in the dead/zero addresses). Original supply was 1,000,000,000.
    const ORIGINAL_SUPPLY = 1000000000;
    const supply = f(supplyWei), deadZero = f(deadWei + zeroWei);
    const burned = Math.max(0, ORIGINAL_SUPPLY - supply) + deadZero;
    const circulating = Math.max(0, supply - deadZero);
    let price = 0, marketCap = 0, fdv = 0, liquidity = 0, volume24h = 0, priceChange24h = 0;
    // PRIMARY source: GeckoTerminal (authoritative for Robinhood Chain — same pools the Pons launchpad reads).
    // FALLBACK: Dexscreener. We do NOT trust a provider's marketCap field (Dexscreener returned mc==fdv on FULL
    // supply, overstating it). Market cap is SELF-COMPUTED = live price × our on-chain CIRCULATING (supply - burned).
    try {
      const gr = await fetch(GT + '/tokens/' + RVLT_TOKEN, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      const ga = ((await gr.json()) || {}).data?.attributes || {};
      price = Number(ga.price_usd || 0);
      volume24h = Number(ga.volume_usd?.h24 || 0);
      liquidity = Number(ga.total_reserve_in_usd || 0);
    } catch (_) {}
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + RVLT_TOKEN, { signal: AbortSignal.timeout(8000) });
      const j = await r.json(); const pairs = j.pairs || [];
      const p = pairs.find(x => x.chainId === 'robinhood') || pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (p) {
        if (!price) price = Number(p.priceUsd || 0);
        if (!volume24h) volume24h = Number(p.volume?.h24 || 0);
        if (!liquidity) liquidity = Number(p.liquidity?.usd || 0);
        priceChange24h = Number(p.priceChange?.h24 || 0);
      }
    } catch (_) {}
    marketCap = price * circulating;   // authoritative: live price × on-chain circulating (post-burn)
    fdv = price * supply;              // fully-diluted on current total supply
    const volumeAllTime = await lifetimeVolume();
    const out = { token: RVLT_TOKEN, price, marketCap, fdv, liquidity, volume24h, volumeAllTime, priceChange24h, totalSupply: supply, burned, burnedPct: (burned / ORIGINAL_SUPPLY * 100), circulating, explorer: n.chainId === 4663 ? 'https://robin.etherscan.io' : '' };
    _tok = { v: out, at: Date.now() };
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── Buy & burn trackers: split the on-chain burned total into the RobinVault (game/token) slice and the Vault
// Robbers (NFT) slice. The NFT slice (mint premium + OpenSea royalties swept to the burn) is tracked explicitly in
// vr_buyburn; everything else is attributed to the game. Valued in USD at the live price. Display-only, read-only. ──
async function burnedNow() {
  if (_tok.v && Date.now() - _tok.at < 60000) return { burned: _tok.v.burned, price: _tok.v.price };
  const n = NETS.mainnet;
  const t = new ethers.Contract(RVLT_TOKEN, ERC20_ABI, new ethers.JsonRpcProvider(n.rpc, n.chainId));
  const [s, d, z] = await Promise.all([
    t.totalSupply().catch(() => 0n),
    t.balanceOf('0x000000000000000000000000000000000000dEaD').catch(() => 0n),
    t.balanceOf('0x0000000000000000000000000000000000000000').catch(() => 0n),
  ]);
  const f = v => Number(ethers.formatUnits(v, 18));
  const burned = Math.max(0, 1000000000 - f(s)) + f(d + z);
  let price = 0; try { price = await rvltUsd(await cfg()); } catch {}
  return { burned, price };
}
// ── OpenSea royalty indexer: the Vault Robbers "buy & burn" slice = the 2% royalty on the collections'
// secondary sales, which now routes to the deployer and is bought-and-burned by the Emblem Terminal. We read it at
// the source: Seaport OrderFulfilled events where our collection is the offered NFT, summing consideration paid to a
// known royalty receiver. Native ETH valued at the live ETH price. Cursor-based + bounded per call so it can never
// hammer the RPC; cached 30 min. Pure read. Mint revenue is NOT counted here (it funds the treasury, it does not burn).
const SEAPORT = (process.env.VR_SEAPORT || '0x0000000000000068F116a894984e2DB1123eB395');
const VR_COLLECTIONS = String(process.env.VR_COLLECTIONS || NETS.mainnet.robbers || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const VR_ROY_RECEIVERS = String(process.env.VR_ROYALTY_RECEIVERS || '0xe8886FD4863855884D5F1FFfA38F8C1c8502Ec8c,0x96bcfdb15b65245f5b9796c7a058fb3649f52432').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const OF_IFACE = new ethers.Interface(['event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer, (uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)']);
const OF_TOPIC = OF_IFACE.getEvent('OrderFulfilled').topicHash;
async function kvGet(k, d) { try { const r = await dbQuery("SELECT value FROM vrmint_config WHERE key=?", [k]); return (r[0] && r[0].value != null) ? r[0].value : d; } catch { return d; } }
async function kvSet(k, v) { try { await dbExec("INSERT OR REPLACE INTO vrmint_config (key,value) VALUES (?,?)", [k, String(v)]); } catch {} }
let _roy = { v: null, at: 0 };
async function royaltyEthCumulative() {
  if (_roy.v != null && Date.now() - _roy.at < 1800000) return _roy.v;   // 30 min
  if (!VR_COLLECTIONS.length || !VR_ROY_RECEIVERS.length) return 0;
  const n = NETS.mainnet;
  const prov = new ethers.JsonRpcProvider(n.rpc, n.chainId);
  const head = await prov.getBlockNumber();
  let cursor = parseInt(await kvGet('vr_roy_block', String(Math.max(0, head - 50000))), 10) || 0;
  let accEth = Number(await kvGet('vr_roy_eth', '0')) || 0;
  const CH = 40000, MAX_SPAN = 200000;                 // bound work per call; cursor resumes next time
  const stop = Math.min(head, cursor + MAX_SPAN);
  const colSet = new Set(VR_COLLECTIONS), recvSet = new Set(VR_ROY_RECEIVERS);
  for (let from = cursor; from < stop; from += CH + 1) {
    const to = Math.min(from + CH, stop);
    try {
      const logs = await prov.getLogs({ address: SEAPORT, fromBlock: from, toBlock: to, topics: [OF_TOPIC] });
      for (const lg of logs) {
        try {
          const p = OF_IFACE.parseLog(lg);
          const sellsOurNft = p.args.offer.some(o => colSet.has(String(o.token).toLowerCase()) && (Number(o.itemType) === 2 || Number(o.itemType) === 3));
          if (!sellsOurNft) continue;
          for (const c of p.args.consideration) {
            if (!recvSet.has(String(c.recipient).toLowerCase())) continue;
            const it = Number(c.itemType);
            if (it === 0 || (it === 1 && String(c.token).toLowerCase() === WETH_MAINNET.toLowerCase())) accEth += Number(ethers.formatEther(c.amount));
          }
        } catch {}
      }
    } catch {}
  }
  await kvSet('vr_roy_block', String(stop));
  await kvSet('vr_roy_eth', String(accEth));
  _roy = { v: accEth, at: Date.now() };
  return accEth;
}
app.get('/api/buyburn', async (req, res) => {
  try {
    const { burned, price } = await burnedNow();
    const [royEth, ethPx] = await Promise.all([royaltyEthCumulative().catch(() => 0), ethUsd().catch(() => 0)]);
    const royUsd = royEth * ethPx;
    const nftRvlt = price ? royUsd / price : 0;          // RVLT-equivalent of the royalties bought & burned
    const game = Math.max(0, burned - nftRvlt);
    res.json({
      price,
      robinvault: { rvlt: game, usd: price ? game * price : null },
      vaultrobbers: { rvlt: nftRvlt, usd: royUsd || 0 },
      total: { rvlt: burned, usd: price ? burned * price : null },
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Daily / weekly burn — scan Transfer→(zero|dead) logs over the last 24h / 7d. No archive state on this RPC, so we
// read event logs in chunks. Robinhood Chain is ~0.1s/block; block window is computed live. Cached 30 min (burns are slow).
const XFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ZERO_T = ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32);
const DEAD_T = ethers.zeroPadValue('0x000000000000000000000000000000000000dEaD', 32);
let _burns = { v: null, at: 0 };
async function burnStats() {
  if (_burns.v && Date.now() - _burns.at < 1800000) return _burns.v;
  const n = NETS.mainnet;
  const prov = new ethers.JsonRpcProvider(n.rpc, n.chainId);
  const now = await prov.getBlockNumber();
  const [b0, b1] = await Promise.all([prov.getBlock(now), prov.getBlock(now - 100000)]);
  const dt = Math.max(0.02, (b0.timestamp - b1.timestamp) / 100000);   // seconds/block
  const perDay = Math.min(3000000, Math.round(86400 / dt));            // clamp for safety
  const weekStart = Math.max(0, now - perDay * 7), dayStart = now - perDay;
  // Robinhood RPC CAPS eth_getLogs at 100,000 blocks/request — the old 250k chunk errored EVERY call (silently caught
  // -> always 0 burns). Chunk at 90k and fetch with bounded concurrency so a full week (~67 chunks) stays fast.
  const CH = 90000, CONC = 6;
  const ranges = [];
  for (let from = weekStart; from <= now; from += CH + 1) ranges.push([from, Math.min(from + CH, now)]);
  let dayBurn = 0n, weekBurn = 0n;
  for (let i = 0; i < ranges.length; i += CONC) {
    const batch = ranges.slice(i, i + CONC).map(([from, to]) =>
      prov.getLogs({ address: RVLT_TOKEN, fromBlock: from, toBlock: to, topics: [XFER_TOPIC, null, [ZERO_T, DEAD_T]] }).catch(() => []));
    for (const logs of await Promise.all(batch)) for (const l of logs) { const v = BigInt(l.data); weekBurn += v; if (l.blockNumber >= dayStart) dayBurn += v; }
  }
  const f = v => Number(ethers.formatUnits(v, 18));
  const out = { daily: f(dayBurn), weekly: f(weekBurn), asOf: Date.now() };
  _burns = { v: out, at: Date.now() };
  return out;
}
app.get('/api/burns', async (req, res) => {
  try { res.json(await burnStats()); } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ── PUBLIC landing burns (UNGATED — see the bypass in the dev gate middleware). Returns the FULL landing shape
// {daily, weekly, total, dailyPct, weeklyPct, totalPct} so the un-authed landing page can show the live burn
// counter. Combines burnStats() (rolling daily/weekly) with the on-chain total from burnedNow() (which reuses the
// /api/token compute: 1e9 - totalSupply + dead/zero). Read-only, safe to expose. Cached ~30 min via both sources'
// own 30-min caches, plus a thin wrapper cache so a burst of landing hits can't fan out to the RPC. ──
const LANDING_ORIGINAL_SUPPLY = 1000000000;
let _landingBurns = { v: null, at: 0 };
app.get('/api/landing-burns', async (req, res) => {
  try {
    if (_landingBurns.v && Date.now() - _landingBurns.at < 1800000) return res.json(_landingBurns.v);
    const [bs, bn] = await Promise.all([burnStats(), burnedNow()]);
    const total = bn.burned || 0;
    const pct = x => (x || 0) / LANDING_ORIGINAL_SUPPLY * 100;
    const out = {
      daily: bs.daily || 0, weekly: bs.weekly || 0, total,
      dailyPct: pct(bs.daily), weeklyPct: pct(bs.weekly), totalPct: pct(total),
      asOf: Date.now(),
    };
    _landingBurns = { v: out, at: Date.now() };
    res.json(out);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.use(express.static(path.join(__dirname, 'public')));

// Explicit HTTP server so we can carry WebSocket UPGRADES for /play/v3 (Vault Standoff's live feed). v1/v2 are
// polling-based and unaffected. CRITICAL: upgrades bypass the Express pipeline, so we re-enforce the SAME hub
// password gate here (otherwise an un-authed client could open the v3 socket directly), THEN proxy to the
// isolated Standoff backend on loopback with the platform token injected (its own gate honors that bypass).
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url.indexOf('/play/v3') !== 0) { try { socket.destroy(); } catch (_) {} return; }
  (async () => {
    if (!gateTokenOk(parseCookies(req).vr_gate, DEV_PW_HASH)) { try { socket.destroy(); } catch (_) {} return; }  // dev gate the socket
    if (!(await isV3Open())) { try { socket.destroy(); } catch (_) {} return; }   // V3 launch gate: no socket before sell-out/Halloween
    const port = standoffPort();
    if (!port) { try { socket.destroy(); } catch (_) {} return; }
    const path2 = url.slice('/play/v3'.length) || '/';
    const headers = { ...req.headers, authorization: 'Bearer ' + TOKEN };
    const preq = http.request({ hostname: '127.0.0.1', port, path: path2, method: req.method, headers });
    preq.on('upgrade', (pres, psock, phead) => {
      const lines = ['HTTP/1.1 ' + (pres.statusCode || 101) + ' ' + (pres.statusMessage || 'Switching Protocols')];
      for (let i = 0; i < pres.rawHeaders.length; i += 2) lines.push(pres.rawHeaders[i] + ': ' + pres.rawHeaders[i + 1]);
      try { socket.write(lines.join('\r\n') + '\r\n\r\n'); } catch (_) {}
      if (head && head.length) { try { psock.write(head); } catch (_) {} }
      if (phead && phead.length) { try { socket.write(phead); } catch (_) {} }
      psock.pipe(socket); socket.pipe(psock);
      psock.on('error', () => { try { socket.destroy(); } catch (_) {} });
      socket.on('error', () => { try { psock.destroy(); } catch (_) {} });
    });
    preq.on('error', () => { try { socket.destroy(); } catch (_) {} });
    preq.end();
  })().catch(() => { try { socket.destroy(); } catch (_) {} });
});
server.listen(process.env.PORT, () => console.log('[vaultrobbers-mint-dev] listening on', process.env.PORT, 'net', DEFAULTS.network));

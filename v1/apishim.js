/* Robbing the Vault V1 - static api shim. The original V1 client streamed input to fetch('api/...'); this file
   intercepts those calls in the browser and answers them from the local RTVEngineV1 (engine.js). No server, no
   wallet, no money. Every on-chain / mint / arcade route returns a benign offline answer so nothing throws. */
(function () {
  "use strict";
  if (window.__VR1_SHIM) return; window.__VR1_SHIM = true;
  var E = function () { return window.RTVEngineV1 || {}; };
  var _f = window.fetch ? window.fetch.bind(window) : null;
  function J(o) { return new Response(JSON.stringify(o == null ? { ok: false } : o), { status: 200, headers: { "Content-Type": "application/json" } }); }
  function readBody(init) { try { return init && init.body ? JSON.parse(init.body) : {}; } catch (e) { return {}; } }
  function readQuery(url) { var q = {}, i = url.indexOf("?"); if (i >= 0) url.slice(i + 1).split("&").forEach(function (p) { var kv = p.split("="); q[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || "").replace(/\+/g, " ")); }); return q; }
  function route(path, b, q) {
    var e = E();
    if (path === "api/enter") return e.enter ? e.enter(b) : { error: "engine" };
    if (path === "api/mini/start") return e.miniStart(b);
    if (path === "api/mini/step") return e.miniStep(q);
    if (path === "api/crack") return e.crack(b);
    if (path === "api/cashout") return e.cashout(b);
    if (path === "api/forfeit") return e.forfeit(b);
    if (path === "api/config") return e.config();
    if (path === "api/state") return e.state();
    if (path === "api/recent-wins") return e.recentWins();
    if (path.indexOf("api/run/") === 0) return e.runById(path.slice(8));
    if (path === "api/visit" || path === "api/health") return { ok: true };
    // everything money/mint/chain/arcade is retired in the free archive -> benign offline answers, never throw
    if (path.indexOf("api/mini/preview") === 0) return { ok: false, retired: true };
    if (path.indexOf("api/onchain/") === 0) return { ok: false, onchainOnly: false, retired: true, disabled: true };
    return { ok: false, retired: true, disabled: true };
  }
  window.fetch = function (input, init) {
    try {
      var url = (typeof input === "string") ? input : (input && input.url) || "";
      var m = url.match(/(?:^|\/)(api\/[a-z0-9/_-]+)/i);
      if (m) { var path = m[1].replace(/\/+$/, ""); return Promise.resolve(J(route(path, readBody(init), readQuery(url)))); }
    } catch (e) {}
    return _f ? _f(input, init) : Promise.reject(new Error("offline"));
  };
})();

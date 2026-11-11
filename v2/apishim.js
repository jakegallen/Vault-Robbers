/* Vault Robbers - static api shim (Phase 1).
   The original game was a server app: the browser talked to it over fetch('api/...').
   This file makes the SAME client run with no server by intercepting those calls in the
   browser and answering them locally. No wallet, no chain, no money: free play, forever.

   Phase 1 scope: the lobby + display endpoints are real (config, state, recent-wins, run,
   visit, behavior, clientenv, arcade/best) and every on-chain route returns a benign offline
   answer so nothing throws or tries to connect a wallet. The game-engine endpoints (enter,
   crack, mini/*, skill/*) are STUBBED here and get their real client-side port in Phase 2. */
(function () {
  "use strict";
  var LS = window.localStorage;
  var jget = function (k, d) { try { var v = LS.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  var jset = function (k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) {} };
  // the engine is loaded by engine/engine.bundle.js (before this file); reference it lazily so load order is forgiving.
  var ENG = function () { return window.RTVEngine; };
  var getRun = function (id) { return jget("rtv_run_" + id, null); };
  var setRun = function (run) { if (run && run.runId) jset("rtv_run_" + run.runId, run); return run; };

  // ---- static config: the 10-chamber ladder, free-play economy (fees/burn/pot all zero/off) ----
  var CONFIG = {
    levels: 10,
    doors: { left: {}, center: {}, right: {} },
    categories: ["luck", "skill", "perception", "dexterity"],
    burnShare: 1.0, fee: 0, chips: 0, cashoutMin: 5,
    potLadder: { 5: 0.01, 6: 0.03, 7: 0.10, 8: 0.20, 9: 0.30 },
    token: null, pair: null, creatorBps: 0, mintSpots: false, coreChoice: false,
    v2: true, casino: false, holderDiscount: 0, potFloor: 0, potTarget: 0,
    ladderV2: {}, ladderV2On: false, potPayFloor: 0, devSkip: false,
    testnet: true, freePlay: true, freeArcade: true, hidePractice: false,
    openSource: true   // marker: this is the free, static, open-source build
  };
  var STATE = { jackpotEth: 0, potRvlt: 0, burnedRvlt: 0, plays: 0, robs: 0, jackpotUsd: 0, syncing: false, recent: [], board: [] };

  // ---- route table: path (no query) -> function(method, bodyObj, query) -> response object ----
  var TODO = { _stub: true };   // TODO Phase 2: port engine (crack loop + skill grading) to the browser
  var routes = {
    // ---- REAL: lobby + display ----
    "api/config": function () { return CONFIG; },
    "api/state": function () { return STATE; },
    "api/recent-wins": function () { return { wins: [] }; },
    "api/status": function () { return { ok: true }; },
    "api/visit": function () { return { ok: true }; },
    "api/behavior": function () { return { ok: true }; },
    "api/clientenv": function () { return { ok: true }; },
    "api/arcade/best": function (m, body, q) {
      if (m === "POST") { var map = jget("rtv_galbest", {}); if (body && body.game != null && body.pct != null) { if (map[body.game] == null || body.pct > map[body.game]) map[body.game] = body.pct; jset("rtv_galbest", map); } return { ok: true }; }
      return { best: jget("rtv_galbest", {}) };
    },

    // ---- REAL: run state from localStorage (resume) ----
    // handled dynamically below (api/run/:id)

    // ---- REAL (Phase 2): the deterministic chamber loop + skill engine, ported to the browser (engine.bundle.js) ----
    "api/enter": function (m, body) {
      var e = ENG().enter(body && body.clientSeed);
      setRun(e.run);                           // persist the run (seed/depth/nonce/mult) for mini/start + crack + resume
      jset("rtv_cur_run", e.run.runId);
      return e.resp;                           // { runId, serverHash, clientSeed, levels, doors, ... }
    },
    // open the chosen door: build the seed-derived challenge, remember the door on the run (crack reads it), hand back the answer-free descriptor
    "api/mini/start": function (m, body) {
      var run = getRun(body && body.runId); if (!run) return { error: "no open run" };
      var ch = ENG().startDoorSession(run, (body && body.door) || "center");
      if (!ch) return { error: "cleared" };
      run.cur_door = ch.door; run.cur_sid = ch.sid; setRun(run);
      return ch;                               // { sid, v4, gameKey, kind, door, level, data, frames, flashMs, minMs }
    },
    "api/crack": function (m, body) {
      var run = getRun(body && body.runId); if (!run) return { error: "no open run" };
      var out = ENG().crack(run, run.cur_door || "center", (body && body.events) || []);
      if (out.resp && out.resp.error) return out.resp;
      var nr = out.run; nr.cur_door = null; nr.cur_sid = null; setRun(nr);   // advance / bust, clear the active door
      return out.resp;
    },
    "api/forfeit": function (m, body) { var run = getRun(body && body.runId); if (run) { run.status = "busted"; setRun(run); } return { ok: true }; },
    "api/cashout": function (m, body) {
      var run = getRun(body && body.runId); if (!run) return { error: "no run" };
      run.status = "cashed"; setRun(run);
      var share = Math.max(0, Math.min(1, ((run.depth || 0) >= 5 ? (0.01 * Math.pow(2.4, (run.depth - 5))) : 0)));
      var won = Math.round((ENG().POT_SEED_RVLT || 0) * share);     // cosmetic: free play, nothing real moves
      return { ok: true, depth: run.depth || 0, mult: run.mult || 1, won: { rvltWon: won }, rvltWon: won };
    },
    // ARCADE / practice skill path (free + open now): start -> frames (Image) -> grade, all local
    "api/skill/start": function (m, body) {
      try { return ENG().startSession({ seed: body && body.seed, level: body && body.level, gameKey: body && body.gameKey }); }
      catch (e) { return { error: "start", detail: String(e && e.message) }; }
    },
    "api/skill/grade": function (m, body) {
      try { return ENG().gradeSession((body && body.sid) || "", (body && body.events) || []); }
      catch (e) { return { error: "grade" }; }
    },
    "api/skill/step": function (m, body, q) { return ENG().getStep((q && q.sid) || (body && body.sid) || "", parseInt((q && q.i) || (body && body.i) || 0, 10)); },
    "api/mini/step": function (m, body, q) {
      var run = getRun((q && q.runId) || (body && body.runId)); var sid = run && run.cur_sid;
      return sid ? ENG().getStep(sid, parseInt((q && q.i) || (body && body.i) || 0, 10)) : { done: true };
    },
    "api/skill/audio": function () { return { ok: true }; },     // procedural audio draws client-side; the server WAV path is retired
    "api/mini/v4audio": function () { return { ok: true }; },
    "api/dev/skip": function () { return { ok: false }; },       // dev-only shortcut, off in the public build

    // ---- ONCHAIN -> benign offline answers (never connect a wallet, never move money) ----
    "api/onchain/config": function () { return { enabled: false, onchain: false, freePlay: true }; },
    "api/onchain/chainstate": function () { return { enabled: false }; },
    "api/onchain/treasury": function () { return { vaultEth: 0, potRvlt: 0, burned: 0 }; },
    "api/onchain/settled": function () { return { ok: true }; },
    "api/onchain/comp-enter": function () { return { enabled: false }; },
    "api/comp/status": function () { return { enabled: false, open: false }; },
    "api/arcade/status": function () { return { pass: false, enabled: false, freeArcade: true }; },
    "api/arcade/pass": function () { return { ok: false, enabled: false }; },
    "api/practice/status": function () { return { enabled: false, runs: 0, free: true }; },
    "api/practice/buy": function () { return { ok: false, enabled: false }; },
    "api/practice/spend": function () { return { ok: true, free: true }; },
    "api/robbers/state": function () { return { enabled: false, minted: 0, max: 1000 }; },
    "api/robbers/mint-exit": function () { return { ok: true }; },
    "api/robbers/voucher": function () { return { enabled: false }; },
    "api/robbers/gallery": function () { return { items: [] }; },
    "api/sac-address": function () { return { address: null }; },
    "api/sac-info": function () { return { enabled: false }; }
  };

  function prefixRoute(path) {
    // dynamic / prefixed routes
    if (path.indexOf("api/run/") === 0) {
      var id = path.slice("api/run/".length);
      return function () { return jget("rtv_run_" + id, null) || { error: "not found", _stub: true }; };
    }
    if (path.indexOf("api/onchain/") === 0) return function () { return { enabled: false }; };
    if (path.indexOf("api/robbers/") === 0) return function () { return { enabled: false }; };
    if (path.indexOf("api/comp/") === 0) return function () { return { enabled: false }; };
    if (path.indexOf("api/arcade/") === 0) return function () { return { ok: false, enabled: false }; };
    if (path.indexOf("api/practice/") === 0) return function () { return { enabled: false, free: true }; };
    // api/skill/frame + api/mini/v4frame are IMAGE loads (new Image().src=...), intercepted below, not here. Any stray fetch -> empty.
    if (path.indexOf("api/skill/") === 0) return function () { return { ok: true }; };
    if (path.indexOf("api/mini/") === 0) return function () { return { ok: true }; };
    if (path.indexOf("api/admin/") === 0) return function () { return { error: "disabled" }; };
    return null;
  }

  // ---- recall-frame interception (memory/perception games) ----
  // The skill presenter loads frames with `new Image(); im.src = 'api/skill/frame?sid=..&i=..'` (or 'api/mini/v4frame?..'),
  // which the fetch override above does NOT catch. Wrap the Image src setter: for those URLs, render the frame locally
  // (engine getFrame -> pnggen.browser canvas -> data URL) and set THAT as the real src. Anti-cheat time-gates are dropped
  // (free play, nothing at stake). Everything else sets through untouched.
  try {
    var ImgProto = window.HTMLImageElement && window.HTMLImageElement.prototype;
    var nativeSrc = ImgProto && Object.getOwnPropertyDescriptor(ImgProto, "src");
    if (nativeSrc && nativeSrc.set) {
      Object.defineProperty(ImgProto, "src", {
        configurable: true, enumerable: nativeSrc.enumerable,
        get: function () { return nativeSrc.get.call(this); },
        set: function (val) {
          try {
            var n = normalize(val);
            if (n.path === "api/skill/frame" || n.path === "api/mini/v4frame") {
              var E = ENG(), data = null;
              if (n.query.sid) data = E.getFrame(n.query.sid, parseInt(n.query.i || 0, 10));
              else if (n.query.runId) { var run = getRun(n.query.runId); if (run) data = E.getRunFrame(run, run.cur_door || "center", parseInt(n.query.i || 0, 10)); }
              if (typeof data === "string") { nativeSrc.set.call(this, data); return; }     // browser: a PNG data URL
              nativeSrc.set.call(this, TRANSPARENT_PX); return;                              // no frame -> a 1x1 so onload fires, never a 404
            }
          } catch (e) {}
          nativeSrc.set.call(this, val);
        }
      });
    }
  } catch (e) {}
  var TRANSPARENT_PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  function normalize(url) {
    // keep only the relative "api/..." part, strip origin, leading ./ or /, and the query string
    var u = String(url);
    try { if (/^https?:\/\//.test(u)) u = new URL(u).pathname; } catch (e) {}
    u = u.replace(/^\.?\//, "");                    // ./api/x or /api/x -> api/x
    var q = {};
    var qi = u.indexOf("?");
    if (qi >= 0) {
      var qs = u.slice(qi + 1); u = u.slice(0, qi);
      qs.split("&").forEach(function (p) { if (!p) return; var kv = p.split("="); q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ""); });
    }
    return { path: u, query: q };
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = (input && input.url) ? input.url : input;
    var n = normalize(url);
    if (n.path.indexOf("api/") === 0) {
      var method = (init && init.method) || (input && input.method) || "GET";
      var body = null;
      try { if (init && init.body && typeof init.body === "string") body = JSON.parse(init.body); } catch (e) {}
      var handler = routes[n.path] || prefixRoute(n.path);
      var out = handler ? handler(method.toUpperCase(), body, n.query) : { error: "unknown route", path: n.path, _stub: true };
      try { (window.__API = window.__API || []).push(method.toUpperCase() + " " + n.path + (handler ? "" : " [UNHANDLED]") + (out && out.error ? " ERR:" + out.error : "")); if (window.__API.length > 200) window.__API.shift(); } catch (e) {}   // play trace: type __API in the console to see every call the game made
      var blob = JSON.stringify(out);
      return Promise.resolve(new Response(blob, { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    if (realFetch) return realFetch(input, init);
    return Promise.reject(new Error("fetch unavailable"));
  };
})();

/* ---- on-screen diagnostic overlay (temporary; removed before ship) ---- */
(function () {
  try {
    var box = document.createElement("div");
    box.id = "__vrdbg";
    box.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:2147483647;max-width:48vw;max-height:42vh;overflow:hidden;font:10px/1.35 ui-monospace,Menlo,monospace;color:#9ff;background:rgba(0,0,0,.74);border:1px solid #2a7;border-radius:6px;padding:6px 8px;pointer-events:none;white-space:pre-wrap;word-break:break-all";
    function mount() { if (document.body) document.body.appendChild(box); else addEventListener("DOMContentLoaded", mount); }
    mount();
    var errs = [];
    window.addEventListener("error", function (e) { try { errs.push("X " + (e.message || (e.error && e.error.message) || e) + (e.filename ? " @" + String(e.filename).split("/").pop() + ":" + e.lineno : "")); } catch (_) {} });
    window.addEventListener("unhandledrejection", function (e) { try { errs.push("X REJ " + ((e.reason && e.reason.message) || e.reason)); } catch (_) {} });
    setInterval(function () {
      try {
        var api = (window.__API || []).slice(-9);
        box.textContent = "VR trace  (api calls)\n" + (api.length ? api.join("\n") : "(none yet - click ENTER)") + (errs.length ? "\n-- errors --\n" + errs.slice(-6).join("\n") : "");
      } catch (_) {}
    }, 400);
  } catch (_) {}
})();

/* ---- ENTER resilience (static free-play): the 3D #scene canvas is fixed/full-screen; make sure it never eats the
   landing click, and ensure ENTER is wired to startRun even if the main init stalled before it got there. ---- */
(function () {
  try {
    var st = document.createElement("style");
    st.textContent = "body:has(#startO.on) #scene{pointer-events:none}#startO,#startO #enterCta,#startO #arcadeBtn{pointer-events:auto}#enterCta{position:relative;z-index:3}";
    (document.head || document.documentElement).appendChild(st);
  } catch (_) {}
  var iv = setInterval(function () {
    try {
      var b = document.getElementById("enterCta");
      if (b && !b.onclick && typeof window.startRun === "function") {   // only bind if main init did not; avoids a double api/enter
        b.onclick = window.startRun;
        (window.__API = window.__API || []).push("[fix] bound enterCta.onclick = startRun");
      }
    } catch (_) {}
  }, 400);
  setTimeout(function () { clearInterval(iv); }, 30000);
})();

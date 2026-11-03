/* ============================================================================
   Vault Standoff i18n runtime (standalone, zero deps)
   ----------------------------------------------------------------------------
   GROUNDWORK ONLY. This file is NOT yet wired into the live client. It is a
   drop-in engine that index.html can adopt later (see INTEGRATION.md) once the
   launch copy is frozen. It does not touch any game/money logic.

   Responsibilities:
     - load the per-language catalog JSON (English is the always-present fallback)
     - t(key, vars)  : key lookup with {placeholder} interpolation + English fallback
     - detect the browser language, persist a user choice in localStorage (vs_lang)
     - setLang(code) : switch language, re-render, emit a 'vs-lang-change' event
     - renderLanguageSwitcher(mountEl) : a compact top-right dropdown on-theme
     - Intl helpers  : fmtNumber / fmtCurrency so numbers localize correctly
     - RTL awareness  : sets <html dir="rtl"> for RTL languages (e.g. ar) so a
                        future Arabic catalog lays out correctly

   Global surface (attached to window.VSI18n):
     VSI18n.t, VSI18n.setLang, VSI18n.getLang, VSI18n.renderLanguageSwitcher,
     VSI18n.ready (a Promise), VSI18n.fmtNumber, VSI18n.fmtCurrency, VSI18n.languages
   ========================================================================== */
(function (global) {
  'use strict';

  // --- registry of shippable languages. Add a code here + a catalog.<code>.json
  //     file to light it up in the switcher. English is the base/fallback. ------
  var LANGUAGES = [
    { code: 'en',    name: 'English',    flag: '🇬🇧' },
    { code: 'es',    name: 'Español',    flag: '🇪🇸' },
    { code: 'fr',    name: 'Français',   flag: '🇫🇷' },
    { code: 'de',    name: 'Deutsch',    flag: '🇩🇪' },
    { code: 'it',    name: 'Italiano',   flag: '🇮🇹' },
    { code: 'nl',    name: 'Nederlands', flag: '🇳🇱' },
    { code: 'pl',    name: 'Polski',     flag: '🇵🇱' },
    { code: 'pt-BR', name: 'Português',  flag: '🇧🇷' },
    { code: 'ru',    name: 'Русский',    flag: '🇷🇺' },
    { code: 'uk',    name: 'Українська', flag: '🇺🇦' },
    { code: 'tr',    name: 'Türkçe',     flag: '🇹🇷' },
    { code: 'ar',    name: 'العربية',    flag: '🇸🇦', rtl: true },
    { code: 'fa',    name: 'فارسی',      flag: '🇮🇷', rtl: true },
    { code: 'ur',    name: 'اردو',       flag: '🇵🇰', rtl: true },
    { code: 'hi',    name: 'हिन्दी',       flag: '🇮🇳' },
    { code: 'bn',    name: 'বাংলা',       flag: '🇧🇩' },
    { code: 'ne',    name: 'नेपाली',       flag: '🇳🇵' },
    { code: 'ta',    name: 'தமிழ்',       flag: '🇮🇳' },
    { code: 'th',    name: 'ไทย',        flag: '🇹🇭' },
    { code: 'km',    name: 'ខ្មែរ',        flag: '🇰🇭' },
    { code: 'my',    name: 'မြန်မာ',      flag: '🇲🇲' },
    { code: 'vi',    name: 'Tiếng Việt', flag: '🇻🇳' },
    { code: 'id',    name: 'Indonesia',  flag: '🇮🇩' },
    { code: 'ms',    name: 'Melayu',     flag: '🇲🇾' },
    { code: 'tl',    name: 'Tagalog',    flag: '🇵🇭' },
    { code: 'zh-CN', name: '简体中文',    flag: '🇨🇳' },
    { code: 'zh-TW', name: '繁體中文',    flag: '🇹🇼' },
    { code: 'ja',    name: '日本語',      flag: '🇯🇵' },
    { code: 'ko',    name: '한국어',      flag: '🇰🇷' }
  ];
  var RTL_CODES = { ar: 1, he: 1, fa: 1, ur: 1 };

  var LS_KEY = 'vs_lang';
  var BASE = 'en';

  // catalogs are loaded on demand and cached here. English is required up front.
  var catalogs = {};       // { en: {...}, es: {...} }
  var current = BASE;
  var _readyResolve;
  var ready = new Promise(function (res) { _readyResolve = res; });

  // --- where to fetch a catalog from. RELATIVE path so it resolves on both the
  //     dashboard path (/pub/main/vault-standoff/) and the custom domain root.
  //     When wired, these files sit beside index.html (served statically). -----
  function catalogUrl(code) { return 'i18n/catalog.' + code + '.json'; }

  function isSupported(code) {
    for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].code === code) return true;
    return false;
  }

  // --- language detection: explicit saved choice > navigator languages > base.
  //     navigator.language gives e.g. "es-419" / "pt-BR"; we match on the 2-char
  //     primary subtag so regional variants fall back to the base translation. --
  // Resolve a browser BCP-47 tag (e.g. "pt-BR", "zh-Hant-TW", "en-US") to a
  // supported catalog code. Try the full tag, then region-aware variants for the
  // languages we ship as regionals (pt-BR, zh-CN, zh-TW), then the bare primary.
  function resolveTag(tag) {
    var raw = String(tag || '').trim();
    if (!raw) return null;
    // exact (case-insensitive) match against a registered code
    for (var i = 0; i < LANGUAGES.length; i++) {
      if (LANGUAGES[i].code.toLowerCase() === raw.toLowerCase()) return LANGUAGES[i].code;
    }
    var parts = raw.toLowerCase().split('-');
    var primary = parts[0];
    var region = parts[parts.length - 1];
    var script = parts.length > 1 ? parts[1] : '';
    if (primary === 'pt') return 'pt-BR';
    if (primary === 'zh') {
      // Traditional markers → zh-TW, everything else → zh-CN
      if (script === 'hant' || region === 'tw' || region === 'hk' || region === 'mo') return 'zh-TW';
      return 'zh-CN';
    }
    if (isSupported(primary)) return primary;
    return null;
  }

  function detectLang() {
    try {
      var saved = localStorage.getItem(LS_KEY);
      if (saved && isSupported(saved)) return saved;
    } catch (e) {}
    try {
      var list = navigator.languages && navigator.languages.length
        ? navigator.languages : [navigator.language || navigator.userLanguage || BASE];
      for (var i = 0; i < list.length; i++) {
        var r = resolveTag(list[i]);
        if (r) return r;
      }
    } catch (e) {}
    return BASE;
  }

  function isRtl(code) { return !!RTL_CODES[code]; }

  // --- fetch + cache a catalog. Resolves to the catalog object (or {} on error
  //     so a missing/broken catalog degrades to English fallback, never a crash).
  function loadCatalog(code) {
    if (catalogs[code]) return Promise.resolve(catalogs[code]);
    return fetch(catalogUrl(code))
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (json) { catalogs[code] = json || {}; return catalogs[code]; })
      .catch(function () { catalogs[code] = {}; return catalogs[code]; });
  }

  // --- interpolation: replace {placeholder} tokens from vars. Unknown tokens are
  //     left as-is so a missing var is visible in QA rather than silently blank.
  //     Numeric vars pass through fmtNumber so 12345 reads as the locale grouping.
  function interpolate(str, vars) {
    if (!vars || str.indexOf('{') === -1) return str;
    return str.replace(/\{(\w+)\}/g, function (m, k) {
      if (vars[k] == null) return m;
      var v = vars[k];
      return (typeof v === 'number') ? fmtNumber(v) : String(v);
    });
  }

  // --- t(key, vars): the lookup. Order: current catalog -> English catalog ->
  //     the raw key (so a never-translated key is obvious in the UI, not blank). -
  function t(key, vars) {
    var cur = catalogs[current];
    var en = catalogs[BASE];
    var str = (cur && cur[key] != null) ? cur[key]
            : (en && en[key] != null) ? en[key]
            : key;
    return interpolate(str, vars);
  }

  // --- Intl number / currency formatting keyed to the active language. --------
  function localeTag() {
    // map our short code to a sensible BCP-47 tag for Intl (region optional).
    var map = {
      en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
      nl: 'nl-NL', pl: 'pl-PL', 'pt-BR': 'pt-BR', ru: 'ru-RU', uk: 'uk-UA',
      tr: 'tr-TR', ar: 'ar', fa: 'fa-IR', ur: 'ur-PK', hi: 'hi-IN',
      bn: 'bn-BD', ne: 'ne-NP', ta: 'ta-IN', th: 'th-TH', km: 'km-KH',
      my: 'my-MM', vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY', tl: 'tl-PH',
      'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', ja: 'ja-JP', ko: 'ko-KR'
    };
    return map[current] || current || 'en-US';
  }
  function fmtNumber(n, opts) {
    try { return new Intl.NumberFormat(localeTag(), opts).format(n); }
    catch (e) { return String(n); }
  }
  // NOTE: the game prices in USD (entry) and settles in RVLT. fmtCurrency is for
  // the USD entry/deposit figures; RVLT amounts use fmtNumber (RVLT is not an ISO
  // currency, so it keeps the " RVLT" suffix in the catalog string, number only).
  function fmtCurrency(amount, ccy) {
    ccy = ccy || 'USD';
    try {
      return new Intl.NumberFormat(localeTag(), {
        style: 'currency', currency: ccy, maximumFractionDigits: 0
      }).format(amount);
    } catch (e) { return '$' + amount; }
  }

  /* ==========================================================================
     DOM TRANSLATION LAYER
     --------------------------------------------------------------------------
     The Vault Standoff client renders almost its entire UI from a single inline
     script (innerHTML / textContent / toast / canvas). Hand-wiring t() into
     every one of the ~600 call sites would be invasive and risk breaking game
     logic. Instead we translate the RENDERED English output back out of the DOM:

       - English IS the source, and catalog.en.json maps every English string to
         a stable key. We invert that into:
           * exactMap:  "<exact english>" -> translated string (443 plain keys)
           * templates: regex matchers for the 176 interpolated strings, e.g.
             "{n} caught" -> /^(.+?) caught$/  so "5 caught" captures "5" and we
             re-interpolate the translated template "{n}" slot with the capture.
       - A MutationObserver (plus a vs-lang-change hook) walks freshly rendered
         text nodes + translatable attributes (placeholder / title / aria-label)
         and swaps them to the active language. For `en` this is a no-op
         (identity), so the page renders pixel-identical to today.

     SKIPPED subtrees (never translated): chat message feeds and user-authored
     content (.msgs/.msg/.who/.mbody/.ticker), form inputs/textareas, <script>/
     <style>, the language switcher itself, and anything flagged [data-no-i18n].
     This keeps usernames, typed chat, and dynamic numbers from being mangled.
     ======================================================================== */
  var _exactMap = null;          // { englishString : translatedString } for current lang
  var _templates = null;         // [ { re, slots:[names], tpl, enTpl } ] for current lang
  var _revBuiltFor = null;       // lang the maps were built for
  var _observer = null;
  var _applyScheduled = false;

  // turn an English template with {tokens} into a matcher. We only build matchers
  // for templates that actually contain a placeholder; plain strings go in exactMap.
  function compileTemplate(enStr) {
    var slots = [];
    // escape regex metachars in the literal parts, turn {name} into a capture.
    var re = '^' + enStr.replace(/[.*+?^${}()|[\]\\]/g, function (ch, idx) {
      return '\\' + ch;
    });
    // the escape above also escaped our braces; undo on the {token} spans by
    // rebuilding from the original string instead. Simpler: do it in one pass.
    re = '^';
    var rest = enStr, m;
    var tokenRe = /\{(\w+)\}/;
    while ((m = tokenRe.exec(rest)) !== null) {
      var before = rest.slice(0, m.index);
      re += before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      slots.push(m[1]);
      re += '([\\s\\S]*?)';
      rest = rest.slice(m.index + m[0].length);
    }
    re += rest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    return { re: new RegExp(re), slots: slots };
  }

  function buildReverseIndex(code) {
    _exactMap = {};
    _templates = [];
    var en = catalogs[BASE] || {};
    var tgt = catalogs[code] || {};
    for (var key in en) {
      if (key === '_meta' || !en.hasOwnProperty(key)) continue;
      var enStr = en[key];
      if (typeof enStr !== 'string' || !enStr) continue;
      var out = (tgt[key] != null) ? tgt[key] : enStr;   // fall back to English per-key
      if (enStr.indexOf('{') === -1) {
        // plain string: direct english -> translated. First mapping wins on dupes.
        if (_exactMap[enStr] == null) _exactMap[enStr] = out;
      } else {
        var c = compileTemplate(enStr);
        _templates.push({ re: c.re, slots: c.slots, tpl: out, enTpl: enStr, len: enStr.length });
      }
    }
    // longer (more specific) templates first so "{door} was packed, and you were
    // on it." wins over a looser matcher that could also swallow the same text.
    _templates.sort(function (a, b) { return b.len - a.len; });
    _revBuiltFor = code;
  }

  // Translate ONE already-rendered (English) string to the active language.
  // Returns the input unchanged if nothing matches (so unknown/dynamic strings,
  // numbers, usernames pass straight through).
  function translateText(str) {
    if (current === BASE) return str;
    if (typeof str !== 'string') return str;
    var s = str;
    if (_revBuiltFor !== current) buildReverseIndex(current);
    // exact match first (covers 71% of keys, zero ambiguity)
    if (_exactMap[s] != null) return _exactMap[s];
    var trimmed = s.replace(/^\s+|\s+$/g, '');
    if (trimmed !== s && _exactMap[trimmed] != null) {
      // preserve surrounding whitespace that rendering may have added
      return s.replace(trimmed, _exactMap[trimmed]);
    }
    // template match: find the first (most specific) template whose regex fits.
    for (var i = 0; i < _templates.length; i++) {
      var tpl = _templates[i];
      var mm = tpl.re.exec(s);
      if (!mm) continue;
      var vars = {};
      for (var j = 0; j < tpl.slots.length; j++) {
        var slotName = tpl.slots[j];
        var cap = mm[j + 1];
        // NESTED NOUN TRANSLATION: a captured value that is itself a known English
        // UI string (a route/door name like "Service Shaft") gets translated via the
        // exact-map so "{door}" resolves localized inside the sentence. Numbers and
        // usernames are never catalog values, so they fall through unchanged. The
        // `name` slot is EXCLUDED so a winner line keeps the username VERBATIM.
        if (slotName !== 'name' && cap != null && _exactMap[cap] != null) cap = _exactMap[cap];
        vars[slotName] = cap;
      }
      // re-interpolate the TRANSLATED template with the captured (already
      // rendered / localized) values.
      var res = tpl.tpl.replace(/\{(\w+)\}/g, function (w, k) {
        return (vars[k] != null) ? vars[k] : w;
      });
      return res;
    }
    return str;
  }

  // Public chokepoint helper: translate a string about to be shown imperatively
  // (toast text, canvas fillText captions). Safe for en (identity).
  function tr(str) { try { return translateText(str); } catch (e) { return str; } }

  // --- which subtrees to leave alone (user content, inputs, our own chrome) ---
  var SKIP_SEL = '.msgs, .msg, .who, .mbody, .ticker, .mts, .rquote, .mention, input, textarea, select, script, style, code, .vsi18n, [data-no-i18n]';
  function inSkip(node) {
    var el = (node.nodeType === 3) ? node.parentNode : node;
    if (!el || !el.closest) return false;
    try { return !!el.closest(SKIP_SEL); } catch (e) { return false; }
  }

  var ATTRS = ['placeholder', 'title', 'aria-label'];

  function translateTextNode(tn) {
    if (!tn || tn.nodeType !== 3) return;
    var v = tn.nodeValue;
    if (!v || !/\S/.test(v)) return;              // whitespace-only
    if (inSkip(tn)) return;
    var out = translateText(v);
    if (out !== v) tn.nodeValue = out;
  }

  function translateAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    if (inSkip(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (el.hasAttribute && el.hasAttribute(a)) {
        var v = el.getAttribute(a);
        var out = translateText(v);
        if (out !== v) el.setAttribute(a, out);
      }
    }
  }

  // Walk an element subtree translating text nodes + attributes.
  function translateSubtree(root) {
    if (current === BASE || !root) return;
    try {
      if (root.nodeType === 3) { translateTextNode(root); return; }
      if (root.nodeType !== 1) return;
      if (inSkip(root)) return;
      translateAttrs(root);
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null, false);
      var n;
      while ((n = walker.nextNode())) {
        if (n.nodeType === 3) { translateTextNode(n); }
        else { translateAttrs(n); }
      }
    } catch (e) {}
  }

  // Full-document sweep (used on language change and first apply).
  function translateDocument() {
    if (current === BASE) return;   // en: leave the DOM as rendered
    translateSubtree(document.body);
  }

  function scheduleApply() {
    if (_applyScheduled) return;
    _applyScheduled = true;
    var run = function () { _applyScheduled = false; try { translateDocument(); } catch (e) {} };
    (global.requestAnimationFrame || function (f) { setTimeout(f, 16); })(run);
  }

  function startObserver() {
    if (_observer || typeof MutationObserver === 'undefined') return;
    _observer = new MutationObserver(function (muts) {
      if (current === BASE) return;
      for (var i = 0; i < muts.length; i++) {
        var mu = muts[i];
        if (mu.type === 'childList' && mu.addedNodes && mu.addedNodes.length) {
          for (var j = 0; j < mu.addedNodes.length; j++) translateSubtree(mu.addedNodes[j]);
        } else if (mu.type === 'characterData') {
          translateTextNode(mu.target);
        } else if (mu.type === 'attributes') {
          translateAttrs(mu.target);
        }
      }
    });
    try {
      _observer.observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ATTRS
      });
    } catch (e) {}
  }

  // --- apply the active language to the document: <html lang> + dir, then emit a
  //     change event so index.html's render loop can repaint (poll()/applyState).
  function applyToDocument() {
    try {
      document.documentElement.setAttribute('lang', current);
      document.documentElement.setAttribute('dir', isRtl(current) ? 'rtl' : 'ltr');
    } catch (e) {}
    // rebuild the reverse index for the new language, then sweep the whole DOM
    // so already-rendered English is translated in place. Observer catches the rest.
    if (current !== BASE && _revBuiltFor !== current) { try { buildReverseIndex(current); } catch (e) {} }
    try { translateDocument(); } catch (e) {}
    try {
      global.dispatchEvent(new CustomEvent('vs-lang-change', { detail: { lang: current } }));
    } catch (e) {
      // very old browsers: fall back to a plain Event
      try { var ev = document.createEvent('Event'); ev.initEvent('vs-lang-change', true, true); global.dispatchEvent(ev); } catch (_) {}
    }
  }

  // --- setLang(code): load the catalog if needed, persist, apply, re-render. ---
  function setLang(code) {
    if (!isSupported(code)) code = BASE;
    return loadCatalog(code).then(function () {
      current = code;
      try { localStorage.setItem(LS_KEY, code); } catch (e) {}
      applyToDocument();
      // refresh any mounted switcher so its label reflects the new choice
      try { paintSwitchers(); } catch (e) {}
      return code;
    });
  }

  function getLang() { return current; }

  // --- the compact top-right language dropdown. Styled to sit in the game's dark
  //     parchment theme using its OWN CSS custom properties (--paper/--ink/--gold/
  //     --card/--tee/--font-ui etc. from index.html's :root). No external CSS, no
  //     dependency: a native <select> under a themed shell so it is accessible and
  //     mobile-friendly. renderLanguageSwitcher(mountEl) injects/refreshes it. ---
  var _switchers = [];
  function injectSwitcherCss() {
    if (document.getElementById('vsi18n-css')) return;
    var st = document.createElement('style'); st.id = 'vsi18n-css';
    st.textContent = ''
      + '.vsi18n{position:relative;display:inline-flex;align-items:center}'
      // match the .btn language in index.html: ink border, hard offset shadow, card surface
      + '.vsi18n .vsi18n-shell{display:inline-flex;align-items:center;gap:6px;'
      +   'border:2.5px solid var(--ink,#17130d);border-radius:11px;'
      +   'box-shadow:3px 3px 0 var(--ink,#17130d);background:var(--card,#fbfaf6);'
      +   'color:var(--ink,#17130d);font-family:var(--font-ui,Inter,system-ui,sans-serif);'
      +   'font-size:15px;padding:0 8px;height:40px;cursor:pointer;'
      +   'transition:transform .14s,box-shadow .14s}'
      + '.vsi18n .vsi18n-shell:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--ink,#17130d)}'
      + '.vsi18n .vsi18n-flag{font-size:17px;line-height:1}'
      + '.vsi18n .vsi18n-code{font-family:var(--font-head,Londrina Solid,system-ui,sans-serif);'
      +   'letter-spacing:.4px;text-transform:uppercase;font-size:14px}'
      + '.vsi18n .vsi18n-caret{font-size:10px;opacity:.55}'
      // the native select overlays the shell, transparent, so the pretty shell shows but taps open the OS picker
      + '.vsi18n select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;'
      +   'border:0;font-size:16px}'  // 16px avoids iOS zoom-on-focus
      + '@media(max-width:560px){.vsi18n .vsi18n-shell{height:38px;font-size:14px;padding:0 7px}}'
      // RTL: flip the switcher content order so the caret sits on the correct side
      + '[dir=rtl] .vsi18n .vsi18n-shell{flex-direction:row-reverse}';
    document.head.appendChild(st);
  }

  function activeMeta() {
    for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].code === current) return LANGUAGES[i];
    return LANGUAGES[0];
  }

  function paintSwitchers() {
    var meta = activeMeta();
    _switchers.forEach(function (root) {
      var flag = root.querySelector('.vsi18n-flag');
      var code = root.querySelector('.vsi18n-code');
      var sel = root.querySelector('select');
      if (flag) flag.textContent = meta.flag || '🌐';
      if (code) code.textContent = (meta.code || 'en').toUpperCase();
      if (sel && sel.value !== current) sel.value = current;
    });
  }

  // renderLanguageSwitcher: mountEl can be an element or a selector string. It is
  // idempotent per mount node (re-calling refreshes rather than duplicating).
  function renderLanguageSwitcher(mountEl) {
    injectSwitcherCss();
    var host = (typeof mountEl === 'string') ? document.querySelector(mountEl) : mountEl;
    if (!host) return null;

    // reuse an existing switcher inside this host if present
    var root = host.querySelector(':scope > .vsi18n') || null;
    if (!root) {
      root = document.createElement('div'); root.className = 'vsi18n';
      var opts = LANGUAGES.map(function (l) {
        return '<option value="' + l.code + '">' + (l.flag || '') + ' ' + l.name + '</option>';
      }).join('');
      root.innerHTML = ''
        + '<span class="vsi18n-shell" aria-hidden="true">'
        +   '<span class="vsi18n-flag">🌐</span>'
        +   '<span class="vsi18n-code">EN</span>'
        +   '<span class="vsi18n-caret">▾</span>'
        + '</span>'
        + '<select aria-label="Language">' + opts + '</select>';
      host.appendChild(root);
      var sel = root.querySelector('select');
      sel.addEventListener('change', function () { setLang(sel.value); });
      _switchers.push(root);
    }
    paintSwitchers();
    return root;
  }

  // --- boot: always load English (the fallback), then the detected language, then
  //     apply + resolve ready. Callers await VSI18n.ready before first paint, OR
  //     just call t() after ready resolves (English is guaranteed present). ------
  function boot() {
    var want = detectLang();
    Promise.all([loadCatalog(BASE), want !== BASE ? loadCatalog(want) : Promise.resolve()])
      .then(function () {
        current = want;
        if (current !== BASE) { try { buildReverseIndex(current); } catch (e) {} }
        // start watching the DOM so every subsequent render is translated live,
        // then sweep whatever is already on the page.
        var begin = function () { try { startObserver(); } catch (e) {} applyToDocument(); _readyResolve(current); };
        if (document.body) begin();
        else document.addEventListener('DOMContentLoaded', begin, { once: true });
      });
  }

  var VSI18n = {
    t: t,
    tr: tr,                          // translate a rendered English string -> active lang
    translateText: translateText,    // alias of tr for call-site clarity
    translateDocument: translateDocument,
    setLang: setLang,
    getLang: getLang,
    renderLanguageSwitcher: renderLanguageSwitcher,
    ready: ready,
    fmtNumber: fmtNumber,
    fmtCurrency: fmtCurrency,
    isRtl: function () { return isRtl(current); },
    languages: LANGUAGES.slice()
  };
  global.VSI18n = VSI18n;
  // convenience global alias; index.html uses t('key', {vars}) at call sites.
  if (!global.t) global.t = t;

  boot();
})(typeof window !== 'undefined' ? window : this);

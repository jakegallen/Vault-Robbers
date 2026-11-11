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
    { code: 'en', name: 'English',  flag: '🇬🇧' },
    { code: 'es', name: 'Español',  flag: '🇪🇸' }
    // future: { code:'pt', name:'Português', flag:'🇧🇷' }, { code:'fr', ... },
    //         { code:'ar', name:'العربية', flag:'🇸🇦', rtl:true }
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
  function detectLang() {
    try {
      var saved = localStorage.getItem(LS_KEY);
      if (saved && isSupported(saved)) return saved;
    } catch (e) {}
    try {
      var list = navigator.languages && navigator.languages.length
        ? navigator.languages : [navigator.language || navigator.userLanguage || BASE];
      for (var i = 0; i < list.length; i++) {
        var primary = String(list[i] || '').toLowerCase().split('-')[0];
        if (isSupported(primary)) return primary;
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
    var map = { en: 'en-US', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', ar: 'ar' };
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

  // --- apply the active language to the document: <html lang> + dir, then emit a
  //     change event so index.html's render loop can repaint (poll()/applyState).
  function applyToDocument() {
    try {
      document.documentElement.setAttribute('lang', current);
      document.documentElement.setAttribute('dir', isRtl(current) ? 'rtl' : 'ltr');
    } catch (e) {}
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
        applyToDocument();
        _readyResolve(current);
      });
  }

  var VSI18n = {
    t: t,
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

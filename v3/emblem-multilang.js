/*! emblem-multilang - tiny, dependency-free i18n for browser apps.
 *  No build step, no eval, same-origin only: works under a strict CSP (script-src 'self').
 *  MIT. Multi-language (i18n) for browser apps. Part of Emblem-Tools (https://github.com/jakegallen/Emblem-Tools).
 *
 *  Usage:
 *    EmblemLang.init({
 *      fallback: 'en',
 *      locales: { en: {...}, es: {...} },   // or load JSON and pass the object
 *      persistKey: 'lang'                    // localStorage key (optional)
 *    });
 *    EmblemLang.apply();                      // translate the current DOM
 *    document.title = EmblemLang.t('title');  // translate a dynamic string
 *    EmblemLang.setLocale('es');              // switch, persist and re-scan the DOM
 *
 *  Mark up static text:
 *    <h1 data-i18n="home.title">Vault Standoff</h1>
 *    <input data-i18n-attr="placeholder:form.email,title:form.email_hint">
 *    <span data-i18n="pot" data-i18n-vars='{"n":"0"}">The pot is 0</span>
 *  Anything without a key, or any key missing from a locale, falls back to the base
 *  locale and then to the on-screen text, so a partial translation never blanks the UI.
 */
(function (root) {
  "use strict";

  var state = {
    fallback: "en",
    locale: "en",
    locales: {},
    persistKey: null,
    listeners: []
  };

  function lookup(locale, key) {
    var tbl = state.locales[locale];
    if (!tbl) return undefined;
    if (Object.prototype.hasOwnProperty.call(tbl, key)) return tbl[key]; // flat keys win
    // allow dotted nested lookup too (home.title -> {home:{title}})
    var parts = key.split("."), cur = tbl, i;
    for (i = 0; i < parts.length; i++) {
      if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, parts[i])) cur = cur[parts[i]];
      else return undefined;
    }
    return typeof cur === "string" ? cur : undefined;
  }

  function interpolate(str, vars) {
    if (!vars || str.indexOf("{") < 0) return str;
    return str.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
    });
  }

  function t(key, vars) {
    var s = lookup(state.locale, key);
    if (s === undefined) s = lookup(state.fallback, key);
    if (s === undefined) return key; // last resort: the key itself (visible, never blank)
    return interpolate(s, vars);
  }

  // Translate one element's text and declared attributes.
  function applyEl(el) {
    var key = el.getAttribute("data-i18n");
    if (key) {
      var vars = null, raw = el.getAttribute("data-i18n-vars");
      if (raw) { try { vars = JSON.parse(raw); } catch (e) { vars = null; } }
      var val = lookup(state.locale, key);
      if (val === undefined) val = lookup(state.fallback, key);
      // Only replace when we actually have a translation; otherwise leave the authored text.
      if (val !== undefined) el.textContent = interpolate(val, vars);
    }
    var attrSpec = el.getAttribute("data-i18n-attr");
    if (attrSpec) {
      attrSpec.split(",").forEach(function (pair) {
        var bits = pair.split(":");
        if (bits.length !== 2) return;
        var attr = bits[0].trim(), k = bits[1].trim();
        var v = lookup(state.locale, k);
        if (v === undefined) v = lookup(state.fallback, k);
        if (v !== undefined) el.setAttribute(attr, v);
      });
    }
  }

  function apply(rootNode) {
    var scope = rootNode || document;
    var nodes = scope.querySelectorAll("[data-i18n],[data-i18n-attr]");
    for (var i = 0; i < nodes.length; i++) applyEl(nodes[i]);
    if (document.documentElement && state.locale) document.documentElement.setAttribute("lang", state.locale);
    return scope;
  }

  function detect() {
    var nav = root.navigator || (typeof navigator !== "undefined" ? navigator : {});
    var langs = (nav.languages && nav.languages.length) ? nav.languages : [nav.language || nav.userLanguage || ""];
    for (var i = 0; i < langs.length; i++) {
      var l = (langs[i] || "").toLowerCase();
      if (!l) continue;
      if (state.locales[l]) return l;              // exact: pt-br
      var base = l.split("-")[0];
      if (state.locales[base]) return base;        // base: pt
    }
    return null;
  }

  function init(opts) {
    opts = opts || {};
    state.locales = opts.locales || {};
    state.fallback = opts.fallback || "en";
    state.persistKey = opts.persistKey || null;
    var chosen = null;
    if (opts.locale && state.locales[opts.locale]) chosen = opts.locale;
    if (!chosen && state.persistKey) {
      try { var saved = root.localStorage.getItem(state.persistKey); if (saved && state.locales[saved]) chosen = saved; } catch (e) {}
    }
    if (!chosen && opts.detect !== false) chosen = detect();
    state.locale = chosen || state.fallback;
    return api;
  }

  function setLocale(code) {
    if (!state.locales[code]) return false;
    state.locale = code;
    if (state.persistKey) { try { root.localStorage.setItem(state.persistKey, code); } catch (e) {} }
    apply(document);
    state.listeners.forEach(function (fn) { try { fn(code); } catch (e) {} });
    return true;
  }

  function addLocale(code, table) { state.locales[code] = table; return api; }
  function onChange(fn) { if (typeof fn === "function") state.listeners.push(fn); return api; }

  // Build a <select> language switcher. names: optional {code: "Display"} map.
  function switcher(names) {
    var sel = document.createElement("select");
    sel.className = "emblem-lang-switch";
    sel.setAttribute("aria-label", "Language");
    Object.keys(state.locales).forEach(function (code) {
      var o = document.createElement("option");
      o.value = code;
      o.textContent = (names && names[code]) || code.toUpperCase();
      if (code === state.locale) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () { setLocale(sel.value); });
    return sel;
  }

  var api = {
    init: init, apply: apply, t: t, setLocale: setLocale, getLocale: function () { return state.locale; },
    available: function () { return Object.keys(state.locales); }, addLocale: addLocale,
    onChange: onChange, switcher: switcher, detect: detect
  };

  root.EmblemLang = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);

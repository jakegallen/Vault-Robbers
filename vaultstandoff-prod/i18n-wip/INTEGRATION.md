# Vault Standoff i18n — integration plan (GROUNDWORK, not yet wired)

Status: scaffolding only. Nothing here touches the live client. `index.html` is
untouched. Wiring is deliberately held until the launch copy is frozen (the
robber-airdrop Owner tab and copy polish are still coming), so we do not
translate a moving target.

Files in this directory (`vaultstandoff-prod/i18n-wip/`):
- `catalog.en.json` — 587 user-facing English strings, flat keyed, grouped by UI area.
- `catalog.es.json` — full Spanish translation (587 keys, verified key + placeholder parity).
- `i18n.js` — standalone runtime (`t()`, detection, persistence, switcher, Intl, RTL).
- `INTEGRATION.md` — this file.

---

## 1. How the engine works

`i18n.js` exposes `window.VSI18n` and a global `t`:

- `t(key, vars)` — looks up `key` in the active catalog, falls back to English,
  then to the raw key. Interpolates `{placeholder}` tokens from `vars`. Numeric
  vars pass through `Intl.NumberFormat` so `12345` renders `12,345` / `12.345`
  per locale.
- `VSI18n.setLang(code)` — loads the catalog if needed, persists to
  `localStorage['vs_lang']`, sets `<html lang>`/`<html dir>`, and dispatches a
  `vs-lang-change` event on `window`.
- `VSI18n.getLang()`, `VSI18n.ready` (Promise), `VSI18n.fmtNumber`,
  `VSI18n.fmtCurrency`, `VSI18n.isRtl()`, `VSI18n.languages`.
- `VSI18n.renderLanguageSwitcher(mountEl)` — injects the compact dropdown.

Catalogs are fetched from `i18n/catalog.<code>.json` (relative). So when wiring,
the three files move from `i18n-wip/` to a served `public/i18n/` directory.

---

## 2. Exact wiring steps (low-risk, mechanical)

### 2a. Load the engine
Add ONE script tag in `<head>` of `index.html`, before the big inline `<script>`
at line ~1297 (it must define `t` before any render helper runs):

```html
<script src="i18n.js"></script>
```

`i18n.js` self-boots on load: it fetches English (the guaranteed fallback) plus
the detected language, then resolves `VSI18n.ready`. Because the inline script
only *calls* `t()` at render time (not at parse time), the tag can load normally;
the first `render()`/`applyState()` happens well after `ready`. If we want to be
strict, gate `boot()`'s first `poll()` on `VSI18n.ready` (one line in `boot()`).

### 2b. Move the catalogs
Create `public/i18n/` and copy `catalog.en.json` + `catalog.es.json` there.
(Served statically by the app already serving `public/`.)

### 2c. Mount the switcher — TOP RIGHT
The header control cluster is `.hdrbar` (index.html line ~1288), holding
`#hdrbuy`, `#howto`, `#conn`. Mount the switcher as the FIRST child of `.hdrbar`
so it sits top-right beside the How-it-works `?` and Connect button, matching
their height/shadow (the switcher CSS already copies `.btn`'s ink border + hard
offset shadow + `--card` surface). In `boot()` (line ~6954) or right after first
paint:

```js
try { VSI18n.renderLanguageSwitcher('.hdrbar'); } catch(e){}
```

It is idempotent, so calling it again after a header rebuild is safe. (The
header lives OUTSIDE `#app`, so it is not torn down by the render loop — mount
once.)

### 2d. Re-render on language change
The client already has a full repaint path (`poll()` / `applyState(LASTS)`).
Listen once, at the end of the inline script:

```js
window.addEventListener('vs-lang-change', function(){
  try { if (window.LASTS) applyState(window.LASTS); } catch(e){}
  try { poll(); } catch(e){}
  // header-owned bits that render() does not rebuild:
  try { if (typeof paintHeaderBuy==='function' && window.LASTS) paintHeaderBuy(window.LASTS); } catch(e){}
});
```

Everything that flows through `render(s)` repaints automatically because the
helpers will read `t()` fresh. Toasts/title-cards are transient and simply use
the new language on their next call — no replay needed.

### 2e. Two conversion styles at call sites

There are two kinds of strings. Handle each the simplest way:

**(A) Static DOM text — use a `data-i18n` sweep.** For the handful of strings
that live as literal HTML in `index.html` (the header buttons at lines
1287-1291, the `<title>`/meta) add `data-i18n="key"` and run one sweep after
render + on `vs-lang-change`:

```js
function i18nSweep(root){
  (root||document).querySelectorAll('[data-i18n]').forEach(function(el){
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  (root||document).querySelectorAll('[data-i18n-ph]').forEach(function(el){
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });
  (root||document).querySelectorAll('[data-i18n-title]').forEach(function(el){
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
}
```

The static header is tiny, so the `data-i18n` pass is only ~6 elements.

**(B) JS-built strings — wrap the literal in `t()`.** The overwhelming majority
(~580 of 587) are built inside template strings in the render/helper functions.
These convert by replacing the literal with a `t()` call. Examples mapped to the
exact source:

| source (index.html) | before | after |
|---|---|---|
| `statusBarHTML` ~5031 | `'PICK YOUR DOOR'` | `t('statusbar.headPick')` |
| `chamberFlavor` 1915 | `CH_FLAVOR[i]\|\|'descend'` | keep array but `CH_FLAVOR` becomes `['chamber.flavor0', ...]` then `t(CH_FLAVOR[i]\|\|'chamber.flavorDefault')` |
| `doorHTML` 4916 | `lbl=mine?'your pick':'open'` | `lbl=mine?t('door.yourPick'):t('door.open')` |
| `toast(...)` 3401 | `toast('Buying in…')` | `toast(t('onchain.buyingIn'))` |
| `fillPanel` 4613 | `'🔥 Fuse lit'` | `t('fill.fuseLit')` |
| `ceremonyHTML` 6084 | `'Vault cracked'` | `t('ceremony.vaultCracked')` |

**Dynamic strings → placeholders.** Where the current code concatenates values,
pass them as `vars`:

| before | after |
|---|---|
| `'🎟 '+TICKETS+' ticket'+(TICKETS>1?'s':'')+' locked in'` | `t('buy.ticketsLockedIn',{n:t(TICKETS>1?'buy.ticketMany':'buy.ticketOne',{n:TICKETS})})` *(see pluralization note)* |
| `'reached chamber '+ch+' · '+inside+' robber'+(inside===1?'':'s')+'...'` | `t('busted.stat',{chamber:ch, inside:t(inside===1?'busted.insideOne':'busted.insideMany',{n:inside}), tix:...})` |
| `s.lockIn+'s'` | `t('statusbar.seconds',{n:s.lockIn})` |
| `fmtK(s.pot)+' RVLT'` | `t('chatstatus.potValue',{amount:fmtK(s.pot)})` (keep `fmtK` for the k-suffix; Intl is for full numbers) |

### 2f. Pluralization pattern

English pluralization here is `X ticket` / `X tickets`. The catalog ships both
singular and plural key variants (`*One` / `*Many`) so each language controls
its own rule. The call site chooses the variant by count:

```js
function plural(n, oneKey, manyKey, extra){
  extra = extra || {}; extra.n = n;
  return t(n === 1 ? oneKey : manyKey, extra);
}
// e.g. plural(TICKETS, 'buy.ticketOne', 'buy.ticketMany')
```

Spanish happens to share the 1-vs-many split, so `*One`/`*Many` covers it. A
future language with more plural categories (e.g. Polish, Arabic) would add more
key variants; the `plural()` helper is where that logic grows. Keep it in ONE
helper so no call site hardcodes `(n>1?'s':'')` again.

---

## 3. Ordered conversion plan — biggest clusters first

Convert in this order so each pass is a self-contained, testable chunk. Numbers
are the key counts per area (from the catalog).

1. **Static header + title** (`header.*` 7, `app.*` 2) — the `data-i18n` sweep.
   Smallest, proves the switcher + sweep end-to-end.
2. **Gameplay core — doors + status + chambers** (`door.*` 9, `statusbar.*` 12,
   `chamber.*` 12, `route.*` 5, `herd.*` 4, `outcome.*` 10, `distrib.*` 3,
   `breach.*` 5) — the live heist screen, most-seen text.
3. **Ceremony + waiting room** (`ceremony.*` 26, `waiting.*` 19, `busted.*` 9,
   `tcard.*` 17, `streak.*` 7) — win/loss/void screens + title cards.
4. **Buy + fill + pricing** (`fill.*` 30, `fillmodule.*` 22, `buybox.*` 19,
   `buy.*` 9, `herostrip.*` 11, `pricing.*` 2, `sched.*` 11) — THE MONEY FLOW.
   Convert carefully; see the QA checklist.
5. **Chat** (`chat.*` 23, `chatstatus.*` 10, `statcard.*` 11, `profile.*` 12,
   `spectator.*` 6, `ticker.*` 3) — Vault Radio + profile + presence.
6. **Overtime** (`overtime.*` 13) — sudden death screen.
7. **Auto-play / auto-buy** (`autopilot.*` 41, `walkaway.*` 37, `games.*` 16) —
   the two biggest sheets. Money + approval copy.
8. **Wallet / network / on-chain / claim / mint** (`wallet.*` 16, `network.*` 12,
   `onchain.*` 8, `claim.*` 13, `mint.*` 4, `walletreroute.*` 5) — wallet flow.
9. **How-it-works + fairness** (`howitworks.*` 19, `fairness.*` 10) — the two
   explainer sheets.
10. **Notifications + share + practice + login + menu + seal + sys + pick**
    (`notify.*` 15, `share.*` 11, `practice.*` 25, `login.*` 9, `menu.*` 7,
    `seal.*` 2, `sys.*` 1, `pick.*` 5, `history.*` 2).

---

## 4. QA checklist — focus on money / flow strings

Run the whole list in BOTH languages (toggle the switcher between every screen).
Practice mode (free, no wallet) exercises most of the arc with zero money risk,
so do a full practice run first in each language, then a real run.

- [ ] **Entry price** reads `$10` / `$5 holder` identically in both languages; the
      struck-through price + holder badge show correctly (`pricing.*`, `buybox.*`).
      Spanish must NOT mistranslate the dollar amount — it is formatted by Intl.
- [ ] **Buy button total** `Buy in · $N` / `Entrar · $N` matches the stepper count.
- [ ] **Ticket count** singular/plural is correct at 1 vs 2+ in both languages.
- [ ] **Per-wallet cap + seats-left** copy (`fillmodule.capSeatsLeft*`,
      `fillmodule.buyAtCap`, `fillmodule.buyFull`) names the right number and never
      lets a disabled state read as buyable.
- [ ] **Auto-buy / auto-play confirm sheets** — the approval amount, round count,
      and "exact allowance never unlimited" wording are intact and accurate in
      Spanish (`autopilot.confirm*`, `walkaway.confirm*`). This is security copy;
      verify it does not soften or drop the "never unlimited" guarantee.
- [ ] **On-chain stage toasts** (`onchain.*`) appear in order: adding gas →
      approve ROBINVAULT → buying in → bought in. Each in the active language.
- [ ] **Claim / refund** (`claim.*`) amounts and states are correct; "Claimed N RVLT"
      shows the real number via Intl formatting.
- [ ] **Ceremony payout** (`ceremony.pot/rake/youTake/winStatus`) — the RVLT amount
      and rake % render correctly; the win auto-send status line is accurate.
- [ ] **Void / rollover** (`ceremony.void*`, `ceremony.mutualBust*`) copy matches the
      actual outcome (refund vs rollover).
- [ ] **Countdowns** (`{sec}` / `{time}`) tick correctly; `m:ss` is NOT localized
      away (it is a clock, keep mmss()).
- [ ] **RVLT amounts** keep the ` RVLT` suffix and k-formatting (`fmtK`) — do NOT
      pass RVLT through `fmtCurrency` (not an ISO currency).
- [ ] **Network labels** (`network.testnet/mainnet`) and the LIVE badge are correct;
      the "(real funds)" clause is preserved in Spanish.
- [ ] **Switcher persistence** — pick Español, reload, it stays Español (localStorage
      `vs_lang`). Clear storage → detects browser language → falls back to English.
- [ ] **Fallback** — temporarily remove a key from `catalog.es.json`; that one string
      must fall back to English, never render blank or the raw key in production.
- [ ] **No layout break** — long Spanish strings (e.g. the auto-buy confirm body,
      `walletreroute.body`) do not overflow buttons/cards on mobile widths.

---

## 5. Strings that are tricky to externalize (and the fix)

These are built by concatenation in JS today. Each is extractable with a
`{placeholder}` + a small refactor at the call site. They are the only spots that
are not a pure literal-swap:

1. **Ticket pluralization everywhere** — `'ticket'+(TICKETS>1?'s':'')`.
   Scattered across `buyBox`, `doLogin`, `ceremony`, `busted`, `autopilot`,
   `walkaway`, `bustedSummaryHTML`. **Fix:** route every one through the single
   `plural(n, oneKey, manyKey)` helper (section 2f). Do NOT leave any inline
   `(n>1?'s':'')` — Spanish and future languages pluralize differently.

2. **`busted.stat` / `herostrip.fillingSub` / `overtime.breachLine`** — multi-part
   sentences assembled from 3-4 values with ` · ` separators and inline plurals
   (index.html 5345, 2363, 5529). **Fix:** keep the whole sentence as ONE catalog
   string with `{chamber}`, `{inside}`, `{tix}` placeholders; compute the plural
   sub-phrases first, pass them in as vars (nested `t()`). This keeps word order
   translatable (Spanish may reorder clauses).

3. **`chatStatus` right-rail** `'👥 '+s.alive+' left · 💰 '+pot` (line 2195). The
   ` · ` glue and the "left"/"in" word are language-specific. **Fix:** the catalog
   already splits these into `chatstatus.leftAndPot` / `inAndPot` / `potOnly` with
   `{alive}`/`{pot}` placeholders — swap the concatenation for the keyed string.

4. **`CH_FLAVOR` and `AV_EMO`/`ROUTE_*` arrays** (lines 1844, 1912-1914). The door
   *names* (`North Wing`, etc.) are both UI labels AND server-matching keys used in
   on-chain route lookups (`ROUTE_THEME`, `ROUTE_ART`, `routeTheme`, and the server
   sends `s.routes` as these exact English strings). **Fix / WARNING:** translate
   only the DISPLAY of the door name, never the lookup key. Render with
   `t('route.northWing')` **but** keep `s.routes[i]` (the English server value) as
   the key into `ROUTE_ART`/`ROUTE_THEME` and as what `pickDoor`/reveal logic
   compares. Map server route string → i18n key with a small lookup
   (`{'North Wing':'route.northWing', ...}`); if a route is not in the map (OT
   `Door N`), fall back to `t('door.generic',{n})`. This keeps art/theme/picks
   working while the visible label localizes. `chamberFlavor` has no such coupling,
   so its array can just hold i18n keys.

5. **`formatHist`** (line 1596) — `'👑 '+esc(h.name)+' took '+fmtK(h.pot)`.
   **Fix:** `t('history.formatWinner',{name:esc(h.name), amount:fmtK(h.pot)})` and
   `t('history.formatNobody')`. Already keyed.

6. **`streakLine`** (line 1559) joins 3 optional pieces with ` · `. **Fix:** keep
   the JS that decides WHICH pieces to include; translate each piece via its key
   (`streak.*`) and `join(' · ')`. The separator stays literal.

7. **Canvas share card** (`drawWinShareCanvas`, line 1490) draws text onto a
   `<canvas>`, so there is no DOM to sweep. **Fix:** it already reads fixed strings
   (`VAULT CRACKED`, footer) — swap each `fillText('...')` for `fillText(t('share.card*'))`.
   The font stack (Londrina) must contain the glyphs for the target language; Latin
   scripts (es/pt/fr) are fine, but an Arabic/CJK card would need a fallback font —
   defer until those languages ship.

---

## 6. RTL + number/currency notes for later languages

- **RTL (Arabic later):** `i18n.js` already sets `<html dir="rtl">` for codes in
  its RTL set (`ar/he/fa/ur`) and the switcher CSS flips its own content order for
  `[dir=rtl]`. The game's layout is heavily flex-based; a full RTL pass would need:
  (a) audit `margin-left:auto` / `right:` positioned elements (chat dock, toasts,
  banners) and mirror them under `[dir=rtl]`; (b) the door grid is symmetric so it
  is fine; (c) verify the hard-offset shadows still read (they are decorative, no
  direction meaning). Hold RTL until an Arabic catalog is actually requested.
- **Numbers/currency:** USD entry/deposit figures should go through
  `VSI18n.fmtCurrency(amount,'USD')` so `$10` localizes (e.g. `10 US$` in some
  locales) — but confirm with product whether the `$` must stay literal for brand
  consistency; if so, keep the catalog's literal `${n}` and only localize the
  number via `{n}` (which already runs through `fmtNumber`). RVLT amounts are NOT a
  currency: keep `fmtK` + the literal ` RVLT` suffix. Clocks (`m:ss`, `Ns`) are not
  localized.

---

## 7. Adding the next language (after es proves the pipeline)

1. Copy `catalog.en.json` → `catalog.<code>.json`, translate every value (keep keys
   + placeholders identical — the validator in section below enforces this).
2. Add `{ code:'<code>', name:'...', flag:'...' }` (and `rtl:true` if applicable) to
   the `LANGUAGES` array in `i18n.js`.
3. Drop the file in `public/i18n/`. The switcher picks it up automatically.

Parity check to run before shipping any catalog (same check used to verify es):

```bash
node -e 'const en=require("./catalog.en.json"),x=require("./catalog.<code>.json");
const ek=Object.keys(en).filter(k=>k!=="_meta"),xk=new Set(Object.keys(x));
const miss=ek.filter(k=>!xk.has(k));
const ph=s=>(String(s).match(/\{\w+\}/g)||[]).sort().join(",");
const mm=ek.filter(k=>xk.has(k)&&ph(en[k])!==ph(x[k]));
console.log("missing:",miss.length?miss:"none","| placeholder mismatch:",mm.length?mm:"none");'
```

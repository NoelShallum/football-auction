/* ================= LOCALIZATION =================

   One game engine, one player database, one set of rules - only the
   words change. Nothing in this file knows anything about auctions;
   nothing in the auction knows anything about languages beyond calling
   t().

   HOW IT FITS TOGETHER

   - locales/<code>.json holds the strings for one language, nested by
     area (common / home / setup / lobby / auction / sim / results).
     They are flattened to dotted keys ("auction.bid") on load.
   - index.html still contains its English text inline. That is the
     safety net the whole design leans on: if a locale file is missing,
     blocked or malformed, the page shows the English that is already in
     the markup rather than a screen full of raw keys. It is also why
     there is no flash of untranslated content on a slow connection.
   - The ACTIVE language and English are both kept in memory, so a key a
     translator hasn't reached yet falls back to English rather than
     disappearing (see t()).

   WHAT IS DELIBERATELY NOT TRANSLATED

   Player names, clubs, nationalities, ratings, prices, position codes
   and the "Auction XI" brand are data, not interface - they come from
   the player database and stay exactly as they are in every language.
   The About / Privacy / Terms screens stay English too: they are legal
   text, where a well-meaning translation is a liability rather than a
   feature.

   The 'M' on money is likewise left alone. It reads as a unit rather
   than a word, and every one of the five languages in the picker uses
   it, so localizing it would only invent inconsistency. Numbers keep
   Western digits everywhere for the same reason (see fmt()). */

const I18N_DEFAULT_LANG = 'en';
const I18N_STORAGE_KEY = 'auctionXI_lang';

/* Order here is the order the picker shows. `dir` drives <html dir>, so
   adding an RTL language later needs nothing but a new row and a file.

   No flags, for the same reason js/config.js gives for nationalities:
   flag emoji are regional-indicator letter PAIRS, and Windows has no
   glyph for them - it prints the bare letters instead, so the Arabic
   option read "SA العربية" rather than showing a flag.

   It is the better choice regardless of rendering, because a flag names
   a country and these are languages: Spanish is not only Spain, Arabic
   is not only Saudi Arabia, and Portuguese is spoken by far more people
   in Brazil than in Portugal. Each language is listed in its own script,
   which is self-identifying to the person looking for it. */
const I18N_LANGS = [
  { code: 'en', label: 'English',    dir: 'ltr' },
  { code: 'fr', label: 'Français',   dir: 'ltr' },
  { code: 'ar', label: 'العربية',     dir: 'rtl' },
  { code: 'es', label: 'Español',    dir: 'ltr' },
  { code: 'pt', label: 'Português',  dir: 'ltr' },
];

let I18N_LANG = I18N_DEFAULT_LANG;
const i18nDicts = {};        // code -> flat { 'auction.bid': 'Bid' }
const i18nPending = {};      // code -> in-flight fetch, so two callers share one request

/* Local escape rather than config.js's esc(). This file is loaded before
   the rest of the game so that t() exists for everyone, which means it
   cannot rely on anything defined later. */
function i18nEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function i18nLangEntry(code){
  return I18N_LANGS.find(l => l.code === code) || I18N_LANGS[0];
}

/* Nested JSON -> flat dotted keys. Arrays are kept whole (they are the
   commentary variant lists - see tVariant), everything else becomes a
   string. */
function i18nFlatten(obj, prefix, out){
  out = out || {};
  Object.keys(obj || {}).forEach(k => {
    const key = prefix ? prefix + '.' + k : k;
    const val = obj[k];
    if(Array.isArray(val)) out[key] = val;
    else if(val && typeof val === 'object') i18nFlatten(val, key, out);
    else out[key] = String(val);
  });
  return out;
}

function i18nLoad(code){
  if(i18nDicts[code]) return Promise.resolve(i18nDicts[code]);
  if(i18nPending[code]) return i18nPending[code];

  const req = fetch(`locales/${code}.json`)
    .then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(json => {
      i18nDicts[code] = i18nFlatten(json);
      return i18nDicts[code];
    })
    .catch(err => {
      // Never fatal. A missing file just means this language resolves
      // through the English fallback (or the markup's own English).
      console.warn('i18n: could not load', code, err && err.message);
      i18nDicts[code] = {};
      return i18nDicts[code];
    })
    .finally(() => { delete i18nPending[code]; });

  i18nPending[code] = req;
  return req;
}

function i18nRaw(key){
  const active = i18nDicts[I18N_LANG];
  if(active && active[key] != null) return active[key];
  const base = i18nDicts[I18N_DEFAULT_LANG];
  if(base && base[key] != null) return base[key];
  return null;
}

/* "{player} sold for {price}M" + {player:'Messi', price:75}.

   Values are substituted verbatim - t() has no idea whether its result
   is going into textContent or innerHTML, so escaping stays the caller's
   job exactly as it was before, at the point where that is knowable.
   A placeholder with no matching value is left standing rather than
   printing "undefined". */
function i18nInterpolate(template, params){
  if(!params) return template;
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    (params[name] === undefined || params[name] === null) ? whole : String(params[name]));
}

function t(key, params){
  const raw = i18nRaw(key);
  if(raw == null){
    // Both the active language and English are missing it. Show the key
    // rather than "undefined" - visible, greppable, and it can't break a
    // layout the way an empty string silently would.
    console.warn('i18n: missing key', key);
    return key;
  }
  if(Array.isArray(raw)) return i18nInterpolate(raw[0] || '', params);
  return i18nInterpolate(raw, params);
}

/* For labels that live in DATA rather than in the interface - pool names
   and taglines from pools/index.json, mode names and bullets from
   js/modes/*.js.

   These are content, so the file that owns them stays the source of
   truth and its English is the fallback: a pool added tomorrow shows its
   own name everywhere immediately, in every language, and only starts
   reading translated once someone adds a key for it. That is the
   difference between this and t(), which would print "pools.x.name" at
   people for a pool nobody had translated yet. */
function tData(key, fallback, params){
  const raw = i18nRaw(key);
  if(raw == null) return fallback == null ? '' : String(fallback);
  if(Array.isArray(raw)) return i18nInterpolate(raw[0] || '', params);
  return i18nInterpolate(raw, params);
}

// The same, for a list (mode bullets). Falls back to the data's own array.
function tDataList(key, fallback){
  const raw = i18nRaw(key);
  if(Array.isArray(raw)) return raw;
  if(raw != null) return [raw];
  return fallback || [];
}

/* One line from a list of interchangeable phrasings (goal calls, saves,
   bookings...).

   `variant` is chosen by the CALLER from the seeded rng and is a plain
   number, never an index into a particular language's list. That matters
   online: two clients running the same seed in different languages must
   stay in step, so the number of phrasings a translator happened to
   write cannot be allowed to influence anything. It is wrapped modulo
   the list actually present, so a language with three phrasings and one
   with eight both work. */
function tVariant(key, variant, params){
  let raw = i18nRaw(key);
  if(raw == null){
    console.warn('i18n: missing key', key);
    return key;
  }
  if(!Array.isArray(raw)) raw = [raw];
  if(!raw.length) return '';
  const idx = ((variant | 0) % raw.length + raw.length) % raw.length;
  return i18nInterpolate(raw[idx], params);
}

/* ---- Applying the active language to static markup ----

   data-i18n            -> textContent   (the common case)
   data-i18n-html       -> innerHTML     (strings that carry <b>/<br>)
   data-i18n-placeholder / -title / -aria  -> that attribute

   Attributes are separate because an element frequently needs both (a
   button with a label AND a title), and because setting textContent on
   an <input> would be meaningless. */
function applyTranslations(root){
  const scope = root || document;

  scope.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  [['data-i18n-placeholder', 'placeholder'],
   ['data-i18n-title', 'title'],
   ['data-i18n-aria', 'aria-label']].forEach(([attr, target]) => {
    scope.querySelectorAll(`[${attr}]`).forEach(el => {
      el.setAttribute(target, t(el.getAttribute(attr)));
    });
  });
}

/* Screens whose text is built in JS rather than sitting in the markup
   have to be asked to redraw themselves. Each of these renders purely
   from existing state, so switching language mid-draft repaints the
   words and touches nothing else - no budget, squad, room or timer is
   rebuilt. Guarded individually because most of them only exist once
   their screen has been reached. */
function i18nRefreshDynamic(){
  const shown = id => {
    const el = document.getElementById(id);
    return !!el && el.style.display !== 'none';
  };
  // Every call is guarded: this runs on a language switch, which can
  // happen at any point in the session, and most of these only exist
  // once their screen has been built at least once.
  const attempt = (fn) => { try { fn(); } catch(e){ console.warn('i18n refresh:', e && e.message); } };

  attempt(() => { if(typeof applyModeChrome === 'function') applyModeChrome(); });
  attempt(() => { if(typeof renderAllPoolPickers === 'function') renderAllPoolPickers(); });
  // The first-run overlay, if it is open - this is how picking a language
  // on its own first step repaints it into that language immediately.
  attempt(() => { if(typeof tutorialRefresh === 'function') tutorialRefresh(); });

  /* The setup rows are rebuilt whether or not the screen is currently
     showing. They are built once at page load - before any locale file
     has arrived - so gating this on visibility left the game-mode cards
     in English until something else happened to re-render them, which on
     the setup screen is never. All of these rebuild from current
     settings, and renderNamesGrid() carries typed names across, so
     running them off-screen costs nothing and loses nothing. */
  attempt(() => { if(typeof applySetupModeLabels === 'function') applySetupModeLabels(); });
  attempt(() => { if(typeof renderCountRow === 'function') renderCountRow(); });
  attempt(() => { if(typeof renderTimerRow === 'function') renderTimerRow(); });
  attempt(() => { if(typeof renderGameModeRow === 'function') renderGameModeRow(); });
  attempt(() => { if(typeof renderFormationRow === 'function') renderFormationRow(); });
  attempt(() => { if(typeof updateFormationNote === 'function') updateFormationNote(); });
  attempt(() => { if(typeof renderRerollsRow === 'function') renderRerollsRow(); });
  attempt(() => { if(typeof renderNamesGrid === 'function') renderNamesGrid(); });
  // The waiting room has its own copy of the mode cards.
  attempt(() => {
    if(typeof renderWaitingRoomSettings === 'function' && typeof currentRoomCode !== 'undefined' && currentRoomCode){
      renderWaitingRoomSettings();
    }
  });

  if(shown('auctionScreen')){
    attempt(() => { if(typeof renderBidderGrid === 'function') renderBidderGrid(); });
    attempt(() => { if(typeof updateRerollButton === 'function') updateRerollButton(); });
    attempt(() => {
      if(typeof AI_MODE !== 'undefined' && AI_MODE && typeof updateAIGoingButton === 'function') updateAIGoingButton();
    });
    attempt(() => {
      if(typeof currentRoomCode !== 'undefined' && currentRoomCode && typeof mpRenderFromState === 'function') mpRenderFromState();
    });
  }

  if(shown('waitingScreen')){
    attempt(() => {
      if(typeof updateWaitingPlayersList === 'function' && typeof mpParticipantsSnapshot !== 'undefined'){
        updateWaitingPlayersList(mpParticipantsSnapshot || {});
      }
    });
  }
}

/* The one entry point. Loads the language (and English alongside it, as
   the fallback layer), then repaints. Everything after the await is
   presentation only. */
function setLanguage(code, opts){
  opts = opts || {};
  const entry = i18nLangEntry(code);
  const wanted = [i18nLoad(entry.code)];
  if(entry.code !== I18N_DEFAULT_LANG) wanted.push(i18nLoad(I18N_DEFAULT_LANG));

  return Promise.all(wanted).then(() => {
    I18N_LANG = entry.code;
    if(opts.persist !== false){
      try { localStorage.setItem(I18N_STORAGE_KEY, entry.code); } catch(e){}
    }

    const html = document.documentElement;
    html.setAttribute('lang', entry.code);
    html.setAttribute('dir', entry.dir);
    // A class as well as the attribute: some rules are easier to express
    // as ".rtl .thing" than with :dir(), which Safari was late to.
    html.classList.toggle('rtl', entry.dir === 'rtl');

    applyTranslations();
    i18nRefreshDynamic();
    renderLanguagePicker();
    return entry.code;
  });
}

/* What the browser says this person reads, if we ship it.

   navigator.languages is ordered by preference and its entries are full tags
   ('fr-CA', 'pt-BR'), so only the base subtag is compared - shipping fr means
   fr-CA should get French, not English. Wrapped because a hostile or ancient
   environment can leave navigator.languages undefined, and a language lookup
   must never be the thing that stops the game loading. */
function browserLanguage(){
  try {
    const tags = (navigator.languages && navigator.languages.length)
      ? navigator.languages : [navigator.language];
    for(const tag of tags){
      if(!tag) continue;
      const base = String(tag).toLowerCase().split('-')[0];
      const hit = I18N_LANGS.find(l => l.code === base);
      if(hit) return hit.code;
    }
  } catch(e){}
  return null;
}

/* The language to start in: what they chose last time, else what their
   browser asks for, else English.

   The middle term was missing entirely - navigator.language was never read
   anywhere in the app - so a French, Spanish, Arabic or Portuguese visitor
   landed in English and had to find the picker to leave it. Five translated
   locales shipped and four of them were opt-in.

   This deliberately does NOT touch hasStoredLanguage(): a detected language
   is a good guess, not a decision, so the first-run overlay still asks. What
   changes is that it now asks in their language with their language already
   selected, which makes it one tap to confirm instead of a hunt. */
function savedLanguage(){
  let stored = null;
  try { stored = localStorage.getItem(I18N_STORAGE_KEY); } catch(e){}
  if(stored && I18N_LANGS.some(l => l.code === stored)) return stored;
  return browserLanguage() || I18N_DEFAULT_LANG;
}

/* Whether this visitor has ever CHOSEN a language, as opposed to being
   shown the English default. savedLanguage() cannot answer that - it
   returns 'en' either way - and the difference is what decides whether
   the first-run overlay asks (see openTutorial()). */
function hasStoredLanguage(){
  let stored = null;
  try { stored = localStorage.getItem(I18N_STORAGE_KEY); } catch(e){}
  return !!stored && I18N_LANGS.some(l => l.code === stored);
}

/* ---- The picker ---- */

function renderLanguagePicker(){
  const wrap = document.getElementById('langPicker');
  if(!wrap) return;
  const current = i18nLangEntry(I18N_LANG);

  wrap.innerHTML = `
    <button class="lang-btn" id="langBtn" aria-haspopup="listbox" aria-expanded="false"
            title="${i18nEsc(t('common.language'))}">
      <span class="lang-globe" aria-hidden="true">⊕</span>
      <span class="lang-name">${i18nEsc(current.label)}</span>
      <span class="lang-caret">▾</span>
    </button>
    <div class="lang-menu" id="langMenu" role="listbox" aria-label="${i18nEsc(t('common.language'))}">
      ${I18N_LANGS.map(l => `
        <button class="lang-option${l.code === I18N_LANG ? ' active' : ''}"
                role="option" aria-selected="${l.code === I18N_LANG}" data-lang="${l.code}">
          <span class="lang-name">${i18nEsc(l.label)}</span>
        </button>`).join('')}
    </div>`;

  const btn = document.getElementById('langBtn');
  const menu = document.getElementById('langMenu');
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  };
  menu.querySelectorAll('.lang-option').forEach(opt => {
    opt.onclick = (e) => {
      e.stopPropagation();
      wrap.classList.remove('open');
      const code = opt.dataset.lang;
      if(code === I18N_LANG) return;
      // Distinct from tutorial_language, which the first-run carousel
      // fires for its own picker - this is the only signal for anyone
      // who changes language later, from the header, not on first visit.
      track('language_changed', {lang: code, from: I18N_LANG});
      setLanguage(code);
    };
  });
}

// Click-away / Escape close, registered once rather than per render.
document.addEventListener('click', () => {
  const wrap = document.getElementById('langPicker');
  if(wrap) wrap.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  const wrap = document.getElementById('langPicker');
  if(wrap) wrap.classList.remove('open');
});

// Boot. Not awaited by the page itself: the markup is already English, so
// the page is usable from the first paint and simply re-labels itself a
// moment later if another language is stored. Exposed as a promise
// because ONE thing does need to wait for it - the first-run tutorial
// (js/tutorial.js) renders real copy from t() the moment it opens, and
// "window load fired" is not a guarantee that this fetch has resolved.
const i18nReady = setLanguage(savedLanguage(), {persist: false});

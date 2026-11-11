/* ================= FIRST RUN: LANGUAGE, THEN TUTORIAL =================

   An auction draft is not a format most people have already played, so
   the home screen's three-line summary is not enough for someone seeing
   the game for the first time - they understand the words and still do
   not know what they are about to do. This runs once, before anything
   else, and explains the CONCEPT rather than the controls.

   WHY A SELF-CONTAINED CAROUSEL RATHER THAN COACH-MARKS

   The obvious alternative is tooltips pinned to the real bidding screen.
   It cannot work here: at first run there is no draft, no budget and no
   player on the stage, so there is nothing to point at. Anchored bubbles
   would also have to be re-anchored for RTL and re-measured on every
   phone width. So each step draws its own small, wordless diagram (see
   the tutArt* functions) instead of pointing at live DOM.

   WHY LANGUAGE COMES FIRST

   A tutorial in a language you do not read is worse than no tutorial. So
   a visitor with no stored language picks one before step 1, and the
   whole overlay repaints in it immediately - which doubles as proof the
   choice took effect. Anyone who has already chosen a language (every
   existing player) skips straight to the steps.

   The art is deliberately made of position codes, numerals and shapes.
   Those read identically in all five languages, so adding a language
   never means redrawing anything - and never means a diagram quietly
   left in English. */

const TUTORIAL_SEEN_KEY = 'auctionXI_tutorialSeen';

// 'language' is only ever entered on a genuinely fresh visit; see openTutorial().
let tutPhase = 'steps';
let tutStep = 0;

function tutHasSeen(){
  try { return localStorage.getItem(TUTORIAL_SEEN_KEY) === '1'; } catch(e){ return false; }
}
function tutMarkSeen(){
  try { localStorage.setItem(TUTORIAL_SEEN_KEY, '1'); } catch(e){}
}

/* ---- The diagrams ----

   No prose, by design (see the header): position codes, numbers and
   shapes only. Everything here is inert - the whole block is
   aria-hidden and built from spans, never buttons, so nothing in it can
   be tabbed to or mistaken for a control. */

// Step 1: the queue. The point is "one at a time", so the stage slot is
// lit and the rest are visibly waiting behind it.
function tutArtQueue(){
  const upcoming = ['CM', 'LB', 'GK'];
  return `<div class="tut-queue">
    <span class="tut-chip now">ST</span>
    <span class="tut-queue-tail">
      ${upcoming.map(p => `<span class="tut-chip">${p}</span>`).join('')}
    </span>
  </div>`;
}

// Step 2: one budget, a whole squad to pay for out of it.
function tutArtBudget(){
  const pips = Array.from({length: 11}, (_, i) =>
    `<span class="tut-pip${i < 2 ? ' filled' : ''}"></span>`).join('');
  return `<div class="tut-budget">
    <div class="tut-budget-num">1000<span class="tut-m">M</span></div>
    <div class="tut-pips">${pips}</div>
  </div>`;
}

// Step 3: the bidding controls, in miniature. Same shape and the same
// order as the real ones - minus on the left, plus on the right, in
// every language (see the RTL block in styles.css).
function tutArtBid(){
  return `<div class="tut-bidpanel">
    <span class="tut-step-btn">−5</span>
    <span class="tut-bid-amount">45<span class="tut-m">M</span></span>
    <span class="tut-step-btn amber">+5</span>
    <span class="tut-clock">7</span>
  </div>`;
}

// Step 4: a 4-3-3 with two slots signed. Never mirrored - a pitch has a
// fixed geometry.
function tutArtPitch(){
  const rows = [
    [{on: false}],
    [{on: false}, {on: true}, {on: false}, {on: false}],
    [{on: false}, {on: false}, {on: false}],
    [{on: false}, {on: true}, {on: false}],
  ];
  return `<div class="tut-pitch">
    ${rows.map(r => `<div class="tut-pitch-row">
      ${r.map(s => `<span class="tut-slot${s.on ? ' filled' : ''}"></span>`).join('')}
    </div>`).join('')}
  </div>`;
}

// Step 4: the round is not one-shot. One player swapped out for another,
// which reads as "this can change" without naming either mechanic - the
// text does that.
function tutArtSwap(){
  return `<div class="tut-swap">
    <span class="tut-chip out">ST</span>
    <span class="tut-swap-arrow">⟲</span>
    <span class="tut-chip now">RW</span>
  </div>`;
}

// Step 6: the payoff. A scoreline needs no words at all - and under it,
// the shape of the match report that now follows every game.
function tutArtMatch(){
  // One wrapper, because .tut-art is a centring flex ROW - two siblings
  // returned side by side put the bars next to the scoreline instead of
  // under it.
  return `<div class="tut-matchwrap">
    <div class="tut-match">
      <span class="tut-shirt a"></span>
      <span class="tut-score">2 <span class="tut-dash">–</span> 1</span>
      <span class="tut-shirt b"></span>
    </div>
    <div class="tut-matchbars">
      <span class="tut-matchbar"><i style="width:58%"></i></span>
      <span class="tut-matchbar"><i style="width:41%"></i></span>
    </div>
  </div>`;
}

/* Keyed by number rather than by name so the key a translator edits
   ("step3Text") is the step the player sees ("3 of 6"). */
const TUTORIAL_STEPS = [
  tutArtQueue,
  tutArtBudget,
  tutArtBid,
  tutArtSwap,
  tutArtPitch,
  tutArtMatch,
];

/* ---- Rendering ---- */

function tutRenderLanguage(){
  return `
    <div class="tut-panel tut-panel-lang">
      <div class="tut-globe" aria-hidden="true">⊕</div>
      <h2 class="tut-title">${i18nEsc(t('tutorial.pickLanguage'))}</h2>
      <p class="tut-text">${i18nEsc(t('tutorial.pickLanguageSub'))}</p>
      <div class="tut-lang-grid">
        ${I18N_LANGS.map(l => `
          <button type="button" class="tut-lang-opt${l.code === I18N_LANG ? ' active' : ''}"
                  data-lang="${l.code}" lang="${l.code}" dir="${l.dir}">
            ${i18nEsc(l.label)}
          </button>`).join('')}
      </div>
      <button type="button" class="start-btn tut-continue" id="tutLangContinue">
        ${i18nEsc(t('tutorial.continue'))}
      </button>
    </div>`;
}

function tutRenderSteps(){
  const total = TUTORIAL_STEPS.length;
  const n = tutStep + 1;
  const last = tutStep === total - 1;

  const dots = TUTORIAL_STEPS.map((_, i) =>
    `<span class="tut-dot${i === tutStep ? ' on' : ''}"></span>`).join('');

  return `
    <div class="tut-panel">
      <button type="button" class="tut-close" id="tutCloseBtn"
              title="${i18nEsc(t('tutorial.close'))}" aria-label="${i18nEsc(t('tutorial.close'))}">✕</button>

      <div class="tut-art" aria-hidden="true">${TUTORIAL_STEPS[tutStep]()}</div>

      <div class="tut-count">${i18nEsc(t('tutorial.stepOf', {n: n, total: total}))}</div>
      <h2 class="tut-title">${i18nEsc(t('tutorial.step' + n + 'Title'))}</h2>
      <p class="tut-text">${i18nEsc(t('tutorial.step' + n + 'Text'))}</p>

      <div class="tut-dots" aria-hidden="true">${dots}</div>

      <div class="tut-nav">
        <button type="button" class="tut-btn" id="tutBackBtn"${tutStep === 0 ? ' disabled' : ''}>
          <span class="nav-arrow">←</span> ${i18nEsc(t('tutorial.back'))}
        </button>
        <button type="button" class="tut-btn primary" id="tutNextBtn">
          ${last ? i18nEsc(t('tutorial.done'))
                 : i18nEsc(t('tutorial.next')) + ' <span class="nav-arrow">→</span>'}
        </button>
      </div>

      ${last ? '' : `<button type="button" class="tut-skip" id="tutSkipBtn">${i18nEsc(t('tutorial.skip'))}</button>`}
    </div>`;
}

function tutRender(){
  const box = document.getElementById('tutorialBox');
  if(!box) return;

  box.innerHTML = tutPhase === 'language' ? tutRenderLanguage() : tutRenderSteps();
  box.scrollTop = 0;

  if(tutPhase === 'language'){
    box.querySelectorAll('.tut-lang-opt').forEach(opt => {
      opt.onclick = () => {
        const code = opt.dataset.lang;
        // setLanguage() repaints the page AND, through i18nRefreshDynamic
        // -> tutorialRefresh, this overlay - so the whole panel is in the
        // new language by the time the tap finishes. That instant echo is
        // the confirmation; there is no separate "selected" state to trust.
        if(code === I18N_LANG){ tutRender(); return; }
        setLanguage(code);
        track('tutorial_language', {lang: code});
      };
    });
    const go = document.getElementById('tutLangContinue');
    if(go) go.onclick = () => {
      // Persist even when the visitor never touched a button: English was
      // a real (default) choice, and re-asking on the next visit would
      // read as the game forgetting.
      try { localStorage.setItem(I18N_STORAGE_KEY, I18N_LANG); } catch(e){}
      tutPhase = 'steps';
      tutStep = 0;
      tutRender();
    };
    return;
  }

  const back = document.getElementById('tutBackBtn');
  if(back) back.onclick = () => { if(tutStep > 0){ tutStep--; tutRender(); } };

  const next = document.getElementById('tutNextBtn');
  if(next) next.onclick = () => {
    if(tutStep < TUTORIAL_STEPS.length - 1){ tutStep++; tutRender(); }
    else closeTutorial('finished');
  };

  const skip = document.getElementById('tutSkipBtn');
  if(skip) skip.onclick = () => closeTutorial('skipped');

  const close = document.getElementById('tutCloseBtn');
  if(close) close.onclick = () => closeTutorial('closed');
}

// Called by i18nRefreshDynamic() so a language change anywhere repaints
// the overlay in place, without disturbing which step is showing.
function tutorialRefresh(){
  const overlay = document.getElementById('tutorialOverlay');
  if(overlay && overlay.classList.contains('show')) tutRender();
}

/* ---- Open / close ---- */

function openTutorial(opts){
  opts = opts || {};
  const overlay = document.getElementById('tutorialOverlay');
  if(!overlay) return;

  // The language step is for people the game has never met. Reopening it
  // from "How to Play" always goes straight to the steps - the picker is
  // right there on the home screen for anyone who wants to switch.
  tutPhase = (opts.firstRun && !hasStoredLanguage()) ? 'language' : 'steps';
  tutStep = 0;

  tutRender();
  overlay.classList.add('show');
  track('tutorial_opened', {first_run: !!opts.firstRun});
}

function closeTutorial(how){
  const overlay = document.getElementById('tutorialOverlay');
  if(!overlay) return;
  overlay.classList.remove('show');
  // Marked on ANY exit, including Skip: skipping is a decision, and a
  // tutorial that reappears after being dismissed is a nuisance. "How to
  // Play" on the home screen is how it comes back.
  tutMarkSeen();
  track('tutorial_closed', {how: how || 'closed', step: tutStep + 1});
}

/* ---- Wiring ---- */

document.getElementById('howToPlayBtn').onclick = () => openTutorial({firstRun: false});

// Escape and the backdrop dismiss it, same as every other overlay here.
document.getElementById('tutorialOverlay').onclick = (e) => {
  if(e.target.id === 'tutorialOverlay') closeTutorial('backdrop');
};
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  const overlay = document.getElementById('tutorialOverlay');
  if(overlay && overlay.classList.contains('show')) closeTutorial('escape');
});

/* This file loads last, so this handler runs after multiplayer.js has
   already decided whether to restore a room. Requiring the home screen
   to be visible is what keeps the tutorial away from someone dropping
   back into a live draft after a refresh.

   Chained off i18nReady rather than a bare 'load' listener: 'load' means
   every resource has finished, which is usually well after the small
   locale fetch, but "usually" isn't "always" - openTutorial() renders
   real copy from t() immediately, and rendering it one tick before the
   dictionary arrives would print raw keys instead of words. */
window.addEventListener('load', () => {
  /* bootReady as well as i18nReady, and this is the whole fix for a bug that
     lost the welcome screen on about half of all first visits.

     The home screen starts as display:none in the markup and is only shown
     once multiplayer.js has awaited playersReady. This handler used to await
     i18nReady alone and then read home.style.display - so when the small
     locale fetch beat the 1.7 MB player database, which is most of the time on
     a fast connection, the check ran against a home screen that had not been
     revealed yet, returned early, and the first-run welcome never opened. The
     visitor got no carousel and, worse, no language chooser.

     Waiting for bootReady means the screen has been chosen before we look at
     it, which is what the check always meant to ask. */
  Promise.all([i18nReady, bootReady]).then(() => {
    if(tutHasSeen()) return;
    const home = document.getElementById('homeScreen');
    if(!home || home.style.display === 'none') return;   // dropped into a live draft
    openTutorial({firstRun: true});
  });
});

/* ================= LIVE, IN-CONTEXT AUCTION WALKTHROUGH =================

   The carousel above teaches the CONCEPT before there is a draft to point
   at. This teaches the CONTROLS, the first time a real player is actually
   up for bid: a ring drawn around the exact element being explained (who's
   being sold, the clock, how to respond) plus a small callout, rather than
   a modal describing them from nowhere.

   Offline only (shared screen / vs AI). It works by borrowing the same
   pause the Pause button uses (see runTimer() and aiTick() in
   auction.js/ai.js, both of which already check state.paused) and pushing
   roundEndsAt out by however long the tour took on close, so nobody loses
   real bidding time to having read it. None of that is available online -
   the clock belongs to every device in the room, not just this one - so a
   first-time online player relies on the home-screen carousel and "How to
   Play" instead. */

const LIVE_TUTORIAL_SEEN_KEY = 'auctionXI_liveTutorialSeen';
const BLIND_TUTORIAL_SEEN_KEY = 'auctionXI_blindTutorialSeen';
let coachStep = 0;
let coachPauseStartedAt = null;
let coachReflow = null;
// Which tour is on screen: the full controls walkthrough, or the single
// note explaining a sealed-bid round. See coachSteps().
let coachMode = 'controls';

function liveTutorialHasSeen(){
  try { return localStorage.getItem(LIVE_TUTORIAL_SEEN_KEY) === '1'; } catch(e){ return false; }
}
function liveTutorialMarkSeen(){
  try { localStorage.setItem(LIVE_TUTORIAL_SEEN_KEY, '1'); } catch(e){}
}
function blindTutorialHasSeen(){
  try { return localStorage.getItem(BLIND_TUTORIAL_SEEN_KEY) === '1'; } catch(e){ return false; }
}
function blindTutorialMarkSeen(){
  try { localStorage.setItem(BLIND_TUTORIAL_SEEN_KEY, '1'); } catch(e){}
}

/* Called from startBidding() on every round. Two different one-shot
   tours can come out of here, each with its own seen-flag:

     - The controls walkthrough, on the first NORMAL round. A blind round
       hides the current bid and the leader on purpose, which makes it the
       wrong round to teach "here's the current bid" on.

     - A single note the first time a SEALED-BID round comes up. This used
       to be skipped in silence, which meant the one round in the draft
       where the rules visibly change - no bid shown, no leader, nobody
       able to see anyone else's offer - was also the only round nothing
       explained. Landing on that with no warning reads as the game
       breaking rather than as a twist. */
function maybeShowLiveAuctionTutorial(){
  if(currentRoomCode) return;
  if(!state.currentPlayer) return;

  if(state.isBlindRound){
    if(blindTutorialHasSeen()) return;
    blindTutorialMarkSeen();
    coachMode = 'blind';
  } else {
    if(liveTutorialHasSeen()) return;
    liveTutorialMarkSeen();
    coachMode = 'controls';
  }

  // Let the round-start visuals (SOLD flash clearing, countdown reset)
  // settle before drawing a ring around them.
  setTimeout(openLiveAuctionTutorial, 500);
}

// Rebuilt fresh on open rather than cached: it reads the CURRENT player,
// slot label and on-screen button text, so the copy is always describing
// what is actually on screen right now, in whatever language is active.
function coachSteps(){
  const p = state.currentPlayer;
  const posLabel = (document.getElementById('posTag').textContent || '').trim();

  /* One note, pointing at the badge that marks the round as sealed, and
     at the bid readout that is showing "hidden" instead of a number -
     the two things on screen that just stopped behaving normally. */
  if(coachMode === 'blind'){
    return [{
      target: () => [document.getElementById('blindBadge'), document.getElementById('currentBid')],
      text: t('tutorial.blind.step1'),
    }];
  }
  const bidBtn = document.querySelector('.bidder-card .bid-btn:not(:disabled)');
  const placeBidLabel = (bidBtn && bidBtn.textContent.trim()) || t('auction.placeBid');
  const goingLabel = (document.getElementById('goingBtn').textContent || '').trim() || t('auction.skipTimer');

  return [
    {
      target: () => [document.getElementById('playerPos'), document.getElementById('playerName')],
      text: t('tutorial.live.step1', {name: i18nEsc(playerNameText(p)), position: i18nEsc(posLabel)}),
    },
    {
      target: () => [document.querySelector('.timer-ring')],
      text: t('tutorial.live.step2'),
    },
    {
      target: () => [bidBtn ? bidBtn.closest('.bidder-card') : document.getElementById('bidderGrid')],
      text: t('tutorial.live.step3', {btn: '<b>' + i18nEsc(placeBidLabel) + '</b>'}),
    },
    {
      target: () => [document.getElementById('goingBtn')],
      text: t('tutorial.live.step4', {btn: '<b>' + i18nEsc(goingLabel) + '</b>'}),
    },
  ];
}

function openLiveAuctionTutorial(){
  // The round can move on in the 500ms this was scheduled after - re-check
  // rather than describing a player that already sold, or explaining
  // sealed bids on a round that turned out to be an ordinary one.
  if(!state.currentPlayer) return;
  if(state.isBlindRound !== (coachMode === 'blind')) return;
  const overlay = document.getElementById('coachOverlay');
  if(!overlay) return;

  coachStep = 0;
  state.paused = true;
  coachPauseStartedAt = Date.now();

  overlay.classList.add('show');
  coachRender();

  coachReflow = () => coachPosition();
  window.addEventListener('resize', coachReflow);
  window.addEventListener('scroll', coachReflow, true);
  track('live_tutorial_opened', {});
}

function closeLiveAuctionTutorial(){
  const overlay = document.getElementById('coachOverlay');
  if(overlay) overlay.classList.remove('show');

  if(coachPauseStartedAt != null){
    // Give back exactly the time this took - a round that had 8 seconds
    // left when the tour opened still has 8 seconds left when it closes,
    // no matter how long the reading actually took.
    if(state.roundEndsAt) state.roundEndsAt += (Date.now() - coachPauseStartedAt);
    state.paused = false;
    coachPauseStartedAt = null;
    if(typeof updateTimerUI === 'function') updateTimerUI();
  }

  if(coachReflow){
    window.removeEventListener('resize', coachReflow);
    window.removeEventListener('scroll', coachReflow, true);
    coachReflow = null;
  }
  track('live_tutorial_closed', {step: coachStep + 1});
}

function coachRender(){
  const steps = coachSteps();
  const step = steps[coachStep];
  if(!step){ closeLiveAuctionTutorial(); return; }

  const card = document.getElementById('coachCard');
  const total = steps.length;
  const n = coachStep + 1;
  const last = n === total;
  const dots = steps.map((_, i) => `<span class="coach-dot${i === coachStep ? ' on' : ''}"></span>`).join('');

  card.innerHTML = `
    <button type="button" class="coach-close" id="coachCloseBtn"
            title="${i18nEsc(t('tutorial.close'))}" aria-label="${i18nEsc(t('tutorial.close'))}">✕</button>
    <div class="coach-count">${i18nEsc(t('tutorial.stepOf', {n: n, total: total}))}</div>
    <div class="coach-text">${step.text}</div>
    <div class="coach-dots">${dots}</div>
    <button type="button" class="coach-next" id="coachNextBtn">
      ${last ? i18nEsc(t('tutorial.live.gotIt')) : i18nEsc(t('tutorial.next')) + ' <span class="nav-arrow">→</span>'}
    </button>`;

  document.getElementById('coachCloseBtn').onclick = () => closeLiveAuctionTutorial();
  document.getElementById('coachNextBtn').onclick = () => {
    if(last){ closeLiveAuctionTutorial(); return; }
    coachStep++;
    coachRender();
  };

  coachPosition();
}

// Measures the current step's real target element(s) and places the ring
// and card around them. Re-run on open, on every step change, and on
// resize/scroll while open - getBoundingClientRect() is viewport-relative,
// which is exactly the coordinate space the overlay's fixed-anchored,
// absolutely-positioned children live in, so no scroll-offset math is
// needed, only a re-measure.
function coachPosition(){
  const overlay = document.getElementById('coachOverlay');
  if(!overlay || !overlay.classList.contains('show')) return;
  const steps = coachSteps();
  const step = steps[coachStep];
  if(!step) return;

  const els = step.target().filter(Boolean);
  if(!els.length) return;

  const rects = els.map(el => el.getBoundingClientRect());
  const box = {
    top: Math.min(...rects.map(r => r.top)),
    left: Math.min(...rects.map(r => r.left)),
    right: Math.max(...rects.map(r => r.right)),
    bottom: Math.max(...rects.map(r => r.bottom)),
  };
  const pad = 8;
  box.top -= pad; box.left -= pad; box.right += pad; box.bottom += pad;

  const ring = document.getElementById('coachRing');
  ring.style.top = box.top + 'px';
  ring.style.left = box.left + 'px';
  ring.style.width = (box.right - box.left) + 'px';
  ring.style.height = (box.bottom - box.top) + 'px';

  const card = document.getElementById('coachCard');
  const cardH = card.offsetHeight || 160;
  const margin = 14;
  const spaceBelow = window.innerHeight - box.bottom;
  // Below by default; only flips above when there is genuinely more room
  // there, so the card never gets clamped to a sliver at the bottom of a
  // short phone screen.
  const placeBelow = spaceBelow > (cardH + margin) || spaceBelow >= (box.top - margin);
  card.style.top = placeBelow ? (box.bottom + margin) + 'px' : Math.max(margin, box.top - cardH - margin) + 'px';

  const cardW = card.offsetWidth || 300;
  let left = (box.left + box.right) / 2 - cardW / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - cardW - margin));
  card.style.left = left + 'px';
}

document.getElementById('coachOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'coachOverlay') closeLiveAuctionTutorial();
});
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  const overlay = document.getElementById('coachOverlay');
  if(overlay && overlay.classList.contains('show')) closeLiveAuctionTutorial();
});

/* ================= STATE ================= */
let ROUND_SECONDS = 30;
let RESET_SECONDS = 6;
let SHOW_RATINGS = false;
let REROLLS_MODE = '3'; // 'disabled' or '3'
let SOUND_EFFECTS = true;
// selectedFormation (and FORMATION/FORMATIONS/BUDGET/MIN_PER_POSITION/
// BID_STEP) are owned by js/modes/registry.js - see applyGameMode().

// Load saved settings from localStorage
function loadSettings(){
  try {
    const saved = localStorage.getItem('auctionXISettings');
    if(saved){
      const settings = JSON.parse(saved);
      participantCount = settings.participantCount || 3;
      ROUND_SECONDS = settings.roundSeconds !== undefined ? settings.roundSeconds : 30;
      // Mode first: it decides which formation keys are even valid, and
      // applyGameMode falls back to the mode's default if the saved
      // formation belongs to the other mode (or to a removed one).
      applyGameMode(settings.gameMode || DEFAULT_GAME_MODE_ID, settings.formation);
      SHOW_RATINGS = settings.showRatings || false;
      REROLLS_MODE = settings.rerollsMode || '3';
      // Absent/unknown = the mode's own default, which is what every save
      // from before this setting existed was already doing.
      setDrawOrder(settings.drawOrder);
      setDraftFilters(settings.filters);
      SOUND_EFFECTS = settings.soundEffects !== undefined ? settings.soundEffects : true;
      // Only a preference at this point - loadPlayerDatabase() checks it
      // against the catalogue and falls back if the pool has since been
      // removed, so a stale id can't leave the game with no players.
      activePoolId = settings.poolId || DEFAULT_POOL_ID;
    }
  } catch(e){
    console.error('Error loading settings:', e);
  }
}

// Save settings to localStorage
function saveSettings(){
  try {
    const settings = {
      participantCount,
      roundSeconds: ROUND_SECONDS,
      gameMode: GAME_MODE_ID,
      formation: selectedFormation,
      showRatings: SHOW_RATINGS,
      rerollsMode: REROLLS_MODE,
      drawOrder: DRAW_ORDER,   // null until the player picks one explicitly
      filters: DRAFT_FILTERS,
      soundEffects: SOUND_EFFECTS,
      poolId: activePoolId
    };
    localStorage.setItem('auctionXISettings', JSON.stringify(settings));
  } catch(e){
    console.error('Error saving settings:', e);
  }
}

// Sound effects
const sounds = {
  newRound: () => playBeep(440, 0.1, 0.05),
  bid: () => playBeep(660, 0.08, 0.03),
  countdown: () => playBeep(800, 0.12, 0.06),
  sold: () => playBeep(520, 0.2, 0.08)
};

function playBeep(freq, duration, volume){
  if(!SOUND_EFFECTS) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch(e){}
}

// Haptic feedback - short, subtle pulses only, and only ever alongside
// sound (same on/off toggle the user already controls via the sound
// button). iOS Safari has no Vibration API at all, even installed as a
// PWA - 'vibrate' in navigator is false there, so this fails silently
// rather than throwing.
function vibrate(pattern){
  if(!SOUND_EFFECTS) return;
  if(!('vibrate' in navigator)) return;
  try { navigator.vibrate(pattern); } catch(e){}
}
const haptics = {
  bid: () => vibrate(10),
  sold: () => vibrate([15, 40, 15]),
  reroll: () => vibrate(20),
  callFinalBids: () => vibrate(12),
  matchFinished: () => vibrate([20, 60, 20, 60, 20])
};

let state = {
  participants: [],
  positionOrder: [],
  currentRound: 0,
  phaseNum: 1,
  totalPhases: 0,
  currentPlayer: null,
  currentBid: 0,
  currentLeader: null,
  timer: 0,
  roundEndsAt: null,
  timerInterval: null,
  auctioning: false,
  rerollsRemaining: 3,
  // AI mode only: who has already called final bids this round, and what
  // each opponent decided the current player is worth to them.
  goingVotes: {},
  aiValuations: {},
  paused: false,
  pausedTime: 0,
  pausedAt: 0,
  timeRemainingWhenPaused: 0,
};

/* ================= SETUP UI ================= */
let participantCount = 3;

// Load settings first
loadSettings();

// Global sound toggle - a local, per-device preference available on
// every screen. Works identically offline and online, and (in
// multiplayer) only ever affects this browser's own audio.
const globalSoundBtn = document.getElementById('globalSoundBtn');
function updateGlobalSoundBtn(){
  globalSoundBtn.textContent = SOUND_EFFECTS ? '🔊' : '🔇';
  globalSoundBtn.classList.toggle('muted', !SOUND_EFFECTS);
  globalSoundBtn.title = SOUND_EFFECTS ? 'Sound on (click to mute)' : 'Sound off (click to unmute)';
}
globalSoundBtn.onclick = () => {
  SOUND_EFFECTS = !SOUND_EFFECTS;
  updateGlobalSoundBtn();
  saveSettings();
};
updateGlobalSoundBtn();

const countRow = document.getElementById('countRow');
for(let i=2;i<=10;i++){
  const btn = document.createElement('button');
  btn.className = 'chip-btn' + (i===participantCount?' active':'');
  btn.textContent = i;
  // The pool warning depends on the participant count, so it has to be
  // recomputed here as well as on a formation or pool change.
  btn.onclick = ()=>{ participantCount = i; renderCountRow(); renderNamesGrid(); renderAllPoolPickers(); saveSettings(); };
  btn.dataset.n = i;
  countRow.appendChild(btn);
}
function renderCountRow(){
  [...countRow.children].forEach(b=> b.classList.toggle('active', parseInt(b.dataset.n)===participantCount));
}

const timerRow = document.getElementById('timerRow');
[10,30,60,300,0,'custom'].forEach(sec=>{
  const btn = document.createElement('button');
  let label;
  if(sec === 0) label = 'Unlimited';
  else if(sec === 'custom') label = 'Custom';
  else if(sec === 60) label = '1 minute';
  else if(sec === 300) label = '5 minutes';
  else label = sec + ' seconds';

  btn.className = 'chip-btn' + (sec===ROUND_SECONDS?' active':'');
  btn.textContent = label;
  btn.onclick = ()=>{
    if(sec === 'custom'){
      ROUND_SECONDS = -1; // Mark as custom
      document.getElementById('customTimerInput').focus();
    } else {
      ROUND_SECONDS = sec;
      RESET_SECONDS = sec === 0 ? 0 : Math.max(4, Math.round(sec*0.4));
    }
    renderTimerRow();
    saveSettings();
  };
  btn.dataset.sec = sec;
  timerRow.appendChild(btn);
});

document.getElementById('customTimerInput').oninput = (e) => {
  const val = parseInt(e.target.value);
  const errorEl = document.getElementById('customTimerError');
  if(val < 1 || val > 60){
    errorEl.textContent = t('field.customTimerError');
    ROUND_SECONDS = -1;
  } else {
    errorEl.textContent = '';
    ROUND_SECONDS = val * 60;
    RESET_SECONDS = Math.max(4, Math.round(ROUND_SECONDS * 0.4));
    saveSettings();
  }
};

function renderTimerRow(){
  [...timerRow.children].forEach(b=> {
    const sec = b.dataset.sec === 'custom' ? 'custom' : parseInt(b.dataset.sec);
    if(sec === 'custom' && ROUND_SECONDS === -1){
      b.classList.add('active');
    } else if(sec === ROUND_SECONDS){
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });
  // Single source of truth: the custom input is visible only for Custom,
  // regardless of which preset was selected before (or on initial load).
  document.getElementById('customTimerSection').style.display = ROUND_SECONDS === -1 ? 'block' : 'none';
}
renderTimerRow();

/* Marks the page with the game mode currently in play, and fills the
   badge that sits beside the position in the auction status bar.

   The auction screen looked byte-for-byte identical in both modes, so
   once a draft started there was nothing at all to tell you whether you
   were in a 1,000M eleven-a-side draft or a 100M futsal one - and the
   rules differ enough (opening prices, bid steps, whether the next
   player can be a superstar) that guessing wrong costs you the draft.
   The body attribute drives the mode accent in the stylesheet; the badge
   names the mode outright.

   Lives here rather than in auction.js because the setup screen calls it
   at LOAD time, and auction.js loads after this file. */
function applyModeChrome(){
  const mode = activeMode();
  document.body.dataset.gameMode = mode.id;
  const badge = document.getElementById('modeBadge');
  if(badge){
    badge.textContent = mode.chipLabel;
    badge.title = mode.tagline || mode.name;
  }
}

/* ---- Game mode (Classic 11v11 / 6v6) ----

   These were two identical chips reading "11 v 11" and "6 v 6", sitting
   in the settings form between Participants and Formation. That framed
   the choice as a squad SIZE, which is the least interesting thing about
   it - the two are different games (priced-by-rating and laddered versus
   everyone-at-1M and fully random, football versus futsal) and nothing
   on screen said so. They are now cards that state the rules they
   actually differ on, drawn from the mode's own config (see the
   presentation block in js/modes/*.js) so a third mode brings its own
   description rather than needing this file edited.

   Shared with the online waiting room, which renders the identical
   picker from its own container - hence the container/onPick arguments
   instead of a hardcoded element. */
function buildGameModeCards(container, onPick){
  applyModeChrome();   // keep the page's mode accent in step with the picker
  container.innerHTML = '';
  Object.values(GAME_MODES).forEach(mode => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mode-card' + (mode.id === GAME_MODE_ID ? ' active' : '');
    card.dataset.mode = mode.id;
    if(mode.accent) card.style.setProperty('--mode-accent', mode.accent);
    // Same data-with-English-fallback rule as the pools (see tData): the
    // mode file stays the source of truth, a locale may override it.
    // chipLabel ("11 v 11") is NOT translated - it is a scoreline-shaped
    // token, not a phrase.
    card.innerHTML = `
      <span class="mc-head">
        <span class="mc-name">${esc(tData('modes.' + mode.id + '.name', mode.name))}</span>
        <span class="mc-chip">${esc(mode.chipLabel)}</span>
      </span>
      <span class="mc-tagline">${esc(tData('modes.' + mode.id + '.tagline', mode.tagline || ''))}</span>
      <span class="mc-bullets">${tDataList('modes.' + mode.id + '.bullets', mode.bullets || []).map(b => `<span>${esc(b)}</span>`).join('')}</span>
    `;
    card.onclick = () => {
      if(mode.id === GAME_MODE_ID) return;
      applyGameMode(mode.id);
      onPick();
    };
    container.appendChild(card);
  });
}

const gameModeRow = document.getElementById('gameModeRow');
function renderGameModeRow(){
  buildGameModeCards(gameModeRow, () => {
    renderGameModeRow();
    buildFormationRow();      // formation keys are per-mode
    updateFormationNote();
    renderAllPoolPickers();   // pool depth is judged per formation slot
    saveSettings();
  });
}
renderGameModeRow();

const formationRow = document.getElementById('formationRow');
function buildFormationRow(){
  formationRow.innerHTML = '';
  Object.keys(FORMATIONS).forEach(formKey=>{
    const btn = document.createElement('button');
    btn.className = 'chip-btn' + (formKey===selectedFormation?' active':'');
    btn.textContent = formKey;
    btn.onclick = ()=>{
      applyFormation(formKey);
      renderFormationRow();
      updateFormationNote();
      renderAllPoolPickers(); // pool depth is judged per formation slot
      saveSettings();
    };
    btn.dataset.form = formKey;
    formationRow.appendChild(btn);
  });
}
buildFormationRow();
function renderFormationRow(){
  [...formationRow.children].forEach(b=> b.classList.toggle('active', b.dataset.form===selectedFormation));
}
function updateFormationNote(){
  const posCount = {};
  FORMATION.forEach(f => posCount[f.code] = (posCount[f.code] || 0) + 1);
  const parts = Object.entries(posCount).map(([c, n]) => n + ' ' + c).join(' · ');
  document.getElementById('formationNote').innerHTML =
    `Formation: ${parts} (${FORMATION.length} players) · Budget ${fmt(BUDGET)}<br>${activeMode().noteHTML()}`;

  // The budget headline used to be the literal string "1,000M" in the
  // markup, which was simply wrong in 6v6 (100M) - and wrong on the one
  // line of the setup screen people actually read before starting.
  document.getElementById('budgetAmt').textContent = fmt(BUDGET);

  // Which slots this formation actually has, in the same wording the
  // auction will use - so LCB/RCB is not the first time you meet them.
  const slots = FORMATION.map((f, i) => slotCode(i)).join(' · ');
  document.getElementById('formationSlots').textContent = slots;
}

const ratingToggle = document.getElementById('ratingToggle');
ratingToggle.onclick = ()=>{
  SHOW_RATINGS = !SHOW_RATINGS;
  ratingToggle.classList.toggle('on', SHOW_RATINGS);
  saveSettings();
};
if(SHOW_RATINGS) ratingToggle.classList.add('on');

const rerollsRow = document.getElementById('rerollsRow');
// modeKey '3' is kept as the internal identifier for "Limited" for
// backward compatibility with saved settings - only its label and pool
// size (see rerollPoolSize()) changed when rerolls became a per-draft
// pool instead of a per-round one.
[['Disabled', 'disabled'], [`Limited (${rerollPoolSize('3')})`, '3'], ['Unlimited', 'unlimited']].forEach(([label, modeKey])=>{
  const btn = document.createElement('button');
  btn.className = 'chip-btn' + (modeKey===REROLLS_MODE?' active':'');
  btn.textContent = label;
  btn.onclick = ()=>{
    REROLLS_MODE = modeKey;
    renderRerollsRow();
    saveSettings();
  };
  btn.dataset.mode = modeKey;
  rerollsRow.appendChild(btn);
});
function renderRerollsRow(){
  [...rerollsRow.children].forEach(b=> b.classList.toggle('active', b.dataset.mode===REROLLS_MODE));
}
renderRerollsRow();

// Sound is controlled exclusively via the persistent top-right button
// (see globalSoundBtn below) - it's a local, per-device preference, not
// a per-draft setting, so it no longer lives in this settings panel.

function renderNamesGrid(){
  const grid = document.getElementById('namesGrid');
  const existing = [...grid.children].map(c=>{
    const inp = c.querySelector('input');
    return inp ? inp.value : '';
  });
  grid.innerHTML = '';

  if(AI_MODE){
    // Only the human types a name. The opponents are shown so you can see
    // who you're up against (and what each one is like) before starting.
    const row = document.createElement('div');
    row.className = 'name-input';
    row.innerHTML = `<span class="dot" style="background:${DOT_COLORS[0]}"></span>
      <input type="text" placeholder="${esc(t('lobby.yourName'))}" autocomplete="off" value="${existing[0] || ''}">`;
    grid.appendChild(row);

    aiRosterFor(participantCount - 1).forEach((prof, i) => {
      const r = document.createElement('div');
      r.className = 'name-input';
      r.innerHTML = `<span class="dot" style="background:${DOT_COLORS[i+1]}"></span>
        <span style="font-size:13px; color:var(--white);">🤖 ${prof.name}</span>
        <span style="font-size:11px; color:var(--stone); margin-left:auto;">${prof.blurb}</span>`;
      grid.appendChild(r);
    });
    return;
  }

  for(let i=0;i<participantCount;i++){
    const row = document.createElement('div');
    row.className = 'name-input';
    row.innerHTML = `<span class="dot" style="background:${DOT_COLORS[i]}"></span>
      <input type="text" placeholder="Participant ${i+1}" autocomplete="off" value="${existing[i] || ''}">`;
    grid.appendChild(row);
  }
}

/* ---- Mode entry points from the home screen ---- */

const HUMAN_ID = 'p0';

// Deterministic slice of the archetype list, so the roster shown on the
// setup screen is the roster you actually play against.
function aiRosterFor(count){
  return AI_PROFILES.slice(0, Math.max(0, count));
}

function openSharedSetup(){
  AI_MODE = false;
  track('mode_selected', {mode: 'shared_screen'});
  applySetupMode();
  showScreen('setupScreen');
}

function openAISetup(){
  AI_MODE = true;
  track('mode_selected', {mode: 'vs_ai'});
  // Total participants (you + opponents) is capped at 6, matching the
  // online room limit.
  if(participantCount > 6) participantCount = 6;
  if(participantCount < 2) participantCount = 2;
  applySetupMode();
  showScreen('setupScreen');
}

// The three labels that read differently in AI mode ("You & your
// opponents" vs "Names", etc). Split out from applySetupMode() so a
// language switch can refresh just these without re-running the pool/
// formation/count-row rebuilds that already happen separately - see
// i18nRefreshDynamic() in js/i18n.js, which calls this directly because
// this file loads before AI_MODE's owning screen is necessarily open.
function applySetupModeLabels(){
  document.getElementById('countLabel').textContent =
    t(AI_MODE ? 'setup.participantsAI' : 'setup.participants');
  document.getElementById('namesLabel').textContent = t(AI_MODE ? 'setup.namesAI' : 'setup.names');
  document.getElementById('startBtn').textContent = t(AI_MODE ? 'setup.startAI' : 'setup.start');
}

// Reshapes the shared setup screen for whichever mode it was opened in,
// rather than maintaining a near-duplicate second screen.
function applySetupMode(){
  applySetupModeLabels();
  // No rerolls in AI mode at all - the setting is hidden here and the
  // in-game button/indicator are suppressed in startAuction().
  document.getElementById('rerollsSetting').style.display = AI_MODE ? 'none' : '';

  // AI mode tops out at 6 total; shared screen keeps the full 2-10.
  [...countRow.children].forEach(b => {
    const n = parseInt(b.dataset.n);
    b.style.display = (AI_MODE && n > 6) ? 'none' : '';
  });

  renderCountRow();
  renderNamesGrid();
  updateFormationNote();
  renderAllPoolPickers();
}
renderNamesGrid();
updateFormationNote();

// Load player database on page load. The promise is kept so the boot
// sequence can hold the loading screen up until there are players to
// draft - see playersReady in js/players.js.
playersReady = loadPlayerDatabase();

// Wrapped rather than `= startAuction` because startAuction lives in
// auction.js, which loads AFTER this file - a bare reference would be
// evaluated now and throw. The arrow defers the lookup to click time.
document.getElementById('startBtn').onclick = () => startAuction();

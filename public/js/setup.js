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
      applyGameMode(settings.gameMode || DEFAULT_GAME_MODE_ID);
      // Absent (every save from before formations became optional) = flexible.
      setFormationChoice(settings.formationChoice);
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
      formationChoice: FORMATION_CHOICE,
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
  // Every change to a setting passes through here, so the match sheet that
  // summarises them can never lag behind what the controls say.
  if(typeof renderMatchSheet === 'function') renderMatchSheet();
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
  // "Any" first: the formation is decided after the draft, and can be changed
  // then. A specific one restricts the draft to that shape.
  ['any', ...Object.keys(FORMATIONS)].forEach(formKey=>{
    const btn = document.createElement('button');
    btn.className = 'chip-btn' + (formKey===FORMATION_CHOICE?' active':'');
    btn.textContent = formKey === 'any' ? t('field.formationAny') : formKey;
    btn.onclick = ()=>{
      setFormationChoice(formKey);
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
  [...formationRow.children].forEach(b=> b.classList.toggle('active', b.dataset.form===FORMATION_CHOICE));
}
function updateFormationNote(){
  const any = FORMATION_CHOICE === 'any';
  const posCount = {};
  FORMATION.forEach(f => posCount[f.code] = (posCount[f.code] || 0) + 1);
  const parts = Object.entries(posCount).map(([c, n]) => n + ' ' + c).join(' \u00b7 ');
  const head = any
    ? `${t('field.formationAnyNote')} (${FORMATION.length} players)`
    : `Formation: ${parts} (${FORMATION.length} players)`;
  document.getElementById('formationNote').innerHTML =
    `${esc(head)} \u00b7 Budget ${fmt(BUDGET)}<br>${activeMode().noteHTML()}`;

  // The budget headline used to be the literal string "1,000M" in the
  // markup, which was simply wrong in 6v6 (100M) - and wrong on the one
  // line of the setup screen people actually read before starting.
  document.getElementById('budgetAmt').textContent = fmt(BUDGET);

  // Which slots the formation has, in the same wording the draft shows. With
  // "any" there is no single shape, so the slot list would only mislead.
  const slots = any ? '' : FORMATION.map((f, i) => slotCode(i)).join(' \u00b7 ');
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

/* ================= DRAFT RULES =================

   Draw order, the back-of-the-pack rule and who can appear. One builder
   serves the offline setup screen and the online waiting room (host only),
   mounted through POOL_MOUNTS like the pool picker, so a change made in
   either place goes through the same persist step: saved on this device
   and, for an online host, published to the room so guests and the host
   engine agree. */
const DRAW_ART = {
  phase: '<svg viewBox="0 0 64 40" aria-hidden="true"><g fill="currentColor"><rect x="2" y="2" width="9" height="36" rx="2"/><rect x="15" y="9" width="9" height="29" rx="2"/><rect x="28" y="16" width="9" height="22" rx="2"/><rect x="41" y="23" width="9" height="15" rx="2"/><rect x="54" y="30" width="8" height="8" rx="2"/></g></svg>',
  random: '<svg viewBox="0 0 64 40" aria-hidden="true"><g fill="currentColor"><rect x="2" y="16" width="9" height="22" rx="2"/><rect x="15" y="3" width="9" height="35" rx="2"/><rect x="28" y="26" width="9" height="12" rx="2"/><rect x="41" y="10" width="9" height="28" rx="2"/><rect x="54" y="20" width="8" height="18" rx="2"/></g></svg>',
  pack: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>',
};

// Saves on this device and, for an online host, tells the room.
function persistDraftRules(){
  saveSettings();
  if(typeof isHost !== 'undefined' && isHost && currentRoomCode){
    database.ref().update({
      [`rooms/${currentRoomCode}/settings/drawOrder`]: effectiveDrawOrder(),
      [`rooms/${currentRoomCode}/settings/filters`]: DRAFT_FILTERS,
    });
  }
}

function renderDraftRules(mount){
  const el = mount.rules && document.getElementById(mount.rules);
  if(!el) return;
  if(!mount.editable()){ el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';

  const opts = draftFilterOptions();
  const order = effectiveDrawOrder();
  const f = DRAFT_FILTERS;
  const inPlay = draftablePlayers(mount.count()).length;

  const card = (id, name, desc) =>
    `<button type="button" class="rule-card${order === id ? ' active' : ''}" data-order="${id}" aria-pressed="${order === id}">` +
    `${DRAW_ART[id]}<span class="rule-name">${esc(name)}</span><span class="rule-desc">${esc(desc)}</span></button>`;
  const chip = (attr, value, label, active) =>
    `<button type="button" class="chip-btn${active ? ' active' : ''}" data-${attr}="${esc(value)}" aria-pressed="${active}">${esc(label)}</button>`;
  const select = (attr, label, anyLabel, list, current) =>
    `<label class="filter-select"><span>${esc(label)}</span><select data-${attr}>` +
    `<option value="">${esc(anyLabel)}</option>` +
    list.map(o => `<option value="${esc(o.name)}"${o.name === current ? ' selected' : ''}>${esc(o.name)} (${o.count})</option>`).join('') +
    `</select></label>`;

  const eraChips = [chip('era', 'all', t('filter.eraAll'), f.era === 'all')];
  if(opts.eraSplit) eraChips.push(chip('era', 'present', t('filter.eraPresent'), f.era === 'present'));
  if(opts.legends) eraChips.push(chip('era', 'legends', t('filter.eraLegends'), f.era === 'legends'));

  el.innerHTML = `
    <span class="field-label">${esc(t('field.drawOrder'))}</span>
    <div class="rule-cards">
      ${card('phase', t('draw.phase'), t('draw.phaseDesc'))}
      ${card('random', t('draw.random'), t('draw.randomDesc'))}
    </div>

    <span class="field-label">${esc(t('field.ifNobodyBids'))}</span>
    <div class="rule-note">${DRAW_ART.pack}<span><b>${esc(t('rule.packName'))}.</b> ${esc(t('rule.packDesc'))}</span></div>

    <span class="field-label">${esc(t('field.whoCanAppear'))}</span>
    <div class="filter-grid">
      ${eraChips.length > 1 ? `<div class="filter-group"><span class="filter-label">${esc(t('filter.era'))}</span><div class="chip-row">${eraChips.join('')}</div></div>` : ''}
      <div class="filter-group"><span class="filter-label">${esc(t('filter.quality'))}</span><div class="chip-row">${
        MIN_RATING_CHOICES.map(n => chip('min', n, n ? t('filter.qualityMin', {n}) : t('filter.qualityAuto'), f.minRating === n)).join('')
      }</div></div>
      ${opts.leagues.length ? select('league', t('filter.league'), t('filter.leagueAny'), opts.leagues, f.league) : ''}
      ${opts.nations.length ? select('nation', t('filter.nation'), t('filter.nationAny'), opts.nations, f.nation) : ''}
    </div>
    <div class="filter-count">${esc(t('filter.inPlay', {n: inPlay.toLocaleString()}))}</div>`;

  const changed = () => { persistDraftRules(); renderAllPoolPickers(); };
  el.querySelectorAll('[data-order]').forEach(b => { b.onclick = () => { setDrawOrder(b.dataset.order); changed(); }; });
  el.querySelectorAll('[data-era]').forEach(b => { b.onclick = () => { setDraftFilters({...DRAFT_FILTERS, era: b.dataset.era}); changed(); }; });
  el.querySelectorAll('[data-min]').forEach(b => { b.onclick = () => { setDraftFilters({...DRAFT_FILTERS, minRating: Number(b.dataset.min)}); changed(); }; });
  const league = el.querySelector('[data-league]');
  if(league) league.onchange = () => { setDraftFilters({...DRAFT_FILTERS, league: league.value}); changed(); };
  const nation = el.querySelector('[data-nation]');
  if(nation) nation.onchange = () => { setDraftFilters({...DRAFT_FILTERS, nation: nation.value}); changed(); };
}

/* The match sheet beside the setup form: everything the draft is about to be,
   in one place. Cheap enough to rewrite whole on every change. */
function timerSummary(){
  if(ROUND_SECONDS === 0) return t('sheet.unlimited');
  if(ROUND_SECONDS === -1) return t('sheet.custom');
  if(ROUND_SECONDS >= 60 && ROUND_SECONDS % 60 === 0) return t('sheet.minutes', {n: ROUND_SECONDS / 60});
  return t('sheet.seconds', {n: ROUND_SECONDS});
}

function renderMatchSheet(){
  const el = document.getElementById('matchSheet');
  if(!el || !activeMode()) return;
  const mode = activeMode();
  const rerolls = AI_MODE ? '—'
    : REROLLS_MODE === 'disabled' ? t('sheet.off')
    : REROLLS_MODE === 'unlimited' ? t('sheet.unlimited')
    : t('sheet.limited', {n: rerollPoolSize('3')});
  const inPlay = playerDatabase.length ? draftablePlayers(participantCount).length : 0;
  const rows = [
    [t('sheet.mode'), tData('modes.' + mode.id + '.name', mode.name)],
    [t('sheet.formation'), selectedFormation],
    [t('sheet.pool'), poolName(activePoolDisplay())],
    [t('sheet.inPlay'), inPlay.toLocaleString()],
    [t('sheet.draw'), t(effectiveDrawOrder() === 'random' ? 'draw.random' : 'draw.phase'), 'hot'],
    [t('sheet.unsold'), t('rule.packName'), 'hot'],
    [t('sheet.managers'), AI_MODE ? t('sheet.managersAI', {n: participantCount - 1}) : t('sheet.managersCount', {n: participantCount})],
    [t('sheet.budget'), t('sheet.eachBudget', {budget: fmt(BUDGET)})],
    [t('sheet.timer'), timerSummary()],
    [t('sheet.rerolls'), rerolls],
  ];
  el.innerHTML = rows.map(([k, v, cls]) =>
    `<div class="sheet-row"><dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd></div>`).join('');
}

/* ---- Mode entry points from the home screen ---- */

const HUMAN_ID = 'p0';

// Deterministic slice of the archetype list, so the roster shown on the
// setup screen is the roster you actually play against.
/* The opponents are a random selection of the archetypes, in a random order, and
   stay the same until the AI setup is opened again - so the names grid, the
   draft and a restart with the same settings all show the same people. Each
   gets its own copy of the profile, because some carry per-draft state. */
let aiRosterOrder = null;
function shuffleAIRoster(){
  const order = AI_PROFILES.map((_, i) => i);
  for(let i = order.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  aiRosterOrder = order;
}
function aiRosterFor(count){
  if(!aiRosterOrder) shuffleAIRoster();
  return aiRosterOrder.slice(0, Math.max(0, count)).map(i => ({...AI_PROFILES[i]}));
}

function openSharedSetup(){
  AI_MODE = false;
  track('mode_selected', {mode: 'shared_screen'});
  applySetupMode();
  showScreen('setupScreen');
}

function openAISetup(){
  AI_MODE = true;
  shuffleAIRoster();
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
  renderMatchSheet();
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

/* ================= GAME MODE REGISTRY =================

   One place that knows which mode is active, and the single owner of
   every global the engine derives from a mode. Everything downstream
   (players.js, auction.js, setup.js, multiplayer.js) reads these
   normally and never needs to know a mode concept exists.

   A mode is orthogonal to HOW you play (offline / online / vs AI) - all
   three entry flows work with any mode, which is exactly why the mode
   lives here as a setting rather than as its own home-screen button.

   Loads after the individual mode files (which define the configs it
   registers) and before config.js/setup.js, both of which read these
   globals at load time. */

const GAME_MODES = {
  [MODE_CLASSIC.id]: MODE_CLASSIC,
  [MODE_SIXV6.id]: MODE_SIXV6,
};

const DEFAULT_GAME_MODE_ID = MODE_CLASSIC.id;

let GAME_MODE_ID = DEFAULT_GAME_MODE_ID;

/* ================= DRAW ORDER =================

   HOW the next player on the stage is chosen is a setting of its own, not a
   property of the mode:

     'phase'  - the ladder. Each pass through the formation offers a weaker
                slice of the pool than the last: stars first, bargains last.
     'random' - any eligible player in any round, weighted toward higher
                ratings (see randomBias) so a draft is not all squad fillers.

   Classic used to be hard-wired to the ladder and 6v6 to random. Those are
   now just each mode's DEFAULT (its `selection` field), so a saved game with
   no explicit choice behaves exactly as before. null = "use the mode's own".
   Online, the host's choice travels in the room settings (see
   mpAdoptRoomSettings) and the host is the only client that ever draws. */
const DRAW_ORDERS = ['phase', 'random'];
let DRAW_ORDER = null;

function modeDefaultDrawOrder(mode){
  return ((mode || activeMode()).selection === 'random') ? 'random' : 'phase';
}

function effectiveDrawOrder(){
  return DRAW_ORDERS.includes(DRAW_ORDER) ? DRAW_ORDER : modeDefaultDrawOrder();
}

// Anything unrecognised (a stale save, a hostile room payload) means "mode default".
function setDrawOrder(order){
  DRAW_ORDER = DRAW_ORDERS.includes(order) ? order : null;
  return effectiveDrawOrder();
}

/* The odds curve used whenever the draw is random: weight = normalised
   rating ^ exponent + floor. Modes may override (6v6 does, with these same
   numbers); everything else gets this, so choosing Random in Classic feels
   like 6v6's random rather than a coin flip over a bottom-heavy pool. */
const DEFAULT_RANDOM_BIAS = { exponent: 2.2, floor: 0.12 };
function randomBias(){
  const mode = activeMode();
  return {
    exponent: mode.randomBiasExponent != null ? mode.randomBiasExponent : DEFAULT_RANDOM_BIAS.exponent,
    floor: mode.randomBiasFloor != null ? mode.randomBiasFloor : DEFAULT_RANDOM_BIAS.floor,
  };
}

// Mode-derived globals. Declared here (rather than in config.js/setup.js
// where they used to live) so that applyGameMode below is the only thing
// that ever writes them - otherwise a mode switch has to be repeated in
// several files and they drift.
let FORMATIONS;         // the active mode's formation table
let FORMATION;          // the currently selected formation's slot list
let selectedFormation;  // its key within FORMATIONS
let BUDGET;             // starting budget per participant
let MIN_PER_POSITION;   // floor price, and the reserve kept per unfilled slot
let BID_STEP;           // bid increment, and what the +/- buttons move by

function activeMode(){
  return GAME_MODES[GAME_MODE_ID] || GAME_MODES[DEFAULT_GAME_MODE_ID];
}

function gameModeById(id){
  return GAME_MODES[id] || null;
}

// Switches mode and re-derives every global above. `formationKey` is
// honoured only if it exists in the target mode - formation keys are
// per-mode ('4-3-3' means nothing in 6v6), so anything unrecognised
// falls back to that mode's default rather than leaving FORMATION
// undefined.
function applyGameMode(id, formationKey){
  const mode = gameModeById(id) || GAME_MODES[DEFAULT_GAME_MODE_ID];
  GAME_MODE_ID = mode.id;
  FORMATIONS = mode.formations;
  // Naming a formation here locks the draft to it. Otherwise the current choice
  // stays if this mode has it (formation keys are per-mode, so a switch usually
  // falls back to flexible).
  if(formationKey && FORMATIONS[formationKey]) FORMATION_CHOICE = formationKey;
  else if(FORMATION_CHOICE !== 'any' && !FORMATIONS[FORMATION_CHOICE]) FORMATION_CHOICE = 'any';
  selectedFormation = FORMATION_CHOICE === 'any' ? mode.defaultFormation : FORMATION_CHOICE;
  FORMATION = FORMATIONS[selectedFormation];
  BUDGET = mode.budget;
  MIN_PER_POSITION = mode.minBid;
  BID_STEP = mode.bidStep;
  buildSlotDisplay();
  return mode;
}

/* ================= FORMATION CHOICE =================

   The formation is no longer something to commit to before the draft.

     'any'      (the default) any formation of the mode is allowed. Each manager
                just builds a squad, and ends up in whichever formation suits it
                best; it can be changed afterwards.
     a key      the draft is restricted to that one formation ('4-3-3').

   Either way players can stand anywhere they can play within it (see
   js/lineup.js). FORMATION / selectedFormation still exist, but only as the
   TEMPLATE the draft paces itself on (which positions come up each pass: the
   mode's default shape when flexible) and as the formation a renderer is
   currently drawing (see withFormation). */
let FORMATION_CHOICE = 'any';

function allowedFormationKeys(){
  return (FORMATION_CHOICE !== 'any' && FORMATIONS[FORMATION_CHOICE]) ? [FORMATION_CHOICE] : Object.keys(FORMATIONS);
}

// Anything unrecognised means flexible.
function setFormationChoice(choice){
  if(choice && choice !== 'any' && FORMATIONS[choice]){
    FORMATION_CHOICE = choice;
    applyFormation(choice);
  } else {
    FORMATION_CHOICE = 'any';
    applyFormation(activeMode().defaultFormation);
  }
  return FORMATION_CHOICE;
}

// Changing formation WITHIN a mode. Exists so the slot display below is
// rebuilt from one place: the setup screen and the online waiting room
// both used to assign selectedFormation/FORMATION by hand, and anything
// derived from the formation had to be remembered at both call sites.
function applyFormation(formationKey){
  if(!FORMATIONS[formationKey]) return selectedFormation;
  selectedFormation = formationKey;
  FORMATION = FORMATIONS[selectedFormation];
  buildSlotDisplay();
  return selectedFormation;
}

/* ================= SLOT IDENTITY =================

   A formation SLOT and a position CODE are not the same thing. 4-3-3 has
   three CM slots and 4-4-2 has two STs, and every one of them was shown
   to the room as a bare "CM"/"ST" - while Classic treats them as
   individually owned (filling the left CM leaves you needing the right
   one specifically). Bidders could not tell which of the three was
   actually up, which is the single most confusing thing about a Classic
   draft: you can be told "you already have this position" about a
   position you can plainly see is still empty on your pitch.

   So a display code is derived per slot from where it actually sits on
   that formation's pitch: two of a kind become L../R.., three become
   L../../R.. with the middle one keeping the bare code (a central CM is
   a CM, not a "middle CM"). Nothing about the DATA changes - the
   underlying code is still what player selection and the match
   simulation read; this is purely what the room is shown.

   Modes whose slots are interchangeable opt out with sidedSlots:false,
   because there "the left forward" is not a thing you can be offered. */
let SLOT_CODES = [];    // display code per slot index, e.g. ['GK','LB','LCB','RCB',...]
let SLOT_LABELS = [];   // the same for the long label ('Left Center Back')

function buildSlotDisplay(){
  const mode = activeMode();
  const coords = (mode.pitchCoords || {})[selectedFormation] || {};
  SLOT_CODES = FORMATION.map(f => f.code);
  SLOT_LABELS = FORMATION.map(f => f.label);
  if(mode.sidedSlots === false) return;

  const byCode = {};
  FORMATION.forEach((f, i) => { (byCode[f.code] = byCode[f.code] || []).push(i); });

  Object.values(byCode).forEach(idxs => {
    if(idxs.length < 2) return;   // the only one of its kind: bare code

    // Left to right as drawn on the pitch, which is the only ordering a
    // player can actually see. Falls back to formation order for a slot
    // with no coordinates, which is already left-to-right.
    const ordered = idxs.slice().sort((a, b) =>
      ((coords[a] && coords[a].x) || 0) - ((coords[b] && coords[b].x) || 0));

    // Defensive: no formation in either mode has four of one code, and
    // L/R has nothing sensible to say about four. Number them instead.
    if(ordered.length > 3){
      ordered.forEach((slot, i) => {
        SLOT_CODES[slot] = FORMATION[slot].code + (i + 1);
        SLOT_LABELS[slot] = FORMATION[slot].label + ' ' + (i + 1);
      });
      return;
    }

    const middle = ordered.length === 3 ? 1 : -1;
    ordered.forEach((slot, i) => {
      if(i === middle) return;
      const left = i < ordered.length / 2;
      SLOT_CODES[slot] = (left ? 'L' : 'R') + FORMATION[slot].code;
      SLOT_LABELS[slot] = (left ? 'Left ' : 'Right ') + FORMATION[slot].label;
    });
  });
}

// The display code/label for a slot. Every "here is the position up for
// auction" surface goes through these; anything that FEEDS the engine
// (player selection, the simulation's position weights) keeps reading
// FORMATION[i].code, which is deliberately untouched.
function slotCode(posIdx){
  return SLOT_CODES[posIdx] || (FORMATION[posIdx] || {}).code || '';
}
function slotLabel(posIdx){
  return SLOT_LABELS[posIdx] || (FORMATION[posIdx] || {}).label || '';
}

/* ================= WHO CAN SIGN WHOM =================

   Slots are not owned any more. A manager can sign a player as long as their
   squad can still be arranged into one of the allowed formations with every
   player standing in a position he can play - see participantCanTake() in
   js/lineup.js. That one rule replaces the old per-slot ownership, so a left
   back can double as a wing-back, a forward can play either wing, and the
   formation itself is decided after the draft. The 6v6 categories (DEF, MID,
   FWD) are slots like any other and follow the same rule. */

/* Who has to vote before a reroll goes through, online.

   'eligible' (Classic): only participants who still need the position.
   Someone who has already filled it cannot bid, so the round's outcome
   is none of their business and waiting on them just stalls the draft.

   'all' (6v6): every connected participant. 6v6 rounds are short, the
   pool is drawn at random rather than laddered, and a player nobody
   present can bid for is exactly the case where the room most wants to
   move on - so the reroll is a decision for the whole room, not for
   whoever happens to have a slot open. */
function modeRerollElectorate(){
  return activeMode().rerollElectorate === 'all' ? 'all' : 'eligible';
}

// Rounds to the active mode's bid increment, never below one increment.
// Classic's round5() still exists for the things that are genuinely
// tied to 5M pricing bands (genPrice, the flash premium); this is for
// anything that must follow the mode's own increment instead.
function roundToBidStep(n){
  return Math.max(BID_STEP, Math.round(n / BID_STEP) * BID_STEP);
}

// The price a player is first offered at. Classic prices by rating;
// 6v6 starts everyone at the minimum so nothing is pre-judged.
function modeStartPrice(player){
  return activeMode().startPrice(player);
}

applyGameMode(DEFAULT_GAME_MODE_ID);

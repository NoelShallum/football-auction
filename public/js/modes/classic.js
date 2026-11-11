/* ================= MODE: CLASSIC (11 vs 11) =================

   The original mode, unchanged in behaviour - a full XI drafted across
   the 5 real-football formations, phase-based quality progression, and
   an auto-assignment when only one participant still needs a slot.

   Everything that used to be hardcoded around those rules (budget, bid
   increments, the formation->database position map, the pitch layout)
   is gathered here so a second mode can differ without the engine
   growing branches for each one. See js/modes/registry.js. */

const CLASSIC_FORMATIONS = {
  '4-3-3': [
    {code:'GK', label:'Goalkeeper'},
    {code:'LB', label:'Left Back'},
    {code:'CB', label:'Center Back'},
    {code:'CB', label:'Center Back'},
    {code:'RB', label:'Right Back'},
    {code:'CM', label:'Central Midfielder'},
    {code:'CM', label:'Central Midfielder'},
    {code:'CM', label:'Central Midfielder'},
    {code:'LW', label:'Left Winger'},
    {code:'RW', label:'Right Winger'},
    {code:'ST', label:'Striker'},
  ],
  '4-2-3-1': [
    {code:'GK', label:'Goalkeeper'},
    {code:'LB', label:'Left Back'},
    {code:'CB', label:'Center Back'},
    {code:'CB', label:'Center Back'},
    {code:'RB', label:'Right Back'},
    {code:'CDM', label:'Defensive Midfielder'},
    {code:'CDM', label:'Defensive Midfielder'},
    {code:'LM', label:'Left Midfielder'},
    {code:'CAM', label:'Central Attacking Mid'},
    {code:'RM', label:'Right Midfielder'},
    {code:'ST', label:'Striker'},
  ],
  '4-4-2': [
    {code:'GK', label:'Goalkeeper'},
    {code:'LB', label:'Left Back'},
    {code:'CB', label:'Center Back'},
    {code:'CB', label:'Center Back'},
    {code:'RB', label:'Right Back'},
    {code:'LM', label:'Left Midfielder'},
    {code:'CM', label:'Central Midfielder'},
    {code:'CM', label:'Central Midfielder'},
    {code:'RM', label:'Right Midfielder'},
    {code:'ST', label:'Striker'},
    {code:'ST', label:'Striker'},
  ],
  '3-4-3': [
    {code:'GK', label:'Goalkeeper'},
    {code:'CB', label:'Center Back'},
    {code:'CB', label:'Center Back'},
    {code:'CB', label:'Center Back'},
    {code:'LM', label:'Left Midfielder'},
    {code:'CM', label:'Central Midfielder'},
    {code:'CM', label:'Central Midfielder'},
    {code:'RM', label:'Right Midfielder'},
    {code:'LW', label:'Left Winger'},
    {code:'RW', label:'Right Winger'},
    {code:'ST', label:'Striker'},
  ],
  '5-3-2': [
    {code:'GK', label:'Goalkeeper'},
    {code:'LWB', label:'Left Wing Back'},
    {code:'CB', label:'Center Back'},
    {code:'CB', label:'Center Back'},
    {code:'CB', label:'Center Back'},
    {code:'RWB', label:'Right Wing Back'},
    {code:'CM', label:'Central Midfielder'},
    {code:'CM', label:'Central Midfielder'},
    {code:'CM', label:'Central Midfielder'},
    {code:'ST', label:'Striker'},
    {code:'ST', label:'Striker'},
  ],
};

/* Positional cover, Classic only (6v6 has its own far broader grouping -
   see SIXV6_POSITION_MAP).

   Written as "a player of THIS position can also fill THESE" rather than
   as the slot->accepts map the engine consumes, for two reasons: it is
   the direction the rules are actually reasoned about (a left back can
   cover left wing-back), and it is the shape per-player overrides will
   take when players start carrying their own position lists. Playing
   their own position is implicit and never listed here.

   CB and GK are deliberately empty: specialists, no cover. */
const CLASSIC_CAN_ALSO_PLAY = {
  'ST':  ['CF'],
  'CF':  ['ST', 'CAM'],
  'RW':  ['RM'],
  'LW':  ['LM'],
  'CAM': ['CF', 'CM', 'RM', 'LM'],
  'CM':  ['CAM', 'CDM'],
  'CDM': ['CM'],
  'RB':  ['RWB'],
  'LB':  ['LWB'],
  'LWB': ['LB'],
  'RWB': ['RB'],
  'CB':  [],
  'GK':  [],
};

/* Inverts the above into what the draft engine asks for: for a formation
   slot, which database positions may fill it. Derived rather than
   maintained by hand so the two can never contradict each other - the
   inverse of a 13-entry map is exactly the sort of thing that silently
   rots when one side is edited.

   A position always leads its own list, so a natural fit is ranked above
   cover when getPositionPool() sorts by rating. */
function buildPositionMapFromCover(canAlsoPlay){
  const map = {};
  Object.keys(canAlsoPlay).forEach(pos => { map[pos] = [pos]; });
  Object.entries(canAlsoPlay).forEach(([pos, covers]) => {
    covers.forEach(slot => {
      if(!map[slot]) map[slot] = [slot];
      if(!map[slot].includes(pos)) map[slot].push(pos);
    });
  });
  return map;
}

const CLASSIC_POSITION_MAP = buildPositionMapFromCover(CLASSIC_CAN_ALSO_PLAY);

// Small-draft depth check (current_players pool, 840 players): even the
// thinnest slot after cover-folding (RB/RWB) still has 40+ eligible
// players at this cut, comfortably more than a 4-participant draft can
// ever use. See categoryTopPercent below for where this is applied.
const CLASSIC_SMALL_DRAFT_TOP_PERCENT = 0.83;

// Where each formation slot sits on the results/live pitch (x%, y%).
const CLASSIC_PITCH_COORDS = {
  '4-3-3': {
    0: {x:50, y:95}, 1: {x:15, y:75}, 2: {x:35, y:73}, 3: {x:65, y:73},
    4: {x:85, y:75}, 5: {x:25, y:50}, 6: {x:50, y:48}, 7: {x:75, y:50},
    8: {x:20, y:18}, 9: {x:80, y:18}, 10: {x:50, y:8}
  },
  '4-2-3-1': {
    0: {x:50, y:95}, 1: {x:15, y:75}, 2: {x:35, y:73}, 3: {x:65, y:73},
    4: {x:85, y:75}, 5: {x:35, y:55}, 6: {x:65, y:55}, 7: {x:18, y:30},
    8: {x:50, y:28}, 9: {x:82, y:30}, 10: {x:50, y:8}
  },
  '4-4-2': {
    0: {x:50, y:95}, 1: {x:15, y:75}, 2: {x:35, y:73}, 3: {x:65, y:73},
    4: {x:85, y:75}, 5: {x:15, y:45}, 6: {x:38, y:48}, 7: {x:62, y:48},
    8: {x:85, y:45}, 9: {x:38, y:12}, 10: {x:62, y:12}
  },
  '3-4-3': {
    0: {x:50, y:95}, 1: {x:25, y:73}, 2: {x:50, y:70}, 3: {x:75, y:73},
    4: {x:15, y:48}, 5: {x:38, y:50}, 6: {x:62, y:50}, 7: {x:85, y:48},
    8: {x:20, y:18}, 9: {x:80, y:18}, 10: {x:50, y:8}
  },
  '5-3-2': {
    0: {x:50, y:95}, 1: {x:10, y:70}, 2: {x:28, y:75}, 3: {x:50, y:73},
    4: {x:72, y:75}, 5: {x:90, y:70}, 6: {x:28, y:45}, 7: {x:50, y:43},
    8: {x:72, y:45}, 9: {x:38, y:12}, 10: {x:62, y:12}
  }
};

const MODE_CLASSIC = {
  id: 'classic',
  name: 'Classic 11 v 11',
  shortName: 'Classic',
  chipLabel: '11 v 11',

  /* ---- How the mode presents itself ----
     The mode used to be two identical chips reading "11 v 11" and
     "6 v 6" sitting in the settings form between Participants and
     Formation, which said nothing about them being different GAMES.
     These drive the mode cards on the setup screen and in the online
     waiting room (see buildGameModeCards), and the accent that marks
     the mode during play. Every bullet is a rule that actually differs
     from the other mode - anything true of both belongs on the home
     screen, not here. */
  accent: '#D4FF3F',
  tagline: 'The full match. A real eleven, drafted position by position.',
  bullets: [
    '11 players · 5 real formations · 1,000M budget',
    'Bids move in 5M steps, and every player is priced by rating',
    'The best players come out first - quality drops phase by phase',
    'Every slot is its own signing: LCB and RCB are different players',
    'Played out as a 90-minute football match',
  ],

  formations: CLASSIC_FORMATIONS,
  defaultFormation: '4-3-3',
  positionMap: CLASSIC_POSITION_MAP,
  pitchCoords: CLASSIC_PITCH_COORDS,

  budget: 1000,
  minBid: 20,   // also the reserve held back per still-unfilled slot
  bidStep: 5,

  // 'progressive' = the phase/rank-floor ladder (each pick for a slot is
  // ranked at or below the last one shown for it). See selectPlayerDynamic().
  selection: 'progressive',
  // Duplicate slots are individually owned and are shown with a side
  // prefix so the room can tell them apart - see buildSlotDisplay().
  sidedSlots: true,
  interchangeableSlots: false,
  // Only participants who still need the position vote on a reroll.
  rerollElectorate: 'eligible',
  // Occasional elite "scouting report" pick that jumps the ladder.
  flashPicks: true,
  // When one participant is the only one left needing a slot, hand it to
  // them at the asking price rather than running a one-bidder auction.
  autoAssignLastEligible: true,

  // Priced by rating - genPrice lives in players.js, which loads later,
  // so this is deliberately a function body rather than a value.
  startPrice: (player) => genPrice(player.rating),

  // Small drafts (<= the pool's smallDraftMaxParticipants, still
  // pool-configurable) keep only the top 83% of EACH underlying database
  // position by rating - see topPercentPerBasePosition below, which tells
  // getPositionPool() to judge that cut per raw position (RB, CM, ST, ...)
  // rather than pooling several positions into one bucket first. Above the
  // threshold the filter drops and the full pool is used.
  categoryTopPercent: (poolId, numParticipants) => {
    const cfg = activePoolDraft();
    const max = cfg.smallDraftMaxParticipants != null ? cfg.smallDraftMaxParticipants : 4;
    return numParticipants > max ? null : CLASSIC_SMALL_DRAFT_TOP_PERCENT;
  },
  topPercentPerBasePosition: true,

  // Match simulation: real 11-a-side scoring rates over 90 minutes.
  sim: {
    baseXG: 1.32,      // average goals per team per match
    maxXG: 4.2,        // clamp, so a freak mismatch doesn't read as broken
    fullTime: 91,      // minute range goals are spread across
    extraTimeTo: 121,
    extraTimeTempo: 0.28,
    // Eleven-a-side can afford to lose someone: a dismissal hurts for the
    // rest of the match (see simStrengthAfterReds) without deciding it.
    redCards: true,
    avgShotXg: 0.11,   // typical chance quality, used to derive shot counts
  },

  noteHTML: () =>
    `Positions auctioned in random order. Phase-based player progression. ` +
    `Budget restrictions: must keep ${MIN_PER_POSITION}M per remaining position.`,
};

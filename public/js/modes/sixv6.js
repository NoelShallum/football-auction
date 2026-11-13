/* ================= MODE: 6 vs 6 =================

   A short, fast, deliberately unpredictable draft. Six players per
   squad (GK + five outfield), 100M to spend, and every player offered
   at 1M regardless of who they are.

   Differences from Classic, all expressed as config the shared engine
   reads - there is no separate 6v6 engine:

     - Budget 100M, minimum bid 1M, increments of 1M.
     - No starting price by rating: everyone opens at 1M, so a 94-rated
       striker and a 78-rated one begin identically and the room decides
       what they are worth.
     - No phase-based quality progression and no rank floor. Every pick
       is drawn uniformly at random from the whole filtered pool, so an
       elite player can appear in any round, including the last.
     - No auto-assignment. If only one participant can still use a slot
       the round still runs; they simply win it unopposed at 1M.
     - Positions collapse to four broad categories, so each slot draws
       from a much deeper pool than a specific role like 'LWB' would.

   Formation limits enforce themselves through the existing per-slot
   eligibility rule: a 2-1-2 squad has two DEF slots, so once a
   participant has filled both they are ineligible for any further DEF
   round and cannot bid. */

// GK + 5 outfield. Slot order here is also the pitch coordinate order
// in SIXV6_PITCH_COORDS below - keep the two in step.
const SIXV6_FORMATIONS = {
  '2-1-2': [
    {code:'GK',  label:'Goalkeeper'},
    {code:'DEF', label:'Defender'},
    {code:'DEF', label:'Defender'},
    {code:'MID', label:'Midfielder'},
    {code:'FWD', label:'Forward'},
    {code:'FWD', label:'Forward'},
  ],
  '2-2-1': [
    {code:'GK',  label:'Goalkeeper'},
    {code:'DEF', label:'Defender'},
    {code:'DEF', label:'Defender'},
    {code:'MID', label:'Midfielder'},
    {code:'MID', label:'Midfielder'},
    {code:'FWD', label:'Forward'},
  ],
  '1-2-2': [
    {code:'GK',  label:'Goalkeeper'},
    {code:'DEF', label:'Defender'},
    {code:'MID', label:'Midfielder'},
    {code:'MID', label:'Midfielder'},
    {code:'FWD', label:'Forward'},
    {code:'FWD', label:'Forward'},
  ],
};

// The four broad categories. Every database position folds into exactly
// one of these, which is what makes each 6v6 slot draw from a far deeper
// pool than Classic's role-specific slots.
const SIXV6_POSITION_MAP = {
  'GK':  ['GK'],
  'DEF': ['CB', 'RB', 'LB', 'RWB', 'LWB'],
  'MID': ['CM', 'CDM', 'CAM', 'RM', 'LM'],
  'FWD': ['ST', 'CF', 'RW', 'LW'],
};

const SIXV6_PITCH_COORDS = {
  '2-1-2': {
    0: {x:50, y:92},                   // GK
    1: {x:28, y:70}, 2: {x:72, y:70},  // DEF
    3: {x:50, y:45},                   // MID
    4: {x:28, y:16}, 5: {x:72, y:16},  // FWD
  },
  '2-2-1': {
    0: {x:50, y:92},                   // GK
    1: {x:28, y:70}, 2: {x:72, y:70},  // DEF
    3: {x:30, y:45}, 4: {x:70, y:45},  // MID
    5: {x:50, y:14},                   // FWD
  },
  '1-2-2': {
    0: {x:50, y:92},                   // GK
    1: {x:50, y:72},                   // DEF
    2: {x:30, y:47}, 3: {x:70, y:47},  // MID
    4: {x:28, y:16}, 5: {x:72, y:16},  // FWD
  },
};

// Only the top slice of each category is used, judged per category so
// goalkeepers aren't crowded out by the far larger outfield groups. GK is
// cut on its own tighter percentage (matching Classic's per-position cut,
// since it really is a single position) rather than the line percentage -
// the three outfield lines (DEF/MID/FWD) each pool several positions
// together, so a looser cut still leaves plenty of depth per line.
const SIXV6_GK_TOP_PERCENT = 0.83;
const SIXV6_LINE_TOP_PERCENT = 0.70;

/* Unlike Classic, this cut is NOT dropped for bigger drafts. Classic's
   "large drafts need the full depth" reasoning is about a 10-participant
   shared-screen game genuinely needing more players than the top slice
   holds - but 6v6 tops out at 6 participants everywhere (AI and online
   both cap it there, see MP_MAX_PLAYERS), and every shipped pool's cut
   slice is still 40-190+ deep per line at that cap, far more than a
   6-player room can ever draft. So there is no depth reason to widen it,
   and every reason not to: this filter is what keeps a thin pool's
   bottom tier out of the draft altogether, at every participant count. */

// Not a pure coin flip: a real talent curve is bottom-heavy (far more
// solid pros than genuine stars), so uniform-random sampling over it
// means the big middle cluster wins almost every draw - the actual cause
// of "most players feel mediocre" on a shallow pool, separate from the
// cut above. Weighting each eligible player by their rating relative to
// the eligible pool's own min/max shifts the odds toward quality while
// RANDOM_BIAS_FLOOR keeps every eligible player reachable - nobody
// becomes impossible, "any rating, any round" stays true, it is just no
// longer a fair coin. Read generically off the active mode by
// weightedRandomPick() in js/players.js, so a future 'random'-selection
// mode can set its own numbers (or none, for true uniform) without this
// file being touched.
const SIXV6_RANDOM_BIAS_EXPONENT = 2.2;
const SIXV6_RANDOM_BIAS_FLOOR = 0.12;

const MODE_SIXV6 = {
  id: 'sixv6',
  name: '6 v 6 Futsal',
  shortName: '6v6',
  chipLabel: '6 v 6',

  /* ---- How the mode presents itself ---- (see MODE_CLASSIC's note)
     A different accent to Classic's house amber, because during a draft
     the mode is otherwise invisible - the auction screen looked
     identical in both, and the rules it plays by are not. */
  accent: '#5CA8FF',
  tagline: 'Short, cheap and unpredictable. Six a side, futsal rules.',
  bullets: [
    '6 players · 3 small-sided shapes · 100M budget',
    'Bids move in 1M steps, and EVERY player opens at 1M - the room decides what they are worth',
    'Completely random order: a 94-rated superstar can turn up in the last round',
    'Slots are interchangeable - any forward fills either forward spot',
    'Played out as a high-scoring futsal match, not a football one',
  ],

  formations: SIXV6_FORMATIONS,
  defaultFormation: '2-1-2',
  positionMap: SIXV6_POSITION_MAP,
  pitchCoords: SIXV6_PITCH_COORDS,

  budget: 100,
  minBid: 1,
  bidStep: 1,

  selection: 'random',
  flashPicks: false,          // pointless when every pick is already random
  randomBiasExponent: SIXV6_RANDOM_BIAS_EXPONENT,
  randomBiasFloor: SIXV6_RANDOM_BIAS_FLOOR,

  /* The two FWD slots of a 2-1-2 are not a left and a right one - they
     are just "two forwards", so there is no side to label and no reason
     to refuse a bid because the one on offer happens to be the slot you
     already filled. (Nothing is owned per slot any more anyway: see
     participantCanTake() in js/lineup.js.) */
  sidedSlots: false,

  /* Rerolling is the whole room's call here, not just the call of
     whoever still has a slot open for this category - see
     modeRerollElectorate(). */
  rerollElectorate: 'all',

  startPrice: () => 1,

  /* Match simulation: 6-a-side on a small pitch is futsal, not football.
     Far more possessions, far less space to defend, and keepers face
     shots from close range all game - real futsal routinely finishes
     4-3 or 6-5 rather than 1-0. So the base rate is roughly 3x the
     11-a-side one and the clamp is lifted to match, over a 40-minute
     clock (2 x 20) instead of 90. */
  sim: {
    baseXG: 3.9,
    maxXG: 11,
    fullTime: 41,
    extraTimeTo: 51,      // futsal extra time is 2 x 5
    extraTimeTempo: 0.22,
    /* No dismissals here, deliberately. A red card takes a SIXTH of this
       squad off the pitch rather than an eleventh, and it does it in a
       40-minute match instead of a 90-minute one - the same event that
       makes a Classic match tense would simply decide a 6v6 one, in a
       mode built to be short and swingy rather than punishing. Bookings
       still happen; they just stay flavour. */
    redCards: false,
    avgShotXg: 0.16,      // futsal shots come from far closer in
    /* Gentler than Classic's 0.34. The same attack/defence gap converts
       to wins far more reliably at four goals a side than at one and a
       bit, because a higher scoring rate drowns less of the edge in
       Poisson noise - measured, attack was worth twice what it is worth
       in Classic and outweighed the other three lines. This pulls it back
       without making 6v6 any less high-scoring. */
    xgSensitivity: 0.26,
  },

  // Returns the fraction of each category to keep. Unlike Classic, this
  // is unconditional - see the note above SIXV6_RANDOM_BIAS_EXPONENT for
  // why 6v6 never widens it back out. position lets GK use its own
  // (tighter) percentage instead of the outfield lines' one.
  categoryTopPercent: (poolId, numParticipants, position) => {
    return position === 'GK' ? SIXV6_GK_TOP_PERCENT : SIXV6_LINE_TOP_PERCENT;
  },

  noteHTML: () => {
    const gk = Math.round(SIXV6_GK_TOP_PERCENT * 100);
    const line = Math.round(SIXV6_LINE_TOP_PERCENT * 100);
    return `Positions auctioned in random order. Every player starts at 1M - ` +
      `no starting price, no phase progression, any rating can appear in any round, ` +
      `higher ratings just more likely than lower ones. Only the top ${line}% ` +
      `of each outfield line and the top ${gk}% of goalkeepers is ever drafted. Budget ` +
      `restrictions: must keep ${MIN_PER_POSITION}M per remaining position.`;
  },
};

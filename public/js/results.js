/* ================= RESULTS ================= */

// Average rating of a participant's squad; 0 for an empty squad so it
// sorts last rather than producing NaN. Drives the final ranking.
function squadAvgRating(participant){
  const squad = participant.squad || [];
  if(!squad.length) return 0;
  return squad.reduce((sum, pl) => sum + pl.rating, 0) / squad.length;
}

function endAuction(){
  aiStopThinking();
  unlockGameplayZoom();
  haptics.matchFinished();
  document.getElementById('auctionScreen').style.display = 'none';
  document.getElementById('resultsScreen').style.display = 'block';

  // Which game these squads came out of. The results screen is the one
  // people screenshot and send to each other, and a 6v6 table of six
  // players was indistinguishable from an eleven-a-side draft that ended
  // early. applyModeChrome() keeps the accent right if this screen is
  // reached without passing back through setup (e.g. Play Again online).
  applyModeChrome();
  document.getElementById('resultsMode').innerHTML =
    `<b>${esc(activeMode().name)}</b> · ${esc(selectedFormation)} · ${fmt(BUDGET)} budget`;

  // The bottom of the funnel: paired with draft_started, this is the
  // completion rate - the number that says whether people who commit to
  // a draft actually see it through.
  track('draft_completed', trackDraftContext({
    mode: currentRoomCode ? 'online' : (AI_MODE ? 'vs_ai' : 'shared_screen'),
    participants: state.participants.length,
    squad_size: FORMATION.length,
  }));

  // Online drafts get "Back to Home" / "Play Another Auction" instead of
  // offline's single restart button (which would incorrectly kick
  // everyone into a fresh offline/shared-screen draft).
  document.getElementById('offlineResultsActions').style.display = currentRoomCode ? 'none' : 'flex';
  document.getElementById('mpResultsActions').style.display = currentRoomCode ? 'flex' : 'none';

  // Rank by squad quality (average player rating), not by money spent -
  // outspending everyone isn't an achievement, assembling the better
  // eleven is. Ties break toward whoever built it more cheaply.
  const ranked = [...state.participants].sort((a, b) => {
    const byRating = squadAvgRating(b) - squadAvgRating(a);
    if (byRating !== 0) return byRating;
    return (BUDGET - a.budget) - (BUDGET - b.budget);
  });

  // Calculate global statistics
  displayGlobalStats(ranked);

  const wrap = document.getElementById('squadsWrap');
  wrap.innerHTML = '';

  ranked.forEach((p,i) => {
    const spent = BUDGET - p.budget;
    const card = document.createElement('div');
    card.className = 'squad-card';

    // Calculate participant statistics
    const stats = calculateParticipantStats(p);

    // Always shown on the results screen, even when "Show ratings" is
    // off: that setting hides ratings DURING bidding (so the auction is
    // judged on football knowledge), but the final table is now ranked
    // by this number, so it has to be visible for the order to make
    // any sense.
    let avgRatingHTML = '';
    if(p.squad.length > 0){
      avgRatingHTML = `<div class="squad-avg">${esc(t('results.avgRating', {rating: squadAvgRating(p).toFixed(1)}))}</div>`;
    }

    // Build formation visualization
    const formationHTML = buildFormationDisplay(p.squad);

    /* Collapsed, and two entries shorter than it was.

       This was six bordered boxes per participant, sitting between the
       squad's name and its pitch - so with four participants you scrolled
       past twenty-four stat cards to see four teams. Two of the six
       (Total Spent, Budget Left) were also a straight duplicate of the
       "Spent X · Left Y" line already in the header immediately above
       them, so they are simply gone rather than hidden. */
    const statsHTML = `
      <details class="stats-disclosure squad-stats">
        <summary>
          <span class="sd-title">${esc(t('results.squadBreakdown'))}</span>
          <span class="sd-hint"></span>
        </summary>
        <div class="stat-rows">
          <div class="stat-row"><span class="k">${esc(t('results.avgPrice'))}</span><span class="v">${fmt(stats.avgPrice)}</span></div>
          <div class="stat-row"><span class="k">${esc(t('results.mostExpensive'))}</span><span class="v">${esc(stats.mostExpensive.name)} · ${fmt(stats.mostExpensive.price)}</span></div>
          <div class="stat-row"><span class="k">${esc(t('results.cheapest'))}</span><span class="v">${esc(stats.cheapest.name)} · ${fmt(stats.cheapest.price)}</span></div>
          ${SHOW_RATINGS ? `<div class="stat-row"><span class="k">${esc(t('results.highestRated'))}</span><span class="v">${esc(stats.highestRated.name)} · ${esc(stats.highestRated.rating)}</span></div>` : ''}
        </div>
      </details>
    `;

    card.innerHTML = `
      <div class="squad-head">
        <h3><span class="rank">#${i+1}</span>${esc(p.name)}</h3>
        <span class="spend">${esc(t('results.spentLeft', {spent: fmt(spent), left: fmt(p.budget)}))}</span>
      </div>
      ${avgRatingHTML}
      ${statsHTML}
      ${formationHTML}
      <button class="squad-share-btn" data-share-pid="${esc(String(p.id))}">
        ${esc(t('sim.shareSquad'))}
      </button>
    `;
    wrap.appendChild(card);

    /* One button per squad rather than one for "your" squad: offline this is
       a shared screen and every eleven on it belongs to somebody in the room,
       and online each device only renders its own. Either way the card the
       button sits on is the card it shares. */
    const shareBtn = card.querySelector('[data-share-pid]');
    if(shareBtn) shareBtn.onclick = () => simShareSquadCard(shareBtn.dataset.sharePid, shareBtn);

    // Wire each rendered pitch card up to its real player object so tapping
    // it (mobile) opens showPlayerInfoPanel() with the full details that the
    // card itself hides at that width - see .pitch-player CSS.
    card.querySelectorAll('.pitch-player[data-pos-idx]').forEach(el => {
      const posIdx = Number(el.dataset.posIdx);
      const player = p.squad.find(pl => pl.posIdx === posIdx);
      if(player) el.onclick = () => showPlayerInfoPanel(player, posIdx);
    });

    // Shorten any name that doesn't fit its card. Has to run after the
    // card is in the document - it measures real layout (see fitPitchName).
    fitAllPitchNames(card);
  });

  // Post-draft match simulation panel (knockout / mini league).
  setupSimulationSection();
}

function calculateParticipantStats(participant){
  const squad = participant.squad;
  const totalSpent = BUDGET - participant.budget;

  // A squad can be empty if the draft ended early (the phase safety
  // valve, or the too-few-players reset). Without this guard every
  // squad[0] below is undefined and the whole results screen throws.
  if(!squad.length){
    const none = {name: '—', price: 0, rating: 0};
    return {avgPrice: 0, mostExpensive: none, cheapest: none, highestRated: none};
  }

  const avgPrice = Math.round(totalSpent / squad.length);

  let mostExpensive = squad[0];
  let cheapest = squad[0];
  let highestRated = squad[0];

  squad.forEach(player => {
    if(player.price > mostExpensive.price) mostExpensive = player;
    if(player.price < cheapest.price) cheapest = player;
    if(player.rating > highestRated.rating) highestRated = player;
  });

  return {
    avgPrice,
    mostExpensive: {name: mostExpensive.name.split(' ').pop(), price: mostExpensive.price},
    cheapest: {name: cheapest.name.split(' ').pop(), price: cheapest.price},
    highestRated: {name: highestRated.name.split(' ').pop(), rating: highestRated.rating}
  };
}

function displayGlobalStats(participants){
  const allPlayers = participants.flatMap(p => p.squad);
  const totalSpent = participants.reduce((sum, p) => sum + (BUDGET - p.budget), 0);
  const avgTransferFee = allPlayers.length ? Math.round(totalSpent / allPlayers.length) : 0;

  // Same guard as calculateParticipantStats: nobody drafted anything.
  let mostExpensivePlayer = allPlayers[0] || {name: '—', price: 0};
  allPlayers.forEach(player => {
    if(player.price > mostExpensivePlayer.price) mostExpensivePlayer = player;
  });

  // Now that rerolls are a single pool for the whole draft (not reset
  // every round), "used" is simply initial minus what's left.
  const totalRerollsUsed = Math.max(0, (state.rerollsInitial || 0) - (state.rerollsRemaining || 0));

  // Best Value Pick: biggest gap between what a player of that rating
  // "normally" costs (expectedPriceForRating) and what they actually
  // sold for - a genuine bargain, not just whoever happened to be cheap
  // (a weak last-resort player at the 20M floor isn't a "value pick",
  // they're just cheap because they're weak).
  // Biggest Gamble: whichever single player consumed the largest SHARE
  // of a fixed 1000M budget - a real risk metric, not just "spent the
  // most money" (which just rewards a bigger overall budget).
  let bestValue = null;
  let biggestGamble = null;
  participants.forEach(participant => {
    (participant.squad || []).forEach(player => {
      const bargain = expectedPriceForRating(player.rating) - player.price;
      if(!bestValue || bargain > bestValue.bargain){
        bestValue = {name: player.name, ownerName: participant.name, bargain};
      }
      const sharePct = player.price / BUDGET;
      if(!biggestGamble || sharePct > biggestGamble.sharePct){
        biggestGamble = {name: player.name, ownerName: participant.name, price: player.price, sharePct};
      }
    });
  });

  // Compact label/value rows rather than a grid of bordered boxes -
  // these live behind a disclosure now (see index.html), so they are read
  // as a short list when opened rather than laid out as a dashboard.
  // Participant names are user input, hence esc() on the owner fields.
  const statsGrid = document.getElementById('globalStatsGrid');
  statsGrid.innerHTML = `
    <div class="stat-row"><span class="k">${esc(t('results.mostExpensivePlayer'))}</span><span class="v">${esc(mostExpensivePlayer.name)} · ${fmt(mostExpensivePlayer.price)}</span></div>
    <div class="stat-row"><span class="k">${esc(t('results.avgFee'))}</span><span class="v">${fmt(avgTransferFee)}</span></div>
    <div class="stat-row"><span class="k">${esc(t('results.totalSpent'))}</span><span class="v">${fmt(totalSpent)}</span></div>
    ${bestValue ? `
    <div class="stat-row"><span class="k">${esc(t('results.bestValue'))}</span><span class="v">${esc(bestValue.name)} <span class="sub">${esc(bestValue.ownerName)}${bestValue.bargain > 0 ? ` · ${esc(t('results.saved', {amount: fmt(Math.round(bestValue.bargain))}))}` : ''}</span></span></div>
    ` : ''}
    ${biggestGamble ? `
    <div class="stat-row"><span class="k">${esc(t('results.biggestGamble'))}</span><span class="v">${esc(biggestGamble.name)} <span class="sub">${esc(biggestGamble.ownerName)} · ${esc(t('results.pctBudget', {pct: Math.round(biggestGamble.sharePct * 100)}))}</span></span></div>
    ` : ''}
    ${(REROLLS_MODE !== 'disabled' && !AI_MODE) ? `
    <div class="stat-row"><span class="k">${esc(t('results.rerollsUsed'))}</span><span class="v">${totalRerollsUsed}</span></div>
    ` : ''}
  `;
}

/* ================= MATCH SIMULATION =================
   Runs after the draft: pit the squads people actually built against
   each other, as a knockout bracket or a mini league.

   The model is the standard football-analytics one, kept deliberately
   small: each squad is reduced to attack / midfield / defence / keeper
   strengths (from position-weighted player ratings), those produce an
   expected-goals number per side, and actual goals are DRAWN from a
   Poisson distribution around it. That draw is the whole point - a
   flat "higher average rating wins" comparison gives the same winner
   every time and makes the button worth pressing exactly once, while
   Poisson reproduces real football: the better squad wins most of the
   time, but not always, and the scorelines vary.

   Everything is driven by a seeded PRNG, which is what makes the
   online mode work: the host broadcasts only {mode, seed} and every
   client re-runs the identical simulation locally. No large payload,
   and no way for two devices to disagree about who won. */

// mulberry32: small, fast, well-distributed seeded PRNG. Any seeded
// generator works here; the requirement is only that identical seeds
// give identical sequences on every device, which Math.random cannot.
function makeRng(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How much each position contributes to each phase of play. A squad's
// attack strength is the rating-weighted average over the players who
// actually attack, so a stacked front three genuinely creates more
// chances - and a squad that spent everything on strikers is properly
// punished at the back. Keeper is tracked separately because
// shot-stopping is not the same job as defending.
/* Tuned against the responsibilities each line is meant to own:

     Defenders   prevent chances first, recover the ball, contribute a
                 little to keeping it, and score very rarely.
     Midfielders keep and control the ball first, create strongly, chip in
                 with goals, and do a real share of the defensive work.
     Forwards    score first, create strongly, help keep the ball a
                 little, and defend only marginally.
     Keepers     do exactly one job, and simDefTotal decides how much
                 that job is worth.

   "Very small" is deliberately not zero for defenders attacking and
   forwards defending: a centre-back really does head one in from a corner
   now and then, and a striker really does win the ball back occasionally.
   Zero makes those things impossible rather than rare, which is a
   different claim about football. */
const SIM_POSITION_WEIGHTS = {
  GK:  {att:0.00, mid:0.00, def:0.00, gk:1.00},
  CB:  {att:0.05, mid:0.12, def:1.00, gk:0.00},
  LB:  {att:0.15, mid:0.32, def:0.80, gk:0.00},
  RB:  {att:0.15, mid:0.32, def:0.80, gk:0.00},
  LWB: {att:0.30, mid:0.48, def:0.60, gk:0.00},
  RWB: {att:0.30, mid:0.48, def:0.60, gk:0.00},
  CDM: {att:0.12, mid:0.72, def:0.62, gk:0.00},
  CM:  {att:0.30, mid:1.00, def:0.38, gk:0.00},
  LM:  {att:0.42, mid:0.72, def:0.28, gk:0.00},
  RM:  {att:0.42, mid:0.72, def:0.28, gk:0.00},
  CAM: {att:0.70, mid:0.72, def:0.08, gk:0.00},
  LW:  {att:0.85, mid:0.32, def:0.06, gk:0.00},
  RW:  {att:0.85, mid:0.32, def:0.06, gk:0.00},
  // A centre-forward leads the line like a striker but drops in to link
  // play far more, so: nearly all of the goal threat, noticeably more of
  // the ball. Previously absent from this table entirely, which quietly
  // simulated every CF in the database as a generic midfielder.
  CF:  {att:0.92, mid:0.30, def:0.05, gk:0.00},
  ST:  {att:1.00, mid:0.18, def:0.04, gk:0.00}
};

/* 6v6's slot codes are BROAD LINES, not positions - a 'FWD' slot is
   filled by a striker, a centre-forward or a winger, and until now none
   of them matched an entry above, so every outfield player in 6v6 fell
   through to SIM_DEFAULT_WEIGHT. A centre-back and a striker of equal
   rating contributed identically to attack, defence and possession, and
   were equally likely to score - which made a 6v6 squad's shape
   meaningless to the match engine.

   These are the family averages of each line's members, used ONLY as a
   fallback when a player's real position is unknown (an online room
   mid-draft during a deploy, or the synthetic last-resort player). When
   the real position IS known, it is used at full strength - see
   simWeightsFor: a striker stays a striker and a winger stays a winger,
   even though both fill the same 'FWD' slot. */
const SIM_LINE_WEIGHTS = {
  DEF: {att:0.18, mid:0.34, def:0.78, gk:0.00},
  MID: {att:0.38, mid:0.78, def:0.33, gk:0.00},
  FWD: {att:0.90, mid:0.28, def:0.05, gk:0.00}
};

const SIM_DEFAULT_WEIGHT = {att:0.35, mid:0.45, def:0.35, gk:0.00};

/* How much of a player out of position is judged on what they ARE rather
   than on the slot they were bought for. Half: a CM bought to play CDM
   does a bit of both jobs and neither perfectly, so they sit exactly
   between the two profiles instead of magically becoming a natural
   holding midfielder the moment the hammer falls. */
const SIM_OUT_OF_POSITION_BLEND = 0.5;

function simBlendWeights(slotW, baseW, share){
  const mix = (a, b) => a * (1 - share) + b * share;
  return {
    att: mix(slotW.att, baseW.att),
    mid: mix(slotW.mid, baseW.mid),
    def: mix(slotW.def, baseW.def),
    gk:  mix(slotW.gk,  baseW.gk)
  };
}

// Sensible mid-table strength for a line nobody drafted for (possible
// when a draft ends early). Without this an empty line divides by zero
// and every downstream number becomes NaN.
const SIM_FALLBACK_STRENGTH = 62;

// The slot a player was bought to fill. Note this is NOT their real
// position: buildRoundPlayer() overwrites `pos` with the slot code, which
// is exactly why `basePos` exists alongside it.
function simPositionCode(player){
  const slot = FORMATION[player.posIdx];
  return (slot && slot.code) || player.pos || 'CM';
}

/* What a player contributes to each line, from two facts: the slot they
   were bought for, and the position they actually play.

   Three cases, in the order they are tested:

     1. The slot is a broad 6v6 line (DEF/MID/FWD - no entry in
        SIM_POSITION_WEIGHTS). The line says only which third of the pitch
        they occupy, which their real position already tells us more
        precisely, so the real position wins outright. This is what keeps
        a striker and a winger different players in 6v6 despite sharing a
        'FWD' slot.

     2. A specific slot, real position unknown. Only possible for a player
        drafted before basePos existed (an online room mid-draft across a
        deploy), so fall back to the old slot-only behaviour rather than
        guessing.

     3. A specific slot AND a known real position - the normal Classic
        case. Blend them, so a CM in a CDM slot is half of each. When the
        two agree, which is most of the time, the blend is a no-op. */
function simWeightsFor(player){
  const slotCode = simPositionCode(player);
  const slotW = SIM_POSITION_WEIGHTS[slotCode];
  const baseW = player && player.basePos ? SIM_POSITION_WEIGHTS[player.basePos] : null;

  if(!slotW) return baseW || SIM_LINE_WEIGHTS[slotCode] || SIM_DEFAULT_WEIGHT;
  if(!baseW) return slotW;
  return simBlendWeights(slotW, baseW, SIM_OUT_OF_POSITION_BLEND);
}

/* How much of "can this team stop you scoring" belongs to the back line
   and how much to the keeper. Defined once and used everywhere a defTotal
   is built (squad strength, and the reduced strength after a dismissal) -
   it was previously written out by hand in each place, which is exactly
   how the two quietly come to mean different things.

   A keeper is 30% of it. Shot-stopping is the last thing between a chance
   and a goal, and at the previous 22% a six-point upgrade in goal barely
   registered in the results - the weakest line in the game by some way,
   for the position most likely to be described as match-winning. */
const SIM_GK_SHARE = 0.30;
function simDefTotal(def, gk){
  return def * (1 - SIM_GK_SHARE) + gk * SIM_GK_SHARE;
}

// Reduce a drafted squad to the four numbers the match model needs.
function computeSquadStrength(participant){
  const squad = participant.squad || [];
  const acc = {att:0, mid:0, def:0, gk:0};
  const wsum = {att:0, mid:0, def:0, gk:0};

  squad.forEach(player => {
    const w = simWeightsFor(player);
    ['att','mid','def','gk'].forEach(line => {
      if(w[line] > 0){
        acc[line] += player.rating * w[line];
        wsum[line] += w[line];
      }
    });
  });

  const line = key => wsum[key] > 0 ? acc[key] / wsum[key] : SIM_FALLBACK_STRENGTH;
  const att = line('att');
  const mid = line('mid');
  const def = line('def');
  const gk = line('gk');

  return {
    att, mid, def, gk,
    // Defence as the match model sees it: the back line does most of
    // the work, but a great keeper meaningfully rescues a weak one
    // (and a poor keeper undermines a strong back line).
    defTotal: simDefTotal(def, gk),
    overall: squadAvgRating(participant)
  };
}

// Knuth's algorithm. Cost is O(lambda), so it stays cheap across both
// the ~0.5-3.5 an 11-a-side match produces and the higher futsal rates
// 6v6 uses; xG is clamped per mode, so lambda can never run away.
function poissonSample(lambda, rng){
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

/* How hard an attack/defence rating gap bites, per 10 rating points.
   Overridable as mode config (sim.xgSensitivity) rather than being one
   global number: the same gap converts to wins far more reliably in a
   4-goal futsal match than in a 1.3-goal football one, because the higher
   scoring rate drowns less of the edge in Poisson noise. 6v6 therefore
   runs a gentler figure so attack does not simply outweigh the other
   three lines there.

   Declared ABOVE SIM_DEFAULTS because that object reads it. */
const SIM_XG_SENSITIVITY = 0.34;

// Scoring rates come from the active mode: 11-a-side football for
// Classic, futsal for 6v6 (see each mode's `sim` block). Falls back to
// the long-standing football numbers for any mode that omits it.
const SIM_DEFAULTS = { baseXG: 1.32, maxXG: 4.2, fullTime: 91, extraTimeTo: 121,
                       extraTimeTempo: 0.28, redCards: true, avgShotXg: 0.11,
                       xgSensitivity: SIM_XG_SENSITIVITY };
function simConfig(){
  return Object.assign({}, SIM_DEFAULTS, activeMode().sim || {});
}

/* `a`'s share of the ball against `b`, 0-1. Extracted so the live
   possession readout and the xG model read the SAME number rather than
   each deriving its own - the stat on screen is literally the term that
   shaped the scoreline, not a decorative second calculation.

   Driven by the DIFFERENCE between the two midfields rather than their
   ratio. A ratio compresses badly this far up the scale: two midfields
   six rating points apart came out at 51.8% / 48.2%, which is not what
   "controlled the game" looks like on a stats panel, and it left midfield
   the weakest line in the game by a distance despite possession being its
   whole job. The difference gives the swing real football actually shows.
   Clamped, because even a total mismatch never means the other side
   simply never touches the ball. */
const SIM_POSSESSION_SENSITIVITY = 0.012;   // share of the ball per rating point
const SIM_POSSESSION_XG_EXPONENT = 0.55;    // how hard that share converts to chances
function simPossessionShare(a, b){
  const share = 0.5 + (a.mid - b.mid) * SIM_POSSESSION_SENSITIVITY;
  return Math.min(0.78, Math.max(0.22, share));
}

/* Home advantage, as a multiplier on expected goals. Deliberately small:
   real home advantage is worth a few percent of scoring rate, not a
   different team, and this sits on top of squad quality rather than
   competing with it. Applied in mirror (the home side up, the away side
   down by the same amount) so a match's total goal expectancy is
   unchanged and only its BALANCE shifts - otherwise every fixture with a
   home team would quietly become higher-scoring than a neutral one.

   Neutral matches (finals) pass no side at all and get exactly 1.0. */
const SIM_HOME_XG_BONUS = 0.06;
function simHomeFactor(side, homeSide){
  if(!homeSide) return 1;
  return side === homeSide ? 1 + SIM_HOME_XG_BONUS : 1 - SIM_HOME_XG_BONUS;
}

// Expected goals for `a` against `b`, before any per-match randomness.
// `homeFactor` is the home/away multiplier for whichever side `a` is.
function expectedGoals(a, b, tempo, homeFactor){
  const cfg = simConfig();
  const edge = (a.att - b.defTotal) / 10;
  // Midfield decides how much of the ball you get, and therefore how
  // many chances you get to convert - a real but secondary effect, so
  // it scales chance VOLUME rather than chance quality.
  /* Possession scales chance VOLUME, and deliberately scales it gently.
     Having the ball more is a real advantage, but it is not a linear
     licence to score - the exponent is what stops a strong all-round
     squad compounding its midfield edge on top of its attacking one and
     turning the whole simulation into a formality. Measured: at 0.9 the
     favourite in an 88-v-78 tie won 72% of the time and upsets fell to
     10%; at 0.55 possession still swings the stats panel visibly while
     leaving the underdog a real chance. */
  const possession = simPossessionShare(a, b);
  const possessionFactor = Math.pow(possession / 0.5, SIM_POSSESSION_XG_EXPONENT);
  const xg = cfg.baseXG * Math.exp(cfg.xgSensitivity * edge)
             * possessionFactor * (tempo || 1) * (homeFactor || 1);
  // Clamp: keeps Poisson cheap and stops a freak mismatch producing
  // a 14-0 that reads as broken rather than dominant.
  return Math.min(cfg.maxXG, Math.max(0.18, xg));
}

/* ---------- Discipline ----------

   Cards are drawn BEFORE any goal is decided, because a dismissal changes
   the strengths the goal model then runs on - simulateMatch() splits
   regulation into segments at each red card and prices each segment at
   the strengths in force during it. Everything here comes off the seeded
   rng, so every client draws the same cards and therefore the same score.

   Red cards are mode-gated (`sim.redCards`), not hardcoded: see the note
   in js/modes/sixv6.js for why futsal only ever produces bookings. */

/* What one dismissal costs, in rating points, for the rest of the match.
   Subtractive rather than a multiplier because the whole model reads
   rating DIFFERENCES - at SIM_XG_SENSITIVITY this makes ten men create
   roughly a quarter fewer chances and concede noticeably more, which is
   a real handicap without making the result a formality. */
const SIM_RED_PENALTY = {att: 8, mid: 6, def: 4};

const SIM_YELLOW_BASE = 2.4;   // mean bookings per match (Poisson)
const SIM_RED_CHANCE = 0.11;   // share of matches with a dismissal

function simStrengthAfterReds(strength, reds){
  if(!reds) return strength;
  const att = strength.att - SIM_RED_PENALTY.att * reds;
  const mid = strength.mid - SIM_RED_PENALTY.mid * reds;
  const def = strength.def - SIM_RED_PENALTY.def * reds;
  return {
    att, mid, def, gk: strength.gk,
    // Rebuilt through the same simDefTotal() computeSquadStrength() uses,
    // so going down to ten never quietly changes what defTotal MEANS.
    defTotal: simDefTotal(def, strength.gk),
    overall: strength.overall
  };
}

function simBuildCards(teamA, teamB, rng, cfg){
  const cards = [];
  const last = cfg.fullTime - 1;
  const book = (side, kind, minute) => {
    const team = side === 'a' ? teamA : teamB;
    // Fouls come mostly from the people doing the chasing, so bookings
    // land on defenders and midfielders far more often than forwards.
    const player = simPickByRole(team, rng() < 0.62 ? 'def' : 'mid', rng);
    cards.push({
      minute, side, kind,
      player: simLastName(player),
      ref: player ? simPlayerRef(team, player) : null
    });
  };

  const yellows = poissonSample(SIM_YELLOW_BASE, rng);
  for(let i = 0; i < yellows; i++){
    book(rng() < 0.5 ? 'a' : 'b', 'yellow', 1 + Math.floor(rng() * (last - 1)));
  }

  if(cfg.redCards && rng() < SIM_RED_CHANCE){
    // Never in the opening minutes: a 3rd-minute dismissal turns the rest
    // of the match into a non-event, which is exactly the "one bad roll
    // decided everything" feeling this is supposed to avoid.
    book(rng() < 0.5 ? 'a' : 'b', 'red', Math.round(last * (0.22 + rng() * 0.68)));
  }

  cards.sort((x, y) => x.minute - y.minute);
  return cards;
}

/* ---------- How goals arrived ----------

   Purely a LABEL on a goal the Poisson model has already decided - it
   never creates, removes or moves one. That is the whole point: the feed
   can say "corner headed in" or "penalty converted" and the scoreline
   still agrees with the simulation, because the goal existed first and
   the description was attached second. */
const SIM_GOAL_ORIGINS = [
  {id: 'openPlay', w: 0.50},
  {id: 'counter',  w: 0.11},
  {id: 'corner',   w: 0.14},
  {id: 'header',   w: 0.08},
  {id: 'freeKick', w: 0.08},
  {id: 'penalty',  w: 0.09},
];

function simPickGoalOrigin(rng){
  const total = SIM_GOAL_ORIGINS.reduce((s, o) => s + o.w, 0);
  let roll = rng() * total;
  for(const o of SIM_GOAL_ORIGINS){
    roll -= o.w;
    if(roll <= 0) return o.id;
  }
  return 'openPlay';
}

/* ---------- Volume statistics ----------

   Shots, shots on target and corners are DERIVED from the xG the model
   already produced (xG / typical chance quality), not invented next to
   it - so a team that created 2.1 xG shows a shot count that could
   plausibly have produced 2.1 xG. Bounded below by goals scored, because
   "3 goals from 2 shots on target" is the kind of contradiction that
   makes the whole panel look made up. */
function simShotProfile(xg, goals, corners0, rng, cfg){
  const perShot = cfg.avgShotXg || 0.11;
  const shots = Math.max(goals, 1, Math.round(xg / perShot + (rng() - 0.5) * 4));
  const onTarget = Math.min(shots, Math.max(goals, 1, Math.round(shots * (0.31 + rng() * 0.15))));
  // Corners scale with attacking volume, and can never be fewer than the
  // goals the feed will attribute to a corner.
  const corners = Math.max(corners0, Math.round(shots * (0.32 + rng() * 0.34)));
  return {shots, onTarget, corners};
}

/* Per-shot timeline, so the live panel's xG can CLIMB during playback
   instead of sitting on its final value from the first whistle.

   Each shot carries a share of its team's already-computed match xG, and
   those shares sum back to exactly that total - the number ticking up on
   screen lands on the same figure the model used to decide the score.
   Goals are pinned to the minutes they actually happened on. */
function simBuildShotTimeline(result, rng){
  const shots = [];
  [['a', result.a, result.stats.a, result.xgA], ['b', result.b, result.stats.b, result.xgB]]
    .forEach(([side, team, st, xgTotal]) => {
      const goalMinutes = result.events.filter(e => e.side === side).map(e => e.minute);
      const entries = [];
      goalMinutes.forEach(minute => entries.push({minute, side, isGoal: true, onTarget: true}));

      const lastMinute = result.extraTime ? simConfig().extraTimeTo - 1 : simConfig().fullTime - 1;
      const others = Math.max(0, st.shots - goalMinutes.length);
      const onTargetLeft = Math.max(0, st.onTarget - goalMinutes.length);
      for(let i = 0; i < others; i++){
        entries.push({
          minute: 1 + Math.floor(rng() * (lastMinute - 1)),
          side, isGoal: false, onTarget: i < onTargetLeft
        });
      }

      // Chance quality: a goal was usually a better chance than a blocked
      // effort from distance, so the xG total is split unevenly rather
      // than flat across every shot.
      const weightOf = e => e.isGoal ? 2.4 : (e.onTarget ? 1.25 : 0.65);
      const wsum = entries.reduce((s, e) => s + weightOf(e), 0) || 1;
      entries.forEach(e => { e.xg = xgTotal * (weightOf(e) / wsum); });
      shots.push(...entries);
    });

  shots.sort((x, y) => x.minute - y.minute);
  return shots;
}

/* Possession over time. Built from the same simPossessionShare() the xG
   model uses, evaluated per SEGMENT - so when a team goes down to ten
   their share of the ball genuinely drops for the rest of the match
   rather than the readout staying flat and contradicting the red card
   everyone just watched. Seeded jitter keeps it from looking synthetic. */
function simBuildPossessionTimeline(segments, rng, cfg){
  const blocks = [];
  const BLOCK = Math.max(3, Math.round(cfg.fullTime / 12));
  segments.forEach(seg => {
    const share = simPossessionShare(seg.strA, seg.strB);
    for(let m = seg.from; m < seg.to; m += BLOCK){
      const jitter = (rng() - 0.5) * 0.10;
      blocks.push({
        minute: Math.min(seg.to, m + BLOCK),
        share: Math.min(0.85, Math.max(0.15, share + jitter)),
        weight: Math.min(BLOCK, seg.to - m)
      });
    }
  });
  return blocks;
}

/* The possession figure as of `minute` - a running weighted average of
   every block played so far, which is exactly how a broadcast builds it.
   Called both during playback (live) and at full time (final stat), so
   the two can never disagree. */
function simPossessionAt(blocks, minute){
  let num = 0, den = 0;
  for(const b of blocks){
    if(b.minute - b.weight >= minute) break;
    const played = Math.min(b.weight, Math.max(0, minute - (b.minute - b.weight)));
    num += b.share * played;
    den += played;
  }
  if(den <= 0) return 0.5;
  return num / den;
}

// Who scored. Weighted by attacking share x rating, so strikers score
// most, wingers and attacking mids chip in, and a centre-back popping
// up occasionally is possible but rare - as in real football.
function pickScorer(participant, rng){
  const squad = participant.squad || [];
  const candidates = squad.map(player => {
    const w = simWeightsFor(player);
    // Keepers are excluded outright - a keeper scoring is a
    // once-a-decade event, and at any nonzero weight it turns up often
    // enough across a bracket to read as a bug. Everyone else gets a
    // 0.02 floor, which is what lets a centre-back head one in from a
    // corner instead of making it impossible.
    if(w.gk > 0) return {player, weight: 0};
    const weight = Math.max(0.02, w.att) * Math.pow(player.rating / 100, 2);
    return {player, weight};
  }).filter(c => c.weight > 0);

  if(!candidates.length) return null;
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let roll = rng() * total;
  for(const c of candidates){
    roll -= c.weight;
    if(roll <= 0) return c.player;
  }
  return candidates[candidates.length - 1].player;
}

function simLastName(player){
  return player ? player.name.split(' ').pop() : 'Unknown';
}

/* Everything an award needs to name a player and say who they play for.
   Keyed by squad id + player id because the same footballer can never be
   in two squads (usedPlayerIds guarantees it), but a `name` collision
   across pools is cheap to rule out and expensive to debug. */
function simPlayerRef(team, player){
  return {
    key: team.id + '|' + (player.id != null ? player.id : player.name),
    name: player.name,
    last: simLastName(player),
    rating: player.rating || 0,
    teamId: team.id,
    teamName: team.name,
    teamColor: team.color
  };
}

/* ---------- Commentary ----------
   Every line is generated during SIMULATION (with the seeded rng), not
   during playback. That matters online: each client re-runs the same
   seed and must produce identical commentary, so nothing here may touch
   Math.random. Playback is then pure reveal - which is also why one
   viewer skipping ahead has no effect on anyone else's screen. */

// Weighted pick from a squad, by how much a position does a given job.
function simPickByRole(team, roleKey, rng, exclude){
  const squad = (team.squad || []).filter(p => p !== exclude);
  if(!squad.length) return null;
  const cands = squad.map(player => {
    const w = simWeightsFor(player);
    return {player, weight: Math.max(0.03, w[roleKey]) * Math.pow(player.rating / 100, 2)};
  });
  const total = cands.reduce((s, c) => s + c.weight, 0);
  let roll = rng() * total;
  for(const c of cands){ roll -= c.weight; if(roll <= 0) return c.player; }
  return cands[cands.length - 1].player;
}

function simKeeper(team){
  return (team.squad || []).find(p => simWeightsFor(p).gk > 0) || null;
}

/* Commentary phrasings now live in the locale files (sim.goal,
   sim.chance, sim.defend, sim.midfield, sim.card), each as a list a
   translator can make as long or as short as they like.

   The line a client shows is chosen by INDEX, drawn here from the seeded
   rng and stored on the timeline - never resolved to text at this point.
   Two consequences, both deliberate:

     - Online stays in step. Every client draws the same index from the
       same seed with exactly one rng() call, so the stream is identical
       however many phrasings each language ships (tVariant wraps the
       index modulo the list it actually has).
     - Switching language mid-match re-renders commentary already on
       screen, because the timeline holds keys and parameters rather than
       a finished English sentence. */
const SIM_VARIANT_SPACE = 24;
function simVariant(rng){ return Math.floor(rng() * SIM_VARIANT_SPACE); }

// Timeline entry -> the sentence to show in whatever language is active
// right now. Called at render time, never at simulation time.
function simLineText(line){
  if(!line || !line.key) return '';
  return tVariant(line.key, line.variant || 0, line.params || null);
}

// Builds the full minute-by-minute broadcast for one match, weaving the
// already-decided goals in among filler chances so the scoreline still
// arrives exactly as the Poisson model determined - the commentary
// dramatises the result, it never changes it.
function simBuildCommentary(result, rng, opts){
  opts = opts || {};
  const {a: teamA, b: teamB} = result;
  // Match structure comes from the mode: 45/90/120 for 11-a-side,
  // 20/40/50 for 6v6's futsal clock (see each mode's `sim` block).
  const simCfg = simConfig();
  const REG = simCfg.fullTime - 1;                 // end of regulation
  const HALF = Math.round(REG / 2);                // half-time whistle
  const ET_END = simCfg.extraTimeTo - 1;           // end of extra time
  const timeline = [];
  // Running score, captured onto every line AT THE MOMENT it is pushed.
  // This is what the live scoreboard reads during playback, so it must
  // never be filled in retroactively - doing that made the kick-off line
  // carry the full-time score and spoiled the result instantly.
  let scoreA = 0, scoreB = 0;
  const push = (minute, kind, side, key, params, variant) =>
    timeline.push({minute, kind, side, key, params: params || null,
                   variant: variant || 0, scoreA, scoreB});

  push(0, 'kickoff', null, 'sim.kickoff', {a: esc(teamA.name), b: esc(teamB.name)});

  // Goals already carry their minute, scorer AND assist from
  // simulateMatch - the commentary now narrates the assist that was
  // actually recorded rather than inventing a second, different one that
  // contradicted the stats table.
  /* Which phrasing narrates a goal depends on how it arrived, so the feed
     can say "headed in from the corner" or "buries the penalty" while
     still describing the exact goal the model already decided. Open play
     falls back to the two long-standing phrasings. */
  const goalKeyFor = e => {
    if(e.origin === 'penalty')  return 'sim.goalPenalty';
    if(e.origin === 'corner')   return 'sim.goalCorner';
    if(e.origin === 'freeKick') return 'sim.goalFreeKick';
    if(e.origin === 'header')   return 'sim.goalHeader';
    if(e.origin === 'counter')  return 'sim.goalCounter';
    return e.assist ? 'sim.goalAssisted' : 'sim.goal';
  };
  const goalEvents = result.events.map(e => ({
    ...e,
    key: goalKeyFor(e),
    variant: simVariant(rng),
    params: {scorer: esc(e.scorer), assist: esc(e.assist || '')}
  }));

  /* Cards are real match data now (drawn in simBuildCards before any goal
     was decided), so they are woven into the feed from result.cards
     rather than invented here as filler. A red card in the feed is the
     same red card that reshaped the strengths for the rest of the match. */
  const cardEvents = (result.cards || []).map(c => ({
    minute: c.minute,
    kind: c.kind === 'red' ? 'red' : 'yellow',
    side: c.side,
    key: c.kind === 'red' ? 'sim.redCard' : 'sim.card',
    variant: simVariant(rng),
    params: {player: esc(c.player)}
  }));

  // Filler: near-misses, saves, blocks, bookings. Volume scales with how
  // open the match was, so a 4-3 thriller reads busier than a 0-0.
  const filler = [];
  if(opts.detail === 'full'){
    const openness = result.goalsA + result.goalsB;
    const nFiller = 4 + Math.floor(rng() * 4) + Math.min(4, openness);
    const lastMinute = result.extraTime ? (simCfg.extraTimeTo - 1) : (simCfg.fullTime - 1);
    for(let i = 0; i < nFiller; i++){
      const minute = 1 + Math.floor(rng() * (lastMinute - 1));
      const attackingA = rng() < 0.5;
      const att = attackingA ? teamA : teamB;
      const def = attackingA ? teamB : teamA;
      const side = attackingA ? 'a' : 'b';
      const roll = rng();
      if(roll < 0.45){
        const shooter = simLastName(simPickByRole(att, 'att', rng));
        const keeper = simLastName(simKeeper(def));
        filler.push({minute, kind: 'chance', side, key: 'sim.chance',
                     variant: simVariant(rng), params: {player: esc(shooter), keeper: esc(keeper)}});
      } else if(roll < 0.70){
        const defender = simLastName(simPickByRole(def, 'def', rng));
        const attacker = simLastName(simPickByRole(att, 'att', rng));
        filler.push({minute, kind: 'defend', side, key: 'sim.defend',
                     variant: simVariant(rng), params: {defender: esc(defender), attacker: esc(attacker)}});
      } else if(roll < 0.80){
        const mid = simLastName(simPickByRole(att, 'mid', rng));
        filler.push({minute, kind: 'midfield', side, key: 'sim.midfield',
                     variant: simVariant(rng), params: {player: esc(mid)}});
      } else if(roll < 0.91){
        // Set pieces as texture. Bookings are no longer drawn here - they
        // are real match data now and come in via cardEvents above.
        const taker = simLastName(simPickByRole(att, 'mid', rng));
        filler.push({minute, kind: 'corner', side, key: 'sim.corner',
                     variant: simVariant(rng), params: {player: esc(taker)}});
      } else {
        const taker = simLastName(simPickByRole(att, 'att', rng));
        const keeper = simLastName(simKeeper(def));
        filler.push({minute, kind: 'freekick', side, key: 'sim.freeKick',
                     variant: simVariant(rng), params: {player: esc(taker), keeper: esc(keeper)}});
      }
    }
  }

  const inPlay = goalEvents.concat(filler, cardEvents).sort((x, y) => x.minute - y.minute);

  // Stitch in the structural markers, advancing the running score so the
  // scoreboard updates live as each goal is revealed.
  let halfTimeDone = false, fullTimeDone = false;
  inPlay.forEach(ev => {
    if(!halfTimeDone && ev.minute > HALF){
      push(HALF, 'halftime', null, 'sim.halfTime', {a: esc(teamA.name), b: esc(teamB.name), scoreA, scoreB});
      halfTimeDone = true;
    }
    if(!fullTimeDone && ev.minute > REG){
      push(REG, 'fulltime90', null, 'sim.fullTimeLevel', {minutes: REG, scoreA, scoreB});
      fullTimeDone = true;
    }
    if(ev.kind === 'goal' || ev.scorer){
      if(ev.side === 'a') scoreA++; else scoreB++;
    }
    timeline.push({
      minute: ev.minute,
      kind: ev.scorer ? 'goal' : ev.kind,
      side: ev.side,
      key: ev.key, params: ev.params, variant: ev.variant,
      scoreA, scoreB
    });
  });
  if(!halfTimeDone){
    push(HALF, 'halftime', null, 'sim.halfTime', {a: esc(teamA.name), b: esc(teamB.name), scoreA, scoreB});
  }

  if(result.extraTime && !fullTimeDone){
    push(REG, 'fulltime90', null, 'sim.fullTimeLevel', {minutes: REG, scoreA, scoreB});
  }

  if(result.penalties){
    push(ET_END, 'shootout', null, 'sim.shootout');
    (result.penalties.kicks || []).forEach((k, i) => {
      const team = k.side === 'a' ? teamA : teamB;
      push(ET_END, 'penalty', k.side, k.scored ? 'sim.penScored' : 'sim.penMissed', {
        taker: esc(k.taker), team: esc(team.name),
        scoreA: result.penalties.runningA[i], scoreB: result.penalties.runningB[i]
      });
    });
  }

  push(result.extraTime ? ET_END : REG, 'final',
    null, result.penalties ? 'sim.fullTimePens' : 'sim.fullTime', {
      a: esc(teamA.name), b: esc(teamB.name),
      scoreA: result.goalsA, scoreB: result.goalsB,
      pensA: result.penalties ? result.penalties.a : 0,
      pensB: result.penalties ? result.penalties.b : 0
    });

  return timeline;
}

// Seeded equivalent of pickRandom - the global one uses Math.random,
// which would desync online clients.
function pickSeeded(arr, rng){
  return arr[Math.floor(rng() * arr.length)];
}

// One match. `opts.knockout` means it cannot end level: extra time is
// played, then penalties. Returns everything the renderer needs.
function simulateMatch(teamA, teamB, rng, opts){
  opts = opts || {};
  const simCfg = simConfig();
  const sA = teamA.strength;
  const sB = teamB.strength;

  // Discipline is settled before anything else, because a dismissal
  // changes the strengths every later part of this match is played at.
  const cards = simBuildCards(teamA, teamB, rng, simCfg);
  const reds = cards.filter(c => c.kind === 'red');

  /* Regulation, split at each dismissal. With no red card - which is
     always the case in 6v6, and the large majority of Classic matches -
     this is a single full-strength segment spanning the whole match, so
     the model behaves exactly as it did before red cards existed. */
  const cuts = [1].concat(reds.map(r => r.minute)).concat([simCfg.fullTime]);
  const spanTotal = simCfg.fullTime - 1;
  const segments = [];
  for(let i = 0; i < cuts.length - 1; i++){
    const from = cuts[i], to = cuts[i + 1];
    if(to <= from) continue;
    const redsA = reds.filter(r => r.side === 'a' && r.minute <= from).length;
    const redsB = reds.filter(r => r.side === 'b' && r.minute <= from).length;
    segments.push({
      from, to,
      frac: (to - from) / spanTotal,
      strA: simStrengthAfterReds(sA, redsA),
      strB: simStrengthAfterReds(sB, redsB)
    });
  }

  const events = [];
  const addGoals = (team, side, count, minFrom, minTo) => {
    for(let i = 0; i < count; i++){
      const scorer = pickScorer(team, rng);
      // How it arrived - a label on a goal that already exists, never a
      // second way of creating one. See SIM_GOAL_ORIGINS.
      const origin = simPickGoalOrigin(rng);
      // The assist is decided HERE, with the seeded rng, rather than at
      // commentary time where it used to be. It's a real statistic now -
      // the awards table is counted from these events - so it has to live
      // in the match data every client derives from the shared seed, not
      // in a presentation layer. Not every goal has one, and a penalty
      // never does.
      const assist = (origin !== 'penalty' && rng() < 0.62)
        ? simPickByRole(team, 'mid', rng, scorer) : null;
      events.push({
        minute: minFrom + Math.floor(rng() * Math.max(1, minTo - minFrom)),
        side, origin,
        scorer: simLastName(scorer),
        assist: assist ? simLastName(assist) : null,
        scorerRef: scorer ? simPlayerRef(team, scorer) : null,
        assistRef: assist ? simPlayerRef(team, assist) : null
      });
    }
  };

  /* Each segment is priced at the strengths in force during it, then
     prorated by how much of the match it covers. The clamp stays inside
     expectedGoals() at whole-match scale, so splitting a match up can
     never apply the per-match floor several times over and quietly
     inflate scorelines whenever a red card happens. */
  /* Which side is at home, if either. Null for a neutral match (a final),
     which is why this is passed in rather than derived - only the format
     knows whether a given tie is being played at somebody's ground. */
  const homeSide = opts.home || null;
  const homeA = simHomeFactor('a', homeSide);
  const homeB = simHomeFactor('b', homeSide);

  let goalsA = 0, goalsB = 0, xgA = 0, xgB = 0;
  segments.forEach(seg => {
    const segXgA = expectedGoals(seg.strA, seg.strB, 1, homeA) * seg.frac;
    const segXgB = expectedGoals(seg.strB, seg.strA, 1, homeB) * seg.frac;
    xgA += segXgA;
    xgB += segXgB;
    const gA = poissonSample(segXgA, rng);
    const gB = poissonSample(segXgB, rng);
    addGoals(teamA, 'a', gA, seg.from, seg.to);
    addGoals(teamB, 'b', gB, seg.from, seg.to);
    goalsA += gA;
    goalsB += gB;
  });

  const result = {
    a: teamA, b: teamB,
    goalsA, goalsB,
    xgA, xgB,
    events, cards, segments,
    homeSide,
    extraTime: false,
    penalties: null,
    normalTimeA: goalsA,
    normalTimeB: goalsB
  };

  /* Is the tie still level - i.e. does this match need deciding? For a
     one-off that's just the scoreline. For the second leg of a two-legged
     tie it's the AGGREGATE, which is why opts.aggregate exists: carrying
     the first leg in means extra time and penalties trigger on the right
     condition ("level over the two matches") instead of the wrong one
     ("level in this one"). */
  const stillLevel = () => opts.aggregate
    ? (opts.aggregate.a + result.goalsA) === (opts.aggregate.b + result.goalsB)
    : result.goalsA === result.goalsB;

  if(opts.knockout && stillLevel()){
    // Extra time is a third of a match, and cagier than normal time -
    // teams protect the draw, so the tempo multiplier is below 1/3.
    // Played at END-of-match strengths: anyone sent off in regulation is
    // still off for extra time, which is the whole point of a dismissal.
    result.extraTime = true;
    const endA = simStrengthAfterReds(sA, reds.filter(r => r.side === 'a').length);
    const endB = simStrengthAfterReds(sB, reds.filter(r => r.side === 'b').length);
    const etXgA = expectedGoals(endA, endB, simCfg.extraTimeTempo, homeA);
    const etXgB = expectedGoals(endB, endA, simCfg.extraTimeTempo, homeB);
    result.xgA += etXgA;
    result.xgB += etXgB;
    const etA = poissonSample(etXgA, rng);
    const etB = poissonSample(etXgB, rng);
    addGoals(teamA, 'a', etA, simCfg.fullTime, simCfg.extraTimeTo);
    addGoals(teamB, 'b', etB, simCfg.fullTime, simCfg.extraTimeTo);
    result.goalsA += etA;
    result.goalsB += etB;

    if(stillLevel()){
      result.penalties = simulatePenalties(teamA, teamB, rng);
    }
  }

  events.sort((x, y) => x.minute - y.minute);

  /* Volume statistics and the two live series, built once the score is
     final (extra time included) so they describe the whole match rather
     than only regulation. All of it is derived from figures the model has
     already produced - see simShotProfile/simBuildShotTimeline. */
  const cornerGoals = side => events.filter(e => e.side === side && e.origin === 'corner').length;
  result.stats = {
    a: simShotProfile(result.xgA, result.goalsA, cornerGoals('a'), rng, simCfg),
    b: simShotProfile(result.xgB, result.goalsB, cornerGoals('b'), rng, simCfg)
  };
  result.stats.a.cards = cards.filter(c => c.side === 'a');
  result.stats.b.cards = cards.filter(c => c.side === 'b');
  result.possessionBlocks = simBuildPossessionTimeline(segments, rng, simCfg);
  result.possessionA = simPossessionAt(result.possessionBlocks, simCfg.fullTime);
  result.possessionB = 1 - result.possessionA;
  result.shotTimeline = simBuildShotTimeline(result, rng);

  if(result.penalties){
    result.winner = result.penalties.a > result.penalties.b ? teamA : teamB;
  } else if(result.goalsA !== result.goalsB){
    result.winner = result.goalsA > result.goalsB ? teamA : teamB;
  } else {
    result.winner = null; // league draw
  }

  // Built here (not at render time) so it consumes the seeded rng and is
  // therefore identical on every client - see simBuildCommentary.
  result.commentary = simBuildCommentary(result, rng, {detail: opts.detail || 'full'});
  return result;
}

// Shootouts are close to a coin flip in reality; squad quality nudges
// it, it does not decide it. Five kicks each, then sudden death.
function simulatePenalties(teamA, teamB, rng){
  const pFor = (taker, keeper) => {
    const p = 0.76 + (taker.strength.att - keeper.strength.gk) / 420;
    return Math.min(0.90, Math.max(0.60, p));
  };
  const pA = pFor(teamA, teamB);
  const pB = pFor(teamB, teamA);

  let a = 0, b = 0;
  // Per-kick record, so the shootout can be played out one penalty at a
  // time in the broadcast instead of just reporting the final tally.
  const kicks = [];
  const runningA = [];
  const runningB = [];
  const takeKick = (team, side, p) => {
    const scored = rng() < p;
    if(scored){ if(side === 'a') a++; else b++; }
    kicks.push({side, scored, taker: simLastName(simPickByRole(team, 'att', rng))});
    runningA.push(a);
    runningB.push(b);
  };

  for(let i = 0; i < 5; i++){
    takeKick(teamA, 'a', pA);
    takeKick(teamB, 'b', pB);
  }
  // Sudden death, with a hard cap so a pathological RNG run cannot
  // spin forever.
  let round = 0;
  while(a === b && round < 20){
    takeKick(teamA, 'a', pA);
    takeKick(teamB, 'b', pB);
    round++;
  }
  if(a === b) a++; // cap reached: settle it rather than return a tie
  return {a, b, kicks, runningA, runningB};
}

/* ---- Formats ---- */

// Single elimination. Seeded by squad quality so the two best squads
// are on opposite sides of the bracket, with byes going to the top
// seeds when the count is not a power of two (the standard approach -
// a bye is earned by seeding, not handed out at random).
function simulateKnockout(teams, rng){
  const seeded = [...teams].sort((x, y) => y.strength.overall - x.strength.overall);
  seeded.forEach((t, i) => { t.seed = i + 1; });

  let size = 1;
  while(size < seeded.length) size *= 2;
  const byes = size - seeded.length;

  // Top `byes` seeds skip round one.
  let advancing = seeded.slice(0, byes);
  let contesting = seeded.slice(byes);

  /* Who hosts a knockout tie.

     The bracket always lists the better seed first, so tying "home" to
     listing order would hand the stronger side an extra edge in every
     round it played - compounding seeding with home advantage and
     quietly flattening the upsets this model is meant to keep. A seeded
     coin flip is fair in expectation and still identical on every client.

     A final is played at neither team's ground, so it gets no host at
     all - which is also what stops the Home/Away badge appearing on it. */
  const hostOf = (isFinal) => isFinal ? null : (rng() < 0.5 ? 'a' : 'b');

  const rounds = [];
  if(contesting.length){
    // Pair strongest-remaining against weakest-remaining.
    const ties = [];
    for(let i = 0; i < contesting.length / 2; i++){
      ties.push([contesting[i], contesting[contesting.length - 1 - i]]);
    }
    const isFinal = (contesting.length + byes) === 2;
    const matches = ties.map(([x, y]) =>
      simulateMatch(x, y, rng, {knockout:true, detail:'full', home: hostOf(isFinal)}));
    rounds.push({name: knockoutRoundName(contesting.length + byes), matches, byes: advancing.slice()});
    advancing = advancing.concat(matches.map(m => m.winner));
  }

  while(advancing.length > 1){
    // Re-seed each round so the bracket stays balanced.
    advancing.sort((x, y) => x.seed - y.seed);
    const isFinal = advancing.length === 2;
    const matches = [];
    for(let i = 0; i < advancing.length / 2; i++){
      matches.push(simulateMatch(advancing[i], advancing[advancing.length - 1 - i], rng,
        {knockout:true, detail:'full', home: hostOf(isFinal)}));
    }
    rounds.push({name: knockoutRoundName(advancing.length), matches, byes: []});
    advancing = matches.map(m => m.winner);
  }

  return {rounds, champion: advancing[0] || null};
}

function knockoutRoundName(teamsInRound){
  if(teamsInRound <= 2) return t('sim.roundFinal');
  if(teamsInRound <= 4) return t('sim.roundSemi');
  if(teamsInRound <= 8) return t('sim.roundQuarter');
  if(teamsInRound <= 16) return t('sim.roundOf', {n: 16});
  return t('sim.roundOf', {n: teamsInRound});
}

// Round robin, 3 points for a win. Small fields play twice so the
// table is decided by more than one or two results - with 2 or 3
// squads a single round robin is only 1-3 matches, which is not a
// league in any meaningful sense.
/* The league table after the first `upto` matches have been played.

   Built purely from the matches themselves - every match already knows
   its two teams and the score, so nothing has to be accumulated during
   the simulation and nothing has to be stored per round. That is what
   lets the standings shown DURING playback and the final table be the
   same function rather than two implementations that can drift: the
   final table is simply this called with every match.

   Pure and rng-free, so it can be called at render time on any client
   without touching the seeded stream. */
function simLeagueTableAfter(teams, matches, upto){
  const rows = new Map();
  teams.forEach(t => rows.set(t, {team:t, p:0, w:0, d:0, l:0, gf:0, ga:0, pts:0}));

  matches.slice(0, upto == null ? matches.length : upto).forEach(m => {
    const rh = rows.get(m.a);
    const ra = rows.get(m.b);
    if(!rh || !ra) return;   // a match between teams not in this table
    rh.p++; ra.p++;
    rh.gf += m.goalsA; rh.ga += m.goalsB;
    ra.gf += m.goalsB; ra.ga += m.goalsA;
    if(m.goalsA > m.goalsB){ rh.w++; ra.l++; rh.pts += 3; }
    else if(m.goalsA < m.goalsB){ ra.w++; rh.l++; ra.pts += 3; }
    else { rh.d++; ra.d++; rh.pts++; ra.pts++; }
  });

  return [...rows.values()].sort((x, y) =>
    (y.pts - x.pts) ||
    ((y.gf - y.ga) - (x.gf - x.ga)) ||
    (y.gf - x.gf) ||
    (y.team.strength.overall - x.team.strength.overall)
  );
}

function simulateLeague(teams, rng){
  const legs = teams.length <= 3 ? 2 : 1;

  // A 10-team league is 45 matches; narrating every near-miss in all of
  // them would run for many minutes. Small leagues get the full
  // broadcast, big ones get goals-only so the whole season still plays
  // out at a watchable length. Derived from team count alone, so every
  // online client independently reaches the same decision.
  const totalMatches = legs * (teams.length * (teams.length - 1)) / 2;
  const detail = totalMatches <= 12 ? 'full' : 'goals';

  const matches = [];
  for(let leg = 0; leg < legs; leg++){
    for(let i = 0; i < teams.length; i++){
      for(let j = i + 1; j < teams.length; j++){
        /* Who hosts. With two legs every pair already plays once each
           way, so the work here is really about the SINGLE round robin -
           where the old rule (always teams[i]) made the first participant
           the home side in every one of their fixtures. That was harmless
           while home was purely a label; it is systematically unfair the
           moment it carries an advantage.

           Parity of (i + j) spreads it: each team hosts either
           floor((n-1)/2) or ceil((n-1)/2) of its matches, which is the
           most even a single round robin can be when every team plays an
           odd number of games. */
        const firstHosts = (leg === 0) === (((i + j) % 2) === 0);
        const home = firstHosts ? teams[i] : teams[j];
        const away = firstHosts ? teams[j] : teams[i];
        matches.push(simulateMatch(home, away, rng, {knockout:false, detail, home:'a'}));
      }
    }
  }

  // The final table is the live table with every match counted - one
  // definition, so the standings on screen mid-season and the ones at the
  // end can never disagree about how a point was earned.
  const table = simLeagueTableAfter(teams, matches);

  return {table, matches, legs, champion: table[0] ? table[0].team : null};
}

/* Two legs, one at each ground, decided on aggregate - the format a
   two-squad draft actually wants, since a "bracket" and a "league" are
   both slightly silly words for two teams. Level on aggregate after the
   second leg goes to extra time and then penalties, played out in the
   second leg exactly as a real tie would be (see opts.aggregate in
   simulateMatch, which is what makes the decider trigger on the
   aggregate rather than on the second leg's own scoreline). */
function simulateTwoLegged(teams, rng){
  const [teamA, teamB] = teams;

  // Each leg is played at the first-named side's ground, and the sides
  // swap below - so across the tie both squads host exactly once.
  const leg1 = simulateMatch(teamA, teamB, rng, {knockout:false, detail:'full', home:'a'});
  // Home and away: the sides swap, so in leg 2 teamB is the home side and
  // the aggregate carried in has to be stated from THAT match's point of
  // view - hence b's first-leg goals under `a`.
  const leg2 = simulateMatch(teamB, teamA, rng, {
    knockout: true,
    detail: 'full',
    home: 'a',
    aggregate: {a: leg1.goalsB, b: leg1.goalsA}
  });

  const aggA = leg1.goalsA + leg2.goalsB;
  const aggB = leg1.goalsB + leg2.goalsA;

  let champion;
  if(leg2.penalties){
    champion = leg2.penalties.a > leg2.penalties.b ? teamB : teamA;
  } else {
    champion = aggA >= aggB ? teamA : teamB;
  }

  return {
    legs: [leg1, leg2],
    matches: [leg1, leg2],
    aggA, aggB,
    champion,
    decidedBy: leg2.penalties ? 'penalties' : (leg2.extraTime ? 'extraTime' : 'aggregate')
  };
}

/* ================= AWARDS =================

   Counted from the events the simulation actually produced - every goal
   and assist recorded in simulateMatch carries a scorerRef/assistRef, so
   nothing here is drawn at random. Given the same seed every client
   computes the identical table, same as the rest of the simulation.

   The per-match score behind Man of the Match and Best Player:

     goal            3     the thing that decides matches
     assist          2     worth most of a goal, not all of it
     clean sheet     2.5   to the keeper only, and only if they kept one
     on the winning side  +0.5   separates two identical returns
     rating/1000           a deterministic tiebreak, never a real factor

   Without the last term two players on 3.0 would be ordered by whatever
   the array happened to hold first, which is not stable across clients. */
const SIM_AWARD_POINTS = { goal: 3, assist: 2, cleanSheet: 2.5, winner: 0.5 };

// One match's worth of per-player scoring, keyed by simPlayerRef().key.
function simMatchPlayerScores(m){
  const scores = new Map();
  const bump = (ref, points, stat) => {
    if(!ref) return;
    let row = scores.get(ref.key);
    if(!row){
      row = {ref, goals: 0, assists: 0, points: 0};
      scores.set(ref.key, row);
    }
    if(stat) row[stat]++;
    row.points += points;
  };

  m.events.forEach(e => {
    bump(e.scorerRef, SIM_AWARD_POINTS.goal, 'goals');
    bump(e.assistRef, SIM_AWARD_POINTS.assist, 'assists');
  });

  // Clean sheets. Goals conceded is the OTHER side's tally, and extra-time
  // goals are already folded into goalsA/goalsB by this point.
  [[m.a, 'a', m.goalsB], [m.b, 'b', m.goalsA]].forEach(([team, side, conceded]) => {
    if(conceded !== 0) return;
    const keeper = simKeeper(team);
    if(keeper) bump(simPlayerRef(team, keeper), SIM_AWARD_POINTS.cleanSheet);
  });

  scores.forEach(row => {
    if(m.winner && row.ref.teamId === m.winner.id) row.points += SIM_AWARD_POINTS.winner;
    row.points += row.ref.rating / 1000;
  });

  return scores;
}

/* ---------- Player match ratings ----------

   Out of ten, extending the same simMatchPlayerScores() table that decides
   Man of the Match - so the highest-rated player on the page is always
   the one holding the award. Two systems ranking the same eleven players
   and disagreeing in public is exactly the kind of thing that makes a
   results screen look untrustworthy.

   No rng at all: every term is read off events that already exist, so the
   ratings are identical on every client without consuming any of the
   seeded stream. Everyone starts at par and moves on what they actually
   did - goals and assists lift, conceding drags down whoever was supposed
   to prevent it, a dismissal is the worst thing on the list, and the
   player's own quality is a small nudge so a 91-rated forward who had a
   quiet game still edges a 74-rated one who had the same quiet game. */
const SIM_RATING_PAR = 6.3;

function simPlayerRatings(m){
  const scores = simMatchPlayerScores(m);
  const cardsFor = ref => (m.cards || []).filter(c => c.ref && c.ref.key === ref.key);

  const rateTeam = (team, side) => {
    const conceded = side === 'a' ? m.goalsB : m.goalsA;
    const won = m.winner && m.winner.id === team.id;
    const lost = m.winner && m.winner.id !== team.id;

    return (team.squad || []).map(player => {
      const ref = simPlayerRef(team, player);
      const row = scores.get(ref.key);
      const w = simWeightsFor(player);
      let r = SIM_RATING_PAR;

      if(row){
        r += row.goals * 1.15;
        r += row.assists * 0.72;
      }
      // A clean sheet belongs to the keeper most, but the back line kept
      // it too - and conceding costs each of them in proportion to how
      // much of that job was theirs in the first place.
      if(conceded === 0){
        if(w.gk > 0) r += 0.85;
        else if(w.def >= 0.6) r += 0.45;
      }
      r -= conceded * (w.gk > 0 ? 0.20 : 0.11 * w.def);

      cardsFor(ref).forEach(c => { r -= (c.kind === 'red' ? 1.6 : 0.25); });

      if(won) r += 0.28;
      else if(lost) r -= 0.18;

      // Small enough that it never outweighs what happened on the day.
      r += (player.rating - 78) / 55;

      return {
        ref, player,
        goals: row ? row.goals : 0,
        assists: row ? row.assists : 0,
        rating: Math.max(4.0, Math.min(10, Math.round(r * 10) / 10))
      };
    }).sort((x, y) => y.rating - x.rating || y.ref.rating - x.ref.rating);
  };

  return {a: rateTeam(m.a, 'a'), b: rateTeam(m.b, 'b')};
}

/* Best performer in one match: simply the best match rating on the pitch.
   The final key comparison is a deterministic tiebreak - without it two
   identical ratings would be ordered by whatever the array happened to
   hold first, which is not stable across clients. */
function simManOfTheMatch(m){
  // Rated once, not once per side - this used to call simPlayerRatings
  // twice for the same match and throw half the work away.
  const rated = simPlayerRatings(m);
  const all = [].concat(rated.a, rated.b);
  if(!all.length) return null;
  all.sort((x, y) =>
    y.rating - x.rating || y.ref.rating - x.ref.rating || x.ref.key.localeCompare(y.ref.key));
  const top = all[0];
  const row = simMatchPlayerScores(m).get(top.ref.key);
  return {
    ref: top.ref,
    goals: top.goals,
    assists: top.assists,
    points: row ? row.points : 0,
    rating: top.rating
  };
}

/* The best player in each slot of the formation, across every match.

   Chosen PER SLOT rather than by taking the eleven best ratings, which
   would happily return a team of eight forwards. Every drafted player
   owns exactly one slot index, so filling each slot with its best
   performer produces a side that could actually take the field - in
   whatever shape the tournament was drafted in, 4-3-3 or 2-1-2 alike.

   Ranked on AVERAGE match rating, not the total: a squad knocked out in
   the first round would otherwise be unable to compete with one that
   played five games, and "team of the tournament" has always meant who
   played best, not who played most. Appearances break the tie, so a
   player who held an average over five matches edges one who managed it
   once, and the remaining tiebreaks are deterministic so every client
   picks the same eleven. */
function simTeamOfTournament(matches){
  const rows = new Map();
  matches.forEach(m => {
    const rated = simPlayerRatings(m);
    [].concat(rated.a, rated.b).forEach(entry => {
      if(!entry.player) return;
      let row = rows.get(entry.ref.key);
      if(!row){
        row = {ref: entry.ref, posIdx: entry.player.posIdx, total: 0, apps: 0, goals: 0};
        rows.set(entry.ref.key, row);
      }
      row.total += entry.rating;
      row.goals += entry.goals || 0;
      row.apps++;
    });
  });

  const xi = [];
  FORMATION.forEach((_, posIdx) => {
    const candidates = [...rows.values()].filter(r => r.posIdx === posIdx);
    if(!candidates.length) return;
    candidates.sort((x, y) =>
      (y.total / y.apps) - (x.total / x.apps) ||
      y.apps - x.apps ||
      y.ref.rating - x.ref.rating ||
      x.ref.key.localeCompare(y.ref.key));
    const best = candidates[0];
    xi.push({
      posIdx,
      ref: best.ref,
      apps: best.apps,
      goals: best.goals,
      avg: best.total / best.apps
    });
  });
  return xi;
}

/* Every award the tournament can hand out, from a flat list of matches.
   `matches` is whatever the format played - one match for a Final, two
   for a two-legged tie, all of them for a bracket or a league. */
function simComputeAwards(matches){
  const totals = new Map();
  const add = (ref, stat, points) => {
    if(!ref) return;
    let row = totals.get(ref.key);
    if(!row){
      row = {ref, goals: 0, assists: 0, points: 0, motm: 0};
      totals.set(ref.key, row);
    }
    if(stat) row[stat]++;
    row.points += points;
  };

  const motmByMatch = [];
  matches.forEach(m => {
    m.events.forEach(e => {
      add(e.scorerRef, 'goals', SIM_AWARD_POINTS.goal);
      add(e.assistRef, 'assists', SIM_AWARD_POINTS.assist);
    });
    const motm = simManOfTheMatch(m);
    motmByMatch.push({match: m, motm});
    if(motm){
      add(motm.ref, 'motm', 0);
      // A match award is worth something towards the tournament one, but
      // less than the goals that usually earned it - otherwise a single
      // quiet clean sheet outranks a hat-trick.
      const row = totals.get(motm.ref.key);
      if(row) row.points += 1;
    }
  });

  const rows = [...totals.values()];
  // Ties are broken by a genuinely different statistic in each case (the
  // brief's "reasonable secondary statistic"), then by rating so the
  // order is identical on every device.
  const byGoals = [...rows].sort((x, y) =>
    y.goals - x.goals || y.assists - x.assists || y.ref.rating - x.ref.rating);
  const byAssists = [...rows].sort((x, y) =>
    y.assists - x.assists || y.goals - x.goals || y.ref.rating - x.ref.rating);
  const byOverall = [...rows].sort((x, y) =>
    y.points - x.points || y.goals - x.goals || y.ref.rating - x.ref.rating);

  /* Best goalkeeper, judged on the job a keeper is actually judged on:
     clean sheets first, then goals conceded per appearance so a keeper
     who played more matches isn't punished for it. Counted separately
     from the outfield table because keepers score almost no goals and
     would never surface in it. */
  const keepers = new Map();
  matches.forEach(m => {
    [[m.a, m.goalsB], [m.b, m.goalsA]].forEach(([team, conceded]) => {
      const k = simKeeper(team);
      if(!k) return;
      const ref = simPlayerRef(team, k);
      let row = keepers.get(ref.key);
      if(!row){
        row = {ref, apps: 0, conceded: 0, cleanSheets: 0, goals: 0, assists: 0};
        keepers.set(ref.key, row);
      }
      row.apps++;
      row.conceded += conceded;
      if(conceded === 0) row.cleanSheets++;
    });
  });
  const byKeeper = [...keepers.values()].sort((x, y) =>
    y.cleanSheets - x.cleanSheets ||
    (x.conceded / x.apps) - (y.conceded / y.apps) ||
    y.ref.rating - x.ref.rating);

  return {
    best: byOverall[0] || null,
    topScorer: (byGoals[0] && byGoals[0].goals > 0) ? byGoals[0] : null,
    topAssists: (byAssists[0] && byAssists[0].assists > 0) ? byAssists[0] : null,
    bestKeeper: byKeeper[0] || null,
    // Only meaningful once there is more than one match to average over,
    // which is the same line every other tournament award is drawn at.
    teamOfTournament: matches.length > 1 ? simTeamOfTournament(matches) : null,
    motmByMatch
  };
}

/* ---- Rendering ---- */

// Participants are sorted by id before simulating so that every online
// client feeds the teams to the RNG in the SAME order. Without this,
// two clients could iterate Firebase's participants object differently
// and produce different results from the identical seed.
function simBuildTeams(){
  return [...state.participants]
    .sort((x, y) => String(x.id).localeCompare(String(y.id)))
    .map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      squad: p.squad || [],
      strength: computeSquadStrength(p)
    }));
}

/* ---------- Post-match detail ----------

   Statistics, ratings and a short explanation of the match, all read off
   figures the model produced. Nothing on this panel is a placeholder and
   nothing is drawn at random - if a number is here, it is the number the
   simulation used. */

function simRenderMatchStats(m){
  const pctA = Math.round(m.possessionA * 100);
  const count = (side, kind) => (m.cards || []).filter(c => c.side === side && c.kind === kind).length;
  const rows = [
    {label: t('sim.possession'), a: pctA + '%', b: (100 - pctA) + '%', na: pctA, nb: 100 - pctA},
    {label: t('sim.xg'), a: m.xgA.toFixed(2), b: m.xgB.toFixed(2), na: m.xgA, nb: m.xgB},
    {label: t('sim.shots'), a: m.stats.a.shots, b: m.stats.b.shots, na: m.stats.a.shots, nb: m.stats.b.shots},
    {label: t('sim.onTarget'), a: m.stats.a.onTarget, b: m.stats.b.onTarget, na: m.stats.a.onTarget, nb: m.stats.b.onTarget},
    {label: t('sim.corners'), a: m.stats.a.corners, b: m.stats.b.corners, na: m.stats.a.corners, nb: m.stats.b.corners},
  ];

  // Cards only appear when there were some - an all-zero row on every
  // clean match is noise, and in 6v6 the red column never fills at all.
  const chips = side => {
    const y = count(side, 'yellow'), r = count(side, 'red');
    return (y ? '🟨'.repeat(Math.min(y, 5)) : '') + (r ? '🟥'.repeat(r) : '') || '—';
  };
  if((m.cards || []).length){
    rows.push({label: t('sim.cards'), a: chips('a'), b: chips('b'), na: 0, nb: 0, noBar: true});
  }

  return '<div class="sim-statpanel">' + rows.map(r => {
    const tot = r.na + r.nb;
    const share = tot > 0 ? Math.round(r.na / tot * 100) : 50;
    return `<div class="sim-stat-row">
      <span class="sim-stat-val">${esc(String(r.a))}</span>
      <span class="sim-stat-mid">
        <span class="sim-stat-label">${esc(r.label)}</span>
        ${r.noBar ? '' : `<span class="sim-stat-bar"><i style="width:${share}%"></i></span>`}
      </span>
      <span class="sim-stat-val">${esc(String(r.b))}</span>
    </div>`;
  }).join('') + '</div>';
}

/* Which line a player reads as, taken from the weights the match engine
   already uses rather than a second position->line table. That way a CM
   bought to play CDM is coloured the way the simulation actually treats
   them, and nothing has to be kept in step by hand. */
function simLineOf(player){
  const w = simWeightsFor(player);
  if(w.gk > 0) return 'gk';
  if(w.att >= w.mid && w.att >= w.def) return 'att';
  if(w.def >= w.mid) return 'def';
  return 'mid';
}

/* Ratings read as a team sheet, not a leaderboard: down the formation
   from the keeper out, each player behind their slot's code. Sorting by
   rating instead would answer "who played well" - which the Man of the
   Match line directly above already answers - while making it oddly hard
   to find a specific player in your own squad. */
function simRenderPlayerRatings(m){
  const ratings = simPlayerRatings(m);
  const col = (team, rows) => `
    <div class="sim-rate-col">
      <div class="sim-rate-team">
        <span class="sim-rate-dot" style="background:${team.color}"></span>${esc(team.name)}
      </div>
      ${rows.slice()
        .sort((x, y) => x.player.posIdx - y.player.posIdx)
        .map(r => `
        <div class="sim-rate-row">
          <span class="sim-rate-pos ${simLineOf(r.player)}">${esc(slotCode(r.player.posIdx))}</span>
          <span class="sim-rate-name">${esc(r.ref.name)}</span>
          <span class="sim-rate-num${r.rating >= 8 ? ' hot' : (r.rating < 6 ? ' cold' : '')}">${r.rating.toFixed(1)}</span>
        </div>`).join('')}
    </div>`;
  return `<div class="sim-ratings">${col(m.a, ratings.a)}${col(m.b, ratings.b)}</div>`;
}

/* Match Analysis. Each line is a template filled from figures this match
   actually produced, and every condition is tested against those same
   figures - so the paragraph physically cannot claim something the table
   directly above it contradicts. Capped at three lines: this is meant to
   explain the result, not report on it. */
function simMatchAnalysis(m){
  const out = [];
  const push = (key, params) => { if(out.length < 3) out.push(t(key, params)); };
  const pctA = Math.round(m.possessionA * 100);

  const red = (m.cards || []).find(c => c.kind === 'red');
  if(red){
    push('sim.anRedCard', {team: (red.side === 'a' ? m.a : m.b).name, minute: red.minute});
  }

  // Who had the ball, and did it turn into anything?
  const domSide = pctA >= 58 ? 'a' : (pctA <= 42 ? 'b' : null);
  if(domSide){
    const team = domSide === 'a' ? m.a : m.b;
    const poss = domSide === 'a' ? pctA : 100 - pctA;
    const xg = domSide === 'a' ? m.xgA : m.xgB;
    const goals = domSide === 'a' ? m.goalsA : m.goalsB;
    const oppGoals = domSide === 'a' ? m.goalsB : m.goalsA;
    push(goals > oppGoals ? 'sim.anControlled' : 'sim.anWasteful',
         {team: team.name, poss, xg: xg.toFixed(2)});
  }

  // Finishing measured against the chances actually created.
  [[m.a, m.goalsA, m.xgA], [m.b, m.goalsB, m.xgB]].forEach(([team, goals, xg]) => {
    if(goals >= xg + 0.9) push('sim.anClinical', {team: team.name, goals, xg: xg.toFixed(2)});
    else if(xg >= goals + 1.1) push('sim.anProfligate', {team: team.name, goals, xg: xg.toFixed(2)});
  });

  if(m.goalsB === 0) push('sim.anCleanSheet', {team: m.a.name, opp: m.b.name, xg: m.xgB.toFixed(2)});
  else if(m.goalsA === 0) push('sim.anCleanSheet', {team: m.b.name, opp: m.a.name, xg: m.xgA.toFixed(2)});

  if(!out.length) push('sim.anTight', {xgA: m.xgA.toFixed(2), xgB: m.xgB.toFixed(2)});
  return out;
}

/* Collapsed by default, using the same disclosure idiom the squad cards
   already use - a bracket can be fifteen matches, and fifteen expanded
   statistics panels is not a results screen. A one-off Final opens it. */
function simRenderMatchDetail(m, open){
  const motm = simManOfTheMatch(m);
  const motmHTML = motm ? `
    <div class="sim-motm">
      <span class="sim-motm-label">⭐ ${esc(t('sim.manOfTheMatch'))}</span>
      <span class="sim-motm-who">${esc(motm.ref.name)}</span>
      <span class="sim-motm-rating">${motm.rating.toFixed(1)}</span>
    </div>` : '';

  return `
    <details class="stats-disclosure sim-detail"${open ? ' open' : ''}>
      <summary>
        <span class="sd-title">${esc(t('sim.matchSummary'))}</span>
        <span class="sd-hint"></span>
      </summary>
      <div class="sim-detail-body">
        ${motmHTML}
        <div class="sim-block-sub">${esc(t('sim.matchStats'))}</div>
        ${simRenderMatchStats(m)}
        <div class="sim-block-sub">${esc(t('sim.playerRatings'))}</div>
        ${simRenderPlayerRatings(m)}
        <div class="sim-block-sub">${esc(t('sim.matchAnalysis'))}</div>
        <ul class="sim-analysis">${simMatchAnalysis(m).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      </div>
    </details>`;
}

function simRenderMatch(m, opts){
  opts = opts || {};
  const aWin = m.winner === m.a;
  const bWin = m.winner === m.b;
  const scoreText = `${m.goalsA} - ${m.goalsB}`;

  let meta = '';
  if(m.penalties){
    const pWinner = m.penalties.a > m.penalties.b ? m.a.name : m.b.name;
    meta = t('sim.metaPens', {winner: esc(pWinner), a: Math.max(m.penalties.a, m.penalties.b), b: Math.min(m.penalties.a, m.penalties.b)});
  } else if(m.extraTime){
    meta = t('sim.metaAET', {a: m.normalTimeA, b: m.normalTimeB});
  }

  const eventsHTML = (opts.showEvents !== false && m.events.length) ? `
    <div class="sim-events">
      ${m.events.map(e => `<div><span class="ev-min">${e.minute}'</span> <span class="ev-side">${e.side === 'a' ? m.a.name : m.b.name}</span> — ${e.scorer}</div>`).join('')}
    </div>` : '';

  return `
    <div class="sim-match">
      <div class="sim-match-row">
        <span class="sim-team home ${aWin ? 'win' : (bWin ? 'lose' : '')}"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${m.a.color};margin-right:6px;"></span>${esc(m.a.name)}${simHostTag(m, 'a')}</span>
        <span class="sim-score">${scoreText}</span>
        <span class="sim-team away ${bWin ? 'win' : (aWin ? 'lose' : '')}">${esc(m.b.name)}${simHostTag(m, 'b')}<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${m.b.color};margin-left:6px;"></span></span>
      </div>
      ${meta ? `<div class="sim-match-meta">${meta}</div>` : ''}
      ${eventsHTML}
      ${opts.showDetail === false ? '' : simRenderMatchDetail(m, !!opts.openDetail)}
    </div>`;
}

/* Squad Ratings. The bar is the quick read (how good is this line?) and
   the number stays next to it for the exact value - one colour per line
   so a card can be scanned without reading the labels at all:
   attack red, midfield yellow, defence green, keeper blue. */
function simRenderStrengths(teams){
  const bar = (label, val, color) => `
    <div class="sim-bar-row">
      <span class="sim-bar-label">${label}</span>
      <span class="sim-bar-track"><span class="sim-bar-fill" style="width:${Math.max(2, Math.min(100, (val - 50) / 50 * 100))}%; background:${color};"></span></span>
      <span class="sim-bar-val">${Math.round(val)}</span>
    </div>`;

  return `
    <div class="sim-block-title">${esc(t('sim.squadRatings'))}</div>
    <div class="sim-strength-grid">
      ${teams.map(t => `
        <div class="sim-strength-card">
          <div class="sim-strength-name"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${t.color};margin-right:6px;"></span>${esc(t.name)}</div>
          ${bar('ATT', t.strength.att, 'var(--red)')}
          ${bar('MID', t.strength.mid, 'var(--amber)')}
          ${bar('DEF', t.strength.def, 'var(--green)')}
          ${bar('GK', t.strength.gk, 'var(--blue)')}
        </div>`).join('')}
    </div>`;
}

/* The eleven, on a pitch.

   Deliberately laid out with the same .formation-pitch geometry the squad
   cards use, because it IS a squad - reading it should feel like reading
   one of the teams above, not like reading another table. Each player
   carries the colour of the squad they came from, which is most of the
   interest: seeing six of your own players in it, or none. */
function simRenderTeamOfTournament(xi){
  if(!xi || !xi.length) return '';
  const coords = getPlayerPositions();
  const byIdx = {};
  xi.forEach(p => { byIdx[p.posIdx] = p; });

  const spots = FORMATION.map((_, posIdx) => {
    const pos = coords[posIdx];
    if(!pos) return '';
    const p = byIdx[posIdx];
    if(!p) return '';
    return `
      <div class="pitch-player" style="left:${pos.x}%; top:${pos.y}%;">
        <div class="pos">${esc(slotCode(posIdx))} <span class="tott-dot" style="background:${esc(p.ref.teamColor || '#FFB020')};"></span><span class="tott-avg">${p.avg.toFixed(1)}</span></div>
        <div class="name" data-full="${esc(p.ref.name)}">${esc(p.ref.name)}</div>
        <div class="nat">${esc(p.ref.teamName)}</div>
      </div>`;
  }).join('');

  return `
    <div class="sim-block-title">⭐ ${esc(t('sim.teamOfTournament'))}</div>
    <div class="sim-tott-note">${esc(t('sim.teamOfTournamentSub'))}</div>
    <div class="formation-pitch sim-tott-pitch">${spots}</div>`;
}

/* The awards block. Man of the Match is per match, so a single Final
   shows just that one; anything longer shows the tournament awards and
   then the match-by-match list underneath. */
function simRenderAwards(awards, opts){
  opts = opts || {};
  if(!awards) return '';

  const who = (row, statLine) => `
    <div class="sim-award">
      <div class="sim-award-label">${esc(opts.labelPrefix || '')}${esc(row.label)}</div>
      <div class="sim-award-who">
        <span class="dot" style="background:${row.ref.teamColor};"></span>${esc(row.ref.name)}
      </div>
      <div class="sim-award-sub">${esc(row.ref.teamName)}${statLine ? ` · ${esc(statLine)}` : ''}</div>
    </div>`;

  const cards = [];
  const single = awards.motmByMatch.length === 1;

  if(!single && awards.best){
    cards.push(who({label: '🏆 ' + t('sim.bestPlayer'), ref: awards.best.ref},
      t('sim.statGA', {g: awards.best.goals, a: awards.best.assists}) +
      (awards.best.motm ? ' · ' + t('sim.statMotm', {n: awards.best.motm}) : '')));
  }
  if(awards.topScorer){
    cards.push(who({label: '🎯 ' + t('sim.topScorer'), ref: awards.topScorer.ref},
      t(awards.topScorer.goals === 1 ? 'sim.goalsOne' : 'sim.goalsMany', {n: awards.topScorer.goals})));
  }
  if(awards.topAssists){
    cards.push(who({label: '🅰️ ' + t('sim.topAssists'), ref: awards.topAssists.ref},
      t(awards.topAssists.assists === 1 ? 'sim.assistsOne' : 'sim.assistsMany', {n: awards.topAssists.assists})));
  }
  /* Tournament only. Across a single match "best goalkeeper" is just
     whichever keeper conceded fewer, which the scoreline has already
     said far more plainly than an award could. */
  if(!single && awards.bestKeeper){
    cards.push(who({label: '🧤 ' + t('sim.bestKeeper'), ref: awards.bestKeeper.ref},
      t('sim.keeperLine', {cs: awards.bestKeeper.cleanSheets, ga: awards.bestKeeper.conceded})));
  }
  if(single && awards.motmByMatch[0].motm){
    const m = awards.motmByMatch[0].motm;
    cards.push(who({label: '⭐ ' + t('sim.manOfTheMatch'), ref: m.ref},
      t('sim.statGA', {g: m.goals, a: m.assists})));
  }

  if(!cards.length) return '';

  let html = `<div class="sim-block-title">${esc(single ? t('sim.matchAwards') : t('sim.tournamentAwards'))}</div>
    <div class="sim-awards-grid">${cards.join('')}</div>`;

  // The eleven, before the per-match list - it is the headline of the
  // tournament's awards, not a footnote to them.
  html += simRenderTeamOfTournament(awards.teamOfTournament);

  // Per-match Man of the Match, once there is more than one match to
  // distinguish. Kept as a compact list rather than another grid of cards.
  if(!single){
    const rows = awards.motmByMatch.filter(x => x.motm).map(x => `
      <div class="stat-row">
        <span class="k">${esc(x.match.a.name)} ${x.match.goalsA}-${x.match.goalsB} ${esc(x.match.b.name)}</span>
        <span class="v"><span class="dot" style="background:${x.motm.ref.teamColor};"></span>${esc(x.motm.ref.name)}</span>
      </div>`).join('');
    if(rows){
      html += `<details class="stats-disclosure sim-motm-list">
          <summary><span class="sd-title">⭐ ${esc(t('sim.motmByGame'))}</span><span class="sd-hint"></span></summary>
          <div class="stat-rows">${rows}</div>
        </details>`;
    }
  }

  return html;
}

// Every format ends the same way: awards, then the squad-ratings cards.
function simRenderTail(matches, teams){
  return simRenderAwards(simComputeAwards(matches)) + simRenderStrengths(teams);
}

function simRenderTwoLegged(result, teams){
  const champ = result.champion;
  const [teamA, teamB] = teams;
  let html = '';

  if(champ){
    const decided = result.decidedBy === 'penalties'
      ? t('sim.decidedPens', {a: Math.max(result.legs[1].penalties.a, result.legs[1].penalties.b), b: Math.min(result.legs[1].penalties.a, result.legs[1].penalties.b)})
      : result.decidedBy === 'extraTime'
        ? t('sim.decidedET', {a: result.aggA, b: result.aggB})
        : t('sim.decidedAgg', {a: Math.max(result.aggA, result.aggB), b: Math.min(result.aggA, result.aggB)});
    html += `
      <div class="sim-champion">
        <div class="trophy">🏆</div>
        <div class="label">${esc(t('sim.winner'))}</div>
        <div class="who">${esc(champ.name)}</div>
        <div class="sub">${esc(decided)}</div>
      </div>`;
  }

  html += `<div class="sim-block-title">${esc(t('sim.firstLeg'))}</div>` + simRenderMatch(result.legs[0]);
  html += `<div class="sim-block-title">${esc(t('sim.secondLeg'))}</div>` + simRenderMatch(result.legs[1]);

  html += `<div class="sim-block-title">${esc(t('sim.aggregate'))}</div>
    <div class="sim-match">
      <div class="sim-match-row">
        <span class="sim-team home ${result.aggA > result.aggB ? 'win' : (result.aggB > result.aggA ? 'lose' : '')}"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${teamA.color};margin-right:6px;"></span>${esc(teamA.name)}</span>
        <span class="sim-score">${result.aggA} - ${result.aggB}</span>
        <span class="sim-team away ${result.aggB > result.aggA ? 'win' : (result.aggA > result.aggB ? 'lose' : '')}">${esc(teamB.name)}<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${teamB.color};margin-left:6px;"></span></span>
      </div>
    </div>`;

  html += simRenderTail(result.matches, teams);
  return html;
}

function simRenderKnockout(result, teams){
  const champ = result.champion;
  let html = '';

  if(champ){
    html += `
      <div class="sim-champion">
        <div class="trophy">🏆</div>
        <div class="label">${esc(t('sim.champion'))}</div>
        <div class="who">${esc(champ.name)}</div>
        <div class="sub">${esc(t('sim.wonBracket', {rating: champ.strength.overall.toFixed(1)}))}</div>
      </div>`;
  }

  result.rounds.forEach(round => {
    html += `<div class="sim-block-title">${round.name}</div>`;
    if(round.byes && round.byes.length){
      html += `<div class="sim-note" style="margin:0 0 10px;">${esc(t('sim.bye', {round: round.name, teams: round.byes.map(x => x.name).join(', ')}))}</div>`;
    }
    // A one-off Final has nothing else competing for the screen, so its
    // summary starts open; a full bracket keeps every panel collapsed.
    const onlyMatch = result.rounds.reduce((n, r) => n + r.matches.length, 0) === 1;
    html += round.matches.map(m => simRenderMatch(m, {openDetail: onlyMatch})).join('');
  });

  html += simRenderTail(result.rounds.flatMap(r => r.matches), teams);
  return html;
}

function simRenderLeague(result, teams){
  const champ = result.champion;
  let html = '';

  if(champ){
    const row = result.table[0];
    html += `
      <div class="sim-champion">
        <div class="trophy">🏆</div>
        <div class="label">${esc(t('sim.winners'))}</div>
        <div class="who">${esc(champ.name)}</div>
        <div class="sub">${esc(t('sim.leagueSummary', {pts: row.pts, played: row.p, w: row.w, d: row.d, l: row.l}))}</div>
      </div>`;
  }

  html += `<div class="sim-block-title">${esc(t('sim.finalTable'))}</div>
    <div class="sim-table-wrap">
      <table class="sim-table">
        <thead>
          <tr>
            <th style="width:28px;">#</th>
            <th class="team-col">${esc(t('sim.tableSquad'))}</th>
            <th>P</th><th>W</th><th>D</th><th>L</th>
            <th>GF</th><th>GA</th><th>GD</th><th>Pts</th>
          </tr>
        </thead>
        <tbody>
          ${result.table.map((r, i) => {
            const gd = r.gf - r.ga;
            return `
            <tr class="${i === 0 ? 'champ' : ''}">
              <td class="pos-num">${i + 1}</td>
              <td class="team-col"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${r.team.color};margin-right:6px;"></span>${esc(r.team.name)}</td>
              <td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
              <td>${r.gf}</td><td>${r.ga}</td><td>${gd > 0 ? '+' : ''}${gd}</td>
              <td class="pts">${r.pts}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  html += `<div class="sim-block-title">${esc(result.legs === 2 ? t('sim.allResultsTwoLegs') : t('sim.allResults'))}</div>`;
  // Goalscorer lists are shown for knockout ties (there are few of
  // them and each one matters); a full round robin can be 45 matches,
  // where the same lists would bury the table.
  html += result.matches.map(m => simRenderMatch(m, {showEvents:false})).join('');

  html += simRenderTail(result.matches, teams);
  return html;
}

/* ---- Wiring ---- */

let simSelectedMode = 'knockout';
let simLastRenderedKey = null;

/* ---------- Live playback ----------
   The tournament is fully simulated up front (deterministically, from
   the seed); playback only REVEALS it, one commentary line at a time.

   That split is what makes "skip" work the way it was asked to online:
   playback state lives entirely in this browser tab and is never written
   to Firebase, so one participant skipping to the final table has no
   effect on anyone else - everybody is watching their own playhead over
   an identical, already-decided tournament. */

let simPlaybackHandle = null;   // setTimeout id for the next line
let simPlaybackToken = 0;       // bumped to orphan any in-flight playback

const SIM_LINE_MS = 950;        // normal commentary line
const SIM_GOAL_MS = 1500;       // goals hang a beat longer
const SIM_MATCH_GAP_MS = 1100;  // pause between matches

/* Playback speed multiplier. This ONLY divides the delay between lines -
   the entire tournament was decided by the seed before the first line was
   drawn, so watching at 2x, at 1x, or skipping outright all reveal the
   identical result. Kept at module scope so the choice survives from one
   match to the next within a tournament. */
let simSpeed = 1;

/* Roughly how much taller the live panel gets once commentary starts
   filling the feed, used when deciding whether the broadcast needs
   scrolling into view. Kept a little under .sim-feed's max-height so the
   check errs toward scrolling rather than leaving a match half off the
   bottom of the screen. */
const SIM_FEED_GROWTH_ALLOWANCE = 180;

/* Whether the viewer has opened the live standings. The panel is rebuilt
   at the start of every match, so without remembering this it would snap
   shut each time - which is worse than useless for the one person who
   actually wants to follow the table. */
let simStandingsOpen = false;

function simStopPlayback(){
  simPlaybackToken++;
  clearTimeout(simPlaybackHandle);
  simPlaybackHandle = null;
}

// Flattens the whole tournament into one ordered list of things to show.
function simBuildPlayQueue(mode, result){
  const queue = [];
  if(mode === 'twoleg'){
    queue.push({type:'match', match:result.legs[0], label:t('sim.firstLeg')});
    /* The second leg carries the first one with it, so the panel can say
       what the tie stands at rather than showing a 0-0 that means nothing
       on its own. Note the sides SWAP between legs (see
       simulateTwoLegged), so this is rendered with team names rather than
       positions - "first leg: A 2-1 B" reads the same either way round. */
    queue.push({type:'match', match:result.legs[1], label:t('sim.secondLeg'),
                firstLeg: result.legs[0]});
  } else if(mode === 'league'){
    result.matches.forEach((m, i) => {
      queue.push({type:'match', match:m,
                  label:t('sim.matchOf', {n: i + 1, total: result.matches.length})});
    });
  } else {
    result.rounds.forEach(round => {
      round.matches.forEach((m, i) => {
        const suffix = round.matches.length > 1
          ? ' — ' + t('sim.tieOf', {n: i + 1, total: round.matches.length}) : '';
        queue.push({type:'match', match:m, label: round.name + suffix});
      });
    });
  }
  return queue;
}

// The one place a format id turns into simulate/render behaviour, so a
// new format is added here rather than in five separate branches.
function simRunFormat(mode, teams, rng){
  if(mode === 'twoleg') return simulateTwoLegged(teams, rng);
  if(mode === 'league') return simulateLeague(teams, rng);
  return simulateKnockout(teams, rng);
}

function simRenderResult(mode, result, teams){
  if(mode === 'twoleg') return simRenderTwoLegged(result, teams);
  if(mode === 'league') return simRenderLeague(result, teams);
  return simRenderKnockout(result, teams);
}

/* Feed icons are driven by the event KIND rather than baked into the
   translated sentence - which is why the in-play commentary lines no
   longer carry their own emoji. One source per event type, so every
   language shows the same symbol and a translator can never accidentally
   change what a red card looks like. Structural lines (kick-off,
   half-time, shootout, full-time) keep the emoji in their own text and
   deliberately get no icon column. */
const SIM_EVENT_ICONS = {
  goal: '⚽', yellow: '🟨', red: '🟥', corner: '🚩',
  freekick: '🎯', chance: '⚠️', defend: '🛡', midfield: '⚔'
};

/* The "playing at home" marker. Deliberately one small letter on one side
   rather than labelling both: marking the host implies the visitor, and
   two badges on a scoreboard is one more thing to read for no extra
   information. Returns nothing at all for a neutral match, which is how
   a final ends up showing neither.

   NB the existing .sim-team.home / .away classes mean LEFT and RIGHT on
   the match row - nothing to do with who is hosting - hence the separate
   name here. */
function simHostTag(m, side){
  if(!m || m.homeSide !== side) return '';
  return ` <span class="sim-host-tag" title="${esc(t('sim.playingAtHome'))}">${esc(t('sim.homeShort'))}</span>`;
}

/* The live statistics strip. Both figures are READ from the series the
   match model already produced (simPossessionAt and the per-shot xG
   timeline) - nothing here recalculates anything, so what is on screen is
   literally what shaped the scoreline. */
function simRenderLiveStats(m, minute){
  const poss = simPossessionAt(m.possessionBlocks || [], minute);
  let xgA = 0, xgB = 0;
  (m.shotTimeline || []).forEach(s => {
    if(s.minute > minute) return;
    if(s.side === 'a') xgA += s.xg; else xgB += s.xg;
  });
  const pctA = Math.round(poss * 100);
  const xgTotal = xgA + xgB;
  const row = (label, aTxt, bTxt, aShare) => `
    <div class="sim-stat-row">
      <span class="sim-stat-val">${esc(aTxt)}</span>
      <span class="sim-stat-mid">
        <span class="sim-stat-label">${esc(label)}</span>
        <span class="sim-stat-bar"><i style="width:${aShare}%"></i></span>
      </span>
      <span class="sim-stat-val">${esc(bTxt)}</span>
    </div>`;
  return row(t('sim.possession'), pctA + '%', (100 - pctA) + '%', pctA)
       + row(t('sim.xg'), xgA.toFixed(2), xgB.toFixed(2),
             xgTotal > 0 ? Math.round(xgA / xgTotal * 100) : 50);
}

/* "Messi 20', 31'" rather than a separate line per goal - one player with
   two goals is how a scoreboard actually shows it. Only goals up to
   `minute` are listed, so the panel fills in as the match is revealed
   instead of printing the full scoresheet at kick-off. */
function simRenderScorers(m, minute){
  const colFor = side => {
    const rows = [];
    m.events
      .filter(e => e.side === side && e.minute <= minute)
      .sort((x, y) => x.minute - y.minute)
      .forEach(e => {
        const mark = e.minute + "'" + (e.origin === 'penalty' ? ' (P)' : '');
        const row = rows.find(r => r.name === e.scorer);
        if(row) row.mins.push(mark); else rows.push({name: e.scorer, mins: [mark]});
      });
    return rows.map(r =>
      `<div class="sim-scorer">⚽ ${esc(r.name)} <span>${esc(r.mins.join(', '))}</span></div>`).join('');
  };
  const a = colFor('a'), b = colFor('b');
  if(!a && !b) return '';
  return `<div class="sim-scorers-col">${a}</div><div class="sim-scorers-col right">${b}</div>`;
}

/* Live standings, for a league in progress.

   Four columns, not the ten the final table carries: position, squad,
   played, goal difference, points. That is what someone glancing mid-
   season actually wants - where am I, and who is above me - and it fits a
   phone without the horizontal scroll the full table needs.

   Collapsed by default, because standings are a thing you go and check
   between matches rather than something that should compete with the
   match being played. The two squads currently on the pitch are marked so
   the table can be read without cross-checking the scoreboard. */
function simRenderLiveStandings(teams, matches, upto, playingIds){
  const table = simLeagueTableAfter(teams, matches, upto);
  const rows = table.map((r, i) => {
    const gd = r.gf - r.ga;
    const playing = playingIds && playingIds.indexOf(r.team.id) !== -1;
    return `
      <tr class="${playing ? 'playing' : ''}">
        <td class="pos-num">${i + 1}</td>
        <td class="team-col"><span class="sim-standings-dot" style="background:${r.team.color};"></span>${esc(r.team.name)}</td>
        <td>${r.p}</td>
        <td>${gd > 0 ? '+' : ''}${gd}</td>
        <td class="pts">${r.pts}</td>
      </tr>`;
  }).join('');

  return `
    <details class="stats-disclosure sim-standings">
      <summary>
        <span class="sd-title">${esc(t('sim.standings'))}</span>
        <!-- Its own span: .sd-hint already carries the disclosure's
             Show/Hide label through ::after, so putting the match count
             in there renders "2 of 15 playedHide". -->
        <span class="sim-standings-count">${esc(t('sim.playedOf', {n: upto, total: matches.length}))}</span>
        <span class="sd-hint"></span>
      </summary>
      <table class="sim-standings-table">
        <thead>
          <tr>
            <th style="width:22px;">#</th>
            <th class="team-col">${esc(t('sim.tableSquad'))}</th>
            <th>P</th><th>GD</th><th>Pts</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

function simRenderLiveShell(){
  return `
    <div class="sim-live" id="simLive">
      <div class="sim-live-head">
        <span class="sim-live-stage" id="simLiveStage">${esc(t('sim.kickoffLabel'))}</span>
        <span class="sim-live-progress" id="simLiveProgress"></span>
        <span class="sim-speed" id="simSpeedRow">
          <button class="sim-speed-btn active" data-speed="1">${esc(t('sim.speed1x'))}</button>
          <button class="sim-speed-btn" data-speed="2">${esc(t('sim.speed2x'))}</button>
          <button class="sim-skip-btn" id="simSkipBtn">${esc(t('sim.skipBtn'))}</button>
        </span>
      </div>
      <div class="sim-scoreboard">
        <span class="sim-sb-team" id="simSbTeamA">—</span>
        <span>
          <span class="sim-sb-score" id="simSbScore">0 - 0</span>
          <div class="sim-sb-clock" id="simSbClock">0'</div>
        </span>
        <span class="sim-sb-team" id="simSbTeamB">—</span>
      </div>
      <div class="sim-firstleg" id="simFirstLeg" style="display:none;"></div>
      <div class="sim-scorers" id="simScorers"></div>
      <div class="sim-livestats" id="simLiveStats"></div>
      <div class="sim-feed" id="simFeed"></div>
      <div class="sim-standings-slot" id="simStandings" style="display:none;"></div>
    </div>`;
}

// Plays the queue, then hands off to the static full-results render.
function simStartPlayback(mode, result, teams){
  simStopPlayback();
  const token = ++simPlaybackToken;
  const out = document.getElementById('simOutput');
  out.innerHTML = simRenderLiveShell();

  /* Bring the broadcast into view if it opened below the fold.

     Pressing Run inserts a tall panel BELOW the button that was pressed,
     and the simulation now sits at the top of the results screen where
     there is a lot of page under it - so on a short viewport the match
     can start playing entirely off-screen and read as "nothing
     happened". Only scrolls when the panel is actually out of view, and
     only as far as it has to ('nearest'), so it never yanks the page on
     a screen where it was already visible. */
  const live = document.getElementById('simLive');
  if(live){
    const box = live.getBoundingClientRect();
    /* The panel is measured EMPTY here and grows as commentary arrives
       (bounded by .sim-feed's max-height), so "it fits right now" is not
       the same as "it will still fit" - leave room for the feed, or the
       match ends up playing out below the fold anyway.

       'start' rather than 'nearest': nearest does nothing at all when an
       element is already partly on screen, which is exactly this case. */
    const roomNeeded = box.height + SIM_FEED_GROWTH_ALLOWANCE;
    const comfortable = box.top >= 0 && box.top + roomNeeded <= window.innerHeight;
    if(!comfortable) live.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  const queue = simBuildPlayQueue(mode, result);
  const finish = () => {
    if(token !== simPlaybackToken) return;
    simStopPlayback();
    out.innerHTML = simRenderResult(mode, result, teams);
    // The Team of the Tournament is drawn on a real pitch, and pitch
    // cards are narrow - long names need the same shrink-to-fit pass the
    // squad cards get, or they clip mid-surname.
    fitAllPitchNames(out);
    // Only offered once the result is actually on screen: sharing a
    // scoreline you have not seen yet spoils your own match.
    const share = document.getElementById('simShareBtn');
    if(share) share.style.display = '';
  };

  /* Skipping stops the REVEAL, never the match - every result was decided
     by the seed before a single line was shown, so what the confirmation
     jumps to is byte-identical to what watching it through would give.
     Uses the shared in-page confirm rather than window.confirm(), which
     blocks the tab and stalls Firebase callbacks during an online room. */
  document.getElementById('simSkipBtn').onclick = () => {
    showConfirm({
      title: t('sim.skipConfirmTitle'),
      text: t('sim.skipConfirmBody'),
      okLabel: t('sim.skipConfirmYes'),
      danger: false
    }, finish);
  };

  const speedRow = document.getElementById('simSpeedRow');
  speedRow.querySelectorAll('.sim-speed-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.speed) === simSpeed);
    btn.onclick = () => {
      simSpeed = Number(btn.dataset.speed) || 1;
      speedRow.querySelectorAll('.sim-speed-btn')
        .forEach(b => b.classList.toggle('active', b === btn));
    };
  });

  let qi = 0, li = 0;
  const feed = () => document.getElementById('simFeed');
  // Every delay runs through here, so 2x is one multiplier rather than a
  // second set of timings that could drift from the first.
  const wait = ms => setTimeout(step, Math.max(60, ms / simSpeed));

  const step = () => {
    if(token !== simPlaybackToken) return;
    if(qi >= queue.length){ finish(); return; }

    const item = queue[qi];
    const m = item.match;
    const lines = m.commentary || [];

    // Start of a match: reset the scoreboard, scorers, stats and feed.
    if(li === 0){
      document.getElementById('simLiveStage').textContent = item.label;
      document.getElementById('simLiveProgress').textContent = `${qi + 1}/${queue.length}`;
      // Host marker, and only on the side that actually is one - a
      // neutral final carries no homeSide and so shows nothing.
      document.getElementById('simSbTeamA').innerHTML = esc(m.a.name) + simHostTag(m, 'a');
      document.getElementById('simSbTeamB').innerHTML = esc(m.b.name) + simHostTag(m, 'b');
      document.getElementById('simSbScore').textContent = '0 - 0';
      document.getElementById('simSbClock').textContent = "0'";
      document.getElementById('simScorers').innerHTML = '';
      document.getElementById('simLiveStats').innerHTML = simRenderLiveStats(m, 0);
      // Second leg of a tie: state where it stands after the first.
      const flEl = document.getElementById('simFirstLeg');
      if(item.firstLeg){
        const f = item.firstLeg;
        flEl.innerHTML = esc(t('sim.firstLegScore', {
          a: f.a.name, sa: f.goalsA, sb: f.goalsB, b: f.b.name
        }));
        flEl.style.display = '';
      } else {
        flEl.style.display = 'none';
        flEl.innerHTML = '';
      }
      feed().innerHTML = '';

      /* Standings, refreshed once per match rather than per event. A
         table that reshuffles mid-match is motion in the one part of the
         screen meant to be still, and `qi` matches completed is exactly
         the state the table should show while match qi is being played.

         Leagues only - a bracket has no table - and only once there are
         enough squads for one to say anything. Two or three squads play a
         double round robin of a handful of matches, where the scoreline
         already tells you everything a table could. */
      const standEl = document.getElementById('simStandings');
      const showTable = mode === 'league' && teams.length >= 4 && result.matches;
      if(showTable){
        standEl.innerHTML = simRenderLiveStandings(teams, result.matches, qi, [m.a.id, m.b.id]);
        const det = standEl.querySelector('details');
        if(det){
          det.open = simStandingsOpen;
          det.addEventListener('toggle', () => { simStandingsOpen = det.open; });
        }
        standEl.style.display = '';
      } else {
        standEl.style.display = 'none';
        standEl.innerHTML = '';
      }
    }

    if(li >= lines.length){
      qi++; li = 0;
      simPlaybackHandle = wait(SIM_MATCH_GAP_MS);
      return;
    }

    const line = lines[li];
    const row = document.createElement('div');
    row.className = `sim-feed-line ${line.kind || ''}`;
    const icon = SIM_EVENT_ICONS[line.kind];
    row.innerHTML = `<span class="sim-feed-min">${line.minute}'</span>` +
      (icon ? `<span class="sim-feed-icon">${icon}</span>` : '') +
      `<span class="sim-feed-txt">${simLineText(line)}</span>`;
    const f = feed();
    f.appendChild(row);
    f.scrollTop = f.scrollHeight;

    const scoreEl = document.getElementById('simSbScore');
    scoreEl.textContent = `${line.scoreA} - ${line.scoreB}`;
    document.getElementById('simSbClock').textContent = `${line.minute}'`;
    // Both panels read the match as of THIS minute, so they climb with
    // the feed rather than sitting on their full-time values.
    document.getElementById('simLiveStats').innerHTML = simRenderLiveStats(m, line.minute);
    if(line.kind === 'goal'){
      document.getElementById('simScorers').innerHTML = simRenderScorers(m, line.minute);
      scoreEl.classList.remove('flash');
      void scoreEl.offsetWidth; // restart the animation
      scoreEl.classList.add('flash');
      sounds.bid();
    }

    li++;
    simPlaybackHandle = wait(line.kind === 'goal' ? SIM_GOAL_MS : SIM_LINE_MS);
  };

  step();
}

/* ---------- Shareable result card ----------

   A picture of how the tournament finished, for the group chat it came
   out of. Deliberately NOT the export: the JSON and text exports are a
   machine-readable copy of the squads, meant to be handed to an AI to
   judge, and they stay exactly as they are. This is the human end of the
   same story; neither replaces the other.

   Drawn on a canvas rather than screenshotted from the DOM, because the
   results screen is a tall scrolling page and what people post is one
   image that has to read at thumbnail size. */

const SHARE_W = 1080;
const SHARE_H = 1350;

// Whatever the last simulation produced, so the card can be built on
// demand rather than rendered speculatively after every run.
let simShareContext = null;

/* Canvas has no wrapping and no ellipsis. Shrink to fit rather than
   truncate - a champion's name is the one thing here that must never be
   cut short. */
function shareFitText(ctx, text, maxWidth, weight, size, family){
  let px = size;
  do {
    ctx.font = `${weight} ${px}px ${family}`;
    if(ctx.measureText(text).width <= maxWidth) break;
    px -= 2;
  } while(px > 14);
  return px;
}

// How the champion actually won it, in one line, per format.
function shareHeadline(mode, result){
  if(mode === 'league' && result.table && result.table[0]){
    const r = result.table[0];
    return t('sim.leagueSummary', {pts: r.pts, played: r.p, w: r.w, d: r.d, l: r.l});
  }
  if(mode === 'twoleg' && result.legs){
    if(result.decidedBy === 'penalties'){
      const p = result.legs[1].penalties;
      return t('sim.metaPens', {winner: result.champion ? result.champion.name : '',
        a: Math.max(p.a, p.b), b: Math.min(p.a, p.b)});
    }
    return t('sim.decidedAgg', {
      a: Math.max(result.aggA, result.aggB),
      b: Math.min(result.aggA, result.aggB)
    });
  }
  const rounds = result.rounds || [];
  const last = rounds[rounds.length - 1];
  const m = last && last.matches && last.matches[0];
  if(!m) return '';
  const pens = m.penalties
    ? ` (${Math.max(m.penalties.a, m.penalties.b)}-${Math.min(m.penalties.a, m.penalties.b)} pens)` : '';
  return `${m.a.name} ${m.goalsA} - ${m.goalsB} ${m.b.name}${pens}`;
}

// Every match the format played, flattened - the awards are counted from
// this, exactly as the results screen counts them.
function shareMatchesOf(mode, result){
  if(mode === 'league') return result.matches || [];
  if(mode === 'twoleg') return result.legs || [];
  return (result.rounds || []).flatMap(r => r.matches);
}

async function simBuildShareCard(){
  if(!simShareContext) return null;
  const {mode, result} = simShareContext;

  // Let the webfonts land first - a card drawn mid-load falls back to a
  // system face and looks nothing like the game it came from.
  try { if(document.fonts && document.fonts.ready) await document.fonts.ready; } catch(e){}

  const canvas = document.createElement('canvas');
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const ctx = canvas.getContext('2d');
  const OSWALD = "'Oswald', Impact, sans-serif";
  const INTER = "'Inter', Helvetica, Arial, sans-serif";
  const MONO = "'Space Mono', 'Courier New', monospace";
  const mid = SHARE_W / 2;
  const space = v => { if('letterSpacing' in ctx) ctx.letterSpacing = v; };

  ctx.fillStyle = '#0B1F17';
  ctx.fillRect(0, 0, SHARE_W, SHARE_H);
  const glow = ctx.createRadialGradient(mid, 240, 0, mid, 240, 820);
  glow.addColorStop(0, 'rgba(62,207,107,0.16)');
  glow.addColorStop(1, 'rgba(62,207,107,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SHARE_W, SHARE_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  ctx.font = `700 58px ${OSWALD}`;
  space('8px');
  const wmW = ctx.measureText('AUCTION XI').width;
  ctx.fillStyle = '#F5F7F2';
  ctx.textAlign = 'left';
  ctx.fillText('AUCTION ', mid - wmW / 2, 138);
  const auctionW = ctx.measureText('AUCTION ').width;
  ctx.fillStyle = '#FFB020';
  ctx.fillText('XI', mid - wmW / 2 + auctionW, 138);
  space('0px');
  ctx.textAlign = 'center';

  ctx.fillStyle = '#8CA097';
  ctx.font = `400 26px ${INTER}`;
  ctx.fillText(`${activeMode().name}  ·  ${poolName(activePoolDisplay())}`, mid, 192);

  ctx.strokeStyle = 'rgba(245,247,242,0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(150, 236); ctx.lineTo(SHARE_W - 150, 236); ctx.stroke();

  ctx.font = `400 86px ${INTER}`;
  ctx.fillStyle = '#F5F7F2';
  ctx.fillText('🏆', mid, 352);

  ctx.fillStyle = '#FFB020';
  ctx.font = `600 26px ${OSWALD}`;
  space('6px');
  ctx.fillText(String(t('sim.champion')).toUpperCase(), mid, 414);
  space('0px');

  const champ = result.champion;
  if(champ){
    ctx.fillStyle = '#F5F7F2';
    const px = shareFitText(ctx, champ.name, SHARE_W - 170, 700, 86, OSWALD);
    ctx.font = `700 ${px}px ${OSWALD}`;
    ctx.fillText(champ.name, mid, 508);
  }

  const head = shareHeadline(mode, result);
  if(head){
    ctx.fillStyle = '#8CA097';
    const hpx = shareFitText(ctx, head, SHARE_W - 190, 400, 30, INTER);
    ctx.font = `400 ${hpx}px ${INTER}`;
    ctx.fillText(head, mid, 562);
  }

  const awards = simComputeAwards(shareMatchesOf(mode, result));
  const rows = [];
  if(awards.topScorer){
    rows.push(['🎯', t('sim.topScorer'), awards.topScorer.ref.name,
      t(awards.topScorer.goals === 1 ? 'sim.goalsOne' : 'sim.goalsMany', {n: awards.topScorer.goals}),
      awards.topScorer.ref.teamColor]);
  }
  if(awards.best){
    rows.push(['🏅', t('sim.bestPlayer'), awards.best.ref.name,
      t('sim.statGA', {g: awards.best.goals, a: awards.best.assists}), awards.best.ref.teamColor]);
  }
  if(awards.bestKeeper){
    rows.push(['🧤', t('sim.bestKeeper'), awards.bestKeeper.ref.name,
      t('sim.keeperLine', {cs: awards.bestKeeper.cleanSheets, ga: awards.bestKeeper.conceded}),
      awards.bestKeeper.ref.teamColor]);
  }

  const boxX = 110, boxW = SHARE_W - 220, boxH = 132;
  let y = 648;
  rows.slice(0, 3).forEach(([icon, label, who, sub, colour]) => {
    ctx.fillStyle = 'rgba(19,47,34,0.9)';
    if(ctx.roundRect){ ctx.beginPath(); ctx.roundRect(boxX, y, boxW, boxH, 18); ctx.fill(); }
    else ctx.fillRect(boxX, y, boxW, boxH);
    ctx.strokeStyle = 'rgba(245,247,242,0.10)';
    ctx.lineWidth = 2;
    if(ctx.roundRect){ ctx.beginPath(); ctx.roundRect(boxX, y, boxW, boxH, 18); ctx.stroke(); }
    else ctx.strokeRect(boxX, y, boxW, boxH);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#F5F7F2';
    ctx.font = `400 42px ${INTER}`;
    ctx.fillText(icon, boxX + 32, y + 86);

    // The squad's colour, so one glance says how spread the awards were.
    ctx.fillStyle = colour || '#FFB020';
    ctx.beginPath(); ctx.arc(boxX + 116, y + 42, 8, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#8CA097';
    ctx.font = `400 22px ${OSWALD}`;
    ctx.fillText(String(label).toUpperCase(), boxX + 136, y + 50);

    /* The stat is measured BEFORE the name, so the name can be given the
       room that is actually left rather than a guessed reservation. A
       fixed allowance was fine for "2 goals" and collided badly with
       "2 clean sheets · 2 conceded". The stat itself shrinks first if it
       is very long, since it is the shorter string of the two. */
    const NAME_X = boxX + 136;
    const RIGHT_X = boxX + boxW - 32;
    const subPx = shareFitText(ctx, sub, boxW * 0.44, 700, 28, MONO);
    ctx.font = `700 ${subPx}px ${MONO}`;
    const subW = ctx.measureText(sub).width;

    ctx.fillStyle = '#F5F7F2';
    const nameRoom = Math.max(160, (RIGHT_X - subW - 26) - NAME_X);
    const npx = shareFitText(ctx, who, nameRoom, 700, 38, INTER);
    ctx.font = `700 ${npx}px ${INTER}`;
    ctx.fillText(who, NAME_X, y + 102);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#FFB020';
    ctx.font = `700 ${subPx}px ${MONO}`;
    ctx.fillText(sub, RIGHT_X, y + 88);

    ctx.textAlign = 'center';
    y += boxH + 20;
  });

  ctx.fillStyle = 'rgba(245,247,242,0.12)';
  ctx.fillRect(150, SHARE_H - 150, SHARE_W - 300, 2);
  ctx.fillStyle = '#8CA097';
  ctx.font = `400 28px ${MONO}`;
  ctx.fillText('auctionxi.app', mid, SHARE_H - 92);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

/* Share sheet where there is one, download where there is not. The Web
   Share API needs a gesture and a secure context, so the download path
   is not an exotic fallback - it is what every desktop browser does. */
/* ================= THE SQUAD CARD =================

   simBuildShareCard() above shares the TOURNAMENT - champion, top scorer,
   best keeper. That is the epilogue. The game is the draft, and the thing a
   drafter actually wants to show somebody is the eleven they built and what
   they paid for it, which nothing could produce.

   Everything expensive is already here and is reused rather than rebuilt: the
   canvas size, shareFitText (canvas has no wrapping and no ellipsis), the
   three font stacks, and simShareBlob for the share-sheet-or-download path.
   What is new is the pitch, and its coordinates are the same percentage table
   the live formation uses in the auction - one source for where a left back
   stands, so the card cannot disagree with the game. */

function squadCardName(p){
  // "R. Dias" rather than "Ruben Dias": eleven full names at this size
  // either collide or shrink to unreadable. The surname is what identifies
  // a footballer anyway.
  const parts = String(p.name || '').trim().split(/\s+/);
  if(parts.length < 2) return parts[0] || '';
  return parts[0][0] + '. ' + parts.slice(1).join(' ');
}

async function simBuildSquadCard(participant, placing){
  const canvas = document.createElement('canvas');
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const ctx = canvas.getContext('2d');
  const OSWALD = "'Oswald', Impact, sans-serif";
  const INTER = "'Inter', Helvetica, Arial, sans-serif";
  const MONO = "'Space Mono', 'Courier New', monospace";
  const mid = SHARE_W / 2;
  const space = v => { if('letterSpacing' in ctx) ctx.letterSpacing = v; };

  ctx.fillStyle = '#0B1F17';
  ctx.fillRect(0, 0, SHARE_W, SHARE_H);

  // ---- masthead, matching the result card so the two read as a set ----
  ctx.textAlign = 'left';
  space('6px');
  ctx.font = `700 46px ${OSWALD}`;
  const wmW = ctx.measureText('AUCTION XI').width;
  ctx.fillStyle = '#F5F7F2';
  ctx.fillText('AUCTION ', mid - wmW / 2, 96);
  const auctionW = ctx.measureText('AUCTION ').width;
  ctx.fillStyle = '#FFB020';
  ctx.fillText('XI', mid - wmW / 2 + auctionW, 96);
  space('0px');

  ctx.textAlign = 'center';
  ctx.fillStyle = '#8CA097';
  ctx.font = `400 24px ${MONO}`;
  ctx.fillText(`${activeMode().name}  ·  ${selectedFormation}`, mid, 138);

  // ---- who ----
  ctx.fillStyle = '#F5F7F2';
  const npx = shareFitText(ctx, participant.name, SHARE_W - 200, 700, 66, OSWALD);
  ctx.font = `700 ${npx}px ${OSWALD}`;
  ctx.fillText(participant.name, mid, 214);

  if(placing){
    ctx.fillStyle = '#FFB020';
    ctx.font = `700 26px ${MONO}`;
    ctx.fillText(placing.toUpperCase(), mid, 254);
  }

  // ---- the pitch ----
  const PX = 90, PY = 300, PW = SHARE_W - 180, PH = 760;
  const g = ctx.createLinearGradient(0, PY, 0, PY + PH);
  g.addColorStop(0, '#16452F');
  g.addColorStop(1, '#0F3222');
  ctx.fillStyle = g;
  ctx.fillRect(PX, PY, PW, PH);
  ctx.strokeStyle = 'rgba(245,247,242,0.18)';
  ctx.lineWidth = 3;
  ctx.strokeRect(PX, PY, PW, PH);
  // halfway line and centre circle
  ctx.beginPath();
  ctx.moveTo(PX, PY + PH / 2); ctx.lineTo(PX + PW, PY + PH / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mid, PY + PH / 2, 78, 0, Math.PI * 2);
  ctx.stroke();
  // the box the keeper defends, at the bottom where he is drawn
  const boxW = PW * 0.54, boxH = PH * 0.16;
  ctx.strokeRect(mid - boxW / 2, PY + PH - boxH, boxW, boxH);

  const coords = getPlayerPositions();
  const byIdx = {};
  (participant.squad || []).forEach(pl => { byIdx[pl.posIdx] = pl; });

  /* A FORMATION entry is {code, label}, not a string - stringifying it
     printed "[object Object]" in every one of the eleven dots. */
  FORMATION.forEach((slot, posIdx) => {
    const slotCode = (slot && slot.code) ? slot.code : String(slot || '');
    const c = coords[posIdx];
    if(!c) return;
    const cx = PX + (c.x / 100) * PW;
    const cy = PY + (c.y / 100) * PH;
    const player = byIdx[posIdx];

    // the dot
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.fillStyle = player ? (participant.color || '#5FBE8C') : 'rgba(245,247,242,0.10)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(11,31,23,0.55)';
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#0B1F17';
    ctx.font = `700 15px ${MONO}`;
    ctx.fillText(String(slotCode), cx, cy + 5);

    if(player){
      ctx.fillStyle = '#F5F7F2';
      const label = squadCardName(player);
      const lpx = shareFitText(ctx, label, 168, 700, 21, INTER);
      ctx.font = `700 ${lpx}px ${INTER}`;
      ctx.fillText(label, cx, cy + 48);

      ctx.fillStyle = '#FFB020';
      ctx.font = `700 18px ${MONO}`;
      ctx.fillText(fmt(player.price || 0), cx, cy + 70);
    }
  });

  // ---- the numbers that make it a boast ----
  const spent = BUDGET - participant.budget;
  const avg = (participant.squad && participant.squad.length)
    ? squadAvgRating(participant).toFixed(1) : '—';
  const statY = PY + PH + 78;
  const cells = [
    [t('results.avgRatingShort') || 'RATING', String(avg)],
    [t('sim.cardSpent') || 'SPENT', fmt(spent)],
    [t('sim.cardLeft') || 'LEFT', fmt(participant.budget)],
  ];
  const cellW = (SHARE_W - 180) / cells.length;
  cells.forEach(([label, value], i) => {
    const cx = 90 + cellW * i + cellW / 2;
    ctx.fillStyle = '#8CA097';
    ctx.font = `400 22px ${MONO}`;
    space('3px');
    ctx.fillText(String(label).toUpperCase(), cx, statY);
    space('0px');
    ctx.fillStyle = '#F5F7F2';
    const vpx = shareFitText(ctx, String(value), cellW - 30, 700, 46, OSWALD);
    ctx.font = `700 ${vpx}px ${OSWALD}`;
    ctx.fillText(String(value), cx, statY + 56);
  });

  ctx.fillStyle = 'rgba(245,247,242,0.12)';
  ctx.fillRect(150, SHARE_H - 108, SHARE_W - 300, 2);
  ctx.fillStyle = '#8CA097';
  ctx.font = `400 26px ${MONO}`;
  ctx.fillText('auctionxi.app', mid, SHARE_H - 58);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

/* Hand a finished PNG to the platform: share sheet where there is one,
   download where there is not. The Web Share API needs a gesture and a secure
   context, so the download path is not an exotic fallback - it is what every
   desktop browser does.

   Extracted from simShareResultCard when the squad card arrived, so there is
   one implementation of "dismissing the sheet is not a failure" rather than
   two that can drift apart. */
async function simShareBlob(blob, filename, event){
  if(!blob) return;
  const file = new File([blob], filename, {type: 'image/png'});

  if(navigator.canShare && navigator.canShare({files: [file]})){
    try {
      await navigator.share({files: [file], title: t('sim.shareTitle')});
      track(event, {method: 'share_sheet'});
      return;
    } catch(err){
      // Dismissing the sheet is not a failure, and must not then drop a
      // file into their downloads folder as a consolation prize.
      if(err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
    }
  }

  saveFile(filename, blob);
  track(event, {method: 'download'});
}

async function simShareResultCard(){
  const btn = document.getElementById('simShareBtn');
  if(btn) btn.disabled = true;
  try {
    await simShareBlob(await simBuildShareCard(), 'auction-xi-result.png', 'result_shared');
  } catch(err){
    console.error('Share card failed', err);
    mpShowToast(t('sim.shareFailed'), 'error');
  } finally {
    if(btn) btn.disabled = false;
  }
}

/* Share one participant's eleven. Bound from the button rendered onto every
   squad card in displaySquads(). */
async function simShareSquadCard(pid, btn){
  const p = (state.participants || []).find(x => String(x.id) === String(pid));
  if(!p) return;
  if(btn) btn.disabled = true;
  try {
    const ranked = [...state.participants].sort((a, b) => squadAvgRating(b) - squadAvgRating(a));
    const idx = ranked.findIndex(x => x.id === p.id);
    const placing = idx >= 0 ? t('sim.cardPlacing', {n: idx + 1, total: ranked.length}) : '';
    await simShareBlob(await simBuildSquadCard(p, placing), 'auction-xi-squad.png', 'squad_shared');
  } catch(err){
    console.error('Squad card failed', err);
    mpShowToast(t('sim.shareFailed'), 'error');
  } finally {
    if(btn) btn.disabled = false;
  }
}

// The single entry point that actually produces output. Given the same
// (mode, seed) it produces byte-identical results on every device -
// see the note at the top of this section.
function runSimulation(mode, seed){
  const out = document.getElementById('simOutput');
  const teams = simBuildTeams();
  if(teams.length < 2){
    out.innerHTML = `<div class="sim-note">${esc(t('sim.needTwo'))}</div>`;
    return;
  }

  const rng = makeRng(seed);
  const result = simRunFormat(mode, teams, rng);
  simLastRenderedKey = mode + ':' + seed;

  simSelectedMode = mode;
  [...document.querySelectorAll('#simModeRow .sim-mode-btn')].forEach(b => {
    b.classList.toggle('active', b.dataset.simMode === mode);
  });

  // Post-draft engagement: whether finishing a draft is the end of the
  // session or the start of the part people actually stay for.
  track('simulation_run', trackDraftContext({
    format: mode,               // knockout | league | twoleg
    teams: teams.length,
  }));

  // Kept for the share card, which is built on demand once the match has
  // actually been watched (see finish() in simStartPlayback).
  simShareContext = {mode, result, teams};

  simStartPlayback(mode, result, teams);
}

/* Which formats a field of this size can actually play.

   With two squads a "knockout bracket" is one match and a "mini league"
   is a two-game round robin - both accurate and both silly things to
   call it, so two squads are offered the two things that tie really is:
   a one-off Final, or a home-and-away tie settled on aggregate.

   'knockout' is reused as the id for Final rather than inventing one:
   simulateKnockout() with two teams already produces exactly a single
   match named "Final" (see knockoutRoundName), and reusing the id keeps
   ids that online rooms may already have published meaningful. */
function simFormatsFor(numTeams){
  if(numTeams === 2){
    return [
      {mode:'knockout', icon:'🥇', title:esc(t('sim.fmtFinal')), sub:esc(t('sim.fmtFinalSub'))},
      {mode:'twoleg', icon:'🔁', title:esc(t('sim.fmtTwoLeg')), sub:esc(t('sim.fmtTwoLegSub'))},
    ];
  }
  return [
    {mode:'knockout', icon:'🏆', title:esc(t('sim.fmtKnockout')), sub:esc(t('sim.fmtKnockoutSub'))},
    {mode:'league', icon:'📊', title:esc(t('sim.fmtLeague')), sub:esc(t('sim.fmtLeagueSub'))},
  ];
}

function simRenderModeButtons(numTeams, selectedMode){
  document.getElementById('simModeRow').innerHTML =
    simFormatsFor(numTeams).map(f => `
      <button class="sim-mode-btn${f.mode === selectedMode ? ' active' : ''}" data-sim-mode="${f.mode}">
        ${f.icon} ${f.title}
        <span class="sim-mode-sub">${f.sub}</span>
      </button>`).join('');
}

// Show + configure the simulation panel for whichever mode we are in.
// Offline anyone can run it; online only the host can, and the result
// is broadcast so everyone sees the same tournament.
function setupSimulationSection(){
  const section = document.getElementById('simSection');
  const runBtn = document.getElementById('simRunBtn');
  const note = document.getElementById('simNote');
  const intro = document.getElementById('simIntro');

  // A previous draft's broadcast could still be mid-playback.
  simStopPlayback();
  document.getElementById('simOutput').innerHTML = '';
  simLastRenderedKey = null;
  simSelectedMode = 'knockout';

  /* A new draft has no result yet, so the share button goes away and the
     old one's context with it - otherwise the first press on a fresh
     results screen would hand out a card for the PREVIOUS draft. */
  simShareContext = null;
  const shareBtn = document.getElementById('simShareBtn');
  if(shareBtn){
    shareBtn.style.display = 'none';
    shareBtn.onclick = simShareResultCard;
  }

  if(state.participants.length < 2){
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  simRenderModeButtons(state.participants.length, simSelectedMode);
  const modeBtns = [...document.querySelectorAll('#simModeRow .sim-mode-btn')];

  const online = !!currentRoomCode;
  const canControl = !online || isHost;

  modeBtns.forEach(b => {
    b.disabled = !canControl;
    b.onclick = () => {
      if(!canControl) return;
      simSelectedMode = b.dataset.simMode;
      modeBtns.forEach(o => o.classList.toggle('active', o === b));
    };
  });

  runBtn.style.display = canControl ? '' : 'none';
  runBtn.disabled = false;

  if(online && !canControl){
    intro.textContent = t('sim.introGuest');
    note.textContent = t('sim.waitingHost');
  } else if(online){
    intro.textContent = t('sim.introHost');
    note.textContent = '';
  } else {
    intro.textContent = t('sim.introOffline');
    note.textContent = '';
  }

  runBtn.onclick = () => {
    if(!canControl) return;
    // A fresh seed every press, so "run it again" is a genuinely
    // different tournament rather than a repaint of the same one.
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
    if(online){
      // Host publishes; the listener below renders it on every device,
      // host included, so there is exactly one render path online.
      database.ref(`rooms/${currentRoomCode}/simulation`).set({
        mode: simSelectedMode,
        seed,
        by: currentUserId,
        at: serverNow()
      }).catch(() => mpShowToast(t('mp.simShareFailed'), 'error'));
      runBtn.textContent = t('sim.runAgain');
    } else {
      runSimulation(simSelectedMode, seed);
      runBtn.textContent = t('sim.runAgain');
    }
  };
}

// Online: mirror whatever the host published. Renders for the host too
// (their own write comes straight back through this listener), which
// keeps host and guests on one code path.
function mpOnSimulationChange(sim){
  if(!sim || !sim.mode || sim.seed == null) return;
  const key = sim.mode + ':' + sim.seed;
  if(key === simLastRenderedKey) return;

  const section = document.getElementById('simSection');
  if(section.style.display === 'none') return;

  runSimulation(sim.mode, sim.seed);
  document.getElementById('simNote').textContent = isHost ? '' : t('sim.simulatedByHost');
  const runBtn = document.getElementById('simRunBtn');
  if(isHost) runBtn.textContent = t('sim.runAgain');
}

// Export functions
function exportAsJSON(){
  const exportData = {
    draftDate: new Date().toISOString(),
    settings: {
      gameMode: GAME_MODE_ID,
      poolId: activePoolId,
      formation: selectedFormation,
      budget: BUDGET,
      participants: state.participants.length,
      timer: ROUND_SECONDS,
      rerollsMode: REROLLS_MODE,
      showRatings: SHOW_RATINGS
    },
    participants: state.participants.map(p => ({
      name: p.name,
      budget: p.budget,
      spent: BUDGET - p.budget,
      squad: p.squad.map(player => ({
        name: player.name,
        position: player.pos,
        rating: player.rating,
        price: player.price,
        nationality: player.nationality,
        club: player.club
      }))
    }))
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
  saveFile(`auction-xi-draft-${Date.now()}.json`, blob);
}

function exportAsText(){
  let text = '═══════════════════════════════════════\n';
  text += '           AUCTION XI DRAFT\n';
  text += `         Formation: ${selectedFormation}\n`;
  text += '═══════════════════════════════════════\n\n';

  state.participants.forEach((p, idx) => {
    const spent = BUDGET - p.budget;
    text += `${idx + 1}. ${p.name.toUpperCase()}\n`;
    text += `${'─'.repeat(40)}\n`;
    text += `Formation: ${selectedFormation}\n\n`;

    // Group players by position for organized display
    const positionOrder = ['GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST', 'CF', 'DEF', 'MID', 'FWD'];
    const playersByPos = {};

    p.squad.forEach(player => {
      if(!playersByPos[player.pos]) playersByPos[player.pos] = [];
      playersByPos[player.pos].push(player);
    });

    positionOrder.forEach(pos => {
      if(playersByPos[pos]){
        playersByPos[pos].forEach(player => {
          const ratingStr = SHOW_RATINGS ? ` (${player.rating})` : '';
          text += `${pos.padEnd(5)} - ${player.name}${ratingStr} - ${fmt(player.price)}\n`;
        });
      }
    });

    text += `\n💰 Spent: ${fmt(spent)} | Remaining: ${fmt(p.budget)}\n`;
    if(SHOW_RATINGS){
      const avgRating = (p.squad.reduce((sum, pl) => sum + pl.rating, 0) / p.squad.length).toFixed(1);
      text += `⭐ Average Rating: ${avgRating}\n`;
    }
    text += '\n';
  });

  text += '═══════════════════════════════════════\n';
  text += 'Generated by Auction XI\n';
  text += `${new Date().toLocaleDateString()}\n`;
  text += '═══════════════════════════════════════';

  // Copy to clipboard and download
  const copyText = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error('Clipboard unavailable'));
  copyText.then(() => {
    appNotice(t('results.copiedClipboard'), 'success');
  }).catch(() => {
    // Fallback: save as a file
    saveFile(`auction-xi-draft-${Date.now()}.txt`, new Blob([text], {type: 'text/plain'}));
  });
}

// Desktop shows every field directly on the card (pos / name / nationality
// / rating+price, each on their own line - see .pitch-player CSS). Mobile
// (<=768px) hides .nat/.stats via CSS and shows only pos+name on the pitch
// itself; data-pos-idx lets endAuction() wire each rendered card up to
// showPlayerInfoPanel() so tapping it reveals the full details there instead.
function buildFormationDisplay(squad){
  // Organize players by position index
  const playersByPosIdx = {};
  squad.forEach(player => {
    playersByPosIdx[player.posIdx] = player;
  });

  // Get position coordinates for current formation
  const positions = getPlayerPositions();

  let html = '<div class="formation-pitch">';

  // Place each player on the pitch using realistic coordinates
  FORMATION.forEach((formPos, posIdx) => {
    const pos = positions[posIdx];
    if(!pos) return;

    const player = playersByPosIdx[posIdx];

    if(player){
      const ratingHTML = SHOW_RATINGS ? `<span class="rating">${esc(player.rating)}</span> · ` : '';
      html += `
        <div class="pitch-player" style="left:${pos.x}%; top:${pos.y}%;" data-pos-idx="${posIdx}">
          <div class="pos">${slotCode(posIdx)}</div>
          <div class="name" data-full="${esc(player.name)}">${esc(player.name)}</div>
          <div class="nat">${nationalityClubHTML(player)}</div>
          <div class="stats">${ratingHTML}${fmt(player.price)}</div>
        </div>
      `;
    } else {
      // Empty slot (shouldn't happen)
      html += `
        <div class="pitch-player" style="left:${pos.x}%; top:${pos.y}%;">
          <div class="pos">${slotCode(posIdx)}</div>
          <div class="name" data-full="—">—</div>
          <div class="nat"></div>
          <div class="stats">—</div>
        </div>
      `;
    }
  });

  html += '</div>';
  return html;
}

/* Longest form of a player's name that actually fits inside its pitch
   card, measured against the rendered card rather than guessed from a
   character count - the font is proportional, so "William" and "MMMMMMM"
   are nothing like the same width, and the card itself is a percentage
   of a pitch whose size depends on the device.

   On mobile the card gives the name a hard two-line box (see the
   .pitch-player .name rule), so anything that would need a third line
   overflows and gets shortened here. On desktop the name has no such
   box, nothing ever reports as overflowing, and this leaves every name
   exactly as it was.

   Order of preference, per the brief: the full name, then whichever
   single name is SHORTER (ties going to the surname, which is what
   football actually calls people by), and only then cutting characters -
   so "Sergej Milinković-Savić" becomes "Sergej" rather than a mid-word
   stump, and a name is only ever clipped when it's one long word with
   nowhere good to break. */
function fitPitchName(el){
  const full = el.dataset.full || el.textContent;

  /* Nothing to measure against means nothing sensible to decide. A card
     inside a hidden container reports zero for every dimension, so the
     overflow test below is true no matter how short the text gets and
     the loop trims all the way down to a single letter and an ellipsis.
     Leave the full name and let the resize/refit pass handle it once the
     element is actually on screen. */
  if(!el.clientWidth || !el.clientHeight){
    el.textContent = full;
    return;
  }
  // +1 absorbs sub-pixel rounding: a name occupying its box exactly can
  // otherwise report a scrollHeight a fraction above clientHeight.
  const overflows = () =>
    el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;

  el.textContent = full;
  if(!overflows()) return;

  const parts = full.split(/\s+/).filter(Boolean);
  if(parts.length > 1){
    const first = parts[0];
    const last = parts[parts.length - 1];
    const candidates = last.length <= first.length ? [last, first] : [first, last];
    for(const candidate of candidates){
      el.textContent = candidate;
      if(!overflows()) return;
    }
    el.textContent = candidates[0];
  }

  // One word, still too wide. Trim until it fits; the ellipsis is the
  // signal that there's more, and the tap panel has the full name.
  const base = el.textContent;
  for(let n = base.length - 1; n >= 1; n--){
    el.textContent = base.slice(0, n) + '…';
    if(!overflows()) return;
  }
}

// Re-fit every pitch name currently on screen. Called after the results
// screen is built and again on resize/rotate, since the card is sized as
// a percentage of the pitch and so changes width with the viewport.
function fitAllPitchNames(root){
  (root || document).querySelectorAll('.formation-pitch .pitch-player .name')
    .forEach(fitPitchName);
}

let pitchNameRefitHandle = null;
window.addEventListener('resize', () => {
  if(document.getElementById('resultsScreen').style.display !== 'block') return;
  clearTimeout(pitchNameRefitHandle);
  pitchNameRefitHandle = setTimeout(() => fitAllPitchNames(), 120);
});

// Mobile results tap panel: fills #playerInfoOverlay with a player's full
// details (called from the click handlers endAuction() wires up on each
// .pitch-player[data-pos-idx] card) and reveals it. Works regardless of
// viewport size - on desktop the same info is already visible on the card,
// so the panel is simply redundant there rather than necessary.
function showPlayerInfoPanel(player, posIdx){
  document.getElementById('playerInfoPos').textContent = slotCode(posIdx);
  document.getElementById('playerInfoName').textContent = player.name;
  const natClub = nationalityClubHTML(player);
  const natEl = document.getElementById('playerInfoNat');
  natEl.innerHTML = natClub;
  natEl.style.display = natClub ? 'block' : 'none';
  const ratingHTML = SHOW_RATINGS ? `<span class="player-info-rating">${esc(player.rating)}</span> · ` : '';
  document.getElementById('playerInfoStats').innerHTML = `${ratingHTML}${fmt(player.price)}`;
  document.getElementById('playerInfoOverlay').classList.add('show');
}

function hidePlayerInfoPanel(){
  document.getElementById('playerInfoOverlay').classList.remove('show');
}

// Offline/AI results actions. "Run another auction" returns to setup so
// the settings can be changed first - restarting with the SAME settings
// is what the in-auction Restart button is for.
document.getElementById('restartBtn').onclick = () => {
  aiStopThinking();
  document.getElementById('resultsScreen').style.display = 'none';
  document.getElementById('setupScreen').style.display = 'block';
  // Keeps whichever mode (shared screen / vs AI) the finished draft used.
  applySetupMode();
  usedPlayerIds.clear(); // Reset used players for new auction
};

document.getElementById('resultsHomeBtn').onclick = () => {
  aiStopThinking();
  simStopPlayback();
  usedPlayerIds.clear();
  state.participants = [];
  document.getElementById('resultsScreen').style.display = 'none';
  showScreen('homeScreen');
};

// Online-only results actions (see endAuction(), which shows these
// instead of restartBtn whenever currentRoomCode is set).
document.getElementById('mpBackHomeBtn').onclick = () => {
  leaveRoom();
};

document.getElementById('mpPlayAgainBtn').onclick = () => {
  if (!isHost) {
    mpShowToast(t('mp.onlyHostRestart'));
    return;
  }
  mpHostResetToLobby('restarted');
};

// Export button handlers
document.getElementById('exportJsonBtn').onclick = exportAsJSON;
document.getElementById('exportTextBtn').onclick = exportAsText;

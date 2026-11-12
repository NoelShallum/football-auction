/* ================= PLAY AGAINST AI =================
   AI mode reuses the entire single-device engine (startRound /
   startBidding / settleRound); the only difference is that participants
   1..N are driven by aiTick() instead of by someone tapping their card.
   That reuse is deliberate - forking a second draft engine would mean
   every future rule change had to be made twice and would drift. */

let AI_MODE = false;

// Each opponent gets an archetype, which is what stops them all bidding
// identically. lineBias makes a manager overpay for the part of the
// pitch they care about, aggression scales their whole valuation, and
// noise gives each squad-building run some individual character.
// starHunger is how willing this manager is to blow a big share of the
// budget on one standout instead of spreading it evenly - high means
// "stars and scrubs", low means a balanced squad of solid players.
/* Besides the dials above, three more shape how a manager reads value:

     valueSense  how much they trust the going rate for a rating (see
                 aiMarketValue). 0 ignores it; above 1 they will not let a
                 player go for less than he is worth, and bid on anyone
                 who is on offer below it, whatever their squad needs.
     rivalry     extra they will pay to stop whoever currently leads
                 the bidding, when that is the human (a grudge).
     patience    0 bids as soon as they like a price; towards 1 they sit
                 on their hands until the clock is nearly out, then pounce.
     flagPull    extra they pay for a player of their favourite nation
                 (picked at the start of the draft from the pool).
     flexPull    extra per additional position a player can play: the
                 versatile signing that makes a lineup easy to build. */
const AI_PROFILES = [
  {key:'gaffer',     name:'The Gaffer',    aggression:1.00, noise:0.14, jumpChance:0.18, starHunger:1.00, valueSense:0.90, rivalry:0,    patience:0,    flagPull:0,    flexPull:0.04,
   lineBias:{GK:1.00, DEF:1.00, MID:1.05, ATT:1.00}, blurb:'Balanced'},
  {key:'showman',    name:'The Showman',   aggression:1.16, noise:0.20, jumpChance:0.34, starHunger:1.35, valueSense:0.55, rivalry:0.08, patience:0,    flagPull:0,    flexPull:0.03,
   lineBias:{GK:0.88, DEF:0.90, MID:1.00, ATT:1.25}, blurb:'Chases superstars'},
  {key:'accountant', name:'The Accountant',aggression:0.86, noise:0.10, jumpChance:0.06, starHunger:0.70, valueSense:1.30, rivalry:0,    patience:0,    flagPull:0,    flexPull:0.04,
   lineBias:{GK:1.00, DEF:1.05, MID:1.00, ATT:0.95}, blurb:'Hunts bargains'},
  {key:'rock',       name:'The Rock',      aggression:1.04, noise:0.13, jumpChance:0.14, starHunger:0.90, valueSense:0.80, rivalry:0,    patience:0,    flagPull:0,    flexPull:0.03,
   lineBias:{GK:1.18, DEF:1.24, MID:0.95, ATT:0.85}, blurb:'Defence first'},
  {key:'maestro',    name:'The Maestro',   aggression:1.06, noise:0.15, jumpChance:0.20, starHunger:1.10, valueSense:0.80, rivalry:0,    patience:0,    flagPull:0,    flexPull:0.05,
   lineBias:{GK:0.92, DEF:0.96, MID:1.28, ATT:1.00}, blurb:'Owns the midfield'},
  {key:'wildcard',   name:'The Wildcard',  aggression:1.10, noise:0.34, jumpChance:0.40, starHunger:1.20, valueSense:0.70, rivalry:0.06, patience:0,    flagPull:0,    flexPull:0.03,
   lineBias:{GK:1.00, DEF:1.00, MID:1.00, ATT:1.10}, blurb:'Unpredictable'},
  {key:'patriot',    name:'The Patriot',   aggression:1.04, noise:0.16, jumpChance:0.20, starHunger:1.00, valueSense:0.85, rivalry:0,    patience:0,    flagPull:0.30, flexPull:0.03,
   lineBias:{GK:1.00, DEF:1.00, MID:1.00, ATT:1.00}, blurb:'Backs one nation'},
  {key:'tinkerman',  name:'The Tinkerman', aggression:1.00, noise:0.15, jumpChance:0.18, starHunger:0.95, valueSense:0.95, rivalry:0,    patience:0,    flagPull:0,    flexPull:0.11,
   lineBias:{GK:1.00, DEF:1.00, MID:1.05, ATT:1.00}, blurb:'Loves versatile players'},
  {key:'sniper',     name:'The Sniper',    aggression:1.08, noise:0.12, jumpChance:0.28, starHunger:1.05, valueSense:1.00, rivalry:0.05, patience:0.75, flagPull:0,    flexPull:0.04,
   lineBias:{GK:1.00, DEF:1.00, MID:1.00, ATT:1.05}, blurb:'Waits, then pounces'},
];

// Which third of the pitch a formation slot belongs to. Used for the
// "my defence is weak, pay up for a defender" logic.
const AI_LINE_OF = {
  GK:'GK',
  CB:'DEF', LB:'DEF', RB:'DEF', LWB:'DEF', RWB:'DEF',
  CDM:'MID', CM:'MID', CAM:'MID', LM:'MID', RM:'MID',
  LW:'ATT', RW:'ATT', ST:'ATT'
};
function aiLineOf(code){ return AI_LINE_OF[code] || 'MID'; }

// How badly this manager needs the line the current player fills.
// 1 = nothing there at all, down towards 0 = that line is already the
// strongest part of the squad. This is what makes an AI that has spent
// big on strikers start defending its budget for the back four.
function aiLineNeed(ai, posCode){
  const line = aiLineOf(posCode);
  const have = (ai.squad || []).filter(pl => aiLineOf(pl.pos) === line);
  if(have.length === 0) return 1;
  const lineAvg = have.reduce((s, x) => s + x.rating, 0) / have.length;
  const overall = squadAvgRating(ai) || lineAvg;
  // 6 rating points below the rest of the squad reads as a real hole.
  return Math.max(0, Math.min(1, (overall - lineAvg) / 6 + 0.3));
}

/* ---- Valuation: replacement value, not "fair price" ----

   The earlier model priced players at roughly fair-price x small
   multipliers, which capped every opponent around 1.25x the going rate.
   That is exactly the wrong shape for an auction draft: a human only had
   to bid slightly over that ceiling to take EVERY elite player, because
   the AI would never chase one. It also ignored two things a real
   drafter cares about most - that leftover budget is worth nothing, and
   that the players available later are strictly worse.

   The replacement model fixes both. It asks: how much better is this
   player than the one I would realistically end up with at this position
   if I lose him? That gap is the only thing worth paying for, and when
   it is large the manager will commit a huge share of the budget - which
   is what makes "stars and scrubs" a real strategy rather than an
   exploit only the human can use. */

// Rating points above replacement a typical remaining slot is worth.
// Tuning knob for the whole economy: lower makes managers spend harder
// on standouts, higher spreads their money more evenly.
const AI_TYPICAL_EDGE = 6.0;

// The personality/need multipliers are capped as a group. Individually
// they're all modest, but starHunger x aggression x lineNeed x lineBias
// x contested compounds past 2.4x, which had one manager valuing a
// 98-rated striker at 510M - over half the budget on a single player.
const AI_MAX_MODIFIER = 1.55;

/* How many more times this slot will come up before the manager has to
   have filled it. Each position is auctioned once per participant, and
   positionPhaseTracking has already been incremented for the round on
   the stage - so this counts the chances AFTER this one. Zero means
   this is the last look, and there is no alternative to buying now. */
function aiChancesLeftAt(player, numParticipants){
  const offered = positionPhaseTracking[player.posIdx] || 1;
  return Math.max(0, numParticipants - offered);
}

/* Replacement level in a RANDOM-selection mode (6v6).

   Classic's ladder guarantees the next player for a slot is weaker, so
   the player on the stage is always the best one still available and
   waiting is pure loss. 6v6 is the opposite: every pick is an
   independent uniform draw from the whole filtered category, so a weak
   player now says nothing about the next one - and with several rounds
   still to come, the manager will very likely see something better.

   So the alternative is not "the next band down", it's "the best of the
   draws I still have coming". For k remaining chances that is
   approximately the (1/(k+1)) quantile of what's left, which is what
   this returns. The more chances remain, the higher the bar the current
   player has to clear to be worth bidding on at all. */
function aiReplacementRandom(player, numParticipants){
  const pool = getPositionPool(player.pos, numParticipants)
    .filter(pl => !usedPlayerIds.has(pl.id));            // already sorted best-first
  const chancesLeft = aiChancesLeftAt(player, numParticipants);

  // Last look at this slot: nothing to wait for, so anything beats
  // nothing and the manager should be willing to pay.
  if(chancesLeft <= 0 || !pool.length) return Math.max(55, player.rating - 12);

  const idx = Math.min(pool.length - 1, Math.floor(pool.length / (chancesLeft + 1)));
  return pool[idx].rating;
}

// What this manager would realistically end up with at this position if
// they lose the current player. Every later phase band is strictly weaker
// (see getPhaseBand), so this is the honest alternative.
function aiReplacementRating(player, numParticipants){
  const bands = Math.max(1, numParticipants);
  // positionPhaseTracking has already been incremented for this round, so
  // subtracting one gives the band actually on the stage. Using that
  // rather than player.phase also gets flash players right - they carry a
  // phase-1 tag but turn up in a much later round.
  const curPhaseIdx = Math.max(0, (positionPhaseTracking[player.posIdx] || 1) - 1);

  const ratings = [];
  for(let i = curPhaseIdx + 1; i < bands; i++){
    const {band} = getPhaseBand(player.pos, i, numParticipants);
    band.forEach(pl => { if(!usedPlayerIds.has(pl.id)) ratings.push(pl.rating); });
    if(ratings.length >= 20) break;
  }

  if(!ratings.length){
    // No weaker band left - the alternative is the bottom of this one.
    const {band} = getPhaseBand(player.pos, curPhaseIdx, numParticipants);
    const left = band.filter(pl => !usedPlayerIds.has(pl.id));
    if(!left.length) return Math.max(60, player.rating - 6);
    return left[left.length - 1].rating;
  }

  ratings.sort((a, b) => b - a);
  // They won't automatically get the best of what's left, so assume they
  // land around the upper-middle of it.
  return ratings[Math.floor(ratings.length * 0.35)];
}

/* What a player of this rating normally goes for, in this mode's economy.
   expectedPriceForRating() is tuned to Classic's 1,000M for eleven; other modes
   are scaled by budget per slot so the same ratio means the same thing. */
function aiMarketValue(player){
  const scale = (BUDGET / Math.max(1, FORMATION.length)) / (1000 / 11);
  return Math.max(MIN_PER_POSITION, expectedPriceForRating(player.rating) * scale);
}

// The nations in the pool with enough players to be worth backing.
function aiFavouriteNation(){
  const nations = draftFilterOptions().nations.filter(n => n.count >= 8).slice(0, 8);
  return nations.length ? nations[Math.floor(Math.random() * nations.length)].name : '';
}

// How much extra (a fraction, 0.12 = 12% more) this manager reads into the player
// beyond his rating: their country, or how many positions he can play.
function aiTasteMul(ai, player){
  const prof = ai.profile || {};
  let extra = 0;
  if(prof.flagPull && ai.favNation && primaryNationality(player.nationality) === ai.favNation) extra += prof.flagPull;
  const flexible = Math.max(0, playerPositionList(player).length - 1);
  extra += Math.min(0.30, flexible * (prof.flexPull || 0));
  return 1 + extra;
}

// Facts about the round that are the same for every opponent, so they're
// computed once per round rather than once per manager.
function aiRoundContext(){
  const player = state.currentPlayer;
  const numParticipants = state.participants.length;
  const random = effectiveDrawOrder() === 'random';
  const replacement = random
    ? aiReplacementRandom(player, numParticipants)
    : aiReplacementRating(player, numParticipants);
  const chancesLeft = aiChancesLeftAt(player, numParticipants);

  // Who else still needs this slot AND has the money to fight for it -
  // the human very much included. A slot several funded rivals want will
  // go for more, so it's worth committing decisively rather than losing
  // it by a single increment.
  const funded = state.participants.filter(p =>
    participantCanTake(p, player) &&
    getMaxAffordable(p) >= player.startPrice * 1.5
  ).length;
  const contestMul = 1 + Math.min(0.18, Math.max(0, funded - 1) * 0.05);

  return {replacement, contestMul, chancesLeft, random};
}

// The single most this manager will pay for the player on the stage.
// Computed ONCE per round (cached in state.aiValuations) rather than per
// bid - recomputing with fresh noise on every increment made them look
// erratic, changing their mind mid-bidding-war for no visible reason.
function aiValuePlayer(ai, player, ctx){
  const spendable = getMaxAffordable(ai);
  // Can't even cover the floor price - out of this one entirely.
  if(spendable < MIN_PER_POSITION) return 0;

  /* Walking away is a real option in a random-selection mode. Because
     every player opens at the minimum in 6v6, without this the manager
     would open at 1M on literally everyone and end up owning whichever
     weak player nobody happened to contest - the exact "bought him just
     because he came up first" behaviour the mode should avoid.

     Only refuse while there are still chances left at this slot; on the
     last look the fallback below applies and they buy regardless. The
     small tolerance keeps them from passing on a player who is
     essentially at replacement level anyway. */
  if(ctx && ctx.random && ctx.chancesLeft > 0){
    const behind = ctx.replacement - player.rating;
    if(behind > 1){
      // Occasionally take one anyway, so they are not perfectly readable
      // and a genuinely uncontested bargain still gets picked up.
      const stubborn = Math.min(0.85, 0.35 + behind * 0.12);
      if(Math.random() < stubborn) return 0;
    }
  }

  const prof = ai.profile;
  const slotsLeft = Math.max(1, FORMATION.length - (ai.squad || []).length);

  const edge = Math.max(0, player.rating - (ctx ? ctx.replacement : player.rating - 3));

  // What this slot is worth is anchored to the budget it can actually
  // claim: everything still spendable, divided by the slots still to
  // fill. Anchoring here (rather than to a share of a "discretionary
  // pot") is what makes the whole budget get used - the previous shape
  // was so cautious that managers finished with 300M+ unspent, which
  // buys nothing and left them outbid on every contested player.
  //
  // It is also self-correcting: overspend early and perSlot falls, so
  // later ceilings drop automatically; hoard and perSlot rises, pushing
  // the manager to spend up. On the final slot perSlot is the entire
  // remaining budget, so a manager with money and one gap goes all in.
  const perSlot = spendable / slotsLeft;

  // How good is this player next to a typical remaining upgrade? ~1.0 is
  // an ordinary one, 2.6 is capped-out irreplaceable.
  const rel = Math.min(2.6, edge / AI_TYPICAL_EDGE);
  const qualityMul = 0.45 + rel * 0.95;

  const need = aiLineNeed(ai, player.pos);
  const needMul = 0.85 + need * 0.40;
  const bias = prof.lineBias[aiLineOf(player.pos)] || 1;
  const noise = 1 + (Math.random() - 0.5) * prof.noise;
  const flashPull = player.isFlash ? 1.10 : 1;
  const contest = ctx ? ctx.contestMul : 1;
  const taste = aiTasteMul(ai, player);

  const mods = Math.min(AI_MAX_MODIFIER,
    prof.starHunger * prof.aggression * needMul * bias * flashPull * contest * taste) * noise;

  let ceiling = perSlot * qualityMul * mods;

  /* Value hunting. A player on offer below what his rating is worth is worth
     bidding for even when the squad's immediate need says otherwise - that is
     the whole point of a bargain. So there is a second ceiling, the going rate
     for his rating (adjusted for taste and for how much this manager trusts it),
     and the manager will pay up to whichever of the two is higher.

     Only for a player who would genuinely help: at or near the level they would
     otherwise end up with at the position. Paying market price for someone worse
     than the replacement is not value, it is a waste of the budget. */
  const market = aiMarketValue(player);
  const sense = prof.valueSense != null ? prof.valueSense : 0.9;
  const helps = !ctx || player.rating >= ctx.replacement - 1;
  if(sense > 0 && helps){
    const fair = market * sense * taste * (0.95 + Math.random() * 0.10);
    ceiling = Math.max(ceiling, Math.min(fair, spendable));
  }

  // They have to fill this slot sooner or later and money left at the
  // final whistle buys nothing, so any player they can comfortably
  // afford is worth at least the asking price. Without this, players
  // barely better than their replacement were valued under their own
  // start price and drew no bids at all.
  if(perSlot >= player.startPrice) ceiling = Math.max(ceiling, player.startPrice);

  // Rounded to the MODE's bid increment, not a fixed 5M - in 6v6 a
  // 5M-rounded ceiling would be a 5% swing of the entire 100M budget.
  return Math.max(MIN_PER_POSITION, roundToBidStep(Math.min(ceiling, spendable)));
}

// Decide this AI's action for the current state of the round.
// Returns {action:'bid', amount} or {action:'pass'}.
function aiDecide(ai, player, minBid){
  let ceiling = state.aiValuations[ai.id];
  if(ceiling == null) return {action:'pass'};
  // A grudge: they will stretch further to stop the human running away with him.
  if(ai.profile.rivalry && state.currentLeader === HUMAN_ID){
    ceiling = Math.min(getMaxAffordable(ai), ceiling * (1 + ai.profile.rivalry));
  }
  if(minBid > ceiling) return {action:'pass'};
  if(minBid > getMaxAffordable(ai)) return {action:'pass'};

  // Mostly minimum increments, so bidding wars actually play out on
  // screen instead of resolving in one jump. Occasionally a manager
  // throws in a statement bid to try to end it early.
  /* Bid size.

     Creeping up one increment at a time is right when the price has
     nearly caught up with what the manager thinks the player is worth,
     and wrong when it hasn't: a manager who values someone at 300M has
     no reason to inch there 5M at a time, and doing so reads as timid
     rather than deliberate. So the jump is a fraction of the HEADROOM
     (ceiling - asking price), which makes it self-scaling - big money
     on a player they rate far above the current bid, small nudges once
     it's close, and sane magnitudes in either mode without tuning:
     roughly +10/+30/+50 on a Classic budget, +3/+6/+20 in 6v6.

     Conviction (how far below their ceiling the price still is) drives
     BOTH how likely a jump is and how big it gets, so a bidding war for
     someone they really want escalates quickly instead of grinding. */
  const prof = ai.profile;
  const headroom = ceiling - minBid;
  const conviction = ceiling > 0 ? Math.max(0, Math.min(1, headroom / ceiling)) : 0;

  let amount = minBid;
  const jumpChance = Math.min(0.92, prof.jumpChance * (0.7 + conviction * 2.4));

  if(headroom >= BID_STEP * 2 && Math.random() < jumpChance){
    const roll = Math.random();
    let frac;
    if(roll < 0.50)      frac = 0.12 + Math.random() * 0.16;  // nudge
    else if(roll < 0.85) frac = 0.28 + Math.random() * 0.27;  // push
    else                 frac = 0.55 + Math.random() * 0.30;  // statement bid
    // Star-hunters commit harder; bargain-hunters stay closer to the nudge.
    frac *= 0.80 + prof.starHunger * 0.22;
    // Scale by conviction so a near-capped price still only gets a nudge.
    frac *= 0.45 + conviction * 0.55;
    amount = roundToBidStep(minBid + headroom * Math.min(0.9, frac));
  }

  // roundToBidStep can land a hair under the asking price - never bid below it.
  amount = Math.max(minBid, amount);
  return {action:'bid', amount: Math.min(amount, ceiling, getMaxAffordable(ai))};
}

/* ---- The AI turn loop ----
   Paced to stay readable without dragging. Every bid wipes all the
   Calling Final Bids votes, so each one sends every opponent back to
   re-decide; at a second-plus per decision a five-opponent bidding war
   could outlast the whole round timer. */

const AI_FIRST_THINK_MS = 420;  // beat before the opening decision
const AI_PASS_MS = 260;         // dropping out needs no deliberation
const AI_BID_MS = 480;          // a bid gets a moment to land

let aiThinkHandle = null;

function aiStopThinking(){
  clearTimeout(aiThinkHandle);
  aiThinkHandle = null;
}

// Prices every AI's opinion of the player who just came up, then starts
// the think loop. Called from startBidding().
function aiBeginRound(){
  if(!AI_MODE || !state.currentPlayer) return;
  // Replacement level and how contested the slot is are the same for
  // everyone, so they're worked out once and shared.
  const ctx = aiRoundContext();
  state.aiValuations = {};
  state.participants.forEach(p => {
    if(!p.isAI) return;
    if(p.profile && p.profile.flagPull && p.favNation == null) p.favNation = aiFavouriteNation();
    state.aiValuations[p.id] = aiValuePlayer(p, state.currentPlayer, ctx);
  });
  aiScheduleThink(AI_FIRST_THINK_MS);
}

function aiScheduleThink(ms){
  aiStopThinking();
  aiThinkHandle = setTimeout(aiTick, ms);
}

/* A patient manager holds back while there is plenty of clock left and others
   still deciding, then comes in late. Never in an untimed or sealed round, and
   never once everyone else has finished: waiting then would only stall the round. */
function aiWaiting(ai){
  const patience = ai.profile.patience || 0;
  if(!patience || state.isBlindRound || !(state.currentRoundSeconds > 0) || !state.roundEndsAt) return false;
  const othersStillDeciding = state.participants.some(p =>
    p.id !== ai.id && participantCanTake(p, state.currentPlayer) && !goingVoteIsIn(p.id));
  if(!othersStillDeciding) return false;
  const remaining = (state.roundEndsAt - Date.now()) / 1000;
  return remaining > Math.max(6, state.currentRoundSeconds * (1 - patience));
}

function aiTick(){
  aiThinkHandle = null;
  if(!AI_MODE || !state.auctioning || state.paused){
    if(AI_MODE && state.paused) aiScheduleThink(500); // re-check after unpause
    return;
  }
  const player = state.currentPlayer;
  if(!player) return;

  const pending = state.participants.filter(p =>
    p.isAI &&
    participantCanTake(p, player) &&           // has room for him in the lineup
    state.currentLeader !== p.id &&            // already winning; nothing to do
    !state.goingVotes[p.id]                    // hasn't already passed
  );

  // Every opponent has decided - the round is waiting on the human now.
  // The loop deliberately parks here instead of polling; placeBid()
  // restarts it, because a new bid is the only thing that can reopen an
  // AI decision. (Parking WITHOUT that restart was a real bug: after the
  // human outbid them the opponents fell silent for the rest of the
  // round and it stalled until the clock ran out.)
  if(pending.length === 0) return;

  if(state.isBlindRound){
    aiActBlind(pending[0]);
    if(state.auctioning) aiScheduleThink(AI_PASS_MS);
    return;
  }

  const minBid = getMinBid();

  // Managers already priced out don't need a deliberation beat - they're
  // out and they know it. Passing them together stops a five-opponent
  // round spending five separate pauses to say the same thing.
  const pricedOut = pending.filter(p => (state.aiValuations[p.id] || 0) < minBid);
  if(pricedOut.length){
    pricedOut.forEach(p => castGoingVote(p.id));
    if(state.auctioning) aiScheduleThink(AI_PASS_MS);
    return;
  }

  // Someone genuinely still in contention: one decision, with a beat. Patient
  // managers hold back until the clock is low (they are still in the round).
  const ready = pending.filter(p => !aiWaiting(p));
  if(!ready.length){ aiScheduleThink(350); return; }
  const ai = ready[Math.floor(Math.random() * ready.length)];
  const decision = aiDecide(ai, player, minBid);
  if(decision.action === 'bid'){
    bidInputs[ai.id] = decision.amount;
    // Say so when they pounce on a player going for well under his worth.
    if(ai.profile.valueSense >= 1 && decision.amount < aiMarketValue(player) * 0.8){
      state.aiBargainShown = state.aiBargainShown || {};
      const flag = (state.currentRound + ':' + state.phaseNum + ':' + ai.id);
      if(!state.aiBargainShown[flag]){
        state.aiBargainShown[flag] = true;
        addTicker(`<span style="color:var(--green)">${t('ticker.bargainBid', {name: esc(ai.name)})}</span>`);
      }
    }
    placeBid(ai.id); // reschedules the loop itself
    return;
  }

  // "If an AI decides not to bid it clicks skip" - passing IS a Calling
  // Final Bids vote, exactly like a human pressing the button.
  castGoingVote(ai.id);
  if(state.auctioning) aiScheduleThink(AI_PASS_MS + Math.random() * 200);
}

// Blind (sealed-bid) round: submit once, near the manager's true
// ceiling since there's no chance to react, then vote to reveal.
function aiActBlind(ai){
  const ceiling = state.aiValuations[ai.id];
  const player = state.currentPlayer;
  if(ceiling != null && !state.sealedBids[ai.id]){
    const floor = player.startPrice;
    if(ceiling >= floor){
      const offer = roundToBidStep(Math.max(floor, ceiling * (0.86 + Math.random() * 0.12)));
      bidInputs[ai.id] = Math.min(offer, getMaxAffordable(ai));
      submitSealedBid(ai.id);
    }
  }
  castGoingVote(ai.id);
}

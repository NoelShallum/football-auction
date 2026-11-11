/* ================= UNSOLD PLAYERS: BACK OF THE PACK =================

   When nobody bids on a player, the old engine rerolled him away (spending
   the draft's reroll pool) and, once rerolls ran out, handed him to a random
   eligible manager at the asking price. Neither is how a real auction works.

   Now an unsold player goes to the BACK OF THE PACK and is revisited:

     1. Nobody bids -> he joins the unsold queue and the draft moves on. The
        slot he was offered for is simply still open, so it comes round again
        on the next pass through the formation.
     2. When that slot's turn comes round, the queued player is offered
        BEFORE a fresh draw, at an opening price 10% lower.
     3. If he draws no bids a second time (UNSOLD_MAX_NO_BIDS), someone has to
        take him: the leftover pick goes to whichever manager needing the slot
        has the most empty squad slots (ties: the smaller budget), at that
        lowered price, or the floor price if they cannot afford it.

   Nobody ever ends up short of players, and nobody is picked at random.

   Everything here is pure: plain data in, plain data out. Both the
   single-device engine (js/auction.js) and the online host engine
   (js/multiplayer.js) call it, so the two cannot drift apart - the same
   reason selection lives in js/players.js. Queue entries are ordinary JSON
   because online they ride inside gameState. */

const UNSOLD_MAX_NO_BIDS = 2;   // the 2nd no-bid on the same player forces a leftover pick
const UNSOLD_PRICE_DROP = 0.10; // each return opens 10% lower than the last

/* The opening price for a player who has already drawn `noBids` no-bids.
   Always measured from his ORIGINAL price (not compounded from a rounded
   one), snapped to the mode's bid step and never below the floor. */
function unsoldReofferPrice(player, noBids){
  const base = player.baseStartPrice != null ? player.baseStartPrice : player.startPrice;
  const dropped = base * Math.pow(1 - UNSOLD_PRICE_DROP, Math.max(0, noBids || 0));
  return Math.max(MIN_PER_POSITION, roundToBidStep(dropped));
}

/* A player just drew no bids. `requeue` sends him to the back of the pack;
   `leftover` means he has been round enough times and must be assigned. */
function unsoldDecision(player){
  const noBids = ((player && player.noBids) || 0) + 1;
  return noBids >= UNSOLD_MAX_NO_BIDS
    ? { action: 'leftover', noBids }
    : { action: 'requeue', noBids };
}

// The queue entry for a requeued player. queuedPhase stops him coming straight
// back within the same pass (the other slot of an interchangeable pair would
// otherwise re-offer him immediately - that is not "the back of the pack").
function unsoldEntry(player, noBids, phaseNum){
  return Object.assign({}, player, {
    noBids,
    baseStartPrice: player.baseStartPrice != null ? player.baseStartPrice : player.startPrice,
    queuedPhase: phaseNum,
  });
}

// Classic owns each slot individually; 6v6 slots of one code are interchangeable.
function unsoldMatchesSlot(entry, posIdx){
  if(entry.posIdx === posIdx) return true;
  if(!modeSlotsInterchangeable()) return false;
  const a = FORMATION[entry.posIdx], b = FORMATION[posIdx];
  return !!a && !!b && a.code === b.code;
}

/* The unsold player to offer for slot `posIdx` this round, if any.
   Returns {queue, player}: the queue without him, and him re-priced and
   re-pointed at the slot being offered (player is null when none is due). */
function takeUnsoldForSlot(queue, posIdx, phaseNum){
  const list = queue || [];
  const i = list.findIndex(e =>
    unsoldMatchesSlot(e, posIdx) && (e.queuedPhase == null || e.queuedPhase < phaseNum));
  if(i < 0) return { queue: list, player: null };
  const entry = list[i];
  const player = Object.assign({}, entry, {
    posIdx,
    startPrice: unsoldReofferPrice(entry, entry.noBids),
  });
  delete player.queuedPhase;
  return { queue: list.filter((_, j) => j !== i), player };
}

// Entries whose slot nobody needs any more can never be offered; drop them so
// the "unsold" count shown to the room is honest.
function pruneUnsold(queue, participants){
  return (queue || []).filter(e => (participants || []).some(p => participantNeedsSlot(p, e.posIdx)));
}

/* The leftover pick: of those still needing the slot, the manager with the
   most empty squad slots; ties go to the smaller budget (a catch-up rule),
   then seat order. null if nobody needs it. */
function pickLeftoverWinner(participants, posIdx){
  const needing = (participants || []).filter(p => participantNeedsSlot(p, posIdx));
  if(!needing.length) return null;
  const empty = p => FORMATION.length - ((p.squad || []).length);
  return needing.slice().sort((a, b) => (empty(b) - empty(a)) || (a.budget - b.budget))[0];
}

// The lowered price, or the floor when the winner cannot afford it (budget
// reserves for their remaining slots are never broken - see getMaxAffordable).
function leftoverPrice(player, winner, noBids){
  const wanted = unsoldReofferPrice(player, noBids);
  return wanted > getMaxAffordable(winner) ? MIN_PER_POSITION : wanted;
}

/* How many passes through the formation a draft may take before the safety
   net ends it. Each unsold player can cost an extra pass, so this scales with
   UNSOLD_MAX_NO_BIDS instead of the old fixed "+5". */
function maxDraftPhases(numParticipants){
  return Math.max(2, numParticipants) * UNSOLD_MAX_NO_BIDS + 5;
}

/* "Phase 2/3 · Round 4/11" - and, once the draft needs more passes than a
   clean one would (because players went unsold), "Extra lap 1 · Round 4/11"
   instead of a nonsense "Phase 5/3". The final pass of a clean Classic draft
   (the auto-assignment) is phase totalPhases + 1, so extras start after it. */
function progressText(phaseNum, totalPhases, round){
  const extra = phaseNum - (totalPhases + 1);
  if(extra > 0) return t('auction.progressExtra', {lap: extra, round: round + 1, rounds: FORMATION.length});
  return t('auction.progress', {phase: phaseNum, phases: totalPhases, round: round + 1, rounds: FORMATION.length});
}

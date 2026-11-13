/* ================= UNSOLD PLAYERS: BACK OF THE PACK =================

   Nobody is ever handed a player. A player goes to a manager only because that
   manager bid for him.

   When nobody bids on a player he goes to the BACK OF THE PACK and is revisited:

     1. Nobody bids -> he joins the unsold queue and the draft moves on. The
        slot he was offered for is simply still open, so it comes round again
        on the next pass through the formation.
     2. When that position's turn comes round, the queued player is offered
        BEFORE a fresh draw, at an opening price 10% lower than the last time,
        down to the floor price.
     3. If nobody bids again he goes back again. There is no forced pick: a draft
        only finishes when every manager has chosen to sign a full squad, and the
        price falling to the floor is the nudge that gets them there.

   Everything here is pure: plain data in, plain data out. Both the
   single-device engine (js/auction.js) and the online host engine
   (js/multiplayer.js) call it, so the two cannot drift apart - the same
   reason selection lives in js/players.js. Queue entries are ordinary JSON
   because online they ride inside gameState. */

const UNSOLD_PRICE_DROP = 0.10; // each return opens 10% lower than the last

/* The opening price for a player who has already drawn `noBids` no-bids.
   Always measured from his ORIGINAL price (not compounded from a rounded
   one), snapped to the mode's bid step and never below the floor. */
function unsoldReofferPrice(player, noBids){
  const base = player.baseStartPrice != null ? player.baseStartPrice : player.startPrice;
  const dropped = base * Math.pow(1 - UNSOLD_PRICE_DROP, Math.max(0, noBids || 0));
  return Math.max(MIN_PER_POSITION, roundToBidStep(dropped));
}

// How many times he has now drawn no bids (this one included).
function unsoldNoBids(player){
  return ((player && player.noBids) || 0) + 1;
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

// Tokens of the same position are interchangeable: an unsold CM returns on a
// later CM token, whichever of the formation's CM slots it was drawn for.
function unsoldMatchesSlot(entry, posIdx){
  if(entry.posIdx === posIdx) return true;
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

// Entries nobody could sign any more (every lineup has outgrown them) can never
// be offered; drop them so the "unsold" count shown to the room is honest.
function pruneUnsold(queue, participants){
  return (queue || []).filter(e => (participants || []).some(p => participantCanTake(p, e)));
}

/* How many passes through the formation a draft may take before the safety net
   ends it. Unsold players keep coming back and nothing is ever forced, so a table
   that keeps passing simply takes more laps; this is only the backstop against a
   draft that can never finish (every remaining position unusable by everyone, or
   nobody ever bidding). When it is reached the draft ends with the squads as they
   stand and says so. */
function maxDraftPhases(numParticipants){
  return Math.max(2, numParticipants) * 8 + 20;
}

/* "Phase 2/3 · Round 4/11" - and, once the draft needs more passes than a clean
   one would (because players went unsold), "Extra lap 1 · Round 4/11" instead of
   a nonsense "Phase 5/3". A clean draft is exactly one pass per participant, so
   extras start after pass totalPhases. */
function progressText(phaseNum, totalPhases, round){
  const extra = phaseNum - totalPhases;
  if(extra > 0) return t('auction.progressExtra', {lap: extra, round: round + 1, rounds: FORMATION.length});
  return t('auction.progress', {phase: phaseNum, phases: totalPhases, round: round + 1, rounds: FORMATION.length});
}

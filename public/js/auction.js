/* ================= START AUCTION ================= */

// Applies the mode-specific chrome for the shared auction screen.
// Offline (shared screen) must never show the online-only Live Squads
// panel or the multiplayer vote counters. Both are toggled with INLINE
// styles while an online draft runs, and inline styles beat stylesheet
// rules - so offline has to actively reset them here rather than rely
// on their initial markup, otherwise an online draft earlier in the
// same page session leaves "0/3" counters and an empty squad panel
// stuck on the offline screen.
function applyAuctionScreenMode(online){
  applyModeChrome();
  const screen = document.getElementById('auctionScreen');
  screen.classList.toggle('online-mode', online);
  screen.style.display = online ? 'grid' : 'block';
  /* The auction screen is revealed here rather than through showScreen(), so
     it has to name itself on <body> the same way - that attribute is what
     stands the masthead down during a round. See the .brand/.tagline rules
     in styles.css. */
  document.body.setAttribute('data-screen', 'auctionScreen');
  document.getElementById('liveSquadsPanel').style.display = online ? 'block' : 'none';
  // Restarting an online draft is the host's call and has to take every
  // client with it (mpHostResetToLobby), so the local restart button is
  // offline/AI only.
  document.getElementById('restartAuctionBtn').style.display = online ? 'none' : 'inline-block';
  if(!online){
    document.getElementById('mpGoingVoteCount').style.display = 'none';
    document.getElementById('mpRerollVoteCount').style.display = 'none';
  }
}

/* Whether the Reroll control is on screen at all, for whichever way the
   draft is being played.

   This used to live inline in startAuction(), which is the OFFLINE entry
   point - so it only ever ran for offline drafts. The buttons are shared
   DOM and the visibility is set with inline styles, so an online draft
   inherited whatever the last local draft left behind: play one game
   against the AI (where rerolls are hidden outright) and every online
   draft afterwards in that tab had no Reroll button and no counter, for
   the whole session, with nothing to suggest why. Reloading "fixed" it,
   which is exactly what makes that class of bug so confusing to report.

   AI mode is the only case with no rerolls at all; online always has
   them unless the room's settings disabled them. */
function applyRerollChrome(){
  const online = !!currentRoomCode;
  const hidden = REROLLS_MODE === 'disabled' || (AI_MODE && !online);
  document.getElementById('rerollsIndicator').style.display = hidden ? 'none' : 'block';
  document.getElementById('rerollBtn').style.display = hidden ? 'none' : 'inline-block';
}

async function startAuction(){
  // A guest who has just left an online room can be showing a pool id
  // whose file was never fetched on this device - reconcile before
  // anything reads playerDatabase.
  await ensureActivePoolLoaded();

  // Check if player database is loaded
  if(playerDatabase.length === 0){
    appNotice(t('auction.dbLoadingAlert'), 'error');
    return;
  }

  // The chosen pool has to be deep enough for this many participants in
  // this formation, or the draft quietly degrades into "Unknown Player"
  // fallbacks partway through. Same check the setup screen shows inline.
  const poolProblem = poolReadinessMessage(participantCount);
  if(poolProblem){
    appNotice(poolProblem + ' ' + t('pool.pickDifferent'), 'error');
    renderAllPoolPickers();
    return;
  }

  // Validate custom timer if selected
  if(ROUND_SECONDS === -1){
    appNotice(t('field.customTimerInvalid'), 'error');
    return;
  }

  const inputs = [...document.querySelectorAll('#namesGrid input')];
  if(AI_MODE){
    // One human (always p0) plus one participant per chosen opponent.
    const humanName = (inputs[0] && inputs[0].value.trim()) || 'You';
    state.participants = [{
      id: HUMAN_ID,
      name: humanName,
      color: DOT_COLORS[0],
      budget: BUDGET,
      squad: [],
      positionsFilled: new Set(),
      isAI: false,
    }];
    aiRosterFor(participantCount - 1).forEach((prof, i) => {
      state.participants.push({
        id: 'p' + (i + 1),
        name: prof.name,
        color: DOT_COLORS[i + 1],
        budget: BUDGET,
        squad: [],
        positionsFilled: new Set(),
        isAI: true,
        profile: prof,
      });
    });
  } else {
    state.participants = inputs.map((inp,i)=>({
      id: 'p'+i,
      name: inp.value.trim() || `Participant ${i+1}`,
      color: DOT_COLORS[i],
      budget: BUDGET,
      squad: [],
      positionsFilled: new Set(),
      isAI: false,
    }));
  }

  state.totalPhases = state.participants.length - 1;
  state.phaseNum = 1;
  state.currentRound = 0;
  state.unsold = [];            // the back of the pack - see js/unsold.js
  state.paused = false;
  state.goingVotes = {};
  state.aiValuations = {};
  aiStopThinking();

  // A single reroll pool for the whole draft (see startRound(), which no
  // longer resets this every round). rerollsInitial is kept alongside so
  // the results screen can report how many were actually used.
  // AI mode has no rerolls at all, whatever the saved setting says.
  state.rerollsInitial = AI_MODE ? 0 : rerollPoolSize(REROLLS_MODE);
  state.rerollsRemaining = state.rerollsInitial;

  // One sealed-bid ("blind") round happens once per draft - see
  // startRound()/settleRound(). Reset the tracking fresh for this draft.
  // The target is drawn across EVERY bidding round the draft will have,
  // not just the first pass through the formation, so it can land in any
  // phase - see pickBlindRoundTarget() in config.js.
  state.blindRoundUsed = false;
  state.biddingRoundsSoFar = 0;
  state.blindRoundTarget = pickBlindRoundTarget(state.participants.length);
  state.isBlindRound = false;
  state.sealedBids = {};

  // Reset used players and phase tracking for new auction
  usedPlayerIds.clear();
  positionPhaseTracking = {};
  positionRankFloor = {};

  // Randomize position order
  state.positionOrder = FORMATION.map((_, i) => i);
  for(let i = state.positionOrder.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [state.positionOrder[i], state.positionOrder[j]] = [state.positionOrder[j], state.positionOrder[i]];
  }

  document.getElementById('setupScreen').style.display = 'none';
  applyAuctionScreenMode(false);
  document.getElementById('ticker').innerHTML = '';

  // Setup can be scrolled a long way down (names, pool, formation...) -
  // land on the player/timer/bid-controls stage, not wherever the page
  // happened to be scrolled to while configuring the draft.
  window.scrollTo(0, 0);

  applyRerollChrome();

  track('draft_started', trackDraftContext({
    mode: AI_MODE ? 'vs_ai' : 'shared_screen',
    rerolls: REROLLS_MODE,
    timer: ROUND_SECONDS,
  }));

  lockGameplayZoom();
  startRound();
}

/* ================= ROUND ENGINE ================= */
function getRemainingPositions(p){
  return FORMATION.length - p.squad.length;
}

function getMaxAffordable(p){
  const remaining = getRemainingPositions(p);
  if(remaining <= 1) return p.budget;
  return p.budget - (MIN_PER_POSITION * (remaining - 1));
}

function startRound(){
  // Check if all participants have complete squads
  const allComplete = state.participants.every(p => p.squad.length === FORMATION.length);
  if(allComplete){
    return endAuction();
  }

  // Move to next round
  if(state.currentRound >= FORMATION.length){
    state.phaseNum++;
    state.currentRound = 0;
  }

  // Safety check - if we've gone through too many phases, force end
  if(state.phaseNum > maxDraftPhases(state.participants.length)){
    return endAuction();
  }

  // rerollsRemaining is intentionally NOT reset here - it's a single
  // pool for the whole draft (set once in startAuction()) and only ever
  // decremented by rerollPlayer(), so it's a real, exhaustible resource
  // instead of refilling every round.

  const posIdx = state.positionOrder[state.currentRound];
  const pos = FORMATION[posIdx];

  // Fresh round, fresh per-round reroll allowance. Deliberately here and
  // not in startBidding(), which rerollPlayer() re-enters for the SAME
  // round - resetting there would make the ceiling unreachable.
  state.roundRerolls = 0;

  // Find who still needs this position
  const eligible = state.participants.filter(p => participantNeedsSlot(p, posIdx));

  if(eligible.length === 0){
    // Everyone has this position, skip to next round
    state.currentRound++;
    return startRound();
  }

  // Track which phase this position is in (0-indexed)
  if(!positionPhaseTracking[posIdx]){
    positionPhaseTracking[posIdx] = 0;
  }

  const positionPhase = positionPhaseTracking[posIdx];
  const numParticipants = state.participants.length;

  // Anyone unsold whose slot nobody needs any more can never come back.
  state.unsold = pruneUnsold(state.unsold, state.participants);

  // A player nobody bid on last time round is offered BEFORE a fresh draw.
  // Neither the ladder nor this position's phase counter moves for him: he
  // was already drawn, and the slot's next fresh player is still the next
  // band down, exactly as if he had been sold.
  const back = takeUnsoldForSlot(state.unsold, posIdx, state.phaseNum);
  if(back.player){
    state.unsold = back.queue;
    state.currentPlayer = back.player;
    addTicker(tVariant('ticker.unsoldReturns', pickVariantIndex(), {name: esc(back.player.name), price: fmt(back.player.startPrice)}));
  } else {
    // Generate player for this phase - occasionally a flash pick from the
    // top tier instead (see maybeGenerateFlashPlayer()), which deliberately
    // bypasses positionRankFloor entirely (a real phase-0 draw regardless
    // of this position's progress is the whole point of a flash pick).
    const flashPlayer = maybeGenerateFlashPlayer(posIdx, positionPhase, numParticipants, eligible.length);
    if(flashPlayer){
      state.currentPlayer = flashPlayer;
    } else {
      const picked = generateRoundPlayer(posIdx, positionPhase, numParticipants, positionRankFloor[posIdx]);
      state.currentPlayer = picked.player;
      positionRankFloor[posIdx] = picked.rankFloor;
    }

    // Increment phase tracker for this position
    positionPhaseTracking[posIdx]++;
  }

  // Check if only one person needs this position (automatic assignment).
  // 6v6 opts out: it has no auto-assignment at all, so the round still
  // runs and the last eligible participant simply wins it unopposed at
  // the minimum bid.
  if(eligible.length === 1 && activeMode().autoAssignLastEligible){
    return autoAssign(eligible[0]);
  }

  // A single sealed-bid ("blind") round happens once per draft, on a
  // bidding round randomized across the WHOLE draft at the start of this
  // auction (state.blindRoundTarget - see pickBlindRoundTarget()). Asked
  // here rather than earlier because everything above this line can still
  // end the round without any bidding (position already full for
  // everyone, or auto-assigned to the last eligible participant), and
  // those must not consume the blind round.
  state.biddingRoundsSoFar++;
  const isBlind = shouldBlindRoundFireNow(
    state.blindRoundUsed, state.biddingRoundsSoFar,
    state.blindRoundTarget, slotsRemainingInDraft());
  if(isBlind) state.blindRoundUsed = true;

  // Start bidding
  startBidding(eligible, isBlind);
}

function startBidding(eligible, isBlind){
  state.currentBid = 0;
  state.currentLeader = null;
  state.auctioning = true;
  state.isBlindRound = !!isBlind;
  state.sealedBids = {};
  state.goingVotes = {};

  const p = state.currentPlayer;
  const pos = FORMATION[p.posIdx];

  // Initialize bid inputs to starting price
  state.participants.forEach(participant => {
    bidInputs[participant.id] = p.startPrice;
  });

  document.getElementById('soldFlash').classList.remove('show');
  document.getElementById('countdownBanner').classList.remove('show');
  document.getElementById('playerPos').classList.remove('forced');
  // The SLOT's display code, not the bare position code: in a 4-3-3 all
  // three CM slots read "CM" otherwise, and nobody can tell which one is
  // actually being auctioned (see buildSlotDisplay).
  document.getElementById('playerPos').textContent = slotCode(p.posIdx);
  document.getElementById('flashBadge').style.display = (p.isFlash && !state.isBlindRound) ? 'inline-block' : 'none';
  document.getElementById('blindBadge').style.display = state.isBlindRound ? 'inline-block' : 'none';

  const nameDisplay = playerNameHTML(p, {nation:false});
  document.getElementById('playerName').innerHTML = nameDisplay;
  document.getElementById('playerNat').innerHTML = playerNationalityLineHTML(p);
  document.getElementById('playerSub').textContent = t('auction.startingPrice', {price: fmt(p.startPrice)});

  document.getElementById('posTag').textContent = slotLabel(p.posIdx);
  document.getElementById('phaseTag').textContent = t('auction.phaseEligible', {phase: p.phase, count: eligible.length});
  document.getElementById('progressTag').textContent = progressText(state.phaseNum, state.totalPhases, state.currentRound);
  renderUnsoldPile();

  // A blind round never shows a public current bid/leader - that's the
  // whole point. See resolveSealedBids() for how this gets settled.
  document.getElementById('bidDisplayLabel').textContent = t(state.isBlindRound ? 'auction.sealedRound' : 'auction.currentBid');
  document.getElementById('currentBid').textContent = state.isBlindRound ? t('auction.hidden') : fmt(p.startPrice);
  document.getElementById('currentLeader').textContent = t(state.isBlindRound ? 'auction.revealedWhenTimeUp' : 'auction.noBids');
  document.getElementById('currentLeader').className = 'leader none';

  // Reroll doesn't make sense mid-blind-round (it would discard
  // whatever's already been sealed, and leak that nobody's happy with
  // the pick), so it stays unavailable until it resolves. Calling Final
  // Bids IS still useful though - waiting out the full timer with
  // nothing to look at otherwise means everyone just sits there once
  // they've already locked in their offer, so it doubles as "reveal
  // now" instead of "shorten to 5 seconds" (see the click handler).
  document.getElementById('goingBtn').disabled = false;
  document.getElementById('goingBtn').textContent = t(state.isBlindRound ? 'auction.revealNow' : 'auction.skipTimer');
  if(state.isBlindRound){
    document.getElementById('rerollBtn').disabled = true;
  } else {
    updateRerollButton();
  }

  // Timestamp-based timer (robust against tab throttling). Later phases
  // get a shorter clock than the configured base - see roundSecondsForPhase().
  state.currentRoundSeconds = roundSecondsForPhase(ROUND_SECONDS, state.phaseNum);
  state.roundEndsAt = Date.now() + (state.currentRoundSeconds * 1000);
  state.timer = state.currentRoundSeconds;
  // A fresh deadline: any pause stopwatch left over from the previous round
  // must not be credited against it.
  pauseStartedAt = null;

  renderBidderGrid();

  // Play new round sound
  sounds.newRound();

  if(state.currentRoundSeconds > 0){
    runTimer();
  } else {
    document.getElementById('timerNum').textContent = '∞';
    const fill = document.getElementById('timerFill');
    fill.style.strokeDasharray = 0;
  }

  // Opponents price up the new player and start deciding.
  aiBeginRound();

  // A no-op after the very first normal round it ever runs on, in this
  // browser - see maybeShowLiveAuctionTutorial() in js/tutorial.js (which
  // loads after this file; the reference below only runs once startBidding
  // is actually called, long after every file has loaded).
  if(typeof maybeShowLiveAuctionTutorial === 'function') maybeShowLiveAuctionTutorial();
}

function autoAssign(participant){
  const p = state.currentPlayer;
  const pos = FORMATION[p.posIdx];

  document.getElementById('soldFlash').classList.remove('show');
  document.getElementById('playerPos').classList.add('forced');
  document.getElementById('playerPos').textContent = slotCode(p.posIdx);
  document.getElementById('flashBadge').style.display = 'none';
  document.getElementById('blindBadge').style.display = 'none';

  const nameDisplay = playerNameHTML(p, {nation:false});
  document.getElementById('playerName').innerHTML = nameDisplay;
  document.getElementById('playerNat').innerHTML = playerNationalityLineHTML(p);
  document.getElementById('playerSub').textContent = t('auction.autoAssignedAt', {price: fmt(p.startPrice)});

  document.getElementById('posTag').textContent = slotLabel(p.posIdx);
  document.getElementById('phaseTag').textContent = t('auction.autoAssignPhase');
  document.getElementById('progressTag').textContent = progressText(state.phaseNum, state.totalPhases, state.currentRound);
  renderUnsoldPile();

  document.getElementById('timerNum').textContent = '—';
  document.getElementById('goingBtn').disabled = true;

  state.auctioning = false;
  renderBidderGrid();

  setTimeout(() => {
    // Which slot this actually lands in: the offered one in Classic,
    // the winner's first free slot of that code where slots are
    // interchangeable (see resolveFilledSlot).
    const slotIdx = resolveFilledSlot(participant, p.posIdx);
    participant.budget -= p.startPrice;
    participant.squad.push({...p, posIdx: slotIdx, price: p.startPrice, newlyPlaced: true});
    participant.positionsFilled.add(slotIdx);

    document.getElementById('soldWord').textContent = t('auction.autoAssigned');
    document.getElementById('soldWord').className = 'word forced';
    document.getElementById('soldDetail').textContent = t('auction.soldDetail', {player: playerNameText(p), winner: participant.name, price: fmt(p.startPrice)});
    document.getElementById('soldFlash').classList.add('show');

    addTicker(buildSaleTickerHTML(p.name, slotCode(slotIdx), participant.name, p.startPrice, ' (auto)', p.rating, p.isFlash));

    renderBidderGrid();

    // Clear newly placed flag after animation
    setTimeout(() => {
      const player = participant.squad[participant.squad.length - 1];
      if(player) player.newlyPlaced = false;
    }, 1000);

    setTimeout(() => {
      state.currentRound++;
      startRound();
    }, 1500);
  }, 1200);
}

/* ================= BIDDING ================= */
function getMinBid(){
  return state.currentBid === 0 ? state.currentPlayer.startPrice : state.currentBid + BID_STEP;
}

function validateBid(pid, amount){
  const p = state.participants.find(x => x.id === pid);
  const minBid = getMinBid();
  const maxAfford = getMaxAffordable(p);

  // Formation limits are enforced here, not just by disabling the button:
  // once every slot for this position is filled the participant is out of
  // the running for it entirely. In Classic this was implicitly true
  // (auto-assignment retired a slot as soon as one person was left), but
  // 6v6 leans on it as a real rule - a 2-1-2 squad that already owns two
  // defenders simply cannot bid on another one.
  if(state.currentPlayer && p && !participantNeedsSlot(p, state.currentPlayer.posIdx)){
    return t('auction.errAlreadyHave');
  }
  /* Passing is NOT checked here any more. It means "I am out unless I
     change my mind", and the only way to change your mind is to bid -
     see placeBid(), which clears the pass. Blocking the bid would make
     "going once, going twice" theatre: the countdown exists precisely so
     there is a last chance to come back in. */
  if(amount < minBid) return t('auction.errMinBid', {min: fmt(minBid)});
  if(amount > maxAfford) return t('auction.errMaxAfford', {max: fmt(maxAfford)});
  if(state.currentLeader === pid) return t('auction.errAlreadyLeading');
  return null;
}

function placeBid(pid){
  if(!state.auctioning) return;
  const p = state.participants.find(x => x.id === pid);
  const amount = bidInputs[pid];

  const error = validateBid(pid, amount);
  if(error){
    // Show error briefly then clear
    const errorEl = document.querySelector(`[data-pid="${pid}"] .bid-error`);
    if(errorEl){
      errorEl.textContent = error;
      setTimeout(() => errorEl.textContent = '', 2000);
    }
    return;
  }

  // Single-player: update local state directly.
  // (Multiplayer bidding goes through mpPlaceBid(), which uses a Firebase
  // transaction so simultaneous bids from different clients can't race.)
  state.currentBid = amount;
  state.currentLeader = pid;

  applyAntiSnipe();

  /* Clears only the BIDDER's own pass, and nobody else's.

     Passing says "I am out unless I change my mind", and bidding is how
     you change it - so your own bid takes you off the pass list, while
     somebody else's bid still leaves you exactly where you chose to be.
     The distinction is the whole point: your state answers to your
     actions, not to theirs.

     No vote needs recording for the bidder either - whoever leads counts
     as having called final bids implicitly (see goingVoteIsIn()), which
     is what lets a bidding war run: being outbid reopens your decision. */
  delete state.goingVotes[pid];

  document.getElementById('currentBid').textContent = fmt(amount);
  const leaderEl = document.getElementById('currentLeader');
  leaderEl.textContent = p.name + ' leads';
  leaderEl.className = 'leader';
  leaderEl.style.color = p.color;

  // Play bid sound
  sounds.bid();
  haptics.bid();

  // Disable Reroll button once bidding has started
  updateRerollButton();

  // Reset all bid inputs to new minimum
  const newMin = getMinBid();
  state.participants.forEach(participant => {
    bidInputs[participant.id] = newMin;
  });

  if(AI_MODE){
    addTicker(t('ticker.bids', {name: esc(p.name), price: fmt(amount)}));
    // The bid may have been the last outstanding decision (everyone else
    // already passed), in which case the round is over right now.
    checkGoingVotesAndMaybeSettle();
    // This bid just cleared every opponent's vote, so they all have to
    // decide again. Restarting the loop here is what un-parks it - see
    // the note in aiTick about why it stops when nobody is pending.
    if(state.auctioning) aiScheduleThink(AI_BID_MS);
  }

  renderBidderGrid();
}

function adjustBid(pid, delta){
  const current = bidInputs[pid] || getMinBid();
  const newAmount = Math.max(0, roundToBidStep(current + delta));
  bidInputs[pid] = newAmount;
  renderBidderGrid();
}

// Submits (or replaces) this participant's sealed offer during a blind
// round. Deliberately never touches state.currentBid/currentLeader -
// nothing here becomes visible to anyone (including, on a shared
// screen, other participants glancing at the stage) until reveal. Can
// be called again before time runs out to change their mind; each call
// simply overwrites the previous amount.
function submitSealedBid(pid){
  if(!state.auctioning || !state.isBlindRound) return;
  const amount = bidInputs[pid];

  const error = validateBid(pid, amount);
  if(error){
    const errorEl = document.querySelector(`[data-pid="${pid}"] .bid-error`);
    if(errorEl){
      errorEl.textContent = error;
      setTimeout(() => errorEl.textContent = '', 2000);
    }
    return;
  }

  state.sealedBids[pid] = {amount, time: Date.now()};
  sounds.bid();
  haptics.bid();
  renderBidderGrid();
}

// Called once, at the moment of reveal (settleRound(), when the blind
// round's timer has run out). Highest valid sealed bid wins; ties go to
// whoever locked theirs in first. Leaves currentBid/currentLeader at
// their initial 0/null if nobody submitted anything valid, which the
// existing "nobody bid" fallback (reroll/random-assign) already handles
// without any special-casing needed here.
function resolveSealedBids(){
  const p = state.currentPlayer;
  let winnerId = null, winnerAmount = 0, winnerTime = Infinity;

  Object.entries(state.sealedBids).forEach(([pid, entry]) => {
    const participant = state.participants.find(x => x.id === pid);
    if(!participant) return;
    if(entry.amount < p.startPrice) return;
    if(entry.amount > getMaxAffordable(participant)) return;
    if(entry.amount > winnerAmount || (entry.amount === winnerAmount && entry.time < winnerTime)){
      winnerId = pid; winnerAmount = entry.amount; winnerTime = entry.time;
    }
  });

  if(winnerId){
    state.currentBid = winnerAmount;
    state.currentLeader = winnerId;
  }
  state.isBlindRound = false;
}

/* Is this participant's bid box the element the user is currently typing
   into? Everything about re-rendering has to bend around this one fact.

   renderBidderGrid() rebuilds the whole grid with innerHTML, and online it
   runs on EVERY gameState change - every rival bid, every vote, every
   connection flicker. Rebuilding replaces the <input> node the user is
   typing in, which throws away the half-typed number, drops focus, and on
   a phone closes the keyboard mid-entry. You could be outbid twice while
   trying to type "120" and never get the chance to finish. */
function bidInputIsFocused(pid){
  const el = document.activeElement;
  if(!el || !el.classList || !el.classList.contains('bid-input')) return false;
  const card = el.closest('.bidder-card');
  return !!card && (pid === undefined || card.getAttribute('data-pid') === pid);
}

/* Patches the mutable parts of the already-rendered cards in place, so
   the DOM node being typed into is never replaced. Used instead of the
   full rebuild whenever someone is mid-entry; the auction still updates
   around them (budgets, leader, slot dots, button states), which is the
   whole point - the state must keep moving, it just must not reach into
   the box under their fingers. Returns false if the card set itself has
   changed, in which case a structural rebuild is unavoidable. */
function softUpdateBidderGrid(ctx){
  const grid = document.getElementById('bidderGrid');
  const cards = [...grid.children];
  if(cards.length !== ctx.participantsToRender.length) return false;

  for(let i = 0; i < cards.length; i++){
    const card = cards[i];
    const p = ctx.participantsToRender[i];
    if(card.getAttribute('data-pid') !== p.id) return false;

    const view = bidderCardView(p, ctx);
    card.className = view.cardClass;

    const budgetEl = card.querySelector('.bidder-budget');
    if(budgetEl){ budgetEl.textContent = fmt(p.budget); budgetEl.style.color = view.budgetColor; }

    const slotsEl = card.querySelector('.bidder-slots');
    if(slotsEl) slotsEl.innerHTML = view.slotsHTML;

    const btn = card.querySelector('.bid-btn');
    if(btn){ btn.textContent = view.btnLabel; btn.disabled = view.btnDisabled; }

    card.querySelectorAll('.bid-adjust').forEach(b => { b.disabled = view.controlsDisabled; });

    const input = card.querySelector('.bid-input');
    if(input){
      input.disabled = view.controlsDisabled;
      input.min = ctx.minBid;
      // The one thing this function exists to protect.
      if(!bidInputIsFocused(p.id)) input.value = bidInputs[p.id];
    }

    const formationEl = card.querySelector('.live-formation');
    if(formationEl && !ctx.online) formationEl.outerHTML = buildLiveFormation(p, true);
  }

  if (ctx.online) renderLiveSquadsPanel();
  if (AI_MODE) updateAIGoingButton();
  return true;
}

/* Everything about one bidder card that can change between renders,
   computed once so the full rebuild and the in-place update below cannot
   drift apart on what a card is supposed to say. */
function bidderCardView(p, ctx){
  const isEligible = ctx.eligible.some(e => e.id === p.id);

  const budgetPercent = (p.budget / BUDGET) * 100;
  let budgetColor = 'var(--green)';            // healthy (>40%)
  if(budgetPercent <= 10)      budgetColor = 'var(--red)';
  else if(budgetPercent <= 20) budgetColor = '#FF9E5E';
  else if(budgetPercent <= 40) budgetColor = '#FFD866';

  let btnLabel = t('auction.placeBid');
  let btnDisabled = false;
  let controlsDisabled = false;
  const hasSealedBid = !!(state.sealedBids && state.sealedBids[p.id]);

  if(p.isAI){
    // Opponents are shown as a read-only status panel - you watch what
    // they do, you never drive their card.
    btnDisabled = true;
    controlsDisabled = true;
    if(!isEligible) btnLabel = t('auction.alreadyHasPosition');
    else if(state.currentLeader === p.id) btnLabel = t('auction.leading');
    else if(state.isBlindRound) btnLabel = t(state.sealedBids[p.id] ? 'auction.sealedBidIn' : 'auction.deciding');
    else if(state.goingVotes[p.id]) btnLabel = t('auction.passed');
    else if(!state.auctioning) btnLabel = '—';
    else btnLabel = t('auction.thinking');
  } else if(!isEligible){
    btnLabel = t('auction.alreadyHasPosition');
    btnDisabled = true;
    controlsDisabled = true;
  } else if((AI_MODE || ctx.online) && state.goingVotes[p.id] && !state.isBlindRound && state.currentLeader !== p.id){
    /* You passed on this player: you are out of the bidding, and someone
       else bidding does NOT drag you back in. But the controls stay live,
       because a pass is a decision you are allowed to reverse - and
       bidding is how you reverse it (placeBid clears your pass). The
       label says so rather than just reading "Place Bid", so the card
       still shows you walked away. (Shared-screen offline never reaches
       this: there the button ends the round for the whole room rather
       than recording a per-participant pass, so goingVotes stays empty.) */
    btnLabel = t('auction.bidToRejoin');
    btnDisabled = !state.auctioning;
    controlsDisabled = !state.auctioning;
  } else if(state.isBlindRound){
    // No visible leader during a blind round - everyone can keep
    // adjusting and resubmitting their sealed offer right up until
    // time runs out, so this never disables on its own account.
    btnLabel = t(hasSealedBid ? 'auction.updateSealedBid' : 'auction.submitSealedBid');
    btnDisabled = !state.auctioning;
    controlsDisabled = !state.auctioning;
  } else if(state.currentLeader === p.id){
    btnLabel = t('auction.youLead');
    btnDisabled = true;
    controlsDisabled = true;
  } else if(!state.auctioning){
    btnDisabled = true;
    controlsDisabled = true;
  }

  const filledDots = p.squad.map(() => '<span class="slot-dot filled"></span>').join('');
  const emptyDots = '<span class="slot-dot"></span>'.repeat(Math.max(0, FORMATION.length - p.squad.length));

  return {
    isEligible, budgetColor, btnLabel, btnDisabled, controlsDisabled, hasSealedBid,
    slotsHTML: filledDots + emptyDots,
    cardClass: 'bidder-card'
      + (state.currentLeader === p.id ? ' leading' : '')
      + (!isEligible ? ' ineligible' : ''),
  };
}

/* Which participants have their pitch expanded.

   The auction screen measured 2,518 px on an 844 px viewport - three phone
   screens for a contest that lasts thirty seconds - and 1,068 px of that was
   three live-formation pitches, one per card, at 356 px each. They are useful
   between rounds and pure scroll cost during one, so they now start collapsed
   and open on request.

   Kept OUTSIDE renderBidderGrid because that function rebuilds the grid's
   innerHTML on every bid; a flag stored on the card element would be thrown
   away with it and every pitch would snap shut mid-auction. */
const openSquads = new Set();

function renderBidderGrid(){
  const grid = document.getElementById('bidderGrid');

  const posIdx = state.currentPlayer?.posIdx;
  const eligible = state.participants.filter(p => participantNeedsSlot(p, posIdx));
  const online = !!currentRoomCode;

  // Offline is shared-screen, so every participant still needs their own
  // card here, exactly as before. Online, this panel is "Bidding
  // Controls" and only ever needs to show the local participant - every
  // other participant's squad/budget is now visible through the Live
  // Squads panel instead.
  const participantsToRender = online
    ? state.participants.filter(p => p.id === currentUserId)
    : state.participants;

  const minBid = getMinBid();
  participantsToRender.forEach(p => { if(!bidInputs[p.id]) bidInputs[p.id] = minBid; });

  const ctx = {eligible, online, participantsToRender, minBid};

  // Someone is typing a bid right now: update around them instead of
  // rebuilding the DOM out from under their fingers. Falls through to the
  // full rebuild if the card set itself changed (someone joined or left),
  // which is rare and structural.
  if(bidInputIsFocused() && softUpdateBidderGrid(ctx)) return;

  grid.innerHTML = '';

  participantsToRender.forEach(p => {
    const view = bidderCardView(p, ctx);
    const card = document.createElement('div');
    card.className = view.cardClass;
    card.setAttribute('data-pid', p.id);

    // Best-effort only offline (shared screen): there's no way to hide
    // a DOM value from someone looking at the same physical screen, so
    // this relies on the same "don't peek" trust every hidden-info
    // party game does. Online genuinely doesn't leak anything, since
    // each device only ever renders its own card (see participantsToRender
    // above) regardless of blind or normal mode.
    const sealedNoteHTML = state.isBlindRound && view.hasSealedBid
      ? `<div style="color:var(--green); font-size:11px; margin-bottom:8px;">🔒 Sealed bid locked in</div>`
      : '';

    // Offline embeds each participant's live formation directly in
    // their card, as before. Online shows it once, in the Live Squads
    // panel, instead of duplicating it into a single-participant card.
    const squadOpen = openSquads.has(p.id);
    const liveFormationHTML = online ? '' : `
      <button class="squad-toggle" data-squad-toggle="${esc(String(p.id))}"
              aria-expanded="${squadOpen}">
        <span class="squad-toggle-caret">${squadOpen ? '▾' : '▸'}</span>
        ${esc(t(squadOpen ? 'auction.hideSquad' : 'auction.showSquad'))}
      </button>
      <div class="squad-collapse"${squadOpen ? '' : ' hidden'}>${buildLiveFormation(p, true)}</div>`;

    // An opponent's card is a read-only status panel, so it gets no bid
    // controls at all. Rendering them was not just clutter: bidInputs
    // holds whatever an AI last entered, so during a sealed-bid round
    // their secret offer was sitting in a visible input for anyone to
    // read - which defeats the entire point of a blind round.
    const bidControlsHTML = p.isAI ? '' : `
      <div class="bid-controls">
        <button class="bid-adjust" data-adjust="-${BID_STEP}" ${view.controlsDisabled?'disabled':''}>-${BID_STEP}</button>
        <input type="number" class="bid-input" value="${bidInputs[p.id]}" min="${minBid}" step="${BID_STEP}" autocomplete="off" ${view.controlsDisabled?'disabled':''}>
        <button class="bid-adjust" data-adjust="+${BID_STEP}" ${view.controlsDisabled?'disabled':''}>+${BID_STEP}</button>
      </div>`;

    card.innerHTML = `
      <div class="bidder-top">
        <span class="bidder-name"><span class="dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${esc(p.name)}</span>
        <span class="bidder-budget" style="color:${view.budgetColor}">${fmt(p.budget)}</span>
      </div>
      <div class="bidder-slots">${view.slotsHTML}</div>
      ${sealedNoteHTML}
      ${bidControlsHTML}
      <button class="bid-btn" ${view.btnDisabled?'disabled':''}>${view.btnLabel}</button>
      <div class="bid-error"></div>
      ${liveFormationHTML}
    `;
    grid.appendChild(card);
  });

  if (online) renderLiveSquadsPanel();
  if (AI_MODE) updateAIGoingButton();

  // Attach event listeners
  [...grid.querySelectorAll('[data-squad-toggle]')].forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-squad-toggle');
      const target = state.participants.find(x => String(x.id) === id);
      if(!target) return;
      if(openSquads.has(target.id)) openSquads.delete(target.id);
      else openSquads.add(target.id);
      renderBidderGrid();
    };
  });

  [...grid.querySelectorAll('.bid-adjust')].forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.bidder-card');
      const pid = card.getAttribute('data-pid');
      const delta = parseInt(btn.dataset.adjust);
      adjustBid(pid, delta);
    };
  });

  [...grid.querySelectorAll('.bid-input')].forEach(input => {
    input.oninput = () => {
      const card = input.closest('.bidder-card');
      const pid = card.getAttribute('data-pid');
      const value = parseInt(input.value) || 0;
      bidInputs[pid] = value;
    };
  });

  [...grid.querySelectorAll('.bid-btn')].forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.bidder-card');
      const pid = card.getAttribute('data-pid');
      // Submit what is actually IN the box, not what bidInputs last
      // recorded. Those can disagree: a rival's bid resets everyone's
      // bidInputs to the new minimum, and if that lands between the
      // user's last keystroke and their tap, the old path would have
      // silently submitted the reset figure instead of the number they
      // were looking at.
      const inputEl = card.querySelector('.bid-input');
      if(inputEl) bidInputs[pid] = parseInt(inputEl.value) || 0;
      if(currentRoomCode){
        if(mpGameState && mpGameState.isBlindRound){
          mpSubmitSealedBid(bidInputs[pid]);
        } else {
          mpPlaceBid(bidInputs[pid]);
        }
      } else if(state.isBlindRound){
        submitSealedBid(pid);
      } else {
        placeBid(pid);
      }
    };
  });
}

// Where each formation slot sits on the pitch (x%, y%). The layouts
// themselves live with their mode (see js/modes/*.js) so a new mode
// brings its own without touching the renderer.
function getPlayerPositions(){
  const mode = activeMode();
  const coords = mode.pitchCoords || {};
  return coords[selectedFormation] || coords[mode.defaultFormation] || {};
}

function buildLiveFormation(participant, showTooltips){
  // Organize players by position index
  const playersByPosIdx = {};
  participant.squad.forEach(player => {
    playersByPosIdx[player.posIdx] = player;
  });

  // Get position coordinates for current formation
  const positions = getPlayerPositions();

  let html = '<div class="live-formation">';
  html += `<div class="live-formation-title">${esc(t('auction.liveSquad'))}</div>`;
  html += '<div class="live-pitch">';

  // Place each position on the pitch
  FORMATION.forEach((formPos, posIdx) => {
    const pos = positions[posIdx];
    if(!pos) return;

    const player = playersByPosIdx[posIdx];
    const isNewlyPlaced = player && player.newlyPlaced;

    if(player){
      // Nation used to be prefixed inline onto tt-name (nation defaulted
      // true here, the one place in the game that did it that way) - now
      // a dedicated tt-nat line instead, same as every other surface, so
      // "Nation • Club" reads consistently everywhere rather than only
      // this one tooltip squeezing it in front of the name.
      const tooltipHTML = showTooltips ? `
        <div class="live-slot-tooltip">
          <div class="tt-name">${playerNameHTML(player, {showRating:false, nation:false})}</div>
          <div class="tt-nat">${nationalityClubHTML(player)}</div>
          ${SHOW_RATINGS ? `<div class="tt-rating">Rating ${esc(player.rating)}</div>` : ''}
          <div class="tt-price">Bought for ${fmt(player.price)}</div>
        </div>
      ` : '';
      html += `
        <div class="live-slot filled ${isNewlyPlaced ? 'newly-placed' : ''}" style="left:${pos.x}%; top:${pos.y}%;">
          <div class="pos">${slotCode(posIdx)}</div>
          <div class="name">${playerNameHTML(player, {surnameOnly:true, showRating:false, nation:false})}</div>
          ${tooltipHTML}
        </div>
      `;
    } else {
      html += `
        <div class="live-slot empty" style="left:${pos.x}%; top:${pos.y}%;">
          <div class="pos">${slotCode(posIdx)}</div>
          <div class="name">—</div>
        </div>
      `;
    }
  });

  html += '</div></div>';
  return html;
}

// ---- Live Squads panel (online only): a single shared panel that lets
// any participant browse everyone's squad via Previous/Next, replacing
// the old "other participants" list entirely (see renderBidderGrid,
// which now only ever renders the local participant's own bid card
// online). Defaults to the viewer's own squad.
let liveSquadsPid = null;

function renderLiveSquadsPanel(){
  const infoEl = document.getElementById('liveSquadsInfo');
  const bodyEl = document.getElementById('liveSquadsBody');
  if (!infoEl || !bodyEl || !state.participants.length) return;

  if (!liveSquadsPid || !state.participants.some(p => p.id === liveSquadsPid)) {
    liveSquadsPid = currentUserId;
  }
  const participant = state.participants.find(p => p.id === liveSquadsPid);
  if (!participant) return;

  const kickHTML = (isHost && participant.id !== currentUserId)
    ? ` <button class="kick-btn" id="liveSquadsKickBtn">Kick</button>`
    : '';
  infoEl.innerHTML = `<span class="live-squads-info-text">${esc(participant.name)} | Budget: ${fmt(participant.budget)}</span>${kickHTML}`;
  const kickBtn = document.getElementById('liveSquadsKickBtn');
  if(kickBtn) kickBtn.onclick = () => mpKickParticipant(participant.id);
  bodyEl.innerHTML = buildLiveFormation(participant, true);
}

function stepLiveSquadsPid(delta){
  const ids = state.participants.map(p => p.id);
  const idx = ids.indexOf(liveSquadsPid);
  const nextIdx = (idx + delta + ids.length) % ids.length;
  liveSquadsPid = ids[nextIdx];
  renderLiveSquadsPanel();
}

document.getElementById('liveSquadsPrevBtn').onclick = () => stepLiveSquadsPid(-1);
document.getElementById('liveSquadsNextBtn').onclick = () => stepLiveSquadsPid(1);

/* ================= TIMER ================= */
function formatTime(seconds){
  if(seconds === 0 || seconds === '∞') return '∞';
  if(seconds < 0) return '00:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if(hours > 0){
    return `${hours}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  } else {
    return `${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  }
}

// Later phases get a shorter clock than Phase 1's configured duration -
// low-stakes late-draft rounds shouldn't take as long to play out as the
// elite-tier rounds that opened the draft. Unlimited (baseSeconds<=0)
// is untouched: there's nothing to scale. Floors at 10s so it's never
// so short the countdown banner (which starts at 5s remaining) barely
// has room to play out.
function roundSecondsForPhase(baseSeconds, phaseNum){
  if(baseSeconds <= 0) return 0;
  const factor = Math.max(0.5, 1 - Math.max(0, phaseNum - 1) * 0.1);
  return Math.max(10, Math.round(baseSeconds * factor));
}

// Anti-snipe. A bid landing in the closing seconds pushes the clock back
// out to a full ANTI_SNIPE_MS, so a last-instant bid can't win purely
// because nobody physically had time to answer it. Real auctions work
// this way, and it also removes the incentive to sit silent and snipe.
// Deliberately re-arms on EVERY late bid (not once per round), so a
// genuine bidding war can keep extending until someone actually stops.
const ANTI_SNIPE_MS = 10000;

// Offline. Returns true if the clock was actually pushed out, so callers
// can clear the "GOING ONCE/TWICE" banner that is now wrong.
function applyAntiSnipe(){
  // Unlimited-timer rounds have no clock to extend.
  if(!state.currentRoundSeconds || state.currentRoundSeconds <= 0) return false;
  if(!state.roundEndsAt) return false;
  const now = Date.now();
  if(state.roundEndsAt - now >= ANTI_SNIPE_MS) return false;
  state.roundEndsAt = now + ANTI_SNIPE_MS;
  state.timer = Math.ceil(ANTI_SNIPE_MS / 1000);
  // The countdown banner may be mid-"GOING TWICE!" for a deadline that
  // no longer exists - hide it and let runTimer re-show it if the new
  // clock reaches 5s again.
  document.getElementById('countdownBanner').classList.remove('show');
  updateTimerUI();
  return true;
}

function runTimer(){
  clearInterval(state.timerInterval);

  let lastSecondsShown = -1;

  state.timerInterval = setInterval(() => {
    if(state.paused) return; // Don't tick down when paused

    // Calculate time remaining from the round's end timestamp (robust
    // against tab throttling / missed ticks) rather than decrementing
    // a counter, which can drift.
    if (state.roundEndsAt) {
      const now = Date.now();
      state.timer = Math.max(0, Math.ceil((state.roundEndsAt - now) / 1000));
    } else {
      state.timer -= 1;
    }

    // Only trigger animations when crossing second boundaries
    if (state.timer !== lastSecondsShown) {
      lastSecondsShown = state.timer;

      // Final countdown animations
      if(state.timer === 5){
        showCountdownBanner('🔥', t('auction.goingOnce'), 5);
        sounds.countdown();
      } else if(state.timer === 4){
        updateCountdownNum(4);
      } else if(state.timer === 3){
        showCountdownBanner('🔥', t('auction.goingTwice'), 3);
        sounds.countdown();
      } else if(state.timer === 2){
        updateCountdownNum(2);
      } else if(state.timer === 1){
        updateCountdownNum(1);
        sounds.countdown();
      } else if(state.timer === 0){
        showCountdownBanner('🔨', t('auction.soldBang'), '');
        sounds.sold();
        haptics.sold();
        setTimeout(() => {
          document.getElementById('countdownBanner').classList.remove('show');
        }, 800);
      }
    }

    if(state.timer <= 0){
      clearInterval(state.timerInterval);
      setTimeout(() => settleRound(), 1000);
      return;
    }
    updateTimerUI();
  }, 100); // Check more frequently (100ms) for smoother sync
}

function showCountdownBanner(emoji, text, num){
  const banner = document.getElementById('countdownBanner');
  document.getElementById('countdownEmoji').textContent = emoji;
  document.getElementById('countdownText').textContent = text;
  document.getElementById('countdownNum').textContent = num;
  banner.classList.add('show');
}

function updateCountdownNum(num){
  document.getElementById('countdownNum').textContent = num;
}

function updateTimerUI(){
  const num = document.getElementById('timerNum');
  const fill = document.getElementById('timerFill');
  num.textContent = formatTime(state.timer);
  const circumference = 2*Math.PI*42;
  fill.style.strokeDasharray = circumference;
  // Divide by the ACTUAL duration this specific round was given
  // (state.currentRoundSeconds), not the configured base ROUND_SECONDS -
  // later phases get a shorter timer (see roundSecondsForPhase()), and
  // dividing by the unscaled base would make the ring start already
  // partway drained.
  const pct = state.timer/(state.currentRoundSeconds || ROUND_SECONDS);
  fill.style.strokeDashoffset = circumference * (1-Math.min(1,pct));
  // Tokens with the original colours as fallbacks: the stage sits on a light
  // card in the current theme, where white digits and an accent-coloured ring
  // would vanish, so the theme declares its own (--timer-*).
  fill.style.stroke = state.timer<=3 ? 'var(--timer-warn, var(--red))' : 'var(--timer-stroke, var(--amber))';
  num.style.color = state.timer<=3 ? 'var(--timer-warn, var(--red))' : 'var(--timer-ink, var(--white))';
}

// Update the Reroll button state and display
function updateRerollButton(){
  // AI_MODE is a sticky global: it stays true after a solo game until
  // another mode is entered, so checking it alone made this bail out
  // during ONLINE drafts too, leaving the counter frozen (see the note
  // in mpRenderFromState about the same trap).
  if(REROLLS_MODE === 'disabled' || (AI_MODE && !currentRoomCode)) return;

  const btn = document.getElementById('rerollBtn');
  const countDisplay = document.getElementById('rerollsCount');

  const leftThisRound = rerollsLeftThisRound(state.rerollsRemaining, state.roundRerolls);
  // Unlimited still shows a number once the per-round ceiling starts to
  // bite, because at that point the remaining count is the real one.
  countDisplay.textContent = (REROLLS_MODE === 'unlimited' && leftThisRound >= MAX_REROLLS_PER_ROUND)
    ? '∞' : leftThisRound;

  // Disabled once the draft pool is out, the round's five are spent, or
  // bidding has started (rerolling away a player someone has bid on).
  btn.disabled = leftThisRound <= 0 || !!state.currentLeader;
  btn.textContent = t('auction.reroll');
}

// The single question both the button and the no-bids fallback ask.
function canRerollThisRound(){
  return rerollsLeftThisRound(state.rerollsRemaining, state.roundRerolls) > 0;
}

// Handle timeout or "Calling Final Bids" when no bids placed
/* ---- Calling Final Bids as a vote (AI mode) ----
   Shared-screen mode keeps its single "ends the round now" button - one
   group of people round one device don't need to poll each other. AI
   mode does, because the opponents have to be able to say "I'm out"
   without ending the round while the human is still thinking. */

// Mirrors the online vote button: once you've called final bids you're
// committed, until someone's bid resets everyone's vote.
function updateAIGoingButton(){
  const btn = document.getElementById('goingBtn');
  if(!state.auctioning || !state.currentPlayer){ btn.disabled = true; return; }
  const human = state.participants.find(p => p.id === HUMAN_ID);
  const eligible = human && participantNeedsSlot(human, state.currentPlayer.posIdx);
  const iVoted = goingVoteIsIn(HUMAN_ID);
  btn.disabled = iVoted || !eligible;
  btn.textContent = !eligible ? t('auction.youAlreadyHavePosition')
    : iVoted ? t('auction.passedWaiting')
    : t(state.isBlindRound ? 'auction.revealNow' : 'auction.skipTimer');
}

/* Has this participant's "I'm done bidding on this player" already been
   registered? Two ways in, and keeping them separate is the whole point:

     - an EXPLICIT pass (the Skip the Timer button, or an AI deciding not
       to bid). Sticky for the rest of the round - a later bid from
       somebody else must never silently put them back in.
     - being the current leader, which is implicit. Having just bid, the
       only move they have left is to close the round, so making them
       press a second button would be busywork.

   The implicit one deliberately evaporates the moment they're outbid,
   which is what still lets a bidding war run: being outbid genuinely
   does reopen their decision, whereas walking away does not. */
function goingVoteIsIn(pid){
  return !!state.goingVotes[pid] || state.currentLeader === pid;
}

function castGoingVote(pid){
  if(!AI_MODE || !state.auctioning) return;
  if(state.goingVotes[pid]) return;
  const p = state.participants.find(x => x.id === pid);
  if(!p || !participantNeedsSlot(p, state.currentPlayer.posIdx)) return;

  state.goingVotes[pid] = true;
  if(p.isAI) addTicker(`<span style="color:var(--stone)">${t('ticker.passes', {name: esc(p.name)})}</span>`);
  renderBidderGrid();
  checkGoingVotesAndMaybeSettle();
}

// Everyone who still needs this position has now said they're done.
function checkGoingVotesAndMaybeSettle(){
  if(!AI_MODE || !state.auctioning || !state.currentPlayer) return;
  const posIdx = state.currentPlayer.posIdx;
  const eligible = state.participants.filter(p => participantNeedsSlot(p, posIdx));
  if(!eligible.length) return;
  if(!eligible.every(p => goingVoteIsIn(p.id))) return;

  // Settle immediately rather than shortening the clock the way online
  // does. Online keeps a 5s grace because a bid there is a human
  // reaction that may still be in flight; here every eligible manager
  // has explicitly committed, so a countdown would just be dead time
  // repeated across every round of the draft.
  aiStopThinking();
  if(state.isBlindRound){ settleRound(); return; }
  if(!state.currentLeader){ handleNoBids(); return; }
  settleRound();
}

/* Nobody bid. This used to spend a reroll and, once those ran out, hand the
   player to a random manager. Now see js/unsold.js: the first time he goes to
   the back of the pack, the second time someone must take him. */
function handleNoBids(){
  if(!state.currentPlayer) return;
  // Callers differ in whether the round is still marked live (settleRound has
  // already stopped it; the AI "everyone passed" vote has not). Stop it here so
  // a still-running timer can never settle the same round a second time.
  state.auctioning = false;
  clearInterval(state.timerInterval);

  const p = state.currentPlayer;
  const decision = unsoldDecision(p);
  if(decision.action === 'leftover'){
    assignLeftoverPlayer(decision.noBids);
    return;
  }

  state.unsold = (state.unsold || []).concat(unsoldEntry(p, decision.noBids, state.phaseNum));
  addTicker(tVariant('ticker.unsoldPack', pickVariantIndex(), {name: esc(p.name)}));
  renderUnsoldPile();

  document.getElementById('soldWord').textContent = t('auction.unsold');
  document.getElementById('soldWord').className = 'word unsold';
  document.getElementById('soldDetail').textContent = t('auction.soldDetailUnsold', {player: playerNameText(p)});
  document.getElementById('soldFlash').classList.add('show');

  // The slot itself is still open: it comes round again on the next pass.
  setTimeout(() => {
    document.getElementById('soldFlash').classList.remove('show');
    state.currentRound++;
    startRound();
  }, 1500);
}

// The back-of-the-pack count shown in the HUD. Tolerates a skin without it.
function renderUnsoldPile(){
  const chip = document.getElementById('drawChip');
  if(chip) chip.textContent = t(effectiveDrawOrder() === 'random' ? 'draw.random' : 'draw.phase');
  const pile = state.unsold || [];
  const el = document.getElementById('unsoldPile');
  if(!el) return;
  el.hidden = pile.length === 0;
  const label = document.getElementById('unsoldPileLabel');
  if(label) label.textContent = t('auction.unsoldPile', {count: pile.length});
  el.title = pile.map(e => `${e.name} (${e.pos} ${e.rating})`).join('\n');
}

// Second no-bid on the same player: someone has to take him. Not random - the
// manager with the most empty slots (see pickLeftoverWinner), at the lowered
// price or the floor if that is out of reach.
function assignLeftoverPlayer(noBids){
  const p = state.currentPlayer;
  const posIdx = p.posIdx;

  const winner = pickLeftoverWinner(state.participants, posIdx);
  if(!winner){
    // Nobody needs this position anymore
    state.currentRound++;
    startRound();
    return;
  }
  const finalPrice = leftoverPrice(p, winner, noBids);

  const slotIdx = resolveFilledSlot(winner, posIdx);
  winner.budget -= finalPrice;
  winner.squad.push({...p, posIdx: slotIdx, price: finalPrice, newlyPlaced: true});
  winner.positionsFilled.add(slotIdx);

  document.getElementById('soldWord').textContent = t('auction.leftoverPick');
  document.getElementById('soldWord').className = 'word forced';
  document.getElementById('soldDetail').textContent = t('auction.soldDetailLeftover', {player: playerNameText(p), winner: winner.name, price: fmt(finalPrice)});
  document.getElementById('soldFlash').classList.add('show');

  addTicker(buildSaleTickerHTML(p.name, slotCode(slotIdx), winner.name, finalPrice, ' (leftover)', p.rating, p.isFlash));

  renderBidderGrid();

  // Clear newly placed flag after animation
  setTimeout(() => {
    const player = winner.squad[winner.squad.length - 1];
    if(player) player.newlyPlaced = false;
  }, 1000);

  setTimeout(() => {
    state.currentRound++;
    startRound();
  }, 1500);
}

document.getElementById('goingBtn').onclick = () => {
  haptics.callFinalBids();
  // Multiplayer: casting a vote is all any client ever does directly -
  // the host-authoritative engine executes the action once everyone
  // connected has voted (see mpVoteGoing/mpCheckVotesAndMaybeExecute).
  if (currentRoomCode){
    mpVoteGoing();
    return;
  }

  if(!state.auctioning) return;

  // AI mode: the human is one voter among the eligible managers, exactly
  // like online. The round ends when everyone still needing the position
  // has passed (see checkGoingVotesAndMaybeSettle).
  if(AI_MODE){
    castGoingVote(HUMAN_ID);
    return;
  }

  // A blind round has no live "leader" to check - !state.currentLeader
  // is always true while sealed bids are still hidden, which would
  // otherwise wrongly read as "nobody bid" and trigger a reroll/random
  // assign even if people HAVE sealed a bid, just not revealed yet.
  // Calling Final Bids here means "reveal now" - settleRound() already
  // resolves the sealed bids first and handles the genuine no-bids
  // case exactly the same as always.
  if(state.isBlindRound){
    settleRound();
    return;
  }

  // If no one has bid yet, auto-reroll or random assign
  if(!state.currentLeader){
    handleNoBids();
    return;
  }

  if(ROUND_SECONDS === 0){
    settleRound();
  } else if(state.timer > 5){
    state.timer = 5;
    state.roundEndsAt = Date.now() + (5 * 1000);
    updateTimerUI();
  }
};

document.getElementById('rerollBtn').onclick = () => {
  haptics.reroll();
  if (currentRoomCode){
    mpVoteReroll();
    return;
  }

  if(!state.auctioning) return;
  if(state.rerollsRemaining <= 0) return;

  rerollPlayer();
};

// Pause/Resume handlers
// When the current pause began, so resume can push the round deadline out by
// exactly that long. null whenever the auction is not paused by this button.
let pauseStartedAt = null;

document.getElementById('pauseBtn').onclick = () => {
  if (currentRoomCode){
    if(!isHost){ mpShowToast(t('mp.onlyHostPause')); return; }
    mpHostPause();
    return;
  }

  if(!state.auctioning) return;
  /* Only start the stopwatch if we are not already paused. The live-auction
     coach tour pauses the game on its own (see closeLiveAuctionTutorial),
     and restarting the clock here would credit time twice. The overlay is
     still shown either way, so what the button DOES on screen is unchanged. */
  if(!state.paused) pauseStartedAt = Date.now();
  state.paused = true;
  document.getElementById('pausedOverlay').classList.add('show');
};

document.getElementById('resumeBtn').onclick = () => {
  if (currentRoomCode){
    if(!isHost){ mpShowToast(t('mp.onlyHostResume')); return; }
    mpHostResume();
    return;
  }

  /* GIVE BACK EXACTLY THE TIME THE PAUSE TOOK.

     runTimer() derives the countdown from the absolute state.roundEndsAt, so
     without this the clock keeps running behind the overlay and pause only
     hides it. Pause for longer than the time remaining and the player was
     sold the instant you resumed, at the standing bid - which is precisely
     the situation pause exists for. Measured before this: paused 4,000 ms,
     deadline moved 0 ms.

     The tutorial (closeLiveAuctionTutorial) and multiplayer
     (gs.pausedRemainingMs) both already did this correctly; the plain pause
     button was the one path that never got it. */
  if(pauseStartedAt != null){
    if(state.roundEndsAt) state.roundEndsAt += (Date.now() - pauseStartedAt);
    pauseStartedAt = null;
  }
  state.paused = false;
  document.getElementById('pausedOverlay').classList.remove('show');
  if(typeof updateTimerUI === 'function') updateTimerUI();
};

function settleRound(){
  // Re-entrancy guard: the round timer expiring (runTimer()'s delayed
  // settleRound() call) and, in AI mode, the last opponent's "going" vote
  // landing (checkGoingVotesAndMaybeSettle()) both lead here independently,
  // and can both fire for the same round if they land within a moment of
  // each other. state.auctioning is only ever true during a live round
  // (set in startBidding(), cleared right below), so a second call here
  // before the next round begins is always this race, not a new round -
  // without this, it would re-sell the same player, double-deduct the
  // winner's budget, and schedule a second "advance to next round" timer
  // that fires later on its own, sometimes after the draft has already
  // ended and the player has moved on (e.g. re-showing the results screen
  // after "Play Another Auction" has already returned to setup).
  if(!state.auctioning) return;
  state.auctioning = false;
  clearInterval(state.timerInterval);

  // A blind round never wrote a public currentBid/currentLeader as
  // people bid - resolve the sealed bids into that exact same shape
  // right now, so every line below (SOLD flash, budget, ticker, the
  // no-bids fallback) runs completely unchanged, exactly as if it had
  // been a normal live bid all along.
  if(state.isBlindRound){
    resolveSealedBids();
  }

  const p = state.currentPlayer;
  const posIdx = p.posIdx;
  const eligible = state.participants.filter(p => participantNeedsSlot(p, posIdx));

  // Nobody bid: back of the pack (or, the second time, a leftover pick). It
  // ends: each player can draw only UNSOLD_MAX_NO_BIDS no-bids before someone
  // is made to take him, so "nobody ever bids" cannot loop forever.
  if(!state.currentLeader){
    handleNoBids();
    return;
  }

  let price = state.currentBid;
  const winner = state.participants.find(x => x.id === state.currentLeader);

  const slotIdx = resolveFilledSlot(winner, posIdx);
  winner.budget -= price;
  winner.squad.push({...p, posIdx: slotIdx, price, newlyPlaced: true});
  winner.positionsFilled.add(slotIdx);

  document.getElementById('soldWord').textContent = t('auction.sold');
  document.getElementById('soldWord').className = 'word sold';
  document.getElementById('soldDetail').textContent = t('auction.soldDetail', {player: playerNameText(p), winner: winner.name, price: fmt(price)});
  document.getElementById('soldFlash').classList.add('show');

  addTicker(buildSaleTickerHTML(p.name, slotCode(slotIdx), winner.name, price, '', p.rating, p.isFlash));

  renderBidderGrid();

  // Clear newly placed flag after animation completes
  setTimeout(() => {
    const player = winner.squad[winner.squad.length - 1];
    if(player) player.newlyPlaced = false;
  }, 1000);

  // Check if only one participant still needs this position.
  // Modes without auto-assignment (6v6) skip this shortcut entirely and
  // fall through to a normal round, so that last slot is still won by
  // bidding - unopposed, at the minimum bid - rather than handed over.
  const stillNeed = state.participants.filter(p => participantNeedsSlot(p, posIdx));

  if(stillNeed.length === 1 && activeMode().autoAssignLastEligible){
    // Immediate auto-assignment for last participant
    setTimeout(() => {
      document.getElementById('soldFlash').classList.remove('show');
      autoAssignLastPlayer(stillNeed[0], posIdx);
    }, 1500);
  } else {
    // Move to next round
    setTimeout(() => {
      state.currentRound++;
      startRound();
    }, 1500);
  }
}

function autoAssignLastPlayer(participant, posIdx){
  const pos = FORMATION[posIdx];

  // Get current phase for this position
  const currentPhase = positionPhaseTracking[posIdx] || 0;
  const numParticipants = state.participants.length;

  // By the time only one participant is left needing this position, the
  // position has been auctioned N-1 times, so currentPhase is already
  // the LAST band index - i.e. the weakest 1/N of the pool, which is
  // exactly what an auto-assignment should hand out. No separate
  // "pick the weakest half" step is needed any more: the band is the
  // weakest slice by construction. (getPhaseBand clamps the index, so
  // this stays correct even if a draft reaches here early.) Still runs
  // through the dynamic floor so the last player handed out continues
  // the same downward progression as everyone else's, rather than
  // resetting to the top of the weakest band.
  const picked = pickAutoAssignPlayer(pos.code, currentPhase, numParticipants, positionRankFloor[posIdx]);
  const realPlayer = picked.player;
  positionRankFloor[posIdx] = picked.rankFloor;

  /* Built through the SHARED builder rather than assembled by hand here.
     This used to be its own copy of buildRoundPlayer's object literal,
     and the two duly drifted: when players gained a `basePos` (their real
     position, which the match simulation needs to tell a striker from a
     winger) the auto-assigned half of every draft silently didn't get
     one. With two participants that is literally half the squad. */
  const lastPlayer = buildRoundPlayer(realPlayer, pos, posIdx, currentPhase);

  // Increment phase tracker for this position
  positionPhaseTracking[posIdx] = (positionPhaseTracking[posIdx] || 0) + 1;

  // Check if participant can afford it
  const maxAfford = getMaxAffordable(participant);
  let price = lastPlayer.startPrice;

  // If can't afford, use last resort (20M)
  if(price > maxAfford){
    price = MIN_PER_POSITION;
    lastPlayer.startPrice = MIN_PER_POSITION;
    lastPlayer.rating = Math.min(lastPlayer.rating, 69); // Cap at 69 for last resort
  }

  const slotIdx = resolveFilledSlot(participant, posIdx);
  participant.budget -= price;
  participant.squad.push({...lastPlayer, posIdx: slotIdx, price, newlyPlaced: true});
  participant.positionsFilled.add(slotIdx);

  // Show auto-assignment flash
  document.getElementById('playerPos').classList.add('forced');
  document.getElementById('playerPos').textContent = slotCode(slotIdx);

  const nameDisplay = playerNameHTML(lastPlayer, {nation:false});
  document.getElementById('playerName').innerHTML = nameDisplay;
  document.getElementById('playerNat').innerHTML = playerNationalityLineHTML(lastPlayer);
  document.getElementById('playerSub').textContent = t('auction.autoAssignedAt', {price: fmt(price)});

  document.getElementById('soldWord').textContent = t('auction.autoAssigned');
  document.getElementById('soldWord').className = 'word forced';
  document.getElementById('soldDetail').textContent = t('auction.soldDetail', {player: playerNameText(lastPlayer), winner: participant.name, price: fmt(price)});
  document.getElementById('soldFlash').classList.add('show');

  addTicker(buildSaleTickerHTML(lastPlayer.name, slotCode(slotIdx), participant.name, price, ' (auto)', lastPlayer.rating));

  renderBidderGrid();

  // Clear newly placed flag after animation
  setTimeout(() => {
    const player = participant.squad[participant.squad.length - 1];
    if(player) player.newlyPlaced = false;
  }, 1000);

  setTimeout(() => {
    state.currentRound++;
    startRound();
  }, 1500);
}

function rerollPlayer(){
  // NOTE: deliberately no `if(!state.auctioning) return;` guard here.
  // settleRound() sets auctioning=false before invoking this for the
  // "timer expired with no bids" path, so such a guard silently
  // swallowed the reroll and froze the draft forever. Both user-facing
  // entry points (the Reroll button and Calling Final Bids ->
  // handleAutoReroll) already check state.auctioning themselves, and
  // startBidding() below sets it back to true.
  if(!state.currentPlayer) return;

  // Both counters: the draft-wide pool and this round's ceiling.
  state.rerollsRemaining--;
  state.roundRerolls = (state.roundRerolls || 0) + 1;
  updateRerollButton();

  const currentPhase = state.currentPlayer.phase - 1; // Convert back to 0-indexed
  const posIdx = state.currentPlayer.posIdx;
  const numParticipants = state.participants.length;
  const currentRating = state.currentPlayer.rating;

  // Classic: the dynamic floor keeps this pick ranked below whatever was
  // just rejected, so a reroll can't climb back to a better player.
  // 6v6: a comparable player instead - see generateRerollPlayer().
  const picked = generateRerollPlayer(posIdx, currentPhase, numParticipants, positionRankFloor[posIdx], currentRating);
  state.currentPlayer = picked.player;
  positionRankFloor[posIdx] = picked.rankFloor;

  addTicker(buildRerolledTickerHTML(state.currentPlayer.name));

  const eligible = state.participants.filter(p => participantNeedsSlot(p, posIdx));
  startBidding(eligible);
}

function addTicker(html){
  const t = document.getElementById('ticker');
  const row = document.createElement('div');
  row.innerHTML = html;
  t.prepend(row);
}

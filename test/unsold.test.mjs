import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { loadApp, until, draftLocally } from './helpers.mjs';

async function startShared(app, { mode = 'classic', count = 2, pool = 'all_time' } = {}) {
  await app.run(`setActivePool(${JSON.stringify(pool)})`);
  app.run(`applyGameMode(${JSON.stringify(mode)}); participantCount = ${count}; ROUND_SECONDS = 0; REROLLS_MODE = 'disabled'; openSharedSetup(); renderNamesGrid()`);
  app.run(`document.querySelector('#namesGrid input').value = 'Manager One'`);
  await app.run('startAuction()');
}

const resultsShown = app => app.run("document.getElementById('resultsScreen').style.display === 'block'");

/* Runs a draft in which NOBODY ever bids. Returns once the results screen is up. */
async function declineEverything(app) {
  let handled = null;
  await until(() => {
    if (resultsShown(app)) return true;
    if (!app.run('state.auctioning && state.currentPlayer && !state.paused')) return false;
    const key = app.run('state.phaseNum + ":" + state.currentRound + ":" + state.currentPlayer.id + ":" + state.currentPlayer.startPrice');
    if (handled === key) return false;
    handled = key;
    app.run('settleRound()');
    return false;
  }, 'a draft where nobody bids to finish', 60_000);
}

test('unsold helpers: price drops 10% a return and floors at the minimum, and no forced pick exists', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic')");
  const price = (start, n) => app.run(`unsoldReofferPrice({startPrice:${start}}, ${n})`);
  assert.equal(price(75, 0), 75);
  assert.equal(price(75, 1), 70);   // 67.5 snaps to the 5M step
  assert.equal(price(75, 2), 60);   // 60.75
  assert.equal(price(20, 3), 20);   // never below the 20M floor
  assert.equal(price(75, 50), 20, 'many returns end at the floor and stay there');
  // Measured from the ORIGINAL price, not compounded from a rounded one.
  assert.equal(app.run('unsoldReofferPrice({startPrice:30, baseStartPrice:75}, 1)'), 70);

  assert.equal(app.run('unsoldNoBids({startPrice:50})'), 1);
  assert.equal(app.run('unsoldNoBids({startPrice:50, noBids:1})'), 2);
  assert.equal(app.run('unsoldNoBids({startPrice:50, noBids:7})'), 8, 'there is no limit after which somebody is made to take him');

  // Nothing in the game can hand a manager a player they did not bid for.
  for (const name of ['unsoldDecision', 'pickLeftoverWinner', 'leftoverPrice', 'autoAssign', 'autoAssignLastPlayer', 'pickAutoAssignPlayer', 'startStragglerRound', 'mpHostAutoAssignLast', 'mpHostStragglerRound', 'assignLeftoverPlayer']) {
    assert.equal(app.run(`typeof ${name}`), 'undefined', `${name} is gone`);
  }

  app.run("applyGameMode('sixv6')");
  assert.equal(app.run('unsoldReofferPrice({startPrice:1}, 2)'), 1);   // 1M stays 1M
});

test('unsold queue entries come back for their own position, and only on a later pass', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic', '4-3-3')");
  const entry = 'unsoldEntry({id:7,name:"X",posIdx:2,pos:"CB",rating:80,startPrice:60}, 1, 1)';
  assert.deepEqual(app.json(`takeUnsoldForSlot([${entry}], 4, 2).player`), null, 'a different position (RB) never receives him');
  assert.deepEqual(app.json(`takeUnsoldForSlot([${entry}], 2, 1).player`), null, 'not within the pass he went unsold in');
  const back = app.json(`takeUnsoldForSlot([${entry}], 2, 2)`);
  assert.equal(back.player.id, 7);
  assert.equal(back.player.startPrice, 55);   // 60 * 0.9 = 54 -> 55 on the 5M step
  assert.equal(back.queue.length, 0);
  // The formation's other centre-back token is the same position, so it can re-offer him too.
  assert.equal(app.json(`takeUnsoldForSlot([${entry}], 3, 2).player.id`), 7);

  // 6v6 tokens of one category are interchangeable as well.
  app.run("applyGameMode('sixv6', '2-1-2')");
  const fwd = app.json("FORMATION.map((f,i)=>[f.code,i]).filter(x=>x[0]==='FWD').map(x=>x[1])");
  assert(fwd.length === 2);
  const e2 = `unsoldEntry({id:9,name:"Y",posIdx:${fwd[0]},pos:"FWD",rating:80,startPrice:1}, 1, 1)`;
  assert.equal(app.json(`takeUnsoldForSlot([${e2}], ${fwd[1]}, 2).player.posIdx`), fwd[1]);
});

test('an unsold player nobody could still fit is pruned from the queue', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic', '4-3-3')");
  const full = codes => `{id:'p', budget:900, squad:[${codes.map(c => `{positions:['${c}']}`).join(',')}]}`;
  const keeper = '{id:1,name:"K",posIdx:0,pos:"GK",positions:["GK"],rating:80,startPrice:30}';
  assert.equal(app.run(`pruneUnsold([${keeper}], [${full(['CB'])}]).length`), 1);
  assert.equal(app.run(`pruneUnsold([${keeper}], [${full(['GK'])}]).length`), 0, 'everyone already has a keeper');
});

test('a position only one manager can use is an unopposed round they win by bidding, never a gift', async t => {
  const app = await loadApp({ accelerate: true }); t.after(() => app.close());
  await startShared(app, { count: 2 });
  await until(() => app.run('state.auctioning && state.currentPlayer'), 'first round');
  // Make the second manager's XI complete, so only the first can sign anybody.
  app.run(`{
    state.auctioning = false; clearInterval(state.timerInterval);
    state.blindRoundUsed = true;   // the draft's one sealed round is not what this test is about
    const full = ['GK','LB','CB','CB','RB','CM','CM','CM','LW','RW','ST'].map((code, i) => ({id: 9000 + i, name: 'F' + i, rating: 70, price: 20, positions: [code], pos: code, basePos: code, posIdx: i}));
    state.participants[1].squad = full;
    refreshLineup(state.participants[1]);
    state.currentRound++; startRound();
  }`);
  assert.equal(app.run('state.auctioning'), true, 'the round runs, it is not skipped or settled for him');
  assert.equal(app.run('state.participants[0].squad.length'), 0, 'nothing was handed to him');
  assert.deepEqual(app.json('state.participants.filter(p => participantCanTake(p, state.currentPlayer)).map(p => p.id)'), ['p0'], 'he is the only one who can sign this player');
  assert.equal(app.run("document.getElementById('soldFlash').classList.contains('show') && /AUTO/i.test(document.getElementById('soldWord').textContent)"), false);

  // Bidding wins him at once (nobody is left to outbid)...
  const before = app.run('state.participants[0].budget');
  const player = app.json('({id: state.currentPlayer.id, price: state.currentPlayer.startPrice})');
  app.run('bidInputs.p0 = getMinBid(); placeBid(\'p0\')');
  assert.equal(app.run('state.auctioning'), false, 'the sale closed straight away');
  assert.equal(app.run(`state.participants[0].squad.some(x => x.id === ${player.id} && x.price === ${player.price})`), true);
  assert.equal(app.run('state.participants[0].budget'), before - player.price);

  // ...and declining sends the next one to the back of the pack instead.
  await until(() => app.run('state.auctioning && state.currentPlayer'), 'next round');
  const squadBefore = app.run('state.participants[0].squad.length');
  const unsoldBefore = app.run('state.unsold.length');
  app.run('settleRound()');
  assert.equal(app.run('state.participants[0].squad.length'), squadBefore, 'declining adds nobody');
  assert.equal(app.run('state.unsold.length'), unsoldBefore + 1, 'he goes to the back of the pack');
  assert.deepEqual(app.errors, []);
});

test('a player nobody bids on goes to the back of the pack and returns next pass at a lower price', async t => {
  const app = await loadApp({ accelerate: true }); t.after(() => app.close());
  await startShared(app);
  await until(() => app.run('state.auctioning && state.currentPlayer'), 'first round');
  const first = app.json('({id: state.currentPlayer.id, posIdx: state.currentPlayer.posIdx, price: state.currentPlayer.startPrice, name: state.currentPlayer.name})');
  const rerollsBefore = app.run('state.rerollsRemaining');

  app.run('settleRound()');   // nobody bid
  assert.equal(app.run('state.unsold.length'), 1);
  assert.equal(app.run('state.unsold[0].id'), first.id);
  assert.equal(app.run('state.participants.every(p => p.squad.length === 0)'), true, 'nobody was handed him');
  assert.equal(app.run('state.rerollsRemaining'), rerollsBefore, 'no reroll was spent');

  // Decline the rest of pass 1; pass 2 must re-offer him for his own slot.
  let handled = null; let returned = null;
  await until(() => {
    if (!app.run('state.auctioning && state.currentPlayer && !state.paused')) return false;
    const key = app.run('state.phaseNum + ":" + state.currentRound');
    if (handled === key) return false;
    handled = key;
    if (app.run('state.phaseNum') >= 2 && app.run(`state.currentPlayer.posIdx === ${first.posIdx}`)) {
      returned = app.json('({id: state.currentPlayer.id, price: state.currentPlayer.startPrice, phase: state.phaseNum})');
      return true;
    }
    app.run('settleRound()');
    return false;
  }, 'the unsold player to return', 30_000);

  assert.equal(returned.id, first.id, 'the same player comes back');
  assert.equal(returned.phase, 2);
  assert.equal(returned.price, app.run(`unsoldReofferPrice({startPrice:${first.price}}, 1)`));
  assert(returned.price < first.price);
  assert.equal(app.run(`state.unsold.some(e => e.id === ${first.id})`), false, 'he left the queue when re-offered');

  // Someone finally bids and wins him at the lowered price.
  app.run(`{ const p = state.participants[0]; bidInputs[p.id] = getMinBid(); placeBid(p.id); settleRound(); }`);
  assert.equal(app.run(`state.participants[0].squad.some(x => x.id === ${first.id} && x.price === ${returned.price})`), true);
  assert.deepEqual(app.errors, []);
});

test('when nobody bids, nobody is assigned anyone: players keep coming back cheaper until somebody chooses to bid', async t => {
  for (const [mode, count] of [['classic', 2], ['sixv6', 3]]) {
    const app = await loadApp({ accelerate: true });
    try {
      await startShared(app, { mode, count });
      // Decline sixty rounds in a row - far more than any old "forced pick" limit allowed.
      let handled = null, declined = 0;
      await until(() => {
        if (declined >= 60) return true;
        if (!app.run('state.auctioning && state.currentPlayer && !state.paused')) return false;
        const key = app.run('state.phaseNum + ":" + state.currentRound + ":" + state.currentPlayer.id + ":" + state.currentPlayer.startPrice');
        if (handled === key) return false;
        handled = key; declined++;
        app.run('settleRound()');
        return false;
      }, 'sixty declined rounds', 60_000);
      assert.equal(app.run('state.participants.every(p => p.squad.length === 0)'), true, `${mode}: nobody was handed a player`);
      assert.equal(app.run('state.participants.every(p => p.budget === BUDGET)'), true, `${mode}: nobody paid for one`);
      assert.equal(resultsShown(app), false, `${mode}: the draft just keeps going`);
      const ticker = app.run("document.getElementById('ticker').textContent");
      assert.equal(/\(auto\)|\(leftover\)|AUTO-ASSIGNED|LEFTOVER/i.test(ticker), false, `${mode}: nothing in the log was assigned`);
      // Returned players come back cheaper, down to the floor, with no cap.
      assert(app.run('state.unsold.some(e => e.noBids >= 3)'), `${mode}: a player has gone round more than twice`);
      assert(app.run('state.unsold.every(e => unsoldReofferPrice(e, e.noBids) >= MIN_PER_POSITION)'));

      // Then the table decides to play: every manager who can bids the asking price. The draft completes.
      let seen = null;
      await until(() => {
        if (resultsShown(app)) return true;
        if (!app.run('state.auctioning && state.currentPlayer && !state.paused')) return false;
        const key = app.run('state.phaseNum + ":" + state.currentRound + ":" + state.currentPlayer.id + ":" + state.currentPlayer.startPrice');
        if (seen === key) return false;
        seen = key;
        app.run(`{
          const eligible = state.participants.filter(p => participantCanTake(p, state.currentPlayer));
          const bidder = eligible.reduce((a, b) => a.squad.length <= b.squad.length ? a : b);
          bidInputs[bidder.id] = getMinBid();
          if(state.isBlindRound) submitSealedBid(bidder.id); else placeBid(bidder.id);
          settleRound();
        }`);
        return false;
      }, `${mode} draft to finish once somebody bids`, 60_000);
      const size = app.run('FORMATION.length');
      assert.equal(app.run(`state.participants.every(p => p.squad.length === ${size} && p.budget >= 0)`), true, `${mode}: every squad is full`);
      const ids = app.json('state.participants.flatMap(p => p.squad.map(x => x.id))');
      assert.equal(new Set(ids).size, ids.length, `${mode}: no player drafted twice`);
      assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
  }
});

test('the pass counter never reads "Phase 6/5": a clean draft is one pass per participant, extra laps count after that', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic')");
  assert.equal(app.run('progressText(1, 3, 0)'), 'Phase 1/3 · Round 1/11');
  assert.equal(app.run('progressText(3, 3, 3)'), 'Phase 3/3 · Round 4/11', 'the final clean pass is N of N');
  assert.equal(app.run('progressText(4, 3, 0)'), 'Extra lap 1 · Round 1/11');
  assert.equal(app.run('progressText(6, 6, 10)'), 'Phase 6/6 · Round 11/11', 'six managers: phase 6 of 6');
  assert(app.run('maxDraftPhases(2)') >= 2 * 2 - 1, 'the safety cap leaves room for two passes per assignment');
  assert(app.run('maxDraftPhases(6)') >= 2 * 6 - 1);
});

test('the total shown during a real draft equals the number of participants, in both modes', async t => {
  for (const [mode, count] of [['classic', 6], ['sixv6', 4]]) {
    const app = await loadApp({ accelerate: true });
    try {
      await startShared(app, { mode, count });
      await until(() => app.run('state.auctioning && state.currentPlayer'), 'first round');
      assert.equal(app.run('state.totalPhases'), count);
      assert.match(app.run("document.getElementById('progressTag').textContent"), new RegExp(`Phase 1/${count} `));
    } finally { await app.close(); }
  }
});

/* ---------- draw order ---------- */

test('draw order defaults to each mode, can be overridden, persists, and ignores junk', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic')");
  assert.equal(app.run('effectiveDrawOrder()'), 'phase');
  app.run("applyGameMode('sixv6')");
  assert.equal(app.run('effectiveDrawOrder()'), 'random');

  app.run("setDrawOrder('phase')");
  assert.equal(app.run('effectiveDrawOrder()'), 'phase', '6v6 can now run the ladder');
  app.run("applyGameMode('classic'); setDrawOrder('random')");
  assert.equal(app.run('effectiveDrawOrder()'), 'random', 'Classic can now run random');

  app.run('saveSettings()');
  assert.equal(JSON.parse(app.window.localStorage.getItem('auctionXISettings')).drawOrder, 'random');
  app.run("setDrawOrder(null); loadSettings()");
  assert.equal(app.run('effectiveDrawOrder()'), 'random');

  assert.equal(app.run("setDrawOrder('sideways')"), 'phase', 'junk falls back to the mode default');
  assert.equal(app.run('DRAW_ORDER'), null);
});

test('phase-wise draws stay in their band while random draws reach the whole pool, in both modes', async t => {
  const app = await loadApp(); t.after(() => app.close());
  await app.run("setActivePool('all_time')");
  const sample = (mode, order) => {
    app.run(`applyGameMode('${mode}'); setDrawOrder('${order}')`);
    return app.json(`(() => {
      const n = 3, out = [];
      for (let i = 0; i < 300; i++) {
        usedPlayerIds.clear();
        const slot = FORMATION.findIndex(f => f.code === ${mode === 'classic' ? "'CB'" : "'DEF'"});
        out.push(generateRoundPlayer(slot, 0, n, 0).player.rating);
      }
      return out;
    })()`);
  };
  for (const mode of ['classic', 'sixv6']) {
    const ladder = sample(mode, 'phase');
    const random = sample(mode, 'random');
    assert(Math.min(...random) < Math.min(...ladder), `${mode}: random reaches below the phase-1 band (${Math.min(...random)} vs ${Math.min(...ladder)})`);
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    assert(mean(ladder) > mean(random), `${mode}: phase 1 is better on average than a random draw`);
  }
  assert.deepEqual(app.errors, []);
});

test('flash picks only fire on the ladder', async t => {
  const app = await loadApp(); t.after(() => app.close());
  await app.run("setActivePool('all_time')");
  app.run("applyGameMode('classic')");
  const flashes = order => {
    app.run(`setDrawOrder('${order}')`);
    return app.run(`(() => { let n = 0; for (let i = 0; i < 400; i++) { usedPlayerIds.clear(); if (maybeGenerateFlashPlayer(0, 2, 4, 3)) n++; } return n; })()`);
  };
  assert(flashes('phase') > 0);
  assert.equal(flashes('random'), 0);
});

/* ---------- online ---------- */

test('online: an unsold player goes to the back of the pack for everyone, and nobody is ever assigned one', async t => {
  const server = await createApplication(); const address = await server.listen();
  const url = `http://127.0.0.1:${address.port}/`;
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await server.close(); });
  const host = await loadApp({ url, accelerate: true }); clients.push(host);
  host.run("applyGameMode('classic'); ROUND_SECONDS=0; RESET_SECONDS=0; REROLLS_MODE='disabled'; document.getElementById('hostNameInput').value='Host Manager'");
  await host.run('createMultiplayerRoom()');
  const code = host.run('currentRoomCode');
  const guest = await loadApp({ url, accelerate: true }); clients.push(guest);
  guest.run(`document.getElementById('joinRoomCode').value='${code}'; document.getElementById('joinNameInput').value='Guest'`);
  await guest.run('joinMultiplayerRoom()');
  await until(() => clients.every(c => c.run('state.participants.length===2')), 'both joined');
  guest.run('toggleReady()');
  await until(() => host.run('Object.values(mpParticipantsSnapshot).filter(p=>p.ready).length===2'), 'ready');
  await host.run('hostStartAuction()');

  await until(() => clients.every(c => c.run("mpGameState && mpGameState.roundPhase==='bidding'")), 'first round');
  const first = host.json('({id: mpGameState.currentPlayer.id, round: mpGameState.roundId})');
  host.run('mpHostSettleRound()');   // nobody bid
  // The settled snapshot is transient (the next round follows almost at once),
  // so read the host's own state synchronously and render it directly.
  assert.equal(host.run('mpGameState.roundPhase'), 'settled');
  assert.equal(host.run('mpGameState.settleInfo.mode'), 'unsold');
  host.run('mpRenderFromState()');
  assert.equal(host.run("document.getElementById('soldWord').textContent"), 'UNSOLD');
  assert.equal(host.run("document.getElementById('soldWord').className"), 'word unsold');
  // The queue is durable and travels in gameState to every client.
  await until(() => clients.every(c => c.run('mpGameState.unsold && mpGameState.unsold.length===1')), 'the unsold queue on every client');
  for (const c of clients) {
    assert.equal(c.run('mpGameState.unsold[0].id'), first.id);
    assert.equal(c.run('state.participants.every(p => p.squad.length === 0)'), true);
  }

  // Keep declining: the same player returns cheaper and nobody is ever handed anyone.
  let seen = null, declined = 0;
  await until(() => {
    if (declined >= 14) return true;
    if (!host.run("mpGameState && mpGameState.roundPhase==='bidding'")) return false;
    const round = host.run('mpGameState.roundId');
    if (round === seen) return false;
    seen = round; declined++;
    host.run('mpHostSettleRound()');
    return false;
  }, 'fourteen declined online rounds', 60_000);
  await until(() => host.run("mpGameState && mpGameState.roundPhase==='bidding'"), 'a live round after the declines');
  assert.equal(host.run("mpGameState.roundPhase === 'complete'"), false, 'the draft keeps going');
  assert.equal(host.run('state.participants.every(p => p.squad.length === 0 && p.budget === BUDGET)'), true, 'nobody was handed anyone');
  assert.equal(host.run("(mpGameState.unsold || []).some(e => e.noBids >= 2)"), true, 'players have gone round more than once');

  // One manager bids: they, and only they, get the player.
  const round = host.run('mpGameState.roundId');
  await until(() => clients.every(c => c.run(`mpGameState && mpGameState.roundId===${round} && mpGameState.roundPhase==='bidding'`)), 'round synchronization');
  const bidder = clients.find(c => c.run('mpIsEligibleThisRound()'));
  const uid = bidder.run('currentUserId');
  const price = host.run('mpGameState.currentPlayer.startPrice');
  const playerId = host.run('mpGameState.currentPlayer.id');
  if (host.run('mpGameState.isBlindRound')) {   // the draft's one sealed round may land here
    bidder.run('mpSubmitSealedBid(mpGameState.currentPlayer.startPrice)');
    await until(() => host.run(`!!mpGameState.sealedBids[${JSON.stringify(uid)}]`), 'the sealed offer');
  } else {
    bidder.run('mpPlaceBid(mpGameState.currentPlayer.startPrice)');
    await until(() => host.run(`mpGameState.currentLeader===${JSON.stringify(uid)} || mpGameState.roundId!==${round}`), 'the bid');
  }
  if (host.run(`mpGameState.roundId===${round} && mpGameState.roundPhase==='bidding'`)) host.run('mpHostSettleRound()');
  await until(() => clients.every(c => c.run(`state.participants.find(p => p.id===${JSON.stringify(uid)}).squad.some(x => x.id===${JSON.stringify(playerId)} && x.price===${price})`)), 'the winner to hold him on every client');
  assert.equal(host.run(`state.participants.filter(p => p.squad.length > 0).length`), 1, 'and nobody else was given anyone');
  assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
});

/* ---------- draft filters ---------- */

test('draft filters: era, league, nation and quality floor narrow who can come up, and junk is ignored', async t => {
  const app = await loadApp(); t.after(() => app.close());
  await app.run("setActivePool('ea_database')");
  app.run("applyGameMode('classic')");
  const count = (filters, n = 4) => { app.run(`setDraftFilters(${JSON.stringify(filters)})`); return app.run(`draftablePlayers(${n}).length`); };

  const everyone = count({ minRating: 75 });
  assert(count({ minRating: 85 }) < everyone, 'a higher floor means fewer players');
  assert(app.run('draftablePlayers(4).every(p => p.rating >= 85)'));

  const present = count({ era: 'present', minRating: 75 });
  assert(present > 0 && present < everyone, 'present-day keeps only players active in the newest data');
  assert(app.run("draftablePlayers(4).every(p => p.era === 'Current')"));

  const epl = count({ league: 'Premier League', minRating: 75 });
  assert(epl > 0 && epl < everyone);
  assert(app.run("draftablePlayers(4).every(p => p.league === 'Premier League')"));

  assert(count({ nation: 'Brazil', minRating: 75 }) > 0);
  assert(app.run("draftablePlayers(4).every(p => primaryNationality(p.nationality) === 'Brazil')"));

  assert.deepEqual(app.json("setDraftFilters({era:'nonsense', league: 5, nation: null, minRating: 99})"), { era: 'all', league: '', nation: '', minRating: 0 });
});

test('a deep pool tightens its automatic quality floor as fewer players are needed', async t => {
  const app = await loadApp(); t.after(() => app.close());
  await app.run("setActivePool('ea_database')");
  app.run('setDraftFilters({})');
  assert.equal(app.run('effectiveMinRating(2)'), 80);
  assert.equal(app.run('effectiveMinRating(4)'), 80);
  assert.equal(app.run('effectiveMinRating(5)'), 76);
  assert.equal(app.run('effectiveMinRating(9)'), 72);
  app.run('setDraftFilters({minRating: 85})');
  assert.equal(app.run('effectiveMinRating(9)'), 85, 'an explicit floor wins over the automatic one');
  // Pools without tiers behave exactly as before.
  await app.run("setActivePool('current_players')");
  app.run('setDraftFilters({})');
  assert.equal(app.run('effectiveMinRating(9)'), 0);
});

test('era filters follow each pool\'s own data, and a pool switch drops filters it cannot honour', async t => {
  const app = await loadApp(); t.after(() => app.close());
  await app.run("setActivePool('all_time')");
  const opts = app.json('draftFilterOptions()');
  assert.equal(opts.legends, 621);
  assert(opts.eraSplit, 'all-time mixes retired and active players');
  app.run("setDraftFilters({era:'legends'})");
  assert(app.run("draftablePlayers(4).length > 100 && draftablePlayers(4).every(p => p.era === 'Legend')"));

  await app.run("setActivePool('current_players')");
  assert.equal(app.run('DRAFT_FILTERS.era'), 'all', 'current players has no legends, so that filter was dropped');
  assert.equal(app.json('draftFilterOptions()').legends, 0);

  app.run("setDraftFilters({league:'Premier League'})");
  await app.run("setActivePool('world_cup_2026')");
  assert.equal(app.run('DRAFT_FILTERS.league'), '', 'World Cup players carry no league');
});

test('a pool that the filters leave too thin is reported with a hint to loosen them, and the draft will not start', async t => {
  const app = await loadApp(); t.after(() => app.close());
  await app.run("setActivePool('ea_database')");
  app.run("applyGameMode('classic'); setDraftFilters({nation:'Iceland', minRating:85})");
  const message = app.run('poolReadinessMessage(4)');
  assert(message && /filter/i.test(message), message);
  app.run("setDraftFilters({})");
  assert.equal(app.run('poolReadinessMessage(4)'), null);
});

test('filters and draw order travel in the room settings and are adopted by everyone', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic')");
  app.run("mpAdoptRoomSettings({gameMode:'classic', formation:'4-3-3', drawOrder:'random', filters:{era:'present', minRating:80}})");
  assert.equal(app.run('effectiveDrawOrder()'), 'random');
  assert.equal(app.run('DRAFT_FILTERS.era'), 'present');
  assert.equal(app.run('DRAFT_FILTERS.minRating'), 80);
  // A room from before these settings existed drafts exactly as it always did.
  app.run("mpAdoptRoomSettings({gameMode:'sixv6', formation:'2-1-2'})");
  assert.equal(app.run('effectiveDrawOrder()'), 'random');   // 6v6's own default
  assert.equal(app.run('draftFiltersActive()'), false);
  app.run("mpAdoptRoomSettings({gameMode:'classic', formation:'4-3-3'})");
  assert.equal(app.run('effectiveDrawOrder()'), 'phase');
});

test('the 10,000-player pool completes Classic drafts at small and large tables, on the ladder and at random', async t => {
  for (const [count, order] of [[3, 'phase'], [8, 'phase'], [5, 'random']]) {
    const app = await loadApp({ accelerate: true });
    try {
      app.run(`setDrawOrder('${order}')`);
      await draftLocally(app, { mode: 'classic', count, pool: 'ea_database' });
      assert.equal(app.run('state.participants.every(p => p.squad.length === 11 && p.budget >= 0)'), true, `${count} managers, ${order}`);
      const ids = app.json('state.participants.flatMap(p => p.squad.map(x => x.id))');
      assert.equal(new Set(ids).size, ids.length);
      const synthetic = app.run('state.participants.some(p => p.squad.some(x => x.id == null))');
      assert.equal(synthetic, false, 'no "Unknown Player" fallbacks');
      assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
  }
});

test('online: the host switching pool, draw order and filters reaches the room and the guest, and the server accepts it', async t => {
  const server = await createApplication(); const address = await server.listen();
  const url = `http://127.0.0.1:${address.port}/`;
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await server.close(); });
  const host = await loadApp({ url, accelerate: true }); clients.push(host);
  host.run("applyGameMode('classic'); document.getElementById('hostNameInput').value='Host Manager'");
  await host.run('createMultiplayerRoom()');
  const code = host.run('currentRoomCode');
  const guest = await loadApp({ url, accelerate: true }); clients.push(guest);
  guest.run(`document.getElementById('joinRoomCode').value='${code}'; document.getElementById('joinNameInput').value='Guest'`);
  await guest.run('joinMultiplayerRoom()');
  await until(() => clients.every(c => c.run('state.participants.length===2')), 'both joined');

  await host.run("choosePool('ea_database')");
  // Through the real controls, so the host's persist step is what is under test.
  const league = host.window.document.querySelector('#waitingDraftRules [data-league]');
  assert(league, 'the Pro Database offers a league filter');
  league.value = 'Premier League'; league.dispatchEvent(new host.window.Event('change'));
  host.window.document.querySelector('#waitingDraftRules [data-order="random"]').click();

  const settings = () => host.json("(() => { let v; database.ref('rooms/'+currentRoomCode+'/settings').once('value').then(s => { window.__s = s.val(); }); return window.__s || null; })()");
  await until(() => { settings(); return host.run('window.__s && window.__s.poolId') === 'ea_database' && host.run("window.__s.filters && window.__s.filters.league") === 'Premier League' && host.run('window.__s.drawOrder') === 'random'; }, 'the room settings to carry the host\'s choices');

  await until(() => guest.run("DRAFT_FILTERS.league === 'Premier League' && effectiveDrawOrder() === 'random' && activePoolId === 'ea_database'"), 'the guest to adopt them');
  assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
});

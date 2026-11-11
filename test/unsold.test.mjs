import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { loadApp, until } from './helpers.mjs';

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

test('unsold helpers: price drops 10% a return, floors at the minimum, and the second no-bid forces a leftover pick', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic')");
  const price = (start, n) => app.run(`unsoldReofferPrice({startPrice:${start}}, ${n})`);
  assert.equal(price(75, 0), 75);
  assert.equal(price(75, 1), 70);   // 67.5 snaps to the 5M step
  assert.equal(price(75, 2), 60);   // 60.75
  assert.equal(price(20, 3), 20);   // never below the 20M floor
  // Measured from the ORIGINAL price, not compounded from a rounded one.
  assert.equal(app.run('unsoldReofferPrice({startPrice:30, baseStartPrice:75}, 1)'), 70);

  assert.deepEqual(app.json('unsoldDecision({startPrice:50})'), { action: 'requeue', noBids: 1 });
  assert.deepEqual(app.json('unsoldDecision({startPrice:50, noBids:1})'), { action: 'leftover', noBids: 2 });

  app.run("applyGameMode('sixv6')");
  assert.equal(app.run('unsoldReofferPrice({startPrice:1}, 2)'), 1);   // 1M stays 1M
});

test('unsold queue entries only come back for their own slot, and only on a later pass', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic', '4-3-3')");
  const entry = 'unsoldEntry({id:7,name:"X",posIdx:2,pos:"CB",rating:80,startPrice:60}, 1, 1)';
  assert.deepEqual(app.json(`takeUnsoldForSlot([${entry}], 3, 2).player`), null, 'a different (individually owned) slot never receives him');
  assert.deepEqual(app.json(`takeUnsoldForSlot([${entry}], 2, 1).player`), null, 'not within the pass he went unsold in');
  const back = app.json(`takeUnsoldForSlot([${entry}], 2, 2)`);
  assert.equal(back.player.id, 7);
  assert.equal(back.player.startPrice, 55);   // 60 * 0.9 = 54 -> 55 on the 5M step
  assert.equal(back.queue.length, 0);

  // 6v6 slots of one category are interchangeable, so either forward slot can re-offer him.
  app.run("applyGameMode('sixv6', '2-1-2')");
  const fwd = app.json("FORMATION.map((f,i)=>[f.code,i]).filter(x=>x[0]==='FWD').map(x=>x[1])");
  assert(fwd.length === 2);
  const e2 = `unsoldEntry({id:9,name:"Y",posIdx:${fwd[0]},pos:"FWD",rating:80,startPrice:1}, 1, 1)`;
  assert.equal(app.json(`takeUnsoldForSlot([${e2}], ${fwd[1]}, 2).player.posIdx`), fwd[1]);
});

test('the leftover pick goes to the manager with the most empty slots, then the smaller budget', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic', '4-3-3')");
  const mk = (id, squad, budget) => `{id:'${id}', budget:${budget}, squad:new Array(${squad}).fill({}), positionsFilled:new Set()}`;
  assert.equal(app.run(`pickLeftoverWinner([${mk('a', 5, 500)}, ${mk('b', 2, 900)}, ${mk('c', 2, 400)}], 4).id`), 'c', 'b and c tie on empty slots; c has less money');
  assert.equal(app.run(`pickLeftoverWinner([${mk('a', 5, 500)}, ${mk('b', 3, 100)}], 4).id`), 'b', 'more empty slots beats a smaller budget');
  // Someone who already filled the slot is not in the running.
  assert.equal(app.run(`pickLeftoverWinner([{id:'a', budget:1, squad:[], positionsFilled:new Set([4])}, ${mk('b', 9, 900)}], 4).id`), 'b');
  assert.equal(app.run(`pickLeftoverWinner([{id:'a', budget:1, squad:[], positionsFilled:new Set([4])}], 4)`), null);
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

test('a draft where nobody EVER bids still ends with full squads, no duplicates, and no random assignment', async t => {
  for (const [mode, count] of [['classic', 2], ['classic', 4], ['sixv6', 3]]) {
    const app = await loadApp({ accelerate: true });
    try {
      await startShared(app, { mode, count });
      await declineEverything(app);
      const size = app.run('FORMATION.length');
      assert.equal(app.run(`state.participants.every(p => p.squad.length === ${size})`), true, `${mode}/${count}: every squad is full`);
      assert.equal(app.run('state.participants.every(p => p.budget >= 0)'), true, `${mode}/${count}: nobody overspent`);
      const ids = app.json('state.participants.flatMap(p => p.squad.map(x => x.id))');
      assert.equal(new Set(ids).size, ids.length, `${mode}/${count}: no player drafted twice`);
      assert.equal(app.run('state.rerollsRemaining'), 0, 'rerolls were disabled and none were spent');
      assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
  }
});

test('the pass counter reads as an extra lap rather than "Phase 7/3" once unsold players force more passes', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic')");
  assert.equal(app.run('progressText(2, 2, 3)'), 'Phase 2/2 · Round 4/11');
  assert.equal(app.run('progressText(3, 2, 3)'), 'Phase 3/2 · Round 4/11', 'the clean final (auto-assign) pass keeps its existing label');
  assert.equal(app.run('progressText(4, 2, 0)'), 'Extra lap 1 · Round 1/11');
  assert(app.run('maxDraftPhases(2)') >= 2 * 2 - 1 + 1, 'the safety cap leaves room for two passes per assignment');
  assert(app.run('maxDraftPhases(6)') >= 2 * 6 - 1);
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

test('online: an unsold player goes to the back of the pack for everyone, and a draft where nobody bids still completes', async t => {
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

  let seen = null;
  await until(() => {
    if (clients.every(c => c.run("mpGameState && mpGameState.roundPhase==='complete'"))) return true;
    if (!host.run("mpGameState && mpGameState.roundPhase==='bidding'")) return false;
    const round = host.run('mpGameState.roundId');
    if (round === seen) return false;
    seen = round;
    host.run('mpHostSettleRound()');
    return false;
  }, 'an online draft where nobody bids to finish', 60_000);

  const squads = c => c.json('state.participants.map(p=>({id:p.id,budget:p.budget,squad:p.squad.map(x=>[x.id,x.posIdx,x.price])})).sort((a,b)=>a.id.localeCompare(b.id))');
  assert.deepEqual(squads(host), squads(guest));
  assert(host.run('state.participants.every(p => p.squad.length === 11 && p.budget >= 0)'));
  const ids = host.json('state.participants.flatMap(p => p.squad.map(x => x.id))');
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
});

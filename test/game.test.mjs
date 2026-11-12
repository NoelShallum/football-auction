import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, draftLocally, until } from './helpers.mjs';

test('boots all player pools, preserves the screen structure, and switches all five languages', async t => {
  const app = await loadApp(); t.after(() => app.close());
  assert.equal(app.run('playerDatabase.length'), 1501);
  assert.deepEqual(app.json('poolCatalog.filter(p=>p.available).map(p=>poolPlayerCount(p.id))'), [1501, 13122, 840, 591]);
  assert.equal(app.window.document.getElementById('homeScreen').style.display, 'block');
  for (const code of ['fr', 'ar', 'es', 'pt', 'en']) {
    await app.run(`setLanguage('${code}')`);
    assert.equal(app.window.document.documentElement.lang, code);
    assert.equal(app.window.document.documentElement.dir, code === 'ar' ? 'rtl' : 'ltr');
    assert(!app.run("t('home.welcome')").startsWith('home.'));
  }
  assert(app.requests.every(url => url.startsWith('http://127.0.0.1:9/')));
  assert.deepEqual(app.errors, []);
});

test('first-run onboarding opens and can be completed, with persistent preferences', async t => {
  const app = await loadApp({ firstRun: true }); t.after(() => app.close());
  await until(() => app.window.document.getElementById('tutorialOverlay').classList.contains('show'), 'first-run tutorial');
  assert.equal(app.run('tutPhase'), 'language');
  app.run("closeTutorial('done')");
  assert.equal(app.window.localStorage.getItem('auctionXI_tutorialSeen'), '1');
  app.run("applyGameMode('sixv6','2-2-1'); participantCount=4; ROUND_SECONDS=60; SHOW_RATINGS=true; saveSettings()");
  app.run("applyGameMode('classic'); ROUND_SECONDS=10; SHOW_RATINGS=false; loadSettings()");
  assert.deepEqual(app.json('[GAME_MODE_ID, selectedFormation, participantCount, ROUND_SECONDS, SHOW_RATINGS]'), ['sixv6', '2-2-1', 4, 60, true]);
  assert.deepEqual(app.errors, []);
});

test('every published pool supplies all slots in each offered formation at supported participant counts', async t => {
  const app = await loadApp(); t.after(() => app.close());
  for (const pool of ['all_time','ea_database','current_players','world_cup_2026']) {
    await app.run(`setActivePool('${pool}')`);
    for (const mode of ['classic','sixv6']) {
      const forms = app.json(`Object.keys(gameModeById('${mode}').formations)`);
      for (const formation of forms) {
        app.run(`applyGameMode('${mode}','${formation}')`);
        for (const count of [2,4,6,10]) assert.equal(app.run(`poolCoverage(${count}).ok`), true, `${pool}/${mode}/${formation}/${count}`);
      }
    }
  }
  assert.deepEqual(app.errors, []);
});

test('classic and futsal enforce squad fit, reserve budgets, phase clocks, and reroll caps', async t => {
  const app = await loadApp(); t.after(() => app.close());
  assert.equal(app.run('getMaxAffordable({budget:1000,squad:[]})'), 800);
  assert.equal(app.run('roundSecondsForPhase(30,1)'), 30);
  assert.equal(app.run('roundSecondsForPhase(30,6)'), 15);
  assert.equal(app.run('roundSecondsForPhase(0,8)'), 0);
  assert.equal(app.run("rerollPoolSize('3')"), 5);
  assert.equal(app.run('rerollsLeftThisRound(9999,5)'), 0);
  assert.deepEqual(app.json('SLOT_CODES.slice(2,4)'), ['LCB','RCB']);
  // A squad is legal while it can still be arranged into an allowed formation - there are no owned slots.
  const squadOf = codes => `[${codes.map(c => `{positions:['${c}']}`).join(',')}]`;
  const canTake = (codes, code) => app.run(`participantCanTake({squad:${squadOf(codes)}}, {positions:['${code}']})`);
  assert.equal(canTake(['GK'], 'GK'), false, 'one keeper per XI');
  assert.equal(canTake(['GK'], 'CB'), true);
  assert.equal(canTake(['CB', 'CB'], 'CB'), true, 'a back three is a legal shape');
  assert.equal(canTake(['CB', 'CB', 'CB'], 'CB'), false, 'no formation has four centre backs');
  app.run("setFormationChoice('4-3-3')");
  assert.equal(canTake(['CB', 'CB'], 'CB'), false, 'locked to 4-3-3: two centre backs is the limit');
  assert.equal(canTake(['LB'], 'LB'), false, 'a second left back has no slot');
  app.run("setFormationChoice('any')");
  assert.equal(canTake(['LB'], 'RWB'), true, 'a left back and a right wing-back make a back five');
  assert.equal(canTake(['LB'], 'LWB'), false, 'two left-sided defenders need two left slots, and no formation has them');
  app.run("applyGameMode('sixv6','2-1-2')");
  assert.equal(app.run('getMaxAffordable({budget:100,squad:[]})'), 95);
  assert.equal(canTake(['DEF', 'DEF'], 'DEF'), false);
  assert.equal(canTake(['FWD'], 'FWD'), true);
  assert.equal(canTake(['FWD', 'FWD'], 'FWD'), false);
  assert.deepEqual(app.errors, []);
});

test('shared-screen Classic finishes a complete draft, exports data, simulates deterministically, and generates PNG cards', async t => {
  const app = await loadApp({ accelerate: true }); t.after(() => app.close());
  await draftLocally(app);
  assert.deepEqual(app.json('state.participants.map(p=>[p.squad.length,p.positionsFilled.size])'), [[11,11],[11,11]]);
  assert(app.run('state.participants.every(p=>p.budget>=0 && p.squad.reduce((s,x)=>s+x.price,0)+p.budget===BUDGET)'));
  assert.equal(app.run('new Set(state.participants.flatMap(p=>p.squad.map(x=>x.id))).size'), 22);
  assert.equal(app.run('state.blindRoundUsed'), true);
  app.run('exportAsJSON()');
  const exported = JSON.parse(await app.blobText(app.downloads[0].blob));
  assert.equal(exported.participants.length, 2);
  assert.equal(exported.participants[0].squad.length, 11);
  app.run('exportAsText()'); await until(() => app.window.__copiedText, 'text export');
  assert(app.window.__copiedText.includes('MANAGER ONE'));
  const first = app.run("JSON.stringify(simRunFormat('knockout',simBuildTeams(),makeRng(12345)))");
  assert.equal(first, app.run("JSON.stringify(simRunFormat('knockout',simBuildTeams(),makeRng(12345)))"));
  const finals = JSON.parse(first); assert.equal(finals.rounds.length, 1);
  const twoLeg = app.json("simRunFormat('twoleg',simBuildTeams(),makeRng(12345))");
  assert.equal(twoLeg.legs.length, 2);
  app.run("runSimulation('knockout',12345); simStopPlayback()");
  const summaryCard = await app.run('simBuildShareCard()');
  const squadCard = await app.run("simBuildSquadCard(state.participants[0],'1st of 2')");
  assert.equal(summaryCard.type, 'image/png'); assert(summaryCard.size > 10_000);
  assert.equal(squadCard.type, 'image/png'); assert(squadCard.size > 10_000);
  assert.deepEqual(app.errors, []);
});

test('all four pools can complete futsal drafts and multi-team tournaments', async t => {
  for (const pool of ['all_time','ea_database','current_players','world_cup_2026']) {
    const app = await loadApp({ accelerate: true });
    try {
      await draftLocally(app, { mode: 'sixv6', count: 3, pool });
      assert(app.run('state.participants.every(p=>p.squad.length===6 && p.positionsFilled.size===6 && p.budget>=0)'));
      delete app.window.navigator.clipboard;
      app.run('exportAsText()');
      await until(() => app.downloads.length > 0, 'clipboard-free text export');
      const text = await app.blobText(app.downloads[0].blob);
      for (const name of app.json('state.participants.flatMap(p=>p.squad.map(x=>x.name))')) assert(text.includes(name));
      const league = app.json("simRunFormat('league',simBuildTeams(),makeRng(8492))");
      assert.equal(league.matches.length, 6);
      const knockout = app.json("simRunFormat('knockout',simBuildTeams(),makeRng(8492))");
      assert(knockout.rounds.length >= 2);
      assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
  }
});

test('AI opponents complete a draft using distinct manager profiles', async t => {
  const app = await loadApp({ accelerate: true }); t.after(() => app.close());
  await draftLocally(app, { mode: 'sixv6', count: 3, ai: true, pool: 'current_players' });
  assert.equal(app.run('state.participants.filter(p=>p.isAI).length'), 2);
  assert.equal(app.run('new Set(state.participants.filter(p=>p.isAI).map(p=>p.profile.key)).size'), 2);
  assert(app.run('state.participants.every(p=>p.squad.length===6 && p.budget>=0)'));
  assert.deepEqual(app.errors, []);
});

test('late bids extend the timer and pause/resume preserves the remaining time', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("openSharedSetup(); participantCount=2; renderNamesGrid(); ROUND_SECONDS=30; REROLLS_MODE='disabled'");
  await app.run('startAuction()');
  app.run('state.roundEndsAt = Date.now()+500; state.isBlindRound=false; bidInputs.p0=getMinBid(); placeBid(\'p0\')');
  assert(app.run('state.roundEndsAt-Date.now()>9500'));
  app.window.document.getElementById('pauseBtn').click();
  assert.equal(app.run('state.paused'), true);
  const deadline = app.run('state.roundEndsAt');
  app.run('pauseStartedAt -= 4000');
  app.window.document.getElementById('resumeBtn').click();
  assert(app.run('state.roundEndsAt') >= deadline+4000);
  assert.equal(app.run('state.paused'), false);
  assert.deepEqual(app.errors, []);
});

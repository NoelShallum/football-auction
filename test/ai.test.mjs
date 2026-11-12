import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, draftLocally } from './helpers.mjs';

const profile = (extra = {}) => JSON.stringify({ aggression: 1, noise: 0, jumpChance: 0.1, starHunger: 1, valueSense: 0.9, rivalry: 0, patience: 0, flagPull: 0, flexPull: 0,
  lineBias: { GK: 1, DEF: 1, MID: 1, ATT: 1 }, ...extra });
const striker = (extra = '') => `{rating:78, pos:'ST', positions:['ST'], posIdx:10, startPrice:30, nationality:'France', ${extra}}`;
const ctx = '{replacement: 79, contestMul: 1, chancesLeft: 3, random: false}';

test('market value is the going rate for a rating, scaled to the mode economy', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic')");
  assert.equal(app.run('aiMarketValue({rating: 85})'), app.run('expectedPriceForRating(85)'));
  assert(app.run('aiMarketValue({rating: 94})') > app.run('aiMarketValue({rating: 80})'));
  app.run("applyGameMode('sixv6')");
  const futsal = app.run('aiMarketValue({rating: 85})');
  assert(futsal < 15 && futsal >= 1, `a 100M budget for six players prices an 85 around ${futsal}M`);
});

test('managers who trust the going rate bid on a player who is on offer below it', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic'); setFormationChoice('any')");
  // A player no better than the replacement they expect: the squad-need model alone is lukewarm on him.
  const ceiling = sense => app.run(`aiValuePlayer({squad: [], budget: 1000, profile: ${profile({ valueSense: sense })}}, ${striker()}, ${ctx})`);
  const indifferent = ceiling(0);
  const bargainHunter = ceiling(2.5);   // well clear of the 5M bid-step rounding
  const market = app.run(`aiMarketValue(${striker()})`);
  assert(bargainHunter > indifferent, `${bargainHunter} should beat ${indifferent}`);
  assert(bargainHunter >= market * 2.5 * 0.9, 'and reach the going rate they believe in');
  // ...but only for a player who actually helps: well below the replacement is not value.
  const weak = sense => app.run(`aiValuePlayer({squad: [], budget: 1000, profile: ${profile({ valueSense: sense })}}, {...${striker()}, rating: 70}, ${ctx})`);
  assert.equal(weak(2.5), weak(0), 'a player far below the replacement is not a bargain at any price');
});

test('taste: a patriot pays more for his nation and everyone pays a little for versatility', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("applyGameMode('classic')");
  const base = app.run(`aiTasteMul({profile: ${profile({ flagPull: 0.3 })}, favNation: 'Spain'}, ${striker()})`);
  const home = app.run(`aiTasteMul({profile: ${profile({ flagPull: 0.3 })}, favNation: 'France'}, ${striker()})`);
  assert.equal(base, 1);
  assert(Math.abs(home - 1.3) < 1e-9);
  const versatile = app.run(`aiTasteMul({profile: ${profile({ flexPull: 0.1 })}}, {...${striker()}, positions: ['ST', 'CF', 'RW']})`);
  assert(Math.abs(versatile - 1.2) < 1e-9, 'two extra positions at 10% each');
  assert(app.run(`aiTasteMul({profile: ${profile({ flexPull: 0.5 })}}, {...${striker()}, positions: ['ST', 'CF', 'RW', 'LW', 'CAM']})`) <= 1.3 + 1e-9, 'capped');
});

test('a patient manager waits while there is clock and others are deciding, and never when it would stall the round', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("openSharedSetup(); participantCount = 2; renderNamesGrid()");
  await app.run('startAuction()');
  app.run(`state.currentPlayer = ${striker()}; state.currentRoundSeconds = 30; state.roundEndsAt = Date.now() + 28000; state.isBlindRound = false;
    state.participants.forEach(p => { p.squad = []; p.positionsFilled = new Set(); });
    state.goingVotes = {}; state.currentLeader = null;
    globalThis.__sniper = {id: 'p1', profile: ${profile({ patience: 0.75 })}};`);
  assert.equal(app.run('aiWaiting(__sniper)'), true, '28 of 30 seconds left, the human has not decided');
  app.run('state.roundEndsAt = Date.now() + 5000');
  assert.equal(app.run('aiWaiting(__sniper)'), false, 'the clock is low: pounce');
  app.run('state.roundEndsAt = Date.now() + 28000; state.goingVotes = {p0: true}');
  assert.equal(app.run('aiWaiting(__sniper)'), false, 'everyone else has finished: waiting would only stall');
  app.run('state.goingVotes = {}; state.isBlindRound = true');
  assert.equal(app.run('aiWaiting(__sniper)'), false, 'no waiting in a sealed round');
  app.run('state.isBlindRound = false; state.currentRoundSeconds = 0');
  assert.equal(app.run('aiWaiting(__sniper)'), false, 'no waiting without a clock');
  assert.equal(app.run(`aiWaiting({id: 'p1', profile: ${profile()}})`), false, 'impatient managers never wait');
  app.run('aiStopThinking()');
});

test('the opponents are a random selection of archetypes that stays fixed until the AI setup is reopened', async t => {
  const app = await loadApp(); t.after(() => app.close());
  const first = app.json('aiRosterFor(5).map(p => p.key)');
  assert.equal(new Set(first).size, 5);
  assert.deepEqual(app.json('aiRosterFor(5).map(p => p.key)'), first, 'stable between calls');
  assert.deepEqual(app.json('aiRosterFor(3).map(p => p.key)'), first.slice(0, 3));
  const seen = new Set(first);
  for (let i = 0; i < 40; i++) { app.run('shuffleAIRoster()'); app.json('aiRosterFor(5).map(p => p.key)').forEach(k => seen.add(k)); }
  assert(seen.size >= 8, `all archetypes turn up over time (saw ${[...seen].join(', ')})`);
  assert(app.json('AI_PROFILES.length') >= 9);
});

test('drafts against five opponents complete with every archetype in play, in both modes', async t => {
  for (const [mode, pool] of [['classic', 'all_time'], ['sixv6', 'current_players']]) {
    const app = await loadApp({ accelerate: true });
    try {
      app.run("shuffleAIRoster(); aiRosterOrder = AI_PROFILES.map((_, i) => i).reverse()");   // include the newest archetypes
      await draftLocally(app, { mode, count: 6, ai: true, pool });
      const size = mode === 'classic' ? 11 : 6;
      assert(app.run(`state.participants.every(p => p.squad.length === ${size} && p.budget >= 0)`), mode);
      assert.equal(app.run('new Set(state.participants.filter(p => p.isAI).map(p => p.profile.key)).size'), 5);
      assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
  }
});

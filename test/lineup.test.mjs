import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, draftLocally } from './helpers.mjs';

// A squad entry from a list of positions, primary first.
const player = (positions, rating = 80, extra = '') => `{name:'P', rating:${rating}, positions:${JSON.stringify(positions)}${extra}}`;

test('slot fit ranks his own position above one he has played above one he covers', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("setFormationChoice('any')");
  assert.equal(app.run(`slotFit(${player(['RW', 'CF', 'ST'])}, 'RW')`), 4);
  assert.equal(app.run(`slotFit(${player(['RW', 'CF', 'ST'])}, 'ST')`), 3, 'a listed alternate');
  assert.equal(app.run(`slotFit(${player(['CM'])}, 'CDM')`), 2, 'a centre midfielder covers the holding role');
  assert.equal(app.run(`slotFit(${player(['CM'])}, 'GK')`), 0);
  assert.equal(app.run(`slotFit(${player(['GK'])}, 'ST')`), 0);
  assert.equal(app.run(`slotFit({position:'LB'}, 'LB')`), 4, 'a player with no list falls back to his position');
});

test('a squad must be arrangeable into an allowed formation, whichever one', async t => {
  const app = await loadApp(); t.after(() => app.close());
  const fits = (codes, keys) => app.run(`squadFits([${codes.map(c => player([c])).join(',')}], ${JSON.stringify(keys)})`);
  assert.equal(fits(['GK', 'GK'], ['4-3-3', '4-4-2']), false, 'two keepers never fit');
  assert.equal(fits(['CB', 'CB', 'CB'], ['4-3-3']), false);
  assert.equal(fits(['CB', 'CB', 'CB'], ['4-3-3', '3-4-3']), true, 'a back three is another formation');
  assert.equal(fits(['ST', 'ST'], ['4-3-3']), false);
  assert.equal(fits(['ST', 'ST'], ['4-3-3', '4-4-2']), true);
  // A multi-position player fills whichever slot the squad needs.
  assert.equal(app.run(`squadFits([${player(['ST', 'RW'])}, ${player(['ST'])}, ${player(['LW'])}], ['4-3-3'])`), true, 'the second striker plays right wing');
  // A full XI that already fits can take no one more.
  const xi = ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'RW', 'ST'];
  assert.equal(fits(xi, ['4-3-3']), true);
  assert.equal(fits(xi.concat('ST'), ['4-3-3', '4-4-2', '3-4-3', '5-3-2', '4-2-3-1']), false);
});

test('the best lineup puts players in their own positions and prefers the shape that suits them', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("setFormationChoice('any')");
  // Two strikers: 4-4-2 and 5-3-2 play two; 4-3-3 would need one of them out wide.
  const squad = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'];
  const best = app.json(`(() => { const b = bestFormation([${squad.map(c => player([c])).join(',')}], allowedFormationKeys()); return {formation: b.formation, complete: b.complete}; })()`);
  assert.equal(best.formation, '4-4-2');
  assert.equal(best.complete, true);

  // refreshLineup writes the formation and every entry's slot onto the participant.
  const lineup = app.json(`(() => { const p = {squad:[${squad.map(c => player([c])).join(',')}]}; refreshLineup(p); return {formation: p.formation, filled: p.positionsFilled.size, slots: p.squad.map(e => e.posIdx)}; })()`);
  assert.equal(lineup.formation, '4-4-2');
  assert.equal(lineup.filled, 11);
  assert.equal(new Set(lineup.slots).size, 11);
});

test('a player can be moved to any position he can play, swapping with whoever is there', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("setFormationChoice('any')");
  app.run(`globalThis.__p = {squad:[${['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM'].map(c => player([c])).join(',')}, ${player(['RW', 'CF', 'ST'], 90)}, ${player(['LW'])}, ${player(['ST', 'RW'])}]}; refreshLineup(__p); changeFormation(__p, '4-3-3');`);
  assert.equal(app.run('__p.formation'), '4-3-3');
  const slotOf = i => app.run(`__p.squad[${i}].posIdx`);
  const codeAt = idx => app.run(`FORMATIONS['4-3-3'][${idx}].code`);
  assert.equal(codeAt(slotOf(8)), 'RW', 'the winger starts on the right wing');
  assert.equal(codeAt(slotOf(10)), 'ST');
  // Both can play either role, so they can swap...
  const strikerSlot = slotOf(10);
  assert.equal(app.run(`moveToSlot(__p, __p.squad[8], ${strikerSlot})`), true);
  assert.equal(codeAt(slotOf(8)), 'ST');
  assert.equal(codeAt(slotOf(10)), 'RW', 'and the other takes his old right-wing place');
  // ...but a pure striker cannot be swapped out wide, so a move that would force it is refused.
  assert.equal(app.run(`moveToSlot(__p, __p.squad[0], ${slotOf(9)})`), false, 'the keeper cannot go to the wing');
  // ...but a left-winger cannot be moved into goal.
  assert.equal(app.run('moveToSlot(__p, __p.squad[9], 0)'), false);
  assert.equal(codeAt(slotOf(0)), 'GK');
  assert.equal(app.run('new Set(__p.squad.map(e => e.posIdx)).size'), 11);
});

test('a formation change is refused when the squad cannot play it, and honoured when it can', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("setFormationChoice('any')");
  app.run(`globalThis.__p = {squad:[${['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'].map(c => player([c])).join(',')}]}; refreshLineup(__p);`);
  assert.equal(app.run('__p.formation'), '4-4-2');
  assert.equal(app.run("changeFormation(__p, '3-4-3')"), false, 'four defenders cannot play a back three');
  assert.equal(app.run('__p.formation'), '4-4-2', 'a refused change leaves the lineup alone');
  assert.equal(app.run("changeFormation(__p, '4-4-2')"), true);
});

test('lineups survive the round trip a shared lineup makes, and reject a forged one', async t => {
  const app = await loadApp(); t.after(() => app.close());
  app.run("setFormationChoice('any')");
  app.run(`globalThis.__sq = [${['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'].map(c => player([c])).join(',')}]; globalThis.__p = {squad: JSON.parse(JSON.stringify(__sq))}; refreshLineup(__p); globalThis.__payload = lineupPayload(__p);`);
  app.run('globalThis.__q = {squad: JSON.parse(JSON.stringify(__sq))}');
  assert.equal(app.run('applyLineupPayload(__q, JSON.parse(JSON.stringify(__payload)))'), true);
  assert.deepEqual(app.json('__q.squad.map(e => e.posIdx)'), app.json('__p.squad.map(e => e.posIdx)'));
  // the keeper put up front
  assert.equal(app.run(`applyLineupPayload(__q, {formation:'4-4-2', slots:[10,1,2,3,4,5,6,7,8,9,0]})`), false);
  assert.equal(app.run(`applyLineupPayload(__q, {formation:'4-4-2', slots:[0,0,2,3,4,5,6,7,8,9,10]})`), false, 'a player cannot stand in two places');
  assert.equal(app.run(`applyLineupPayload(__q, {formation:'9-9-9', slots:[]})`), false);
});

test('real drafts end with every manager in a legal lineup, and managers may differ', async t => {
  const app = await loadApp({ accelerate: true }); t.after(() => app.close());
  await draftLocally(app, { count: 4 });
  const result = app.json(`state.participants.map(p => ({
    formation: p.formation,
    count: p.squad.length,
    distinct: new Set(p.squad.map(e => e.posIdx)).size,
    legal: p.squad.every(e => e.posIdx >= 0 && slotFit(e, FORMATIONS[p.formation][e.posIdx].code) > 0),
    gk: p.squad.filter(e => FORMATIONS[p.formation][e.posIdx].code === 'GK').length,
    filled: p.positionsFilled.size
  }))`);
  for (const m of result) {
    assert.equal(m.count, 11);
    assert.equal(m.distinct, 11, 'everybody has a slot of his own');
    assert.equal(m.legal, true, 'everybody stands where he can play');
    assert.equal(m.gk, 1);
    assert.equal(m.filled, 11);
  }
  assert.deepEqual(app.errors, []);
});

test('a draft locked to one formation keeps every manager in it', async t => {
  const app = await loadApp({ accelerate: true }); t.after(() => app.close());
  app.run("setFormationChoice('4-3-3')");
  await draftLocally(app, { count: 3 });
  assert.deepEqual(app.json('state.participants.map(p => p.formation)'), ['4-3-3', '4-3-3', '4-3-3']);
  assert.deepEqual(app.errors, []);
});

test('player positions: curated alternates are applied, every player has a list, and the primary leads it', async t => {
  const app = await loadApp(); t.after(() => app.close());
  await app.run("setActivePool('all_time')");
  const messi = app.json("playerDatabase.find(p => p.name === 'Lionel Messi')");
  assert(messi.positions.length >= 3, 'Messi can play several positions');
  assert.equal(messi.positions[0], messi.position, 'the primary position leads the list');
  assert(messi.positions.includes('RW') || messi.positions.includes('RM') || messi.positions.includes('CF'));
  for (const pool of ['all_time', 'ea_database', 'current_players', 'world_cup_2026']) {
    await app.run(`setActivePool('${pool}')`);
    assert.equal(app.run('playerDatabase.every(p => Array.isArray(p.positions) && p.positions.length >= 1 && p.positions[0] === p.position)'), true, pool);
  }
});

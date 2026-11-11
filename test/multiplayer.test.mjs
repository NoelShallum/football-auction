import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { loadApp, until } from './helpers.mjs';

async function party(t, { mode = 'classic', count = 2 } = {}) {
  const server = await createApplication(); const address = await server.listen();
  const url = `http://127.0.0.1:${address.port}/`;
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await server.close(); });
  const host = await loadApp({ url, accelerate: true }); clients.push(host);
  host.run(`applyGameMode('${mode}'); ROUND_SECONDS=0; RESET_SECONDS=0; REROLLS_MODE='disabled'; document.getElementById('hostNameInput').value='Host Manager'`);
  await host.run('createMultiplayerRoom()');
  const code = host.run('currentRoomCode'); assert.equal(code.length, 6);
  for (let i = 1; i < count; i++) {
    const guest = await loadApp({ url, accelerate: true }); clients.push(guest);
    guest.run(`document.getElementById('joinRoomCode').value='${code}'; document.getElementById('joinNameInput').value='Guest ${i}'`);
    await guest.run('joinMultiplayerRoom()');
  }
  await until(() => clients.every(client => client.run(`state.participants.length===${count}`)), 'everyone joined');
  for (const guest of clients.slice(1)) guest.run('toggleReady()');
  await until(() => host.run(`Object.values(mpParticipantsSnapshot).filter(p=>p.ready).length===${count}`), 'ready states');
  return { server, url, code, clients, host };
}

async function playDraft(host, clients) {
  await host.run('hostStartAuction()');
  let seen = null; let rounds = 0;
  await until(async () => {
    if (clients.every(client => client.run("mpGameState && mpGameState.roundPhase==='complete'"))) return true;
    if (!host.run("mpGameState && mpGameState.roundPhase==='bidding'")) return false;
    const round = host.run('mpGameState.roundId'); if (round === seen) return false;
    await until(() => clients.every(client => client.run(`mpGameState && mpGameState.roundId===${round} && mpGameState.roundPhase==='bidding'`)), 'round synchronization');
    seen = round; rounds++;
    const eligible = clients.filter(client => client.run('mpIsEligibleThisRound()'));
    const chosen = eligible.reduce((a,b) => a.run('state.participants.find(p=>p.id===currentUserId).squad.length') <= b.run('state.participants.find(p=>p.id===currentUserId).squad.length') ? a : b);
    const uid = chosen.run('currentUserId');
    if (host.run('mpGameState.isBlindRound')) {
      chosen.run('mpSubmitSealedBid(mpGameState.currentPlayer.startPrice)');
      await until(() => host.run(`!!mpGameState.sealedBids[${JSON.stringify(uid)}]`), 'sealed offer');
    } else {
      chosen.run('mpPlaceBid(mpGameState.currentPlayer.startPrice)');
      // In an untimed round the only remaining eligible bidder can win
      // immediately, before the polling task sees the transient leader.
      await until(() => host.run(`mpGameState.currentLeader===${JSON.stringify(uid)} || mpGameState.roundId!==${round} || mpGameState.roundPhase!=='bidding'`), 'live offer or immediate sale');
    }
    if (host.run(`mpGameState.roundId===${round} && mpGameState.roundPhase==='bidding'`)) host.run('mpHostSettleRound()');
    return false;
  }, 'complete online draft', 30_000);
  assert(rounds >= 6);
}

test('two real client DOMs complete Classic online, share chat, render identical squads, and replay a seeded match', async t => {
  const { host, clients } = await party(t);
  const guest = clients[1];
  guest.run("document.getElementById('chatInput').value='<b>hello</b>'; mpSendChatMessage()");
  await until(() => host.window.document.getElementById('chatMessages').textContent.includes('<b>hello</b>'), 'room chat');
  assert.equal(host.window.document.querySelector('#chatMessages b'), null);
  await playDraft(host, clients);
  const squads = client => client.json('state.participants.map(p=>({id:p.id,budget:p.budget,squad:p.squad.map(x=>[x.id,x.posIdx,x.price])})).sort((a,b)=>a.id.localeCompare(b.id))');
  assert.deepEqual(squads(host), squads(guest));
  assert(host.run('state.participants.every(p=>p.squad.length===11 && p.budget>=0)'));
  assert(clients.every(c => c.window.document.getElementById('resultsScreen').style.display === 'block'));
  host.run("database.ref(`rooms/${currentRoomCode}/simulation`).set({mode:'knockout',seed:88991,at:serverNow()})");
  await until(() => clients.every(c => c.run("simLastRenderedKey==='knockout:88991'")), 'shared simulation seed');
  assert.equal(host.run('JSON.stringify(simShareContext.result)'), guest.run('JSON.stringify(simShareContext.result)'));
  for (const client of clients) client.run('simStopPlayback()');
  assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
});

test('futsal online fills interchangeable slots, then a new draft resets every squad and budget', async t => {
  const { host, clients } = await party(t, { mode: 'sixv6' });
  await playDraft(host, clients);
  assert(clients.every(client => client.run('state.participants.every(p=>p.squad.length===6 && p.positionsFilled.size===6 && p.budget>=0)')));
  host.run('mpHostResetToLobby()');
  await until(() => clients.every(c => c.run("mpLastKnownStatus==='waiting' && !state.auctioning")), 'return to room lobby');
  await host.run('hostStartAuction()');
  await until(() => clients.every(c => c.run("mpGameState && mpGameState.roundPhase==='bidding'")), 'restarted auction');
  assert(clients.every(c => c.run('state.participants.every(p=>p.budget===100 && p.squad.length===0)')));
  for (const client of clients) assert.deepEqual(client.errors, []);
});

test('a disconnected guest can restore its original seat while other clients remain connected', async t => {
  const { host, clients, url, code } = await party(t, { mode: 'sixv6', count: 3 });
  const guest = clients[1]; const uid = guest.run('currentUserId');
  const storage = Object.fromEntries(Object.entries(guest.window.localStorage));
  const session = Object.fromEntries(Object.entries(guest.window.sessionStorage));
  await guest.close(); clients.splice(1, 1);
  await until(() => host.run(`mpParticipantsSnapshot[${JSON.stringify(uid)}].connected===false`), 'guest presence loss');
  const restored = await loadApp({ url, accelerate: true, storage, session }); clients.push(restored);
  await until(() => restored.run(`currentRoomCode==='${code}' && currentUserId===${JSON.stringify(uid)}`), 'seat restoration');
  await until(() => host.run(`mpParticipantsSnapshot[${JSON.stringify(uid)}].connected===true`), 'restored presence');
  assert.equal(restored.run('state.participants.find(p=>p.id===currentUserId).budget'), 100);
  assert.equal(restored.run('isHost'), false);
  assert.deepEqual(restored.errors, []);
});

test('new tabs share preferences while retaining independent room identities', async t => {
  const { host, clients, url, code } = await party(t, { mode: 'sixv6' });
  assert.equal(host.window.localStorage.getItem('auctionXI_roomCode'), null);
  const storage = Object.fromEntries(Object.entries(host.window.localStorage));
  const fresh = await loadApp({ url, accelerate: true, storage }); clients.push(fresh);
  await until(() => fresh.run('database.pending.size===0'), 'fresh tab boot');
  assert.equal(fresh.run('currentRoomCode'), null);
  fresh.run(`document.getElementById('joinRoomCode').value='${code}'; document.getElementById('joinNameInput').value='Another Tab'`);
  await fresh.run('joinMultiplayerRoom()');
  await until(() => host.run('state.participants.length===3'), 'independent seat in another tab');
  assert.notEqual(fresh.run('currentUserId'), host.run('currentUserId'));
  assert.equal(fresh.run('ROUND_SECONDS'), 0);
  assert.equal(fresh.run('RESET_SECONDS'), 0);
  assert.deepEqual(fresh.errors, []);
});

test('a rejected session restore clears stale online state before local play', async t => {
  const { host, clients, url, code } = await party(t);
  const keys = { auctionXI_roomCode: code, auctionXI_userId: host.run('currentUserId'), auctionXI_isHost: 'true' };
  const fresh = await loadApp({ url, accelerate: true, storage: keys, session: keys }); clients.push(fresh);
  await until(() => fresh.run('database.pending.size===0'), 'rejected seat claim');
  assert.equal(fresh.run('currentRoomCode'), null);
  assert.equal(fresh.run('isHost'), false);
  assert.equal(fresh.window.sessionStorage.getItem('auctionXI_roomCode'), null);
  fresh.run('openSharedSetup()');
  assert.equal(fresh.run('currentUserId'), null);
  assert.equal(fresh.window.document.getElementById('setupScreen').style.display, 'block');
  assert.deepEqual(fresh.errors, []);
});

test('a rejected room creation leaves the lobby usable without stale host state', async t => {
  const { clients, url, server } = await party(t);
  const fresh = await loadApp({ url, accelerate: true }); clients.push(fresh);
  fresh.run(`showScreen('lobbyScreen'); document.getElementById('hostNameInput').value='${'X'.repeat(81)}'`);
  await fresh.run('createMultiplayerRoom()');
  assert.equal(fresh.run('currentRoomCode'), null);
  assert.equal(fresh.run('currentUserId'), null);
  assert.equal(fresh.run('isHost'), false);
  assert.equal(fresh.window.document.getElementById('lobbyScreen').style.display, 'block');
  assert(fresh.window.document.getElementById('lobbyError').textContent.includes('1–80'));
  assert.equal(server.store.rooms.size, 1);
  assert.deepEqual(fresh.errors, []);
});

test('a room starting between lookup and join rejects the seat cleanly', async t => {
  const { host, clients, server, url, code } = await party(t, { mode: 'sixv6' });
  const fresh = await loadApp({ url, accelerate: true }); clients.push(fresh);
  fresh.window.startRoomRace = () => server.store.set(host.run('database.token'), `rooms/${code}/status`, 'playing');
  fresh.run(`{
    showScreen('lobbyScreen');
    document.getElementById('joinRoomCode').value='${code}';
    document.getElementById('joinNameInput').value='Late Joiner';
    const request = database.request.bind(database);
    let fired = false;
    database.request = async (op,data) => {
      const result = await request(op,data);
      if(!fired && op==='get' && data.path==='rooms/${code}'){
        fired=true; window.startRoomRace();
      }
      return result;
    };
  }`);
  await fresh.run('joinMultiplayerRoom()');
  assert.equal(fresh.run('currentRoomCode'), null);
  assert.equal(fresh.run('currentUserId'), null);
  assert.equal(fresh.run('isHost'), false);
  assert.equal(fresh.window.document.getElementById('lobbyScreen').style.display, 'block');
  assert(fresh.window.document.getElementById('lobbyError').textContent.includes('already started'));
  assert.equal(Object.keys(server.store.read(`rooms/${code}/participants`).value).length, 2);
  assert.deepEqual(fresh.errors, []);
});

test('a bid delayed across a round transition cannot purchase the next player', async t => {
  const { server, host, clients, code } = await party(t, { mode: 'sixv6' });
  const guest = clients[1];
  await host.run('hostStartAuction()');
  await until(() => clients.every(c => c.run("mpGameState && mpGameState.roundPhase==='bidding'")), 'initial round');
  const path = `rooms/${code}/gameState`;
  const initial = server.store.read(path).value;
  initial.isBlindRound = false;
  server.store.set(host.run('database.token'), path, initial);
  await until(() => clients.every(c => c.run('!mpGameState.isBlindRound')), 'normal bidding round');
  guest.run(`{
    const request = database.request.bind(database);
    let delayed = false;
    database.request = (op, data) => {
      if(!delayed && op==='get' && data.path==='${path}'){
        delayed = true;
        return new Promise(resolve => { window.releaseBid = () => request(op,data).then(resolve); });
      }
      return request(op,data);
    };
    mpPlaceBid(mpGameState.currentPlayer.startPrice);
  }`);
  await until(() => typeof guest.window.releaseBid === 'function', 'delayed bid snapshot');
  server.store.set(host.run('database.token'), path, { ...initial, roundId: initial.roundId + 1, currentPlayer: { ...initial.currentPlayer, id: 999999, name: 'Next Player' } });
  await until(() => clients.every(c => c.run(`mpGameState.roundId===${initial.roundId+1}`)), 'next round');
  await guest.window.releaseBid();
  await until(() => guest.run('database.pending.size===0'), 'delayed bid response');
  assert.equal(server.store.read(path).value.currentBid, 0);
  assert.equal(server.store.read(path).value.currentLeader, null);
  assert.deepEqual(guest.errors, []);
});

test('six managers complete a synchronized draft at the supported room capacity', async t => {
  const { host, clients } = await party(t, { mode: 'sixv6', count: 6 });
  assert(clients.every(c => c.run('ROUND_SECONDS===0 && RESET_SECONDS===0')));
  await playDraft(host, clients);
  const expected = host.run('JSON.stringify(simBuildTeams())');
  for (const client of clients) {
    assert(client.run('state.participants.every(p=>p.squad.length===6 && p.positionsFilled.size===6 && p.budget>=0)'));
    assert.equal(client.run('JSON.stringify(simBuildTeams())'), expected);
    assert.deepEqual(client.errors, []);
  }
});

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
  host.run(`applyGameMode('${mode}'); ROUND_SECONDS=0; REROLLS_MODE='disabled'; document.getElementById('hostNameInput').value='Host Manager'`);
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

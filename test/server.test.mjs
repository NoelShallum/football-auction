import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../server/index.mjs';
import { RoomStore } from '../server/room-store.mjs';
import { until } from './helpers.mjs';

const nameOf = uid => uid === 'host' ? 'Host' : uid === 'guest' ? 'Guest' : uid;
const seat = uid => ({ name: nameOf(uid), color: '#FFB020', budget: 100, squad: [], positionsFilled: [], connected: true, ready: uid === 'host', joinedAt: Date.now() });
const room = () => ({
  hostId: 'host', status: 'waiting', createdAt: Date.now(),
  settings: { gameMode: 'sixv6', formation: '2-1-2', budget: 100, roundSeconds: 30, showRatings: true, rerollsMode: '3', maxParticipants: 2, poolId: 'all_time' },
  participants: { host: seat('host') },
});
const bidding = () => ({
  draftId: 'draft-1',
  roundId: 1, currentRound: 0, roundPhase: 'bidding', currentPlayer: { id: 1, name: 'Test Player', posIdx: 1, startPrice: 1 },
  currentBid: 0, currentLeader: null, currentRoundSeconds: 30, roundEndsAt: Date.now() + 30_000,
  paused: false, isBlindRound: false, rerollVotes: {}, goingVotes: {}, goingGraceApplied: false, rerollsRemaining: 5, roundRerolls: 0,
});
async function start(t) {
  const app = await createApplication(); const address = await app.listen();
  t.after(() => app.close());
  return { app, url: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/_realtime` };
}
async function connect(t, url, token = randomUUID()) {
  const ws = new WebSocket(url); const pending = new Map(); const events = []; let sequence = 0;
  t.after(() => ws.terminate());
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.event) { events.push(message); return; }
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timeout);
    if (message.ok) waiter.resolve(message); else waiter.reject(Object.assign(new Error(message.error), { code: message.code }));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const request = (op, data = {}) => new Promise((resolve, reject) => {
    const id = 'test_' + (++sequence);
    const timeout = setTimeout(() => reject(new Error('Test wire request timed out')), 3000);
    pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, op, ...data }));
  });
  await request('hello', { token });
  return { ws, request, token, events };
}
async function populate(t, wsUrl) {
  const host = await connect(t, wsUrl); const guest = await connect(t, wsUrl);
  await host.request('set', { path: 'rooms/ABC234', value: room() });
  await guest.request('set', { path: 'rooms/ABC234/participants/guest', value: seat('guest') });
  return { host, guest };
}

test('serves the self-contained application and rejects private-file and cross-origin access', async t => {
  const { url, wsUrl } = await start(t);
  const home = await fetch(url); assert.equal(home.status, 200);
  const html = await home.text(); assert(!html.includes('gstatic.com/firebase'));
  for (const [, path] of html.matchAll(/<script src="([^"]+)"/g)) assert.equal((await fetch(url + '/' + path)).status, 200, path);
  assert.equal((await fetch(url + '/fonts/font-1.ttf')).status, 200);
  assert.equal((await fetch(url + '/.env')).status, 403);
  assert.equal((await fetch(url + '/..%2fpackage.json')).status, 403);
  assert.equal((await fetch(url + '/not-present')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await (await fetch(url + '/api/health')).json()).status, 'ok');
  const forbidden = new WebSocket(wsUrl, { origin: 'https://unrelated.example' });
  forbidden.on('error', () => {});
  await new Promise(resolve => forbidden.once('unexpected-response', (_request, response) => { assert.equal(response.statusCode, 403); forbidden.terminate(); resolve(); }));
});

test('room creation, joining, seat limits, ownership, and hidden ownership metadata', async t => {
  const { wsUrl } = await start(t); const { host, guest } = await populate(t, wsUrl);
  const outsider = await connect(t, wsUrl);
  await assert.rejects(outsider.request('set', { path: 'rooms/ABC234/participants/extra', value: seat('extra') }), { code: 'ROOM_FULL' });
  await assert.rejects(guest.request('set', { path: 'rooms/ABC234/participants/host/budget', value: 9999 }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(outsider.request('get', { path: 'rooms' }), { code: 'INVALID_PATH' });
  await assert.rejects(outsider.request('subscribe', { path: 'rooms/ABC234', subscription: 'spy' }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(outsider.request('set', { path: 'rooms/ABC234/status', value: 'playing' }), { code: 'PERMISSION_DENIED' });
  const data = (await guest.request('get', { path: 'rooms/ABC234' })).value;
  assert.equal(data.participants.guest.budget, 100); assert(!('owners' in data));
  await guest.request('set', { path: 'rooms/ABC234/participants/guest/ready', value: true });
  assert.equal((await host.request('get', { path: 'rooms/ABC234/participants/guest/ready' })).value, true);
});

test('simultaneous bids serialize with compare-and-set and server checks enforce reserve budgets and round integrity', async t => {
  const { wsUrl } = await start(t); const { host, guest } = await populate(t, wsUrl);
  const gs = bidding();
  await host.request('update', { value: { 'rooms/ABC234/status': 'playing', 'rooms/ABC234/gameState': gs } });
  const snapshot = await host.request('get', { path: 'rooms/ABC234/gameState' });
  const offer = uid => ({ ...snapshot.value, currentLeader: uid, currentBid: 1 });
  const replies = await Promise.all([
    host.request('cas', { path: 'rooms/ABC234/gameState', revision: snapshot.revision, value: offer('host') }),
    guest.request('cas', { path: 'rooms/ABC234/gameState', revision: snapshot.revision, value: offer('guest') }),
  ]);
  assert.equal(replies.filter(r => r.committed).length, 1); assert.equal(replies.filter(r => r.conflict).length, 1);
  const winner = (await host.request('get', { path: 'rooms/ABC234/gameState' })).value.currentLeader;
  const bidder = winner === 'host' ? guest : host; const uid = winner === 'host' ? 'guest' : 'host';
  const current = await bidder.request('get', { path: 'rooms/ABC234/gameState' });
  await assert.rejects(bidder.request('cas', { path: 'rooms/ABC234/gameState', revision: current.revision, value: { ...current.value, currentLeader: uid, currentBid: 99 } }), { code: 'INVALID_BID' });
  await assert.rejects(bidder.request('cas', { path: 'rooms/ABC234/gameState', revision: current.revision, value: { ...current.value, currentLeader: uid, currentBid: 2, currentPlayer: { ...current.value.currentPlayer, rating: 999 } } }), { code: 'PERMISSION_DENIED' });
  await host.request('set', { path: 'rooms/ABC234/gameState', value: { ...bidding(), roundEndsAt: Date.now() + 100 } });
  const late = await bidder.request('get', { path: 'rooms/ABC234/gameState' });
  await bidder.request('cas', { path: 'rooms/ABC234/gameState', revision: late.revision, value: { ...late.value, currentLeader: uid, currentBid: 1, roundEndsAt: Date.now() + 10_000 } });
  assert((await host.request('get', { path: 'rooms/ABC234/gameState' })).value.roundEndsAt - Date.now() > 9000);
  await host.request('set', { path: 'rooms/ABC234/gameState/paused', value: true });
  const paused = await bidder.request('get', { path: 'rooms/ABC234/gameState' });
  await assert.rejects(bidder.request('cas', { path: 'rooms/ABC234/gameState', revision: paused.revision, value: { ...paused.value, currentLeader: uid, currentBid: 5 } }), { code: 'INVALID_BID' });
});

test('atomic multipath updates produce a complete snapshot, and chat and votes stay seat-scoped', async t => {
  const { app, wsUrl } = await start(t); const { host, guest } = await populate(t, wsUrl);
  await guest.request('subscribe', { path: 'rooms/ABC234', subscription: 'room' });
  await host.request('update', { value: { 'rooms/ABC234/status': 'playing', 'rooms/ABC234/gameState': bidding() } });
  await until(() => guest.events.length === 2, 'atomic room snapshot');
  assert.equal(guest.events[1].value.status, 'playing'); assert.equal(guest.events[1].value.gameState.roundPhase, 'bidding');
  await guest.request('set', { path: 'rooms/ABC234/gameState/rerollVotes/guest', value: true, context: { draftId: 'draft-1', roundId: 1 } });
  await assert.rejects(guest.request('set', { path: 'rooms/ABC234/gameState/goingVotes/host', value: true }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(guest.request('set', { path: 'rooms/ABC234/chat/bad', value: { uid: 'host', name: 'Host', text: 'spoofed' } }), { code: 'PERMISSION_DENIED' });
  const message = { uid: 'guest', name: 'Guest', text: '<script>text</script>', ts: Date.now() };
  for (let i = 0; i < 205; i++) app.store.set(guest.token, 'rooms/ABC234/chat/m' + String(i).padStart(4, '0'), message);
  assert.equal(Object.keys(app.store.read('rooms/ABC234/chat').value).length, 200);
  assert.equal(Object.keys(app.store.read('rooms/ABC234/chat', 3).value).length, 3);
});

test('disconnect presence, reconnect ownership, and dropped-seat reclamation preserve a squad', async t => {
  const { wsUrl } = await start(t); const { host, guest } = await populate(t, wsUrl);
  const path = 'rooms/ABC234/participants/guest/connected';
  await guest.request('onDisconnect', { path, value: false });
  guest.ws.close(); await until(async () => (await host.request('get', { path })).value === false, 'disconnect presence');
  const replacement = await connect(t, wsUrl, guest.token);
  await replacement.request('claim', { code: 'ABC234', uid: 'guest', name: 'Guest' });
  await replacement.request('set', { path, value: true });
  assert.equal((await host.request('get', { path: 'rooms/ABC234/participants/guest/budget' })).value, 100);
  const stranger = await connect(t, wsUrl);
  await assert.rejects(stranger.request('claim', { code: 'ABC234', uid: 'guest', name: 'Guest' }), { code: 'PERMISSION_DENIED' });
  await replacement.request('onDisconnect', { path, value: false }); replacement.ws.close();
  await until(async () => (await host.request('get', { path })).value === false, 'second disconnect');
  await stranger.request('claim', { code: 'ABC234', uid: 'guest', name: 'Guest' });
  await stranger.request('set', { path, value: true });
  assert.equal((await stranger.request('get', { path })).value, true);
});

test('snapshots persist without bearer tokens, reset presence on restart, and expire inactive rooms', async t => {
  const folder = await mkdtemp(resolve(tmpdir(), 'auctionxi-test-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const dataFile = resolve(folder, 'rooms.json'); const token = randomUUID(); let now = Date.now();
  const store = new RoomStore({ dataFile, now: () => now, ttlMs: 1000 });
  store.set(token, 'rooms/ABC234', room()); await store.flush();
  assert(!(await readFile(dataFile, 'utf8')).includes(token));
  const restored = new RoomStore({ dataFile, now: () => now, ttlMs: 1000 }); await restored.load();
  assert.equal(restored.member(token, 'ABC234'), 'host');
  assert.equal(restored.read('rooms/ABC234/participants/host/connected').value, false);
  now += 1001; restored.expire(); assert.equal(restored.read('rooms/ABC234').value, null);
  assert.throws(() => store.set(token, 'rooms/ABC234/__proto__/polluted', true), { code: 'INVALID_PATH' });
});

test('votes and sealed offers stay bound to their original draft and round', () => {
  let now = 100_000;
  const store = new RoomStore({ now: () => now });
  const host = randomUUID(); const guest = randomUUID();
  store.set(host, 'rooms/ABC234', room());
  store.set(guest, 'rooms/ABC234/participants/guest', seat('guest'));
  store.update(host, '', { 'rooms/ABC234/status': 'playing', 'rooms/ABC234/gameState': { ...bidding(), roundEndsAt: now + 30_000 } });
  const path = 'rooms/ABC234/gameState/goingVotes/guest';
  assert.throws(() => store.set(guest, path, true), { code: 'STALE_ROUND' });
  assert.throws(() => store.set(guest, path, true, { draftId: 'draft-1', roundId: 0 }), { code: 'STALE_ROUND' });
  assert.throws(() => store.set(guest, path, true, { draftId: 'previous-draft', roundId: 1 }), { code: 'STALE_ROUND' });
  assert.equal(store.read(path).value, null);
  store.set(guest, path, true, { draftId: 'draft-1', roundId: 1 });
  assert.equal(store.read(path).value, true);
  store.set(host, 'rooms/ABC234/gameState', { ...bidding(), isBlindRound: true, roundId: 2, roundEndsAt: now + 30_000 });
  assert.throws(() => store.set(guest, 'rooms/ABC234/gameState/sealedBids/guest', { amount: 1 }, { draftId: 'draft-1', roundId: 1 }), { code: 'STALE_ROUND' });
  const context = { draftId: 'draft-1', roundId: 2 };
  store.set(host, 'rooms/ABC234/gameState/sealedBids/host', { amount: 1, time: -999 }, context);
  now += 10;
  store.set(guest, 'rooms/ABC234/gameState/sealedBids/guest', { amount: 1, time: -999999 }, context);
  const offers = store.read('rooms/ABC234/gameState/sealedBids').value;
  assert.equal(offers.host.time, 100_000); assert.equal(offers.guest.time, 100_010);
});

test('server deadlines close bids and votes before a delayed host settlement runs', () => {
  let now = 100_000;
  const store = new RoomStore({ now: () => now }); const host = randomUUID(); const guest = randomUUID();
  store.set(host, 'rooms/ABC234', room());
  store.set(guest, 'rooms/ABC234/participants/guest', seat('guest'));
  store.update(host, '', { 'rooms/ABC234/status': 'playing', 'rooms/ABC234/gameState': { ...bidding(), roundEndsAt: now + 1000 } });
  now += 1001;
  const current = store.read('rooms/ABC234/gameState');
  assert.throws(() => store.compareAndSet(guest, 'rooms/ABC234/gameState', current.revision, { ...current.value, currentLeader: 'guest', currentBid: 1, roundEndsAt: now + 10_000 }), { code: 'INVALID_BID' });
  assert.throws(() => store.set(guest, 'rooms/ABC234/gameState/goingVotes/guest', true, { draftId: 'draft-1', roundId: 1 }), { code: 'INVALID_BID' });
  store.set(host, 'rooms/ABC234/gameState', { ...current.value, isBlindRound: true });
  assert.throws(() => store.set(guest, 'rooms/ABC234/gameState/sealedBids/guest', { amount: 1 }, { draftId: 'draft-1', roundId: 1 }), { code: 'INVALID_BID' });
  assert.equal(store.read('rooms/ABC234/gameState/currentBid').value, 0);
  assert.equal(store.read('rooms/ABC234/gameState/goingVotes/guest').value, null);
});

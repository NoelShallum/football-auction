import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const suffix = randomUUID().slice(0, 8);
const name = 'auctionxi-verify-' + suffix;
const image = name + ':local'; const volume = name + '-data';
const endpoint = process.env.AUCTIONXI_DOCKER_HOST;
const dockerPrefix = endpoint ? ['--host', endpoint] : [];
const sockets = new Set();

function docker(args, { ignoreFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...dockerPrefix, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-30_000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-30_000); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || ignoreFailure) resolve(stdout.trim());
      else reject(new Error(`docker ${args[0]} failed (${code}):\n${stderr || stdout}`));
    });
  });
}
async function until(predicate, label, timeout = 15_000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function connect(url, token = randomUUID()) {
  const ws = new WebSocket(url); sockets.add(ws); const pending = new Map(); let sequence = 0;
  ws.on('error', () => {});
  ws.on('message', data => {
    const message = JSON.parse(String(data)); const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.ok) request.resolve(message); else request.reject(new Error(message.error));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const request = (op, data = {}) => new Promise((resolve, reject) => {
    const id = 'r' + (++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Container request timed out: ' + op)); }, 5000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, op, ...data }));
  });
  await request('hello', { token });
  return { token, request, close: () => ws.close() };
}
const participant = (name, ready) => ({ name, color: '#FFB020', budget: 100, squad: [], positionsFilled: [], connected: true, ready, joinedAt: Date.now() });

try {
  console.log('Building the production container…');
  const build = ['build', '--quiet', '--tag', image];
  if (process.env.CODEX_PROXY_CERT && existsSync(process.env.CODEX_PROXY_CERT)) build.push('--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
  build.push('.'); await docker(build);
  await docker(['volume', 'create', volume]);
  await docker(['run', '--detach', '--name', name, '--publish', '127.0.0.1::3000', '--mount', `type=volume,source=${volume},target=/app/data`, image]);
  let url; let websocket;
  const refreshEndpoint = async () => {
    // Docker can allocate a different random host port after a restart.
    const port = Number((await docker(['port', name, '3000/tcp'])).split(':').at(-1));
    url = `http://127.0.0.1:${port}`; websocket = `ws://127.0.0.1:${port}/_realtime`;
  };
  await refreshEndpoint();
  const ready = async () => { try { return (await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
  await until(ready, 'container startup');
  assert.equal(await docker(['exec', name, 'id', '-u']), '1000');
  assert((await (await fetch(url)).text()).includes('homeScreen'));
  assert.equal((await (await fetch(url + '/pools/world_cup_2026.json')).json()).players.length, 591);
  const host = await connect(websocket); const guest = await connect(websocket);
  await host.request('set', { path: 'rooms/SMK234', value: {
    hostId: 'host', status: 'waiting', createdAt: Date.now(),
    settings: { gameMode: 'sixv6', formation: '2-1-2', budget: 100, roundSeconds: 0, showRatings: true, rerollsMode: 'disabled', maxParticipants: 6, poolId: 'all_time' },
    participants: { host: participant('Container Host', true) },
  } });
  await guest.request('set', { path: 'rooms/SMK234/participants/guest', value: participant('Container Guest', false) });
  await guest.request('set', { path: 'rooms/SMK234/participants/guest/ready', value: true });
  assert.equal((await host.request('get', { path: 'rooms/SMK234/participants/guest/ready' })).value, true);
  console.log('Container serves the application and synchronizes two multiplayer clients.');
  host.close(); guest.close();
  await docker(['restart', '--time', '10', name]); await refreshEndpoint();
  await until(ready, 'container restart').catch(async error => {
    throw new Error(error.message + '\n' + (await docker(['logs', '--tail', '20', name], { ignoreFailure: true })));
  });
  const restored = await connect(websocket, host.token);
  const snapshot = (await restored.request('get', { path: 'rooms/SMK234' })).value;
  assert.equal(Object.keys(snapshot.participants).length, 2);
  assert.equal(snapshot.participants.host.connected, false);
  assert.equal(snapshot.participants.guest.ready, true);
  await restored.request('claim', { code: 'SMK234', uid: 'host', name: 'Container Host' });
  await restored.request('set', { path: 'rooms/SMK234/participants/host/connected', value: true });
  const storage = JSON.parse(await docker(['exec', name, 'node', '-e', "const fs=require('node:fs');const s=fs.statSync('/app/data/rooms.json');console.log(JSON.stringify({mode:s.mode&511,uid:s.uid,temporaryCA:fs.existsSync('/run/secrets/proxy_ca'),runtimeCA:Boolean(process.env.NODE_EXTRA_CA_CERTS)}))"]));
  assert.equal(storage.mode, 0o600); assert.equal(storage.uid, 1000);
  assert.equal(storage.temporaryCA, false); assert.equal(storage.runtimeCA, false);
  console.log('Container restart preserves rooms and restores seat ownership; runtime files belong to the non-root user.');
} finally {
  for (const ws of sockets) ws.terminate();
  await docker(['rm', '--force', name], { ignoreFailure: true });
  await docker(['volume', 'rm', volume], { ignoreFailure: true });
  await docker(['image', 'rm', image], { ignoreFailure: true });
}
console.log('Container verification passed; temporary container, volume, and image removed.');

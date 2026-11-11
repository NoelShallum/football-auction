import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomStore, RoomError } from './room-store.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/** Exported for integration tests; tests use an ephemeral loopback port. */
export async function createApplication({ assetDirectory = resolve(ROOT, 'public'), dataFile = null, ttlMs, allowedOrigins = [] } = {}) {
  const assets = resolve(assetDirectory);
  const store = new RoomStore({ dataFile, ttlMs }); await store.load();
  store.on('persistError', error => console.error('Room persistence failed:', error.message));
  const http = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', CSP);
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname); }
    catch { response.writeHead(400); response.end(); return; }
    if (pathname === '/api/health') {
      response.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok', application: 'auctionxi-clone', version: '1.0.0' })); return;
    }
    const path = resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(assets + sep) || pathname.includes('\0') || pathname.split('/').some(p => p.startsWith('.'))) { response.writeHead(403); response.end(); return; }
    try {
      const info = await stat(path);
      if (!info.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
      const content = request.method === 'HEAD' ? null : await readFile(path);
      response.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      response.end(content);
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end('Not found'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const clients = new Set();
  http.on('upgrade', (request, socket, head) => {
    let url; try { url = new URL(request.url, 'http://local'); } catch { socket.destroy(); return; }
    const origin = request.headers.origin;
    const sameHost = !origin || (() => { try { return new URL(origin).host === request.headers.host; } catch { return false; } })();
    if (url.pathname !== '/_realtime' || (!sameHost && !allowedOrigins.includes(origin))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  const send = (client, value) => { if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(value)); };
  const notify = (client, subscription, force = false) => {
    try {
      const result = store.read(subscription.path, subscription.limit);
      const serialized = JSON.stringify(result.value);
      if (force || subscription.last !== serialized) {
        subscription.last = serialized;
        send(client, { event: 'value', subscription: subscription.id, ...result });
      }
    } catch { /* The subscription will be removed with its connection. */ }
  };
  const broadcast = code => {
    for (const client of clients) for (const sub of client.subscriptions.values()) if (sub.code === code) notify(client, sub);
  };
  store.on('change', broadcast);
  wss.on('connection', ws => {
    const client = { ws, token: null, subscriptions: new Map(), disconnects: new Map(), alive: true, count: 0, window: Date.now() };
    clients.add(client);
    const greetingTimeout = setTimeout(() => { if (!client.token) ws.close(1008, 'Session required'); }, 5000); greetingTimeout.unref();
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
        if (Date.now() - client.window > 1000) { client.window = Date.now(); client.count = 0; }
        if (++client.count > 250) throw new RoomError('Too many requests.', 'RATE_LIMIT');
        const { id, op, path } = message;
        if (op === 'hello') {
          if (!/^[a-zA-Z0-9_-]{20,100}$/.test(message.token || '') || client.token) throw new RoomError('Invalid session.');
          client.token = message.token; clearTimeout(greetingTimeout);
          send(client, { id, ok: true, serverTime: Date.now() }); return;
        }
        if (!client.token) throw new RoomError('Session required.');
        let result = {};
        if (op === 'get') result = store.read(path, message.limit);
        else if (op === 'set') result = store.set(client.token, path, message.value);
        else if (op === 'update') result = store.update(client.token, path || '', message.value);
        else if (op === 'cas') result = store.compareAndSet(client.token, path, message.revision, message.value);
        else if (op === 'claim') store.claim(client.token, message.code, message.uid, message.name);
        else if (op === 'subscribe') {
          if (client.subscriptions.size >= 40) throw new RoomError('Too many listeners.');
          const code = store.subscribeAllowed(client.token, path);
          const sub = { id: message.subscription, path, code, limit: message.limit, last: null };
          client.subscriptions.set(sub.id, sub); notify(client, sub, true);
        } else if (op === 'unsubscribe') client.subscriptions.delete(message.subscription);
        else if (op === 'onDisconnect') {
          const uid = store.member(client.token, path?.split('/')[1]);
          if (!uid || path !== `rooms/${path.split('/')[1]}/participants/${uid}/connected` || message.value !== false) throw new RoomError('Invalid presence instruction.');
          client.disconnects.set(path, false);
        } else if (op === 'cancelDisconnect') client.disconnects.delete(path);
        else throw new RoomError('Unknown operation.', 'INVALID_OPERATION');
        send(client, { id, ok: true, ...result });
      } catch (error) { send(client, { id: message?.id, ok: false, error: error.message, code: error.code || 'INVALID_REQUEST' }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(greetingTimeout); clients.delete(client);
      const anotherConnection = [...clients].some(c => c.token === client.token && c.ws.readyState === WebSocket.OPEN);
      if (!anotherConnection) for (const [path, value] of client.disconnects) {
        try { store.disconnect(client.token, path, value); } catch { /* A removed seat has no presence left to update. */ }
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) { client.ws.terminate(); continue; }
      client.alive = false; client.ws.ping();
    }
    store.expire();
  }, 20_000); heartbeat.unref();
  return {
    http, store,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); });
      return http.address();
    },
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (http.listening) await new Promise(resolve => http.close(resolve));
      await store.flush();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApplication({
    assetDirectory: resolve(ROOT, process.env.ASSET_DIRECTORY || 'public'),
    dataFile: resolve(ROOT, process.env.ROOM_DATA_FILE || 'data/rooms.json'),
    ttlMs: Number(process.env.ROOM_TTL_HOURS || 24) * 3_600_000,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  });
  const address = await app.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0');
  console.log(`Auction XI local clone: http://localhost:${address.port}`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}

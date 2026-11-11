/* Local realtime transport. The game keeps its original reference/listener
   interface, while every connection stays on this application's own origin. */
(function () {
  'use strict';
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const random = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  class Snapshot {
    constructor(value) { this.value = copy(value); }
    val() { return copy(this.value); }
    exists() { return this.value !== null; }
  }
  class Reference {
    constructor(database, path = '', limit = null) {
      this.database = database; this.path = path.replace(/^\/+|\/+$/g, ''); this.limit = limit;
      this.key = this.path.split('/').at(-1) || null;
    }
    child(path) { return new Reference(this.database, [this.path, path].filter(Boolean).join('/')); }
    limitToLast(limit) { return new Reference(this.database, this.path, Math.min(200, Math.max(1, Number(limit)))); }
    async once(event, callback) {
      if (event !== 'value') throw new Error('Only value snapshots are supported.');
      const result = await this.database.request('get', { path: this.path, limit: this.limit });
      const snapshot = new Snapshot(result.value); if (callback) callback(snapshot); return snapshot;
    }
    on(event, callback) {
      if (event !== 'value') throw new Error('Only value subscriptions are supported.');
      this.database.subscribe(this.path, this.limit, callback); return callback;
    }
    off(event, callback) { this.database.unsubscribe(this.path, callback); }
    set(value, context = {}) { return this.database.write('set', { path: this.path, value, context }); }
    update(value, context = {}) { return this.database.write('update', { path: this.path, value, context }); }
    remove() { return this.set(null); }
    push(value) {
      const key = Date.now().toString(36).padStart(10, '0') + '_' + random().replace(/-/g, '').slice(0, 12);
      const ref = this.child(key); const promise = ref.set(value);
      promise.key = key; return promise;
    }
    onDisconnect() {
      return {
        set: value => this.database.write('onDisconnect', { path: this.path, value }),
        cancel: () => this.database.write('cancelDisconnect', { path: this.path }),
      };
    }
    async transaction(update, complete) {
      try {
        for (let attempt = 0; attempt < 30; attempt++) {
          const current = await this.database.request('get', { path: this.path });
          const next = update(copy(current.value));
          if (next === undefined) {
            const result = { committed: false, snapshot: new Snapshot(current.value) };
            if (complete) complete(null, false, result.snapshot); return result;
          }
          const response = await this.database.request('cas', { path: this.path, revision: current.revision, value: next });
          if (response.conflict) continue;
          const result = { committed: true, snapshot: new Snapshot(response.value) };
          if (complete) complete(null, true, result.snapshot); return result;
        }
        throw new Error('This bid could not be committed. Please try again.');
      } catch (error) { if (complete) { complete(error, false, null); return { committed: false }; } throw error; }
    }
  }
  class LocalRealtimeDatabase {
    constructor() {
      this.connected = false; this.offset = 0; this.sequence = 0; this.generation = 0;
      this.pending = new Map(); this.listeners = new Map(); this.socket = null;
      this.connecting = null; this.retryTimer = null; this.retryDelay = 250; this.stopped = false;
      this.token = random();
      try {
        this.token = sessionStorage.getItem('auctionXI_localTransport') || this.token;
        sessionStorage.setItem('auctionXI_localTransport', this.token);
      } catch (_) { /* Private browsing can still play for the lifetime of the tab. */ }
      window.addEventListener('pagehide', () => this.close());
      window.addEventListener('pageshow', event => { if (event.persisted) { this.stopped = false; this.ensureConnection().catch(() => {}); } });
    }
    ref(path = '') { return new Reference(this, path); }
    claim(code, uid, name) { return this.write('claim', { code, uid, name }); }
    ensureConnection() {
      if (this.connected) return Promise.resolve();
      if (this.connecting) return this.connecting;
      if (this.stopped) return Promise.reject(new Error('The realtime connection is closed.'));
      clearTimeout(this.retryTimer);
      this.connecting = new Promise((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let settled = false;
        const finish = error => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
        const ws = this.socket = new WebSocket(protocol + '//' + location.host + '/_realtime');
        const timeout = setTimeout(() => { finish(new Error('Cannot reach the multiplayer server.')); ws.close(); }, 8000);
        ws.addEventListener('open', async () => {
          try {
            const before = Date.now();
            const hello = await this.send('hello', { token: this.token });
            this.offset = hello.serverTime - Math.round((before + Date.now()) / 2);
            this.connected = true; this.connecting = null; this.generation++; this.retryDelay = 250;
            clearTimeout(timeout); finish();
            this.emitInfo('.info/serverTimeOffset', this.offset); this.emitInfo('.info/connected', true);
            for (const listener of this.listeners.values()) if (!listener.path.startsWith('.info/')) this.startSubscription(listener);
          } catch (error) { finish(error); ws.close(); }
        });
        ws.addEventListener('message', event => {
          let message; try { message = JSON.parse(event.data); } catch (_) { return; }
          if (message.event === 'value') {
            const listener = this.listeners.get(message.subscription);
            if (listener) this.deliver(listener, message.value);
            return;
          }
          const pending = this.pending.get(message.id); if (!pending) return;
          clearTimeout(pending.timeout); this.pending.delete(message.id);
          if (message.ok) pending.resolve(message);
          else { const error = new Error(message.error || 'Multiplayer request failed.'); error.code = message.code; pending.reject(error); }
        });
        ws.addEventListener('error', () => { /* close supplies a single connection error. */ });
        ws.addEventListener('close', () => {
          clearTimeout(timeout); this.connected = false; this.connecting = null;
          finish(new Error('Multiplayer connection was interrupted.'));
          for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('Multiplayer connection was interrupted.')); }
          this.pending.clear(); this.emitInfo('.info/connected', false);
          if (!this.stopped) {
            this.retryTimer = setTimeout(() => this.ensureConnection().catch(() => {}), this.retryDelay);
            this.retryDelay = Math.min(10_000, this.retryDelay * 2);
          }
        });
      });
      return this.connecting;
    }
    send(op, data) {
      return new Promise((resolve, reject) => {
        const id = 'r' + (++this.sequence);
        const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('The multiplayer server took too long to respond.')); }, 8000);
        this.pending.set(id, { resolve, reject, timeout });
        try { this.socket.send(JSON.stringify({ id, op, ...data })); }
        catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
      });
    }
    async request(op, data) { await this.ensureConnection(); return this.send(op, data); }
    write(op, data) {
      const promise = this.request(op, data);
      // Some original UI handlers intentionally fire-and-forget writes.
      // Register an error handler while preserving the rejectable promise.
      promise.catch(error => window.dispatchEvent(new CustomEvent('auctionxi:transport-error', { detail: error.message })));
      return promise;
    }
    subscribe(path, limit, callback) {
      const listener = { id: 's' + (++this.sequence), path, limit, callback, generation: -1 };
      this.listeners.set(listener.id, listener);
      if (path.startsWith('.info/')) {
        queueMicrotask(() => { if (this.listeners.has(listener.id)) this.deliver(listener, path === '.info/connected' ? this.connected : this.offset); });
        this.ensureConnection().catch(() => {});
      } else this.startSubscription(listener);
    }
    async startSubscription(listener) {
      try {
        await this.ensureConnection();
        if (!this.listeners.has(listener.id) || listener.generation === this.generation) return;
        listener.generation = this.generation;
        await this.send('subscribe', { path: listener.path, limit: listener.limit, subscription: listener.id });
      } catch (error) { window.dispatchEvent(new CustomEvent('auctionxi:transport-error', { detail: error.message })); }
    }
    unsubscribe(path, callback) {
      for (const [id, listener] of this.listeners) if (listener.path === path && (!callback || callback === listener.callback)) {
        this.listeners.delete(id);
        if (!path.startsWith('.info/') && this.connected) this.send('unsubscribe', { subscription: id }).catch(() => {});
      }
    }
    deliver(listener, value) {
      try { listener.callback(new Snapshot(value)); }
      catch (error) { console.error('Room listener failed:', error); }
    }
    emitInfo(path, value) { for (const listener of this.listeners.values()) if (listener.path === path) this.deliver(listener, value); }
    close() {
      this.stopped = true; clearTimeout(this.retryTimer);
      if (this.socket) this.socket.close();
    }
  }
  window.LocalRealtimeDatabase = LocalRealtimeDatabase;
}());

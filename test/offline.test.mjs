import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContext, Script } from 'node:vm';
import { ROOT } from './helpers.mjs';

test('service worker installs all local assets, restores offline play assets, and excludes live APIs', async () => {
  const code = await readFile(resolve(ROOT, 'public/sw.js'), 'utf8');
  const callbacks = new Map(); const saved = new Map(); const cachesByName = new Map();
  const keyOf = input => new URL(typeof input === 'string' ? input : input.url, 'http://offline.test/').href;
  const cache = {
    async addAll(paths) { for (const path of paths) saved.set(keyOf(path), new Response(await readFile(resolve(ROOT, 'public', path)))); },
    async match(request) { return saved.get(keyOf(request))?.clone(); },
    async put(request, response) { saved.set(keyOf(request), response); },
  };
  let online = false;
  const context = createContext({
    self: { location: { origin: 'http://offline.test' }, addEventListener(name, fn) { callbacks.set(name, fn); }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { async open(name) { cachesByName.set(name, cache); return cache; }, async keys() { return [...cachesByName.keys()]; }, async delete(name) { return cachesByName.delete(name); } },
    fetch: async () => { if (!online) throw new Error('Offline'); return new Response('fresh'); },
    URL, setTimeout, clearTimeout,
  });
  new Script(code).runInContext(context);
  let installed; callbacks.get('install')({ waitUntil(promise) { installed = promise; } }); await installed;
  const fonts = (await readdir(resolve(ROOT, 'public/fonts'))).filter(path => path.endsWith('.ttf'));
  for (const path of ['index.html','players.json','pools/current_players.json','pools/world_cup_2026.json','locales/ar.json','js/realtime.js',...fonts.map(path=>'fonts/'+path)]) assert(saved.has(keyOf(path)), path);
  let result;
  callbacks.get('fetch')({ request: { url: keyOf('players.json'), method: 'GET', mode: 'same-origin' }, respondWith(promise) { result = promise; } });
  assert.equal((await (await result).json()).players.length, 1501);
  callbacks.get('fetch')({ request: { url: keyOf('some-navigation'), method: 'GET', mode: 'navigate' }, respondWith(promise) { result = promise; } });
  assert((await (await result).text()).includes('homeScreen'));
  for (const url of ['http://offline.test/api/health','http://offline.test/_realtime','https://outside.example/asset']) {
    let handled = false;
    callbacks.get('fetch')({ request: { url, method: 'GET', mode: 'same-origin' }, respondWith() { handled = true; } });
    assert.equal(handled, false, url);
  }
  online = true;
  callbacks.get('fetch')({ request: { url: keyOf('styles.css'), method: 'GET', mode: 'same-origin' }, respondWith(promise) { result = promise; } });
  assert.equal(await (await result).text(), 'fresh');
});

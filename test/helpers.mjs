import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { WebSocket } from 'ws';
import { createCanvas } from '@napi-rs/canvas';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export async function until(predicate, label = 'condition', timeout = 10_000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** A DOM test environment, not a graphical/headless browser. All assets are
    loaded from the checkout; only realtime integration uses loopback sockets. */
export async function loadApp({ url = 'http://127.0.0.1:9/', accelerate = false, firstRun = false, storage = {}, session = {} } = {}) {
  const html = await readFile(resolve(ROOT, 'public/index.html'), 'utf8');
  const scriptPaths = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  const sources = await Promise.all(scriptPaths.map(async path => [path, await readFile(resolve(ROOT, 'public', path), 'utf8')]));
  const errors = []; const alerts = []; const downloads = []; const blobs = new Map(); const requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  virtualConsole.on('error', (...args) => errors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const window = dom.window;
  window.fetch = async input => {
    const requested = new URL(input, url); requests.push(requested.href);
    if (requested.origin !== new URL(url).origin) throw new Error('External request blocked by test');
    try {
      const content = await readFile(resolve(ROOT, 'public', '.' + requested.pathname));
      return { ok: true, status: 200, json: async () => JSON.parse(content.toString()), text: async () => content.toString() };
    } catch { return { ok: false, status: 404 }; }
  };
  window.WebSocket = WebSocket;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  window.alert = text => alerts.push(text);
  window.document.fonts = { ready: Promise.resolve() };
  const canvasMap = new WeakMap();
  const canvasOf = element => {
    let canvas = canvasMap.get(element);
    if (!canvas || canvas.width !== element.width || canvas.height !== element.height) {
      canvas = createCanvas(element.width || 300, element.height || 150); canvasMap.set(element, canvas);
    }
    return canvas;
  };
  window.HTMLCanvasElement.prototype.getContext = function (kind) { return canvasOf(this).getContext(kind); };
  window.HTMLCanvasElement.prototype.toBlob = function (callback) { callback(new window.Blob([canvasOf(this).toBuffer('image/png')], { type: 'image/png' })); };
  window.URL.createObjectURL = blob => { const url = 'blob:local-test/' + randomUUID(); blobs.set(url, blob); return url; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, href: this.href, blob: blobs.get(this.href) }); };
  window.navigator.clipboard = { writeText: async text => { window.__copiedText = text; } };
  if (!firstRun) window.localStorage.setItem('auctionXI_lang', 'en');
  if (!firstRun) for (const key of ['auctionXI_tutorialSeen', 'auctionXI_liveTutorialSeen', 'auctionXI_blindTutorialSeen']) window.localStorage.setItem(key, '1');
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(session)) window.sessionStorage.setItem(key, value);
  if (accelerate) {
    const original = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => original(callback, delay >= 200 && delay <= 3000 ? 1 : delay, ...args);
  }
  const context = dom.getInternalVMContext();
  const run = source => new Script(source).runInContext(context);
  for (const [path, source] of sources) new Script(source, { filename: path }).runInContext(context);
  window.dispatchEvent(new window.Event('load'));
  await run('Promise.all([playersReady, i18nReady, bootReady])');
  await until(() => run('poolFileCache.current_players && poolFileCache.world_cup_2026'), 'all pool prefetches');
  run('SOUND_EFFECTS = false');
  return {
    dom, window, run, errors, alerts, downloads, requests,
    json(source) { return JSON.parse(run(`JSON.stringify(${source})`)); },
    async blobText(blob) { return new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob); }); },
    async close() {
      run('aiStopThinking(); simStopPlayback(); clearInterval(state.timerInterval); clearTimeout(mpHostTimerHandle); clearTimeout(mpAdvanceTimerHandle); clearInterval(mpTickHandle); if(database) database.listeners.clear()');
      await until(() => run('!database || database.pending.size===0'), 'pending transport operations before teardown', 2000).catch(() => {});
      run('if(database) database.close()');
      window.close(); await new Promise(resolve => setTimeout(resolve, 10));
    },
  };
}

export async function draftLocally(app, { mode = 'classic', count = 2, pool = 'all_time', ai = false } = {}) {
  await app.run(`setActivePool(${JSON.stringify(pool)})`);
  app.run(`applyGameMode(${JSON.stringify(mode)}); participantCount = ${count}; ROUND_SECONDS = 0; REROLLS_MODE = 'disabled'; ${ai ? 'openAISetup()' : 'openSharedSetup()'}; renderNamesGrid()`);
  app.run(`document.querySelector('#namesGrid input').value = 'Manager One'`);
  await app.run('startAuction()');
  let handled = null;
  await until(async () => {
    if (app.run("document.getElementById('resultsScreen').style.display === 'block'")) return true;
    if (!app.run('state.auctioning && state.currentPlayer && !state.paused')) return false;
    const key = app.run('state.phaseNum + ":" + state.currentRound + ":" + state.currentPlayer.id');
    if (handled === key) return false;
    handled = key;
    app.run(`{
      const eligible = state.participants.filter(p => participantNeedsSlot(p, state.currentPlayer.posIdx));
      const human = ${ai ? 'eligible.find(p => !p.isAI)' : 'eligible.reduce((a,b)=>a.squad.length <= b.squad.length ? a : b)'};
      if(human){
        bidInputs[human.id] = getMinBid();
        if(state.isBlindRound) submitSealedBid(human.id); else placeBid(human.id);
      }
      ${ai ? "if(human) { state.goingVotes[human.id]=true; checkGoingVotesAndMaybeSettle(); }" : 'settleRound();'}
    }`);
    return false;
  }, `${mode} ${ai ? 'AI' : 'shared-screen'} draft completion`, 30_000);
}

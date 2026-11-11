import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, until } from './helpers.mjs';

const hidden = (app, id) => app.run(`document.getElementById('${id}').hidden`);

test('the online entry point is hidden when no room server answers, and comes back when one does', async t => {
  const app = await loadApp(); t.after(() => app.close());
  // The test environment has no /api/health, which is exactly "static hosting".
  assert.equal(app.run('ONLINE_PLAY_AVAILABLE'), false);
  assert.equal(hidden(app, 'playOnlineBtn'), true);
  assert.equal(hidden(app, 'onlineUnavailableNote'), false);
  assert.equal(hidden(app, 'modeExplain'), true, 'the explainer that mentions online rooms is hidden too');
  assert.equal(app.run("document.getElementById('playSharedBtn').classList.contains('as-primary')"), true, 'shared screen becomes the primary choice');

  app.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });
  assert.equal(await app.run('probeOnlinePlay()'), true);
  assert.equal(hidden(app, 'playOnlineBtn'), false);
  assert.equal(hidden(app, 'onlineUnavailableNote'), true);
  assert.equal(hidden(app, 'modeExplain'), false);
  assert.equal(app.run("document.getElementById('playSharedBtn').classList.contains('as-primary')"), false);

  // A host that answers with something else (a static host's 404 page, say) is not a server.
  app.window.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
  assert.equal(await app.run('probeOnlinePlay()'), false);
  app.window.fetch = async () => { throw new Error('network down'); };
  assert.equal(await app.run('probeOnlinePlay()'), false);
  assert.deepEqual(app.errors, []);
});

test('saving a file uses the downloads capability when the host offers it, and a plain download otherwise', async t => {
  const app = await loadApp(); t.after(() => app.close());
  const blob = () => app.run("new Blob(['hello'], {type: 'text/plain'})");

  // Plain browser: an anchor download, as before.
  assert.equal(await app.run("saveFile('a.txt', new Blob(['x']))"), 'saved');
  assert.equal(app.downloads.length, 1);
  assert.equal(app.downloads[0].name, 'a.txt');

  // Hosted: the capability is asked, and no anchor is used.
  const calls = [];
  app.window.claude = { use: async name => name === 'downloads' ? { save: async req => { calls.push(req); return { status: 'saved' }; } } : null };
  assert.equal(await app.run("saveFile('b.json', new Blob(['{}']))"), 'saved');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, 'b.json');
  assert.equal(app.downloads.length, 1, 'no extra anchor download');

  // The viewer declining is respected: nothing is downloaded behind their back.
  app.window.claude = { use: async () => ({ save: async () => { throw Object.assign(new Error('no'), { code: 'declined' }); } }) };
  assert.equal(await app.run("saveFile('c.txt', new Blob(['x']))"), 'declined');
  assert.equal(app.downloads.length, 1);

  // Capability missing or broken: fall back to the plain download.
  app.window.claude = { use: async () => null };
  assert.equal(await app.run("saveFile('d.txt', new Blob(['x']))"), 'saved');
  assert.equal(app.downloads.length, 2);
  app.window.claude = { use: async () => { throw Object.assign(new Error('x'), { code: 'unavailable' }); } };
  assert.equal(await app.run("saveFile('e.txt', new Blob(['x']))"), 'saved');
  assert.equal(app.downloads.length, 3);
});

test('refusals show in the page instead of a dialog the host may never display', async t => {
  const app = await loadApp(); t.after(() => app.close());
  await app.run("setActivePool('ea_database')");
  app.run("applyGameMode('classic'); participantCount = 4; openSharedSetup(); setDraftFilters({nation: 'Iceland', minRating: 85})");
  await app.run('startAuction()');
  const toast = app.window.document.getElementById('mpToast');
  assert.match(toast.textContent, /too thin/i);
  assert.match(toast.textContent, /filter/i, 'it says what to loosen');
  assert(toast.classList.contains('show') && toast.classList.contains('error'));
  assert.deepEqual(app.alerts, [], 'no alert() was used');
  assert.equal(app.run("document.getElementById('auctionScreen').style.display !== 'block'"), true, 'the draft did not start');
});

test('the text export copies to the clipboard and says so in the page', async t => {
  const app = await loadApp(); t.after(() => app.close());
  const { draftLocally } = await import('./helpers.mjs');
  await draftLocally(app, { mode: 'sixv6', count: 2, pool: 'current_players' });
  app.run('exportAsText()');
  await until(() => app.window.__copiedText, 'clipboard text');
  await until(() => /copied/i.test(app.window.document.getElementById('mpToast').textContent), 'the in-page confirmation');
  assert.deepEqual(app.alerts, []);
});

test('a build declared server-less never probes or opens a socket', async t => {
  const app = await loadApp(); t.after(() => app.close());
  let calls = 0;
  app.window.fetch = async () => { calls++; return { ok: true, json: async () => ({ status: 'ok' }) }; };
  app.window.AUCTION_NO_SERVER = true;
  assert.equal(await app.run('probeOnlinePlay()'), false);
  assert.equal(calls, 0, 'no request was made');
  assert.equal(hidden(app, 'playOnlineBtn'), true);
});

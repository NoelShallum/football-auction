import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = resolve(root, 'public');
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(path); else files.push(path);
  }
}
await walk(publicDir);
let scripts = 0;
for (const path of files) {
  if (path.endsWith('.js')) { new Script(await readFile(path, 'utf8'), { filename: path }); scripts++; }
  if (path.endsWith('.json')) JSON.parse(await readFile(path, 'utf8'));
  if (/\.(js|html)$/.test(path)) {
    const source = await readFile(path, 'utf8');
    assert(!/googletagmanager\.com|gstatic\.com\/firebase|firebaseio\.com|firebasedatabase\.app|AIza[0-9A-Za-z_-]{20}/.test(source), `Production tracking or database configuration in ${path}`);
  }
}
const html = await readFile(resolve(publicDir, 'index.html'), 'utf8');
for (const [, attr, value] of html.matchAll(/\b(src|href)="([^"#]+)"/g)) {
  if (/^(?:https?:|data:|mailto:)/.test(value)) {
    assert(attr === 'href', `Runtime resource must be local: ${value}`); continue;
  }
  await access(resolve(publicDir, value.split('?')[0]));
}
for (const file of files.filter(path => path.endsWith('.css'))) {
  for (const [, url] of (await readFile(file, 'utf8')).matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
    assert(!/^https?:/.test(url), `External CSS asset ${url}`);
    if (!url.startsWith('data:')) await access(resolve(dirname(file), url));
  }
}
const manifest = JSON.parse(await readFile(resolve(publicDir, 'pools/index.json'), 'utf8'));
let players = 0; let pools = 0;
for (const pool of manifest.pools) {
  if (!pool.available) continue;
  const data = JSON.parse(await readFile(resolve(publicDir, pool.file), 'utf8'));
  assert(data.players.length > 0); assert.equal(new Set(data.players.map(p => p.id)).size, data.players.length);
  players += data.players.length; pools++;
}
assert.equal(players, 2932); assert.equal(pools, 3);
for (const language of ['en', 'fr', 'ar', 'es', 'pt']) {
  const dictionary = JSON.parse(await readFile(resolve(publicDir, `locales/${language}.json`), 'utf8'));
  assert(dictionary.home && dictionary.auction && dictionary.sim && dictionary.tutorial, `Incomplete language ${language}`);
}
for (const folder of ['server', 'scripts', 'test']) {
  for (const file of await readdir(resolve(root, folder))) if (file.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', resolve(root, folder, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}
console.log(`Checked ${scripts} frontend scripts, local asset references, 5 languages, and ${players} player records in ${pools} pools.`);

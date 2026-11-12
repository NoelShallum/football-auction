#!/usr/bin/env node
/* Builds dist-artifact/index.html: the whole game as ONE self-contained page
   fragment, in the shape the Claude Artifact tool publishes (a <title> and
   <style> first, then the page content; no document wrapper, which the tool
   adds at publish time).

   Why one file: an artifact page may only load scripts and styles from a short
   CDN list, and nothing tells us how relative paths resolve on the host, so the
   CSS, JavaScript, translations and player pools are all embedded. A small
   fetch shim serves the embedded JSON to the code that asks for it by path
   (locales/*.json, pools/*.json, players.json); every other request passes
   through untouched, so the online-play probe (api/health) simply fails and the
   online button hides itself.

   Fonts come from Google Fonts, the one font host the page contract allows,
   instead of the bundled copies. The service worker is not included (service
   workers do not run in an artifact).

   Also writes dist-artifact/preview.html: the same page inside the wrapper the
   tool adds, for testing locally. Publish index.html, not preview.html.

   Usage: node scripts/build-artifact.mjs */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(root, 'public');
const out = resolve(root, 'dist-artifact');
const read = path => readFile(resolve(pub, path), 'utf8');

const FONTS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Oswald:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap';

const html = await read('index.html');
const bodyStart = html.indexOf('<body>');
const bodyEnd = html.lastIndexOf('</body>');
if (bodyStart < 0 || bodyEnd < 0) throw new Error('index.html has no <body>');

// Script order matters (shared global scope, same as separate <script> tags).
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
if (!scripts.length) throw new Error('no scripts found in index.html');

const markup = html.slice(bodyStart + 6, bodyEnd)
  .replace(/<script src="[^"]*"><\/script>[^\n]*/g, '')   // inlined below
  .replace(/<!--[\s\S]*?-->/g, '')
  .trim();

const stripCssComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripCssComments(await read('styles.css')) + '\n' + stripCssComments(await read('theme.css'));

// Data the app fetches by relative path.
const manifest = JSON.parse(await read('pools/index.json'));
const dataFiles = ['players.json', 'pools/index.json', 'pools/positions.json'];   // positions.json: the curated alternate positions
for (const pool of manifest.pools) if (pool.available && pool.file && !dataFiles.includes(pool.file)) dataFiles.push(pool.file);
for (const code of ['en', 'fr', 'ar', 'es', 'pt']) dataFiles.push(`locales/${code}.json`);

// A JS string literal that is safe inside <script> (no "</script", no "<!--").
const literal = text => JSON.stringify(text).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16));
const embedded = [];
let dataBytes = 0;
for (const path of dataFiles) {
  const text = JSON.stringify(JSON.parse(await read(path)));   // minified
  dataBytes += text.length;
  embedded.push(`${JSON.stringify(path)}:${literal(text)}`);
}

const shim = `window.AUCTION_NO_SERVER = true;
window.AUCTION_NO_SERVICE_WORKER = true;
(function(){
  var DATA = {${embedded.join(',\n')}};
  var real = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function(input, init){
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var key = /^[a-z][a-z0-9+.-]*:/i.test(url) ? null : url.split('#')[0].split('?')[0].replace(/^(\\.\\/|\\/)+/, '');
    if (key !== null && Object.prototype.hasOwnProperty.call(DATA, key)) {
      return Promise.resolve(new Response(DATA[key], {status: 200, headers: {'Content-Type': 'application/json'}}));
    }
    return real ? real(input, init) : Promise.reject(new Error('Network unavailable'));
  };
})();`;

const scriptTags = [];
for (const src of scripts) {
  const source = await read(src);
  if (/<\/script/i.test(source)) throw new Error(`${src} contains "</script" and cannot be inlined`);
  scriptTags.push(`<script>\n${source}\n</script>`);
}

const fragment = `<title>Auction XI</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${FONTS}">
<style>
:root{color-scheme:dark}
${css}
</style>
${markup}
<script>
${shim}
</script>
${scriptTags.join('\n')}
`;

// What the tool wraps around a page, so the preview matches what is published.
const wrapper = body => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'index.html'), fragment);
await writeFile(resolve(out, 'preview.html'), wrapper(fragment));

const mb = n => (n / 1024 / 1024).toFixed(2) + ' MB';
console.log(`dist-artifact/index.html  ${mb(Buffer.byteLength(fragment))}  (CSS ${mb(css.length)}, data ${mb(dataBytes)}, ${scripts.length} scripts)`);

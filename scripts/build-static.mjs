#!/usr/bin/env node
/* Builds dist-static/: the game ready to upload to a static host such as
   Cloudflare Pages (or Netlify, GitHub Pages, S3...).

   It is the normal `npm run build` output (so the offline service worker and
   bundled fonts come along) with three differences:
     - index.html declares window.AUCTION_NO_SERVER, so the page never opens
       the room-server socket and hides online play. Shared-screen and
       against-AI play are unaffected.
     - _headers carries the same security headers the Node server sends, minus
       WebSockets (honoured by Cloudflare Pages and Netlify; ignored elsewhere).
     - 404.html, so unknown paths return a real 404. Without one, Cloudflare
       Pages treats the site as a single-page app and answers every unknown path
       with index.html.

   Usage: node scripts/build-static.mjs
   Deploy: npx wrangler pages deploy dist-static --project-name <name> */

import { spawnSync } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = spawnSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const out = resolve(root, 'dist-static');
await rm(out, { recursive: true, force: true });
await cp(resolve(root, 'dist'), out, { recursive: true });

// 1. No room server here. Before any other script runs.
const indexPath = resolve(out, 'index.html');
let index = await readFile(indexPath, 'utf8');
if (!index.includes('<head>')) throw new Error('index.html has no <head> to put the flag in');
index = index.replace('<head>', '<head>\n<script>window.AUCTION_NO_SERVER = true;</script>');
await writeFile(indexPath, index);

// 2. Headers: the Node server's policy, without WebSockets.
await writeFile(resolve(out, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'

/sw.js
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache
`);

// 3. A real 404.
await writeFile(resolve(out, '404.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found - Auction XI</title>
<style>
  :root{color-scheme:dark}
  body{margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; box-sizing:border-box;
    background:#07170F; color:#F5F7F2; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; text-align:center;}
  h1{margin:0 0 8px; font-size:56px; letter-spacing:.06em;}
  p{margin:0 0 24px; color:#B4CCBF;}
  a{display:inline-block; padding:14px 28px; border-radius:12px; background:#D4FF3F; color:#0B2A1B; font-weight:700; text-decoration:none; letter-spacing:.08em; text-transform:uppercase;}
  a:focus-visible{outline:3px solid #D4FF3F; outline-offset:3px;}
</style>
</head>
<body>
<main>
  <h1>404</h1>
  <p>That page is not in the squad.</p>
  <a href="/">Back to Auction XI</a>
</main>
</body>
</html>
`);

console.log('dist-static/ ready: deploy it with  npx wrangler pages deploy dist-static --project-name <name>');

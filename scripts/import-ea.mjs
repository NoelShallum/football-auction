#!/usr/bin/env node
/* Builds public/pools/ea_database.json from the sofifa "FIFA 15-23 complete
   player dataset" CSV (the Kaggle file, also mirrored on Hugging Face as
   `jsulz/FIFA23`, file `male_players (legacy).csv`).

   Usage:
     node scripts/import-ea.mjs "<path to male_players (legacy).csv>" [options]

   Options:
     --min-rating <n>   Drop players rated below n (default 65).
     --out <file>       Output path (default public/pools/ea_database.json).
     --stats            Print a profile of the result and write nothing.

   One record per player:
     - Active in the newest game version  -> that version's rating and club (era "Current").
     - EA "Icons"/"Heroes" cards, if the file has any -> the card's rating (era "Legend").
       (The FIFA 15-23 "legacy" file does not, so legends come from the
       curated All-Time pool instead.)
     - Everyone else (retired, dropped)    -> their peak rating across versions (era "Past").
       Note the data starts with FIFA 15 (2014), so a long-retired star appears
       at his 2014+ rating, not his career peak.

   "Current" therefore means "in the newest game version of the file" (FIFA 23,
   the 2022-23 season for the legacy file), not today's squads.

   The source data is EA's, scraped from sofifa.com. Keep it out of any
   repository that is published or redistributed unless you are comfortable
   with that - see docs/SOURCE_NOTES.md. */

import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- CSV (RFC 4180: quoted fields, doubled quotes, newlines in quotes) ---------- */
async function* csvRows(path) {
  let field = '';
  let row = [];
  let inQuotes = false;
  let pendingQuote = false; // saw a quote while inQuotes; next char decides escape vs close
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') { field += '"'; continue; }
        inQuotes = false; // the quote closed the field; fall through and handle ch normally
      }
      if (inQuotes) {
        if (ch === '"') pendingQuote = true; else field += ch;
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ',') { row.push(field); field = ''; continue; }
      if (ch === '\n') {
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') yield row;
        row = [];
        continue;
      }
      if (ch !== '\r') field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); yield row; }
}

/* ---------- normalisation ---------- */
const NATION_FIXES = {
  'Korea Republic': 'South Korea',
  'Korea DPR': 'North Korea',
  'China PR': 'China',
  'Republic of Ireland': 'Ireland',
  "Côte d'Ivoire": 'Ivory Coast',
  'Cape Verde Islands': 'Cape Verde',
  'FYR Macedonia': 'North Macedonia',
  'St Kitts Nevis': 'Saint Kitts and Nevis',
  'St Lucia': 'Saint Lucia',
  'DR Congo': 'DR Congo',
  'Congo': 'Congo',
};

// EA position codes the game already understands.
const KNOWN_POSITIONS = new Set(['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST']);

/* "L. Messi" + "Lionel Andrés Messi Cuccittini" -> "Lionel Messi".
   Short names without an initial ("Neymar Jr", "Rodri") are already the
   name fans use, so they pass through unchanged. */
export function displayName(shortName, longName) {
  const short = String(shortName || '').trim();
  const long = String(longName || '').trim();
  const m = short.match(/^([A-Za-zÀ-ÖØ-öø-ÿ])\.\s+(.+)$/);
  if (!m) return short || long;
  const initial = m[1].toLowerCase();
  const first = long.split(/\s+/).find(t => t.toLowerCase().startsWith(initial));
  return first ? `${first} ${m[2]}` : short;
}

function formatValue(eur) {
  const v = Number(eur);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  if (v >= 1e6) return `€${Math.round(v / 1e5) / 10}M`.replace('.0M', 'M');
  return `€${Math.round(v / 1e3)}K`;
}

const seasonLabel = v => `${2000 + v - 1}-${2000 + v}`; // FIFA 23 = 2022-2023

/* ---------- main ---------- */
export async function buildPool(csvPath, { minRating = 65 } = {}) {
  let header = null;
  const col = {};
  const byPlayer = new Map();
  let newest = 0;

  for await (const r of csvRows(csvPath)) {
    if (!header) {
      header = r;
      header.forEach((h, i) => { col[h] = i; });
      for (const need of ['player_id', 'fifa_version', 'short_name', 'long_name', 'player_positions', 'overall', 'club_name', 'nationality_name', 'league_name', 'age', 'value_eur', 'preferred_foot']) {
        if (!(need in col)) throw new Error(`CSV is missing column "${need}"`);
      }
      continue;
    }
    const id = Number(r[col.player_id]);
    const version = Number(r[col.fifa_version]);
    const overall = Number(r[col.overall]);
    if (!id || !version || !overall) continue;
    newest = Math.max(newest, version);
    const club = r[col.club_name];
    const rec = {
      version, overall,
      short: r[col.short_name], long: r[col.long_name],
      positions: r[col.player_positions],
      club, league: r[col.league_name],
      nation: r[col.nationality_name],
      age: Number(r[col.age]) || undefined,
      value: r[col.value_eur],
      foot: r[col.preferred_foot],
      icon: club === 'Icons' || club === 'Heroes',
    };
    let p = byPlayer.get(id);
    if (!p) { p = { first: version, last: version, latest: rec, peak: rec, icon: null }; byPlayer.set(id, p); }
    p.first = Math.min(p.first, version);
    p.last = Math.max(p.last, version);
    if (version >= p.latest.version) p.latest = rec;
    if (overall > p.peak.overall) p.peak = rec;
    if (rec.icon && (!p.icon || overall > p.icon.overall)) p.icon = rec;
  }

  const players = [];
  for (const [id, p] of byPlayer) {
    let rec, era;
    if (p.icon) { rec = p.icon; era = 'Legend'; }
    else if (p.last === newest) { rec = p.latest; era = 'Current'; }
    else { rec = p.peak; era = 'Past'; }
    if (rec.overall < minRating) continue;

    const codes = rec.positions.split(',').map(s => s.trim()).filter(Boolean);
    const position = codes.find(c => KNOWN_POSITIONS.has(c));
    if (!position) continue;
    const secondary = codes.filter(c => c !== position && KNOWN_POSITIONS.has(c));

    const out = {
      id,
      name: displayName(rec.short, rec.long),
      nationality: NATION_FIXES[rec.nation] || rec.nation || 'Unknown',
      club: rec.icon ? '' : (rec.club || ''),
      league: rec.icon ? '' : (rec.league || ''),
      position,
      rating: rec.overall,
      era,
      years: era === 'Legend' ? '' : `${seasonLabel(p.first).slice(0, 4)}-${seasonLabel(p.last).slice(5)}`,
    };
    if (secondary.length) out.secondaryPositions = secondary;
    const mv = formatValue(rec.value);
    if (mv && era === 'Current') out.marketValue = mv;
    if (rec.foot) out.foot = rec.foot;
    if (rec.age && era === 'Current') out.age = rec.age;
    players.push(out);
  }

  players.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  // Stable, dense ids after sorting keep the file diff-friendly and ids small.
  // (EA ids would also work, but they are 6 digits each across thousands of rows.)
  players.forEach((p, i) => { p.id = i + 1; });
  return { players, newest, totalSeen: byPlayer.size };
}

function profile({ players, newest, totalSeen }) {
  const by = f => players.reduce((m, p) => ((m[f(p)] = (m[f(p)] || 0) + 1), m), {});
  const bucket = by(p => Math.floor(p.rating / 5) * 5);
  console.log(`source players seen: ${totalSeen}, newest game version: FIFA ${newest}`);
  console.log(`kept: ${players.length}`);
  console.log('era      :', JSON.stringify(by(p => p.era)));
  console.log('position :', JSON.stringify(by(p => p.position)));
  console.log('rating   :', JSON.stringify(bucket));
  const leagues = Object.entries(by(p => p.league || '(none)')).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('top leagues:', leagues.map(([k, v]) => `${k} ${v}`).join(' | '));
  console.log('sample   :', players.slice(0, 3).map(p => `${p.name} ${p.rating} ${p.era}`).join(' | '));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const input = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!input) { console.error('usage: node scripts/import-ea.mjs <csv> [--min-rating n] [--out file] [--stats]'); process.exit(1); }
  const minRating = Number(opt('--min-rating') || 65);
  const result = await buildPool(input, { minRating });
  profile(result);
  if (!args.includes('--stats')) {
    const out = resolve(root, opt('--out') || 'public/pools/ea_database.json');
    const file = {
      schemaVersion: 1,
      pool: {
        id: 'ea_database',
        name: 'Pro Database',
        shortName: 'Pro DB',
        icon: '🗄️',
        tagline: 'Thousands of pros, from superstars to squad fillers.',
        description: `A deep ratings database built from the FIFA 15-23 player data (2014 to the 2022-23 season): players still active then, plus retired players at their best rating in the data. Rated ${minRating} and up, so later phases have a long tail of cheaper players.`,
        category: 'core',
        order: 12,
        theme: { accent: '#D4FF3F', accentInk: '#0B2A1B', badge: 'PRO DATABASE' },
        // A flat 10,000-player pool would make "phase 1" a random 73-rated
        // player, so the quality floor tightens as fewer players are needed.
        draft: {
          smallDraftMinRating: null,
          autoMinRating: [{ upTo: 4, min: 80 }, { upTo: 6, min: 76 }, { upTo: 10, min: 72 }],
          minParticipants: 2,
          maxParticipants: 10,
        },
        credit: { author: 'sofifa.com via the FIFA 15-23 player dataset (EA ratings)', url: 'https://sofifa.com/' },
      },
      players: result.players,
    };
    await writeFile(out, JSON.stringify(file) + '\n');
    console.log(`wrote ${out}`);
  }
}

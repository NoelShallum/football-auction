#!/usr/bin/env node
/* Builds public/pools/ea_database.json (the "Pro Database" pool) from public
   EA ratings data.

   Usage:
     node scripts/import-ea.mjs --fc26 <EAFC26.csv> [--legacy "<male_players (legacy).csv>"] [options]
     node scripts/import-ea.mjs "<male_players (legacy).csv>"           (legacy only, older behaviour)

   Sources:
     --fc26    A CSV of EA SPORTS FC 26 ratings with columns ID, Name, GENDER, OVR,
               Position, "Alternative positions", Age, Nation, League, Team,
               "Preferred foot". (EA publishes these on its ratings pages; community
               CSVs of them circulate on GitHub and Kaggle.) Only men (GENDER = M)
               are used: this is a men's football game.
     --legacy  The sofifa "FIFA 15-23 complete player dataset" (Kaggle; mirrored on
               Hugging Face as jsulz/FIFA23, file `male_players (legacy).csv`).

   One record per player. Player ids are EA's own, shared by both files, so the two
   merge cleanly:
     - In FC 26                    -> FC 26 rating and club (era "Current", i.e. present day).
     - Only in FIFA 15-23          -> his best rating across those versions (era "Past").
       The data starts with FIFA 15 (2014), so a long-retired star appears at his
       2014-onward rating, not his career peak. There are no Icons in either file;
       retired legends come from the curated All-Time pool.
     - FC 26 players below the rating floor are dropped, not demoted to "Past".

   Options:
     --min-rating <n>   Drop players rated below n (default 70).
     --out <file>       Output path (default public/pools/ea_database.json).
     --stats            Print a profile of the result and write nothing.

   The ratings are EA's. See docs/SOURCE_NOTES.md before publishing the output. */

import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- CSV (RFC 4180: quoted fields, doubled quotes, newlines in quotes) ---------- */
export async function* csvRows(path) {
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

// Header-aware reader: yields each row as an object keyed by column name.
async function* records(path, required) {
  let header = null;
  for await (const r of csvRows(path)) {
    if (!header) {
      header = r;
      for (const need of required) if (!header.includes(need)) throw new Error(`${path} is missing column "${need}"`);
      continue;
    }
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    yield o;
  }
}

/* ---------- normalisation ---------- */
const NATION_FIXES = {
  'Holland': 'Netherlands',
  'Korea Republic': 'South Korea',
  'Korea DPR': 'North Korea',
  'China PR': 'China',
  'Republic of Ireland': 'Ireland',
  "Côte d'Ivoire": 'Ivory Coast',
  'Congo DR': 'DR Congo',
  'Cape Verde Islands': 'Cape Verde',
  'FYR Macedonia': 'North Macedonia',
  'St. Kitts and Nevis': 'Saint Kitts and Nevis',
  'St Kitts Nevis': 'Saint Kitts and Nevis',
  'St. Lucia': 'Saint Lucia',
  'St Lucia': 'Saint Lucia',
};
const nation = n => NATION_FIXES[n] || n || 'Unknown';

/* FC 26 names its leagues after sponsors; FIFA 15-23 used plain names. Mapped to
   the plain ones so the league filter treats both sources as one list. Only
   names I am sure of are mapped; anything else keeps EA's own wording. */
const LEAGUE_FIXES = {
  'LPF': 'Liga Profesional',
  'MLS': 'Major League Soccer',
  'EFL Championship': 'Championship',
  'EFL League One': 'League One',
  'EFL League Two': 'League Two',
  'Serie A Enilive': 'Serie A',
  'Serie BKT': 'Serie B',
  'Bundesliga 2': '2. Bundesliga',
  'LALIGA EA SPORTS': 'La Liga',
  'LALIGA HYPERMOTION': 'La Liga 2',
  'PKO BP Ekstraklasa': 'Ekstraklasa',
  "Ligue 1 McDonald's": 'Ligue 1',
  'Ligue 2 BKT': 'Ligue 2',
  '1A Pro League': 'Jupiler Pro League',
  'Trendyol Süper Lig': 'Super Lig',
  'ROSHN Saudi League': 'Saudi Pro League',
  'CSL': 'Chinese Super League',
  'Scottish Prem': 'Scottish Premiership',
  '3F Superliga': 'Danish Superliga',
  'Ö. Bundesliga': 'Austrian Bundesliga',
  'SSE Airtricity PD': 'League of Ireland Premier Division',
  'ISL': 'Indian Super League',
  'Brack Super League': 'Swiss Super League',
  'Libertadores': 'Copa Libertadores',
  'Sudamericana': 'Copa Sudamericana',
};
/* The FIFA 15-23 file gives league names without a country, so these could be
   any of several countries' leagues. Better no league than a wrong one. */
const AMBIGUOUS_LEAGUES = new Set(['', 'Super League', 'Pro League', 'Premiership', 'Superliga', 'Premier Division',
  '1. Division', 'Primera Division', 'Primera División', 'Liga 1', 'Liga Pro', 'Liga De Futbol Prof']);

const KNOWN_POSITIONS = new Set(['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST']);

/* "L. Messi" + "Lionel Andrés Messi Cuccittini" -> "Lionel Messi". Short names
   without an initial ("Neymar Jr", "Rodri") pass through unchanged. */
export function displayName(shortName, longName) {
  const short = String(shortName || '').trim();
  const long = String(longName || '').trim();
  const m = short.match(/^([A-Za-zÀ-ÖØ-öø-ÿ])\.\s+(.+)$/);
  if (!m) return short || long;
  const initial = m[1].toLowerCase();
  const first = long.split(/\s+/).find(t => t.toLowerCase().startsWith(initial));
  return first ? `${first} ${m[2]}` : short;
}

// "['RW', 'CAM']" (a Python list printed as text) -> ['RW', 'CAM']
function parseList(text) {
  return String(text || '').replace(/[\[\]'"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
}

const seasonStart = v => 2000 + v - 1;   // FIFA 23 = the 2022-23 season

/* ---------- sources ---------- */
async function loadLegacy(path) {
  const byId = new Map();
  let newest = 0;
  for await (const r of records(path, ['player_id', 'fifa_version', 'short_name', 'long_name', 'player_positions', 'overall', 'club_name', 'nationality_name', 'league_name', 'preferred_foot'])) {
    const id = Number(r.player_id), version = Number(r.fifa_version), overall = Number(r.overall);
    if (!id || !version || !overall) continue;
    newest = Math.max(newest, version);
    const rec = { version, overall, short: r.short_name, long: r.long_name, positions: r.player_positions, club: r.club_name, league: r.league_name, nation: r.nationality_name, foot: r.preferred_foot, age: Number(r.age) || undefined };
    let p = byId.get(id);
    if (!p) { p = { first: version, last: version, peak: rec }; byId.set(id, p); }
    p.first = Math.min(p.first, version);
    p.last = Math.max(p.last, version);
    if (overall > p.peak.overall) p.peak = rec;
  }
  return { byId, newest };
}

async function loadFc26(path) {
  const rows = [];
  for await (const r of records(path, ['ID', 'Name', 'GENDER', 'OVR', 'Position', 'Alternative positions', 'Age', 'Nation', 'League', 'Team', 'Preferred foot'])) {
    if (r.GENDER !== 'M') continue;
    const id = Number(r.ID), ovr = Number(r.OVR);
    if (!id || !ovr) continue;
    rows.push({ id, ovr, name: r.Name, position: r.Position, alts: r['Alternative positions'], age: Number(r.Age) || undefined, nation: r.Nation, league: r.League, team: r.Team, foot: r['Preferred foot'] });
  }
  return rows;
}

/* ---------- main ---------- */
export async function buildPool({ fc26Path, legacyPath, minRating = 70 }) {
  if (!fc26Path && !legacyPath) throw new Error('Give --fc26 and/or --legacy');
  const legacy = legacyPath ? await loadLegacy(legacyPath) : { byId: new Map(), newest: 0 };
  const fc26 = fc26Path ? await loadFc26(fc26Path) : [];
  const inFc26 = new Set(fc26.map(r => r.id));
  const players = [];

  for (const r of fc26) {
    if (r.ovr < minRating || !KNOWN_POSITIONS.has(r.position)) continue;
    const old = legacy.byId.get(r.id);
    const out = {
      id: r.id,
      name: r.name,
      nationality: nation(r.nation),
      club: r.team || '',
      league: LEAGUE_FIXES[r.league] || r.league || '',
      position: r.position,
      rating: r.ovr,
      era: 'Current',
      years: `${old ? seasonStart(old.first) : 2025}-2026`,
    };
    const alts = parseList(r.alts).filter(c => c !== r.position && KNOWN_POSITIONS.has(c));
    if (alts.length) out.secondaryPositions = alts;
    if (r.foot) out.foot = r.foot;
    if (r.age) out.age = r.age;
    players.push(out);
  }

  for (const [id, p] of legacy.byId) {
    if (inFc26.has(id)) continue;                      // still in the game: handled above
    const rec = p.peak;
    if (rec.overall < minRating) continue;
    // The legacy-only mode has no FC 26 to compare to, so "current" is its newest version.
    const era = (!fc26.length && p.last === legacy.newest) ? 'Current' : 'Past';
    const codes = String(rec.positions || '').split(',').map(s => s.trim()).filter(Boolean);
    const position = codes.find(c => KNOWN_POSITIONS.has(c));
    if (!position) continue;
    const secondary = codes.filter(c => c !== position && KNOWN_POSITIONS.has(c));
    const league = AMBIGUOUS_LEAGUES.has(rec.league) ? '' : (LEAGUE_FIXES[rec.league] || rec.league);
    const out = {
      id,
      name: displayName(rec.short, rec.long),
      nationality: nation(rec.nation),
      club: rec.club || '',
      league,
      position,
      rating: rec.overall,
      era,
      years: `${seasonStart(p.first)}-${seasonStart(p.last) + 1}`,
    };
    if (secondary.length) out.secondaryPositions = secondary;
    if (rec.foot) out.foot = rec.foot;
    players.push(out);
  }

  players.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  // Dense ids after sorting keep the file small and diff-friendly (EA's ids are 6 digits each).
  players.forEach((p, i) => { p.id = i + 1; });
  return { players, fc26Count: fc26.length, legacySeen: legacy.byId.size, legacyNewest: legacy.newest };
}

function profile({ players, fc26Count, legacySeen, legacyNewest }) {
  const by = f => players.reduce((m, p) => ((m[f(p)] = (m[f(p)] || 0) + 1), m), {});
  console.log(`sources: FC 26 men ${fc26Count || 0}, FIFA 15-${legacyNewest || '-'} players ${legacySeen}`);
  console.log(`kept: ${players.length}`);
  console.log('era      :', JSON.stringify(by(p => p.era)));
  console.log('position :', JSON.stringify(by(p => p.position)));
  console.log('rating   :', JSON.stringify(by(p => Math.floor(p.rating / 5) * 5)));
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(' | ');
  console.log('top leagues:', top(by(p => p.league || '(none)')));
  console.log('blank league:', players.filter(p => !p.league).length, ' blank club:', players.filter(p => !p.club).length);
  console.log('sample   :', players.slice(0, 4).map(p => `${p.name} ${p.rating} ${p.era} ${p.club}`).join(' | '));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const valueFlags = new Set(['--fc26', '--legacy', '--min-rating', '--out']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
  const fc26Path = opt('--fc26');
  const legacyPath = opt('--legacy') || positional[0];
  if (!fc26Path && !legacyPath) {
    console.error('usage: node scripts/import-ea.mjs --fc26 <EAFC26.csv> [--legacy <legacy.csv>] [--min-rating n] [--out file] [--stats]');
    process.exit(1);
  }
  const minRating = Number(opt('--min-rating') || 70);
  const result = await buildPool({ fc26Path, legacyPath, minRating });
  profile(result);
  if (!args.includes('--stats')) {
    const out = resolve(root, opt('--out') || 'public/pools/ea_database.json');
    const hasFc26 = !!fc26Path;
    const file = {
      schemaVersion: 1,
      pool: {
        id: 'ea_database',
        name: 'Pro Database',
        shortName: 'Pro DB',
        icon: '🗄️',
        tagline: 'Thousands of pros, from superstars to squad fillers.',
        description: hasFc26
          ? `A deep ratings database: the EA SPORTS FC 26 men's player ratings for today's pros, plus players from FIFA 15-23 who have since left the game at their best rating in that data. Rated ${minRating} and up, so later phases have a long tail of cheaper players.`
          : `A deep ratings database built from the FIFA 15-23 player data (2014 to the 2022-23 season). Rated ${minRating} and up, so later phases have a long tail of cheaper players.`,
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
        credit: {
          author: hasFc26
            ? 'EA SPORTS FC 26 ratings (ea.com/games/ea-sports-fc/ratings) and sofifa.com via the FIFA 15-23 player dataset'
            : 'sofifa.com via the FIFA 15-23 player dataset (EA ratings)',
          url: 'https://www.ea.com/games/ea-sports-fc/ratings',
        },
      },
      players: result.players,
    };
    await writeFile(out, JSON.stringify(file) + '\n');
    console.log(`wrote ${out}`);
  }
}

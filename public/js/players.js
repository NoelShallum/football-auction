/* ================= PLAYER POOLS =================

   The game ships several pools (all-time, World Cup, ...) and the picker
   in every mode is generated from pools/index.json - no pool is named
   anywhere in this file, so adding one is a data change only.

   Online is unaffected by any of this at draft time: the host is the only
   client that resolves players out of a pool, and the resulting player
   objects travel inside gameState. Guests only need the pool's metadata,
   which rides along in the room settings, so a guest never fetches a pool
   file and can't desync by having a different version of one. */

const DEFAULT_POOL_ID = 'all_time';
const POOL_MANIFEST_URL = 'pools/index.json';

// Used when pools/index.json is missing or unreadable. The game then
// behaves exactly as it did before pools existed rather than failing.
const FALLBACK_POOL_ENTRY = {
  id: DEFAULT_POOL_ID,
  name: 'All-Time Greats',
  shortName: 'All-Time',
  icon: '⚽',
  tagline: 'Every era, every legend, every position.',
  category: 'core',
  order: 10,
  available: true,
  file: 'players.json',
  theme: { accent: '#FFB020', accentInk: '#1A1200', badge: 'ALL-TIME GREATS' }
};

// What a pool gets when its file says nothing. These are the all-time
// database's long-standing rules, so pools that don't opt out behave
// exactly as the game always has. A curated pool overrides them in its
// own `draft` block - notably smallDraftMinRating:null to switch the
// 80+ floor off, which a few-hundred-player event pool needs.
const POOL_DRAFT_DEFAULTS = {
  smallDraftMinRating: 80,
  smallDraftMaxParticipants: 4,
  minParticipants: 2,
  maxParticipants: 10
};

/* Resolves once the pool catalogue and the starting pool have been
   fetched - i.e. once there are actually players to draft. Assigned where
   loadPlayerDatabase() is kicked off (js/setup.js) and awaited by the
   boot sequence, which keeps the loading screen up until then: the home
   screen used to be fully clickable while a third of a megabyte of
   players was still in flight, so pressing Start early met an error
   instead of a draft. */
let playersReady = null;

let poolCatalog = [];              // manifest entries, sorted for display
let POOL_DEFAULT_FROM_MANIFEST = DEFAULT_POOL_ID;
let activePoolId = DEFAULT_POOL_ID;
let activePoolMeta = null;         // resolved metadata of the loaded pool
// Which pool playerDatabase actually holds. This can lag activePoolId:
// a guest in an online room adopts the host's pool id for branding
// without fetching its file, so the two must be reconciled before that
// client ever drafts on its own again (see ensureActivePoolLoaded).
let loadedPoolId = null;
const poolFileCache = {};          // id -> {meta, players}, so re-picking is instant

function poolEntry(id){
  return poolCatalog.find(p => p.id === id) || null;
}

// Accepts both envelopes: the curated {schemaVersion, pool, players}
// shape and players.json's original {metadata, players} one. Normalising
// here is what lets the original database stay a pool like any other
// without being rewritten.
function normalizePoolFile(data, entry){
  const meta = Object.assign({}, entry, data && data.pool ? data.pool : {});
  meta.id = entry.id; // the manifest is authoritative on identity
  meta.draft = Object.assign({}, POOL_DRAFT_DEFAULTS, meta.draft || {});
  meta.theme = Object.assign({}, FALLBACK_POOL_ENTRY.theme, entry.theme || {}, meta.theme || {});
  const players = (data && Array.isArray(data.players)) ? data.players : [];
  return { meta, players };
}

async function loadPoolCatalog(){
  try {
    const res = await fetch(POOL_MANIFEST_URL, { cache: 'no-cache' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data.pools) ? data.pools : [];
    if(!list.length) throw new Error('manifest lists no pools');
    poolCatalog = list.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    if(data.defaultPoolId && poolEntry(data.defaultPoolId)) POOL_DEFAULT_FROM_MANIFEST = data.defaultPoolId;
  } catch(err){
    // Not fatal, and deliberately quiet for the user: the game still
    // works, it just offers the one built-in pool.
    console.warn('Pool catalogue unavailable, falling back to the built-in pool:', err.message);
    poolCatalog = [FALLBACK_POOL_ENTRY];
  }
}

async function loadPool(id){
  const entry = poolEntry(id) || poolEntry(DEFAULT_POOL_ID) || FALLBACK_POOL_ENTRY;
  if(!entry.available || !entry.file) throw new Error(`"${entry.name}" is not available yet.`);
  if(poolFileCache[entry.id]) return poolFileCache[entry.id];

  const res = await fetch(entry.file, { cache: 'no-cache' });
  if(!res.ok) throw new Error(`Could not load ${entry.file} (HTTP ${res.status})`);
  const loaded = normalizePoolFile(await res.json(), entry);
  poolFileCache[entry.id] = loaded;
  return loaded;
}

// Makes `id` the pool the draft engine draws from. Returns true on
// success; on failure the previously active pool is left untouched, so a
// bad pick can never leave the game with an empty database.
async function setActivePool(id){
  try {
    const loaded = await loadPool(id);
    activePoolId = loaded.meta.id;
    activePoolMeta = loaded.meta;
    playerDatabase = loaded.players;
    loadedPoolId = loaded.meta.id;
    applyPoolTheme(activePoolMeta);
    console.log(`Pool "${activePoolMeta.name}": ${playerDatabase.length} players`);
    return true;
  } catch(err){
    console.error('Failed to activate pool', id, err);
    return false;
  }
}

// Guarantees playerDatabase really is the pool the UI says is selected.
// Cheap and synchronous in the normal case; only does work after a guest
// has inherited a host's pool id without the file behind it.
async function ensureActivePoolLoaded(){
  if(loadedPoolId === activePoolId && playerDatabase.length) return true;
  if(await setActivePool(activePoolId)) return true;
  return await setActivePool(DEFAULT_POOL_ID);
}

function activePoolDraft(){
  return (activePoolMeta && activePoolMeta.draft) || POOL_DRAFT_DEFAULTS;
}

// Display metadata for whatever pool is active, safe to call before any
// pool has loaded and safe for a guest whose pool metadata arrived over
// the wire rather than from a file.
function activePoolDisplay(){
  return activePoolMeta || poolEntry(activePoolId) || FALLBACK_POOL_ENTRY;
}

/* How many players the pool can actually offer for each slot of the
   current formation. A draft needs the position's band to be non-empty
   in every phase, which means roughly one player per participant per
   slot of that position - anything less and selectPlayer() starts
   falling through to its "Unknown Player" last resort. Checking this up
   front is the difference between "this pool is too thin, here's what's
   missing" and a draft that silently degrades halfway through. */
function poolCoverage(numParticipants){
  const slots = {};
  FORMATION.forEach(f => { slots[f.code] = (slots[f.code] || 0) + 1; });
  // Measured through getPositionPool() itself rather than re-deriving the
  // filter here, so this always reflects exactly what the draft will see
  // - including the active mode's own rules (Classic's small-draft rating
  // floor, or 6v6's per-category top-% cut).
  const rows = Object.keys(slots).map(code => {
    const have = getPositionPool(code, numParticipants).length;
    const need = slots[code] * Math.max(1, numParticipants);
    return { code, have, need, short: Math.max(0, need - have) };
  });
  return { rows, missing: rows.filter(r => r.short > 0), ok: rows.every(r => r.short === 0) };
}

// One place decides whether the current pool can run the draft that has
// been set up, so the offline, AI and online start buttons all agree.
function poolReadinessMessage(numParticipants){
  if(!playerDatabase.length){
    return t('pool.hasNoPlayers', {pool: poolName(activePoolDisplay())});
  }
  const cov = poolCoverage(numParticipants);
  if(cov.ok) return null;
  const worst = cov.missing.sort((a, b) => b.short - a.short).slice(0, 3)
    .map(r => `${r.code} (${r.have}/${r.need})`).join(', ');
  return t('pool.tooThin', {pool: poolName(activePoolDisplay()), n: numParticipants, detail: worst});
}

// Boots the pool system: read the catalogue, then activate the pool the
// user last chose (falling back to the default if it has since been
// removed or emptied).
async function loadPlayerDatabase(){
  await loadPoolCatalog();
  const wanted = poolEntry(activePoolId) ? activePoolId : POOL_DEFAULT_FROM_MANIFEST;
  if(!(await setActivePool(wanted)) && wanted !== DEFAULT_POOL_ID){
    await setActivePool(DEFAULT_POOL_ID);
  }
  if(!playerDatabase.length){
    // Reported through the loading screen's own failed state rather than
    // an alert(), which blocks the tab and leaves a half-drawn app
    // behind it once dismissed.
    console.error('No players available from any pool.');
    return false;
  }
  renderAllPoolPickers();
  prefetchPoolCounts();
  return true;
}

/* ---------- Pool UI ----------

   Every surface that shows or picks a pool is generated from the
   catalogue by the functions below, and mounted through POOL_MOUNTS. A
   new curated event therefore needs no markup and no code: it appears in
   the offline setup, the AI setup and the online host settings at once,
   already branded in its own colour. */

// Fills in the real player counts so the cards can say how big each pool
// is, and makes switching between pools instant afterwards. Sequential
// on purpose - this is background work behind an already-usable screen,
// not something worth saturating a phone connection for.
let poolPrefetchStarted = false;
async function prefetchPoolCounts(){
  if(poolPrefetchStarted) return;
  poolPrefetchStarted = true;
  for(const entry of poolCatalog){
    if(!entry.available || !entry.file || poolFileCache[entry.id]) continue;
    try { await loadPool(entry.id); }
    catch(err){ entry.loadError = err.message; }
    renderAllPoolPickers();
  }
}

function poolPlayerCount(id){
  return poolFileCache[id] ? poolFileCache[id].players.length : null;
}

function applyPoolTheme(meta){
  const theme = (meta && meta.theme) || FALLBACK_POOL_ENTRY.theme;
  const root = document.documentElement;
  root.style.setProperty('--pool-accent', theme.accent || '#FFB020');
  root.style.setProperty('--pool-ink', theme.accentInk || '#1A1200');
}

// The default pool is the ordinary game, so it gets no banner - the
// banner exists precisely to say "this is not a normal draft".
function poolBannerHTML(meta){
  if(!meta || meta.id === DEFAULT_POOL_ID) return '';
  const theme = meta.theme || {};
  const badge = poolBadge(meta);
  return `<div class="pool-banner">
    <span class="pb-icon">${esc(meta.icon || '')}</span>
    <span class="pb-badge">${esc(badge)}</span>
    <span class="pb-text">${esc(poolTagline(meta) || meta.description || '')}</span>
  </div>`;
}

// The compact trigger shown inline on the settings screen in place of
// the old always-expanded grid. It only ever displays the ACTIVE pool -
// the full catalogue lives in the modal this button opens - so this row
// costs exactly the same one line whether the catalogue has 2 pools or
// 20.
/* A pool's display strings, translated when a translation exists and
   falling back to the pool file's own English when it doesn't - so a new
   pool is usable in every language the day it is added. See tData(). */
function poolName(entry){
  return tData('pools.' + entry.id + '.name', entry.name);
}
function poolTagline(entry){
  return tData('pools.' + entry.id + '.tagline', entry.tagline || '');
}
function poolBadge(entry){
  const fallback = (entry.theme && entry.theme.badge) || entry.shortName || entry.name;
  return tData('pools.' + entry.id + '.badge', fallback);
}
function poolCountText(count){
  if(count == null) return '';
  return t(count === 1 ? 'pool.countOne' : 'pool.countMany', {n: count});
}

function poolSelectHTML(entry){
  const countText = poolCountText(poolPlayerCount(entry.id));
  return `
    <span class="pool-select-icon">${esc(entry.icon || '⚽')}</span>
    <span class="pool-select-body">
      <span class="pool-select-name"><span class="pool-select-name-text">${esc(poolName(entry))}</span><span class="pool-select-badge">${esc(poolBadge(entry))}</span></span>
      <span class="pool-select-meta">${esc(poolTagline(entry))}${countText ? ' · ' + esc(countText) : ''}</span>
    </span>
    <span class="pool-select-chevron">${esc(t('pool.change'))} ▾</span>
  `;
}

function poolCardHTML(entry){
  const isActive = entry.id === activePoolId;
  const count = poolPlayerCount(entry.id);
  const locked = !entry.available || !!entry.loadError;

  let pill = '';
  if(!entry.available) pill = t('pool.comingSoon');
  else if(entry.loadError) pill = t('pool.unavailable');
  else if(count === 0) pill = t('pool.empty');

  const countText = count == null
    ? (entry.available && !entry.loadError ? t('pool.loading') : '')
    : poolCountText(count);

  // Each card carries its own accent so the whole grid reads as a set of
  // distinct events rather than one highlighted row.
  const accent = (entry.theme && entry.theme.accent) || '#FFB020';
  const ink = (entry.theme && entry.theme.accentInk) || '#1A1200';

  return `<button type="button" class="pool-card${isActive ? ' active' : ''}${locked ? ' locked' : ''}"
      data-pool-id="${esc(entry.id)}" ${locked ? 'disabled' : ''}
      style="--pool-accent:${esc(accent)}; --pool-ink:${esc(ink)};">
    <span class="pool-card-check">✓</span>
    <span class="pool-card-top">
      <span class="pool-card-icon">${esc(entry.icon || '⚽')}</span>
      <span class="pool-card-name">${esc(poolName(entry))}</span>
    </span>
    <span class="pool-card-tag">${esc(poolTagline(entry))}</span>
    <span class="pool-card-meta">
      <span class="pool-card-count">${esc(countText)}</span>
      ${pill ? `<span class="pool-card-pill">${esc(pill)}</span>` : ''}
    </span>
  </button>`;
}

// Every place a pool is shown or chosen. `count` is how many
// participants that screen is currently set up for, which is what the
// readiness check needs; `editable` decides whether the trigger button
// is enabled at all (guests in an online room only ever see the banner).
const POOL_MOUNTS = [
  {
    select: 'setupPoolSelect', warning: 'setupPoolWarning', banner: 'setupPoolBanner',
    editable: () => true,
    count: () => participantCount,
  },
  {
    select: 'waitingPoolSelect', warning: 'waitingPoolWarning', banner: 'waitingPoolBanner',
    editable: () => isHost,
    count: () => Math.max(2, mpConnectedParticipants),
  },
  { banner: 'auctionPoolBanner' },
  { banner: 'resultsPoolBanner' },
];

// Which mount's trigger opened the modal, so a successful pick can go
// back to refreshing that mount's readiness warning immediately (the
// full renderAllPoolPickers() below refreshes every mount anyway, but
// this is what the modal's own re-render targets while it's still open).
let poolModalMountKey = null;

function renderAllPoolPickers(){
  POOL_MOUNTS.forEach(mount => {
    const bannerEl = mount.banner && document.getElementById(mount.banner);
    if(bannerEl) bannerEl.innerHTML = poolBannerHTML(activePoolDisplay());

    const selectEl = mount.select && document.getElementById(mount.select);
    if(selectEl){
      const editable = mount.editable();
      selectEl.disabled = !editable;
      selectEl.style.display = editable ? '' : 'none';
      selectEl.innerHTML = poolSelectHTML(activePoolDisplay());
      selectEl.onclick = () => openPoolModal(mount);
    }

    const warnEl = mount.warning && document.getElementById(mount.warning);
    if(warnEl){
      const msg = mount.editable && mount.editable() ? poolReadinessMessage(mount.count()) : null;
      warnEl.innerHTML = msg
        ? `<div class="pool-warning">${esc(msg)} Pick another pool, or add more players to this one.</div>`
        : '';
    }
  });

  // The modal grid is shared by every mount, so it only needs a refresh
  // while actually open (an active-pool change elsewhere, e.g. a host's
  // choice arriving over the wire, should still move the tick if a guest
  // happens to have their own modal open).
  const modalEl = document.getElementById('poolModalOverlay');
  if(modalEl && modalEl.classList.contains('show')) renderPoolModalGrid();
}

function renderPoolModalGrid(){
  const gridEl = document.getElementById('poolModalGrid');
  gridEl.innerHTML = poolCatalog.length
    ? poolCatalog.map(poolCardHTML).join('')
    : '<div class="pool-card-tag">Loading pools…</div>';
  gridEl.querySelectorAll('.pool-card').forEach(btn => {
    btn.onclick = () => choosePool(btn.dataset.poolId);
  });
}

function openPoolModal(mount){
  if(!mount.editable()) return;
  poolModalMountKey = mount.select;
  renderPoolModalGrid();
  document.getElementById('poolModalOverlay').classList.add('show');
}
function closePoolModal(){
  document.getElementById('poolModalOverlay').classList.remove('show');
  poolModalMountKey = null;
}
document.getElementById('poolModalCloseBtn').onclick = closePoolModal;
document.getElementById('poolModalOverlay').onclick = (e) => {
  if(e.target.id === 'poolModalOverlay') closePoolModal();
};
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape' && document.getElementById('poolModalOverlay').classList.contains('show')){
    closePoolModal();
  }
});

// Single entry point for "the user picked a pool", shared by the offline,
// AI and online host screens. Online additionally publishes the choice to
// the room so every guest's branding follows the host's. Closes the
// modal on success, same as any other picker - the trigger button
// immediately reflects the new choice.
let poolSwitchInFlight = false;
async function choosePool(id){
  if(poolSwitchInFlight || id === activePoolId){ closePoolModal(); return; }
  poolSwitchInFlight = true;
  try {
    if(!(await setActivePool(id))){
      const entry = poolEntry(id);
      mpShowToast(`Couldn't load ${entry ? entry.name : 'that pool'}. Staying on ${activePoolDisplay().name}.`, 'error');
      return;
    }
    saveSettings();
    if(isHost && currentRoomCode){
      database.ref(`rooms/${currentRoomCode}/settings/poolId`).set(activePoolId);
    }
    closePoolModal();
  } finally {
    poolSwitchInFlight = false;
    // Re-render either way: on success to move the tick, on failure to
    // show that the selection stayed where it was (modal stays open so
    // the toast and the un-moved tick are seen together).
    renderAllPoolPickers();
  }
}

// Set from the room's participant listener so the waiting-room readiness
// check knows how many people the draft is actually for. Declared here
// rather than read from the multiplayer state directly, because the pool
// UI renders during page load, before that state exists.
let mpConnectedParticipants = 0;

/* ---------- Phase pools: percentile bands, not fixed rating windows ----------

   Each position's pool is split into one band per participant, and each
   phase draws from the next band down. This replaced a hardcoded table
   of rating windows (90-99, then 85-89, then 70-84, ...), which caused
   the two problems this system exists to fix:

     1. Repetition. A window like 92-99 held only ~22 players in the
        entire database, so the same elite names came up nearly every
        game, while the 70-89 window held 1,433 players who almost never
        appeared.

     2. Per-position scarcity. The windows were global, but the database
        is not evenly distributed by position: 92-99 contained 28
        wingers and ZERO right-backs. Every draft of 4+ participants was
        therefore guaranteed to miss on the phase-1 RB and quietly fall
        through to a fallback.

   A percentile band is defined relative to the players who actually
   exist for THAT position, so it can never be empty, it scales with how
   deep the position really is, and it is wide enough that the same
   player rarely reappears across games. */

// Which database positions a formation slot will accept. Comes from the
// active mode, since a slot code means different things per mode - 'ST'
// is a specific role in Classic, whereas 6v6's 'FWD' deliberately folds
// several roles together to make each slot's pool much deeper.
function positionMapFor(position){
  const map = activeMode().positionMap || {};
  return map[position] || [position];
}

// Small drafts fill far fewer slots overall, so there's no need to reach
// into the bottom of the database for them - holding 2-4 participant
// games to 80+ keeps every player on the stage someone recognisable.
// Larger drafts need the depth and keep the full pool.
// The floor now comes from the active pool's `draft` block rather than
// being a constant, because it only makes sense against a database deep
// enough to absorb it - see POOL_DRAFT_DEFAULTS, which keeps the
// original 80-and-up rule for any pool that doesn't say otherwise.
function poolMinRatingFor(numParticipants){
  const cfg = activePoolDraft();
  const floor = cfg.smallDraftMinRating;
  if(floor == null) return 0;
  return numParticipants <= (cfg.smallDraftMaxParticipants || 4) ? floor : 0;
}

// Every database player eligible for a formation slot, best first.
// Deliberately does NOT exclude already-drafted players: the band
// boundaries must stay fixed for the whole draft. Recomputing them
// against only the remaining players would make every band drift upward
// as the good players got taken, so the late phases would start serving
// elite players again - the exact opposite of the intent.
//
// Both modes cut small drafts down to a top-% slice rather than an
// absolute rating floor, so the same fraction of every role survives
// regardless of how deep the active pool happens to be at that role -
// see each mode's categoryTopPercent. They differ in what the % is
// judged against: Classic (topPercentPerBasePosition) cuts each
// underlying database position on its own before folding cover positions
// together, so a deep position like CM can't crowd out how many RB/RWB
// survive for the RB slot. 6v6 instead cuts the whole pooled line at
// once - that's the point of collapsing positions into lines there.
function getPositionPool(position, numParticipants){
  const accepted = positionMapFor(position);
  const mode = activeMode();
  const pctFn = mode.categoryTopPercent;
  const keep = pctFn ? pctFn(activePoolId, numParticipants, position) : null;

  if(keep == null){
    return playerDatabase
      .filter(p => accepted.includes(p.position))
      .sort((a, b) => b.rating - a.rating);
  }

  if(mode.topPercentPerBasePosition){
    const kept = [];
    accepted.forEach(rawPos => {
      const list = playerDatabase
        .filter(p => p.position === rawPos)
        .sort((a, b) => b.rating - a.rating);
      kept.push(...list.slice(0, Math.max(1, Math.ceil(list.length * keep))));
    });
    return kept.sort((a, b) => b.rating - a.rating);
  }

  const ranked = playerDatabase
    .filter(p => accepted.includes(p.position))
    .sort((a, b) => b.rating - a.rating);
  return ranked.slice(0, Math.max(1, Math.ceil(ranked.length * keep)));
}

/* A weighted pick from `list`, favoring higher-rated players without
   ever making a lower-rated one impossible - see SIXV6_RANDOM_BIAS_*  in
   js/modes/sixv6.js for why. Generic rather than 6v6-specific: `exponent`
   and `floor` come from the active mode (undefined -> pure uniform, the
   historical behavior), so this also works unmodified for any future
   mode that sets `selection: 'random'`.

   Each player's rating is normalized against the list's OWN min/max
   (not the whole database's), so the same exponent produces the same
   relative bias whether the eligible pool spans 60-98 or 80-99 - no
   pool-specific tuning needed, which is what keeps this working the
   same on every pool without being told which one is active. */
function weightedRandomPick(list, exponent, floor){
  if(list.length <= 1) return list[0];
  if(!exponent) return list[Math.floor(Math.random() * list.length)];

  const ratings = list.map(p => p.rating);
  const min = Math.min(...ratings), max = Math.max(...ratings);
  const span = max - min;
  const weights = list.map(p => {
    const norm = span > 0 ? (p.rating - min) / span : 1;
    return Math.pow(norm, exponent) + (floor || 0);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for(let i = 0; i < list.length; i++){
    r -= weights[i];
    if(r <= 0) return list[i];
  }
  return list[list.length - 1]; // floating-point safety net
}

// 6v6's selection rule: weighted rather than perfectly uniform (see
// weightedRandomPick), and deliberately still has no phase and no rank
// floor - an elite player can appear in the last round exactly as
// easily as the first, only now it is somewhat MORE likely to appear at
// all than a bottom-of-the-pool one, at every round.
function selectPlayerRandom(position, numParticipants){
  const pool = getPositionPool(position, numParticipants);
  const available = pool.filter(p => !usedPlayerIds.has(p.id));
  if(available.length === 0){
    return {
      name: 'Unknown Player ' + Math.floor(Math.random()*1000),
      rating: 70,
      position: position
    };
  }
  const mode = activeMode();
  const player = weightedRandomPick(available, mode.randomBiasExponent, mode.randomBiasFloor);
  usedPlayerIds.add(player.id);
  return player;
}

// Band `phaseIndex` out of `numParticipants` equally sized bands, best
// band first. With N participants each position is auctioned exactly N
// times (N-1 competitive rounds, then the final auto-assignment), so N
// bands maps one band onto each of those: phase 1 draws the top 1/N,
// and the auto-assignment draws the bottom 1/N.
function getPhaseBand(position, phaseIndex, numParticipants){
  const pool = getPositionPool(position, numParticipants);
  const bands = Math.max(1, numParticipants);
  const idx = Math.min(Math.max(0, phaseIndex), bands - 1);
  const start = Math.floor(pool.length * idx / bands);
  // The last band absorbs any rounding remainder, so no player is
  // orphaned between the end of band N-1 and the end of the pool.
  const end = (idx === bands - 1) ? pool.length : Math.floor(pool.length * (idx + 1) / bands);
  return {band: pool.slice(start, end), pool, start};
}

function selectPlayer(position, phaseIndex, numParticipants){
  const {band, pool, start} = getPhaseBand(position, phaseIndex, numParticipants);

  // Uniform across the WHOLE band, not weighted toward its top. The band
  // is already the quality control; skewing within it would narrow the
  // effective pool (reintroducing the repetition this replaced) and
  // would mean phase 1 really drew from the top 1/2N rather than 1/N.
  let available = band.filter(p => !usedPlayerIds.has(p.id));

  if(available.length === 0){
    // Band exhausted - possible with heavy rerolling on a shallow
    // position. Continue DOWN the pool first so quality keeps descending
    // along with the phases, instead of jumping back up to players an
    // earlier, stronger phase should have taken.
    available = pool.slice(start).filter(p => !usedPlayerIds.has(p.id));
  }
  if(available.length === 0){
    // Nothing left below the band either - accept anything still unused
    // for this position.
    available = pool.filter(p => !usedPlayerIds.has(p.id));
  }
  if(available.length === 0){
    // The database genuinely has nobody left for this position. Synthetic
    // last resort - `id` is intentionally absent, which is how callers
    // (maybeGenerateFlashPlayer) detect a non-real player.
    return {
      name: 'Unknown Player ' + Math.floor(Math.random()*1000),
      rating: Math.max(65, poolMinRatingFor(numParticipants)),
      position: position
    };
  }

  const player = available[Math.floor(Math.random() * available.length)];
  usedPlayerIds.add(player.id);
  return player;
}

/* ---------- Dynamic pool progression ----------

   selectPlayer()/getPhaseBand() above are UNCHANGED and still used by
   two callers that deliberately want the old fixed-quantile band
   regardless of what's actually been offered so far: the flash-player
   "surprise elite pick" (which explicitly wants a real phase-0 draw,
   not wherever this position's progress currently sits) and the AI's
   replacement-value estimate (a valuation heuristic, not a selection
   path - out of scope for this change).

   Every REAL round-to-round pick instead goes through the functions
   below, which replace "phase N always means exactly this fixed slice"
   with "the next player is always ranked below the last one shown for
   this position". A phase's percentile boundary is kept only as a
   MINIMUM depth guarantee (so a position that's had a run of very
   strong picks still gets appropriately weaker options as the draft
   goes on) - it no longer resets the pool back to the top of that
   slice if the previous pick already went deeper than it.

   `rankFloor` is the index (within getPositionPool's stable, full
   ordering - stable because that function deliberately never excludes
   drafted players) that the next pick for this position must start at.
   Callers own storing it between calls (positionRankFloor{} offline,
   gs.positionRankFloor online) - these functions are pure with respect
   to it, taking the old value in and handing the new one back out. */
function selectPlayerDynamic(position, phaseIndex, numParticipants, rankFloor){
  const pool = getPositionPool(position, numParticipants);
  const bands = Math.max(1, numParticipants);
  const idx = Math.min(Math.max(0, phaseIndex), bands - 1);
  // Same "guaranteed depth by this phase" formula as getPhaseBand's end,
  // so the minimum promise for phase N is exactly what it always was.
  const guaranteedEnd = (idx === bands - 1) ? pool.length : Math.floor(pool.length * (idx + 1) / bands);

  const start = Math.max(0, rankFloor || 0);
  // Only widens beyond the phase's own slice once the dynamic floor has
  // already passed it - a position still on its first few picks gets
  // exactly the old band shape.
  const end = Math.max(guaranteedEnd, start);

  let available = pool.slice(start, end).filter(p => !usedPlayerIds.has(p.id));
  if(available.length === 0){
    // Same descending fallback order as selectPlayer(): keep going DOWN
    // the pool before ever considering anything back above `start`.
    available = pool.slice(start).filter(p => !usedPlayerIds.has(p.id));
  }
  if(available.length === 0){
    available = pool.filter(p => !usedPlayerIds.has(p.id));
  }
  if(available.length === 0){
    return {
      player: {
        name: 'Unknown Player ' + Math.floor(Math.random()*1000),
        rating: Math.max(65, poolMinRatingFor(numParticipants)),
        position: position
      },
      rankFloor: start
    };
  }

  const player = available[Math.floor(Math.random() * available.length)];
  usedPlayerIds.add(player.id);
  const pickedIndex = pool.indexOf(player);
  // Math.max guards the one fallback tier that can legally return a
  // player above `start` (the final "anything still unused" tier, only
  // reached once nothing at all remains below the floor) - the floor
  // must never move backwards.
  return { player, rankFloor: Math.max(start, pickedIndex + 1) };
}

function generatePlayerForPositionDynamic(posIdx, phaseIndex, numParticipants, rankFloor){
  const pos = FORMATION[posIdx];
  const picked = selectPlayerDynamic(pos.code, phaseIndex, numParticipants, rankFloor);
  return {
    player: buildRoundPlayer(picked.player, pos, posIdx, phaseIndex),
    rankFloor: picked.rankFloor
  };
}

// The player object every round runs on, in the one shape the whole game
// (stage, bidding, squads, results, Firebase gameState) expects.
// startPrice comes from the active mode: Classic prices by rating,
// 6v6 opens everyone at 1M.
function buildRoundPlayer(realPlayer, pos, posIdx, phaseIndex){
  return {
    id: realPlayer.id, // retained so drafted-player exclusion can be rebuilt on reconnect
    name: realPlayer.name,
    pos: pos.code,
    /* What this player actually IS, as opposed to the slot they were
       bought to fill. `pos` above is the SLOT code and overwrites it, so
       without this the real position is lost the moment someone is
       drafted - which left the match simulation unable to tell a striker
       from a winger in 6v6 (both fill a 'FWD' slot), or to know that the
       CM in your CDM slot is not a natural holding midfielder.
       See simWeightsFor(). */
    basePos: realPlayer.position || pos.code,
    posIdx: posIdx,
    rating: realPlayer.rating,
    startPrice: modeStartPrice(realPlayer),
    phase: phaseIndex + 1,
    nationality: realPlayer.nationality || 'Unknown',
    club: realPlayer.club || 'Unknown'
  };
}

/* The single "who is on the stage next" entry point, used by BOTH the
   single-device engine (startRound) and the online host engine
   (mpHostAdvanceRound), so the two can never drift on selection rules.

   Classic keeps its progressive ladder untouched. 6v6 takes the random
   branch, which ignores phaseIndex and rankFloor entirely - it carries
   rankFloor straight through only so callers can store it back without
   special-casing the return shape. */
/* A replacement of comparable quality, for rerolling in a mode that
   draws at random (6v6).

   Rerolling there used to run selectPlayerDynamic - Classic's ladder,
   which walks DOWN the pool and is anchored to a rank floor. In a mode
   whose whole premise is that any rating can appear in any round, that
   made a reroll a punishment: reject a 78-rated forward and the ladder
   hands you progressively worse ones, and rejecting a 94 could drop you
   to a 70. A reroll should change WHO is offered, not what tier is on
   offer, so this picks from players within a rating band around the one
   being replaced, widening the band only if nothing is available. */
function selectPlayerSimilar(position, rating, numParticipants){
  const pool = getPositionPool(position, numParticipants)
    .filter(p => !usedPlayerIds.has(p.id));
  if(pool.length === 0){
    return {name: 'Unknown Player ' + Math.floor(Math.random()*1000), rating: rating || 70, position};
  }
  // Widen in steps rather than once, so a crowded band stays tight and a
  // sparse one still finds somebody.
  for(const band of [2, 4, 7, 11]){
    const near = pool.filter(p => Math.abs(p.rating - rating) <= band);
    if(near.length){
      const pick = near[Math.floor(Math.random() * near.length)];
      usedPlayerIds.add(pick.id);
      return pick;
    }
  }
  // Nothing close at all: the single nearest by rating beats a random one.
  const nearest = pool.reduce((best, p) =>
    Math.abs(p.rating - rating) < Math.abs(best.rating - rating) ? p : best, pool[0]);
  usedPlayerIds.add(nearest.id);
  return nearest;
}

// The reroll counterpart of generateRoundPlayer(): same mode-awareness,
// but anchored to the rating of the player being replaced.
function generateRerollPlayer(posIdx, phaseIndex, numParticipants, rankFloor, currentRating){
  if(activeMode().selection === 'random'){
    const pos = FORMATION[posIdx];
    const realPlayer = selectPlayerSimilar(pos.code, currentRating, numParticipants);
    return {
      player: buildRoundPlayer(realPlayer, pos, posIdx, phaseIndex),
      rankFloor: rankFloor || 0
    };
  }
  // Classic keeps the ladder: there, a reroll is explicitly meant to
  // continue the downward progression rather than reset it.
  return generatePlayerForPositionDynamic(posIdx, phaseIndex, numParticipants, rankFloor);
}

function generateRoundPlayer(posIdx, phaseIndex, numParticipants, rankFloor){
  if(activeMode().selection === 'random'){
    const pos = FORMATION[posIdx];
    const realPlayer = selectPlayerRandom(pos.code, numParticipants);
    return {
      player: buildRoundPlayer(realPlayer, pos, posIdx, phaseIndex),
      rankFloor: rankFloor || 0
    };
  }
  return generatePlayerForPositionDynamic(posIdx, phaseIndex, numParticipants, rankFloor);
}

function genPrice(rating){
  // Price based strictly on rating to ensure higher rated = higher price
  if(rating >= 94) return round5(70 + Math.random()*8); // 70-78M
  if(rating >= 92) return round5(65 + Math.random()*5); // 65-70M
  if(rating >= 90) return round5(60 + Math.random()*5); // 60-65M
  if(rating >= 88) return round5(55 + Math.random()*5); // 55-60M
  if(rating >= 86) return round5(50 + Math.random()*5); // 50-55M
  if(rating >= 84) return round5(45 + Math.random()*5); // 45-50M
  if(rating >= 82) return round5(40 + Math.random()*5); // 40-45M
  if(rating >= 80) return round5(35 + Math.random()*5); // 35-40M
  if(rating >= 78) return round5(30 + Math.random()*5); // 30-35M
  if(rating >= 75) return round5(28 + Math.random()*4); // 28-32M
  if(rating >= 72) return round5(25 + Math.random()*3); // 25-28M
  if(rating >= 70) return round5(22 + Math.random()*3); // 22-25M
  return MIN_PER_POSITION; // 20M last resort
}

/* Western digits in every language on purpose: prices sit next to
   ratings and squad numbers, and switching numeral systems for one of
   them only makes a squad list harder to read. The 'M' is a unit, not a
   word - see the note at the top of js/i18n.js.

   The THOUSANDS SEPARATOR does follow the language, and that is not a
   contradiction of the above. It was hard-coded to en-US, so a French,
   Spanish or Portuguese player saw a budget of "1,000M" - and in those
   languages a comma is the DECIMAL separator, so the largest number in the
   game read as one. Digits staying Western is about legibility next to
   ratings; the separator is about not saying the wrong number.

   `-u-nu-latn` keeps Arabic on Western digits while still giving it the
   right grouping, which is the whole point of separating the two decisions. */
function fmt(m){
  /* The whole lookup sits inside the try. i18n.js loads before this file so
     I18N_LANG is always initialised by the time a price is formatted, but a
     `let` read before its declaration throws even under typeof - and a
     reordered script tag should not be able to break every number in the
     game. */
  try {
    const lang = (typeof I18N_LANG === 'string' && I18N_LANG) ? I18N_LANG : 'en';
    return m.toLocaleString(lang + '-u-nu-latn', {maximumFractionDigits: 0}) + 'M';
  } catch(e){
    return m.toLocaleString('en-US') + 'M';
  }
}
function round5(n){ return Math.max(5, Math.round(n/5)*5); }

function pickRandom(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

// Deterministic mirror of genPrice()'s tiers (the midpoint of each tier's
// random range, with no randomness of its own). Used to judge whether an
// actual sale price was a bargain or a big spend relative to what a
// player of that rating "normally" costs - purely for ticker flavor and
// the results screen's Best Value / Biggest Gamble stats, never for
// actual pricing.
function expectedPriceForRating(rating){
  if(rating >= 94) return 74;
  if(rating >= 92) return 67.5;
  if(rating >= 90) return 62.5;
  if(rating >= 88) return 57.5;
  if(rating >= 86) return 52.5;
  if(rating >= 84) return 47.5;
  if(rating >= 82) return 42.5;
  if(rating >= 80) return 37.5;
  if(rating >= 78) return 32.5;
  if(rating >= 75) return 30;
  if(rating >= 72) return 26.5;
  if(rating >= 70) return 23.5;
  return MIN_PER_POSITION;
}

// Proportional (not flat) thresholds: a flat "M below expected" gap means
// wildly different things at a 20M price point vs a 74M one, so this
// compares price as a RATIO of the expected price instead. genPrice()'s
// own randomness never exceeds roughly ±10% of a tier's midpoint, so
// these bands only fire on genuinely notable events - forced-cheap
// fallback assignments, or a real bidding war driving the price up.
function saleFlavorSuffix(price, rating){
  if(rating == null) return '';
  const expected = expectedPriceForRating(rating);
  if(expected <= 0) return '';
  const ratio = price / expected;
  if(ratio <= 0.8) return ` <span style="color:var(--green)">— ${t('ticker.bargain')}</span>`;
  if(ratio >= 1.4) return ` <span style="color:var(--amber)">— ${t('ticker.bigSpend')}</span>`;
  return '';
}

// Ticker phrasings live in the locale files as a list per key, picked
// through tVariant(). Unlike the match commentary these are local-only
// (every client writes its own ticker, nothing about them is shared), so
// a plain random index is fine here.
function pickVariantIndex(key){
  return Math.floor(Math.random() * 1000);
}

// Builds the ticker line for any completed sale (competitive bid, auto
// assignment, or random assignment). `suffixLabel` keeps the existing
// " (auto)"/" (random)" tags; `rating` is optional and only adds the
// bargain/big-spend flavor when provided.
function buildSaleTickerHTML(name, pos, winner, price, suffixLabel, rating, isFlash){
  const flashPrefix = isFlash ? '⚡ ' : '';
  // Player and participant names are data and are interpolated as-is,
  // exactly as they were before - the <b> wrappers are part of the
  // template so a translator controls where the emphasis falls.
  const line = tVariant('ticker.sale', pickVariantIndex(), {
    name: esc(name), pos: esc(pos), winner: esc(winner), price: fmt(price)
  });
  return flashPrefix + line + (suffixLabel || '') + saleFlavorSuffix(price, rating);
}

function buildNoInterestTickerHTML(){
  return tVariant('ticker.noInterest', pickVariantIndex());
}

function buildRerolledTickerHTML(name){
  return tVariant('ticker.rerolled', pickVariantIndex(), {name: esc(name)});
}

// Shared player-generation helper used by both single-player and the
// multiplayer host engine, so "who gets drafted next" is computed by
// exactly one code path instead of being duplicated (and able to drift).
function generatePlayerForPosition(posIdx, phaseIndex, numParticipants){
  const pos = FORMATION[posIdx];
  const realPlayer = selectPlayer(pos.code, phaseIndex, numParticipants);
  return buildRoundPlayer(realPlayer, pos, posIdx, phaseIndex);
}

const FLASH_ROUND_CHANCE = 0.14; // roughly 1 in 7 eligible rounds
const FLASH_PRICE_PREMIUM = 1.35; // sought-after players cost a real premium

// "Scouting Report" - occasionally pulls a top-tier (Phase 0) player
// forward into a later, lower-phase round instead of the phase-
// appropriate one. Without this, the phase ladder is 100% predictable
// once you've played a few times (Phase N always means exactly this
// rating band) - this keeps a real elite name possible at any point.
// Never fires on Phase 0 itself (nothing to pull forward from), or on a
// round that's about to auto-assign rather than go to bidding (a
// surprise player is only exciting if people can actually compete for
// them). Never wastes a real player from the database: if the
// speculative Phase-0 draw comes back as the synthetic last-resort
// fallback (no `.id` - see selectPlayer()'s ultimate fallback), it's
// discarded and the caller falls through to the normal, phase-
// appropriate generatePlayerForPosition() call instead.
function maybeGenerateFlashPlayer(posIdx, positionPhase, numParticipants, eligibleCount){
  // Modes that already draw uniformly at random (6v6) have nothing to
  // pull an elite pick "forward" from - every round is a top-tier draw
  // already, so a flash pick would be a badge with no meaning behind it.
  if(!activeMode().flashPicks) return null;
  if(positionPhase <= 0 || eligibleCount <= 1) return null;
  if(Math.random() >= FLASH_ROUND_CHANCE) return null;
  const flashPlayer = generatePlayerForPosition(posIdx, 0, numParticipants);
  if(flashPlayer.id == null) return null;
  flashPlayer.isFlash = true;
  flashPlayer.startPrice = round5(flashPlayer.startPrice * FLASH_PRICE_PREMIUM);
  return flashPlayer;
}

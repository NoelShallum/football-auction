/* ================= CONFIG ================= */

// Analytics are intentionally disabled in the local edition.
function track(){ }

// The context every draft-related event carries, so funnels can be split
// by what people actually chose without repeating this at each call site.
function trackDraftContext(extra){
  return Object.assign({
    game_mode: GAME_MODE_ID,                     // classic | sixv6
    formation: selectedFormation,
    participants: (typeof participantCount === 'number' ? participantCount : null),
    pool: activePoolId,
  }, extra || {});
}
// FORMATIONS, FORMATION, selectedFormation, BUDGET, MIN_PER_POSITION and
// BID_STEP are all mode-derived and now live in js/modes/registry.js,
// which loads before this file and is their single writer (see
// applyGameMode there). Everything below is mode-independent.
let bidInputs = {}; // Store bid input values per participant
const DOT_COLORS = ['#FFB020','#3ECF6B','#5CA8FF','#FF7C7C','#C792FF','#FFD866','#6EE7D8','#FF9E5E','#9AE66E','#FF6FA6'];

// Player database - the players of whichever pool is currently active.
let playerDatabase = [];
let usedPlayerIds = new Set();
let positionPhaseTracking = {}; // Track which phase each position is in
// Dynamic pool progression's per-position floor - see selectPlayerDynamic().
// Reset everywhere positionPhaseTracking is reset.
let positionRankFloor = {};

// Shared by both engines: rerolls used to reset to this every ROUND
// (making the "3 remaining" counter meaningless - it never actually ran
// out over a whole draft). Now it's a single pool for the WHOLE draft,
// set once at the start and only ever decremented - so "Limited" mode
// gets a bigger number (5) than the old per-round allowance to still
// feel usable across a full draft, but it's now a real, scarce resource.
// Lives here rather than with the multiplayer code because setup.js
// calls it at LOAD time (to label the rerolls chips) - it has to be
// declared in a file that loads before that one.
function rerollPoolSize(mode){
  if(mode === 'unlimited') return 9999;
  if(mode === '3') return 5;
  return 0;
}

/* A hard ceiling on rerolls within ONE round, on top of the per-draft
   pool above - it applies even on Unlimited.

   Unlimited previously meant a round could be rerolled indefinitely,
   which is both a way to stall a shared screen forever and a way to
   quietly grind the pool for the one player a room wants. It also made
   the no-bids path unbounded: nobody bids, the round rerolls, nobody
   bids again, forever. Five is enough to escape a genuinely unwanted
   player and short enough that a round always ends. Resets at the start
   of every round (see startRound / mpHostAdvanceRound); once it is spent
   the button greys out and the no-bids path assigns at random instead. */
const MAX_REROLLS_PER_ROUND = 5;

// Rerolls left in THIS round, for whichever engine is asking - the
// per-draft pool and the per-round ceiling are both real limits and the
// smaller one governs.
function rerollsLeftThisRound(remainingInDraft, usedThisRound){
  return Math.max(0, Math.min(
    remainingInDraft == null ? 0 : remainingInDraft,
    MAX_REROLLS_PER_ROUND - (usedThisRound || 0)
  ));
}

/* ================= THE BLIND ROUND =================

   Exactly one round per draft is sealed-bid, and which one is picked at
   random when the draft starts. Both engines (single-player startRound()
   and the host's mpHostAdvanceRound()) count the same thing -
   biddingRoundsSoFar, the number of rounds that have actually reached the
   bidding stage - and share the three helpers below so the two can't
   drift on when it fires.

   How many rounds is that in total? Every round assigns exactly one slot,
   so a draft is always FORMATION.length x participants assignments. What
   varies is how many of those get BID on:

     - Classic auto-assigns a slot the moment only one participant still
       needs it. Each pass through the formation retires one participant's
       claim on every slot, so the final pass is entirely auto-assigned
       and never reaches bidding - hence (participants - 1) passes.
       state.totalPhases (the number of passes) is set from the same reasoning.
     - 6v6 has no auto-assignment (the last eligible participant simply
       wins unopposed), so every one of its assignments is a bid round.

   A consequence worth knowing rather than hiding: with 2 participants in
   Classic there is only ONE bidding pass, so the blind round can only
   land in phase 1. It spreads across more phases the more people play,
   which is the best that can be done without inventing bid rounds that
   the format doesn't have. */
function estimatedBiddingRounds(numParticipants){
  const n = Math.max(2, numParticipants || 2);
  const passes = activeMode().autoAssignLastEligible ? (n - 1) : n;
  return Math.max(1, FORMATION.length * passes);
}

function pickBlindRoundTarget(numParticipants){
  return 1 + Math.floor(Math.random() * estimatedBiddingRounds(numParticipants));
}

/* Is the round about to start the one that should be sealed-bid?

   `>=` rather than `===` on purpose: the estimate above is derived from
   how the formats behave rather than measured, so overshooting it must
   still fire rather than silently skipping the blind round for the whole
   draft. slotsRemaining is the belt-and-braces half of the same
   guarantee - if the draft is down to its last formation's worth of
   unfilled slots and the blind round STILL hasn't happened, take this
   round, which is known to be a bidding round because both callers only
   ask once they're past their auto-assign check. */
function shouldBlindRoundFireNow(used, biddingRoundsSoFar, target, slotsRemaining){
  if(used) return false;
  if(biddingRoundsSoFar >= (target || 1)) return true;
  return slotsRemaining != null && slotsRemaining <= FORMATION.length + 1;
}

// Unfilled slots across every participant, i.e. how many assignments the
// draft still has left to make. Shared so both engines measure it the
// same way (state.participants is kept in sync online too).
function slotsRemainingInDraft(){
  return (state.participants || []).reduce(
    (sum, p) => sum + Math.max(0, FORMATION.length - ((p.squad || []).length)), 0);
}

/* ================= NATIONALITY =================

   Flag emoji (the regional-indicator two-letter sequences, e.g. 🇫🇷) are
   NOT used anywhere in this file. They depend on the OS/browser having a
   flag glyph for that sequence - Windows in particular has no such glyph
   for most of its life, and instead prints the two bare letters the
   sequence is built from ("FR", "US", ...). That looked exactly like the
   abbreviation this feature exists to avoid, so nationality is shown as
   the plain country name, in full, and nothing else - no flag, no
   letter-code fallback, on any platform. */

// Dual-national entries in the database are written "Argentina/Spain";
// the first is the one they actually played for.
function primaryNationality(nationality){
  if(!nationality) return '';
  const name = String(nationality).split('/')[0].trim();
  return (!name || name.toLowerCase() === 'unknown') ? '' : name;
}

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The nationality chip on its own - just the full country name.
function nationalityHTML(nationality){
  const name = primaryNationality(nationality);
  return name ? `<span class="nat-name">${esc(name)}</span>` : '';
}

/* Nationality + club, the "who is this" line every player surface wants:
     Nationality • Club
   or, for the retired legends strongly associated with two clubs, the
   club HALF is already the pre-formatted "Club A / Club B" string (see
   players.json's curation) - this function never builds that pairing
   itself, it only concatenates whatever the data already says.

   Deliberately a single shared function so every surface (auction stage,
   live squads, results pitch, results player-info panel) reads the same
   way - "keep formatting consistent" was explicit. Returns plain escaped
   text with a middle-dot separator; the caller's own element supplies
   font-size/color, so this never wraps its output in its own span. */
function nationalityClubHTML(player){
  const nation = primaryNationality(player && player.nationality);
  const club = (player && player.club) ? String(player.club).trim() : '';
  const parts = [];
  if(nation) parts.push(esc(nation));
  if(club && club.toLowerCase() !== 'unknown') parts.push(esc(club));
  return parts.join(' <span class="nat-sep">•</span> ');
}

// Plain-text counterpart of playerNameHTML, for the handful of places
// that write to textContent.
function playerNameText(player){
  if(!player) return '';
  const name = primaryNationality(player && player.nationality);
  return (name ? name + ' ' : '') + (player.name || '');
}

/* The single component every "here is a player" surface renders through.
   opts:
     showRating - defaults to the SHOW_RATINGS setting
     nation     - set false to drop the nationality chip (the tight pitch
                  slot marker does, and the auction stage does - see
                  playerNationalityLineHTML, its own line below)
     surnameOnly- for the cramped pitch markers                        */
function playerNameHTML(player, opts){
  opts = opts || {};
  if(!player) return '—';
  const nation = opts.nation === false ? '' : nationalityHTML(player.nationality);
  const label = opts.surnameOnly ? String(player.name || '').split(' ').pop() : player.name;
  const wantRating = opts.showRating === undefined ? SHOW_RATINGS : opts.showRating;
  const rating = (wantRating && player.rating != null)
    ? `<span class="player-rating">${esc(player.rating)}</span>` : '';
  return `${nation}${esc(label)}${rating}`;
}

// The auction stage's own nationality (+ club) line (#playerNat, between
// the name and the starting price). Every offer-stage render sets this
// alongside playerNameHTML(player, {nation:false}), so this is the only
// place nationality appears for that player.
function playerNationalityLineHTML(player){
  return nationalityClubHTML(player);
}

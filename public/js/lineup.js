/* ================= LINEUPS: WHERE EVERYONE PLAYS =================

   The draft no longer hands out formation slots. Every manager just builds a
   squad (an XI in Classic, six in futsal), and a squad is legal as long as it
   can still be arranged into at least one allowed formation, with every player
   standing in a position he can play. Formations are decided afterwards and can
   be changed, and players can be moved between any positions they can cover.

   This file is the pure logic for that, with no DOM and no engine state beyond
   the active mode's formation tables:

     slotFit()            how well a player suits a slot: 0 = can't play there,
                          4 = his own position ... 1 = covers it from an alternate
     squadFits()          can these players still form a valid lineup?
     participantCanTake() the bidding rule: would this signing still fit?
     bestLineup()         the best way to place a squad in one formation
     bestFormation()      the best formation for a squad, among the allowed ones
     refreshLineup()      writes that onto a participant (formation + each slot)
     withFormation()      runs a renderer as if one manager's formation were active

   A player's positions come from js/players.js (primary first). A slot accepts
   a position directly or through the mode's cover rules (a CM covers CDM and CAM,
   a LB covers LWB, and so on - see positionMapFor()). */

// ---- Fit -------------------------------------------------------------

// The positions this player can play, primary first. Tolerates players built
// without a `positions` list (older saves, synthetic fallbacks).
function playerPositionList(player){
  if(!player) return [];
  if(Array.isArray(player.positions) && player.positions.length) return player.positions;
  const list = [player.basePos || player.position || player.pos];
  (player.secondaryPositions || []).forEach(c => { if(c && !list.includes(c)) list.push(c); });
  return list.filter(Boolean);
}

/* How well `player` suits a slot with this code.
     4  it is his own (primary) position
     3  he has played it (a listed alternate)
     2  his primary position covers it (a CM at CDM)
     1  an alternate covers it
     0  he cannot play there */
function slotFit(player, slotCode){
  const list = playerPositionList(player);
  if(!list.length) return 0;
  const accepted = positionMapFor(slotCode);
  const primary = list[0];
  if(primary === slotCode) return 4;
  for(let i = 1; i < list.length; i++) if(list[i] === slotCode) return 3;
  if(accepted.includes(primary)) return 2;
  for(let i = 1; i < list.length; i++) if(accepted.includes(list[i])) return 1;
  return 0;
}

function formationSlotsOf(key){ return FORMATIONS[key] || []; }

function fitMatrix(squad, formationKey){
  const slots = formationSlotsOf(formationKey);
  return squad.map(player => slots.map(slot => slotFit(player, slot.code)));
}

// ---- Feasibility -----------------------------------------------------

// Can every row be given its own column it fits? (augmenting-path matching)
function canMatchAll(fit, columns){
  const owner = new Array(columns).fill(-1);
  const place = (row, seen) => {
    for(let col = 0; col < columns; col++){
      if(fit[row][col] > 0 && !seen[col]){
        seen[col] = true;
        if(owner[col] < 0 || place(owner[col], seen)){ owner[col] = row; return true; }
      }
    }
    return false;
  };
  for(let row = 0; row < fit.length; row++) if(!place(row, [])) return false;
  return true;
}

// Could this squad be arranged into at least one of these formations, everyone
// in a position he can play? A complete squad that already is can take no one more.
function squadFits(squad, formationKeys){
  for(const key of formationKeys){
    const slots = formationSlotsOf(key);
    if(squad.length > slots.length) continue;
    if(canMatchAll(fitMatrix(squad, key), slots.length)) return true;
  }
  return false;
}

// The bidding rule. `player` may also be a stand-in {positions:[code]}.
function participantCanTake(participant, player){
  if(!participant || !player) return false;
  return squadFits((participant.squad || []).concat([player]), allowedFormationKeys());
}

// Does anybody still have room for a player of this position? Lets the engine
// skip a draw nobody could use instead of burning a player on it.
function anyoneCanUsePosition(participants, code){
  const standIn = { positions: [code] };
  return (participants || []).some(p => participantCanTake(p, standIn));
}

// The position a player is known by (his first listed one).
function playerPrimaryCode(player){ return playerPositionList(player)[0] || ''; }

// Every position code this manager could still take a player for: the slot
// codes of the allowed formations that a stand-in of that position would fit.
function usableCodes(participant){
  const codes = [];
  allowedFormationKeys().forEach(key => formationSlotsOf(key).forEach(slot => {
    if(!codes.includes(slot.code) && participantCanTake(participant, { positions: [slot.code] })) codes.push(slot.code);
  }));
  return codes;
}

/* Every engine's single way of adding a signing: pays, adds him to the squad and
   re-lays the lineup. The round player's draw token (posIdx) is overwritten by
   the slot he actually stands in. Returns the squad entry. */
function signPlayer(participant, player, price){
  participant.budget -= price;
  const entry = { ...player, price, newlyPlaced: true };
  participant.squad.push(entry);
  refreshLineup(participant);
  return entry;
}

// ---- Best lineup -----------------------------------------------------

/* The best way to place `squad` in one formation: as many players as possible
   in positions they can play first, then the best total fit (a player in his
   own position beats one covering it), with higher-rated players winning ties
   for a slot. Exact: a bitmask search over slots, tiny at 11 or fewer.
   Returns {formation, slots, placed, score, complete}: slots[i] is the squad
   index standing in slot i, or -1 when it is empty. */
const LINEUP_PLACEMENT_BONUS = 1000;

function bestLineup(squad, formationKey){
  const slots = formationSlotsOf(formationKey);
  const n = slots.length, k = squad.length;
  const fit = fitMatrix(squad, formationKey);
  const size = 1 << n;
  const NEG = -1e12;
  let prev = new Float64Array(size).fill(NEG);
  prev[0] = 0;
  const choice = [];
  for(let i = 0; i < k; i++){
    const next = new Float64Array(size).fill(NEG);
    const chose = new Int16Array(size).fill(-2);
    const rating = Number(squad[i].rating) || 0;
    for(let mask = 0; mask < size; mask++){
      const base = prev[mask];
      if(base <= NEG) continue;
      if(base > next[mask]){ next[mask] = base; chose[mask] = -1; }   // leave him out
      for(let j = 0; j < n; j++){
        if(mask & (1 << j) || fit[i][j] <= 0) continue;
        const m2 = mask | (1 << j);
        const value = base + LINEUP_PLACEMENT_BONUS + fit[i][j] * (1 + rating / 1000);
        if(value > next[m2]){ next[m2] = value; chose[m2] = j; }
      }
    }
    choice.push(chose);
    prev = next;
  }
  let bestMask = 0;
  for(let mask = 1; mask < size; mask++) if(prev[mask] > prev[bestMask]) bestMask = mask;
  const assigned = new Array(n).fill(-1);
  let mask = bestMask;
  for(let i = k - 1; i >= 0; i--){
    const j = choice[i][mask];
    if(j >= 0){ assigned[j] = i; mask ^= (1 << j); }
  }
  const placed = assigned.filter(x => x >= 0).length;
  return { formation: formationKey, slots: assigned, placed, score: prev[bestMask], complete: placed === k };
}

/* The best formation for this squad among `keys`. `preferred` wins a tie, so a
   lineup does not flip between equally good shapes as players are added. */
function bestFormation(squad, keys, preferred){
  let best = null;
  (keys || allowedFormationKeys()).forEach(key => {
    const lineup = bestLineup(squad, key);
    const beats = !best
      || lineup.placed > best.placed
      || (lineup.placed === best.placed && lineup.score > best.score + 1e-9)
      || (lineup.placed === best.placed && Math.abs(lineup.score - best.score) <= 1e-9 && key === preferred);
    if(beats) best = lineup;
  });
  return best;
}

/* Puts a participant's squad into its best formation: sets participant.formation,
   participant.positionsFilled (which slots are taken) and, on every squad entry,
   posIdx / pos (the slot and position code he stands in, in THAT formation). An
   entry that fits nowhere (only possible mid-edit) gets posIdx -1. */
function refreshLineup(participant, keys){
  const squad = participant.squad || [];
  const best = bestFormation(squad, keys || allowedFormationKeys(), participant.formation);
  if(!best) return null;
  applyLineupTo(participant, best.formation, best.slots);
  return best;
}

// Writes an explicit arrangement (used by the best-lineup above and by manual edits).
function applyLineupTo(participant, formationKey, slotsToSquadIndex){
  const slots = formationSlotsOf(formationKey);
  participant.formation = formationKey;
  participant.positionsFilled = new Set();
  const squad = participant.squad || [];
  squad.forEach(entry => { entry.posIdx = -1; });
  slotsToSquadIndex.forEach((squadIdx, slotIdx) => {
    if(squadIdx < 0 || !squad[squadIdx]) return;
    squad[squadIdx].posIdx = slotIdx;
    squad[squadIdx].pos = slots[slotIdx].code;
    participant.positionsFilled.add(slotIdx);
  });
  return participant;
}

/* Rebuilds a participant's lineup from where entries currently stand in
   `formationKey`, then re-validates it (used after an edit or a reload). */
function lineupSlotsOf(participant){
  const slots = formationSlotsOf(participant.formation);
  const out = new Array(slots.length).fill(-1);
  (participant.squad || []).forEach((entry, i) => {
    if(Number.isInteger(entry.posIdx) && entry.posIdx >= 0 && entry.posIdx < out.length) out[entry.posIdx] = i;
  });
  return out;
}

// Which slots of this participant's formation could this player stand in right now?
function slotsFor(participant, entry){
  return formationSlotsOf(participant.formation).map((slot, i) => (slotFit(entry, slot.code) > 0 ? i : -1)).filter(i => i >= 0);
}

/* Moves `entry` into slot `slotIdx` of the participant's formation. The player
   already standing there swaps into the mover's old slot when he can play it;
   otherwise the move is refused. Returns true when something changed. */
function moveToSlot(participant, entry, slotIdx){
  const formation = formationSlotsOf(participant.formation);
  if(slotIdx < 0 || slotIdx >= formation.length || slotFit(entry, formation[slotIdx].code) <= 0) return false;
  const squad = participant.squad || [];
  const from = entry.posIdx;
  if(from === slotIdx) return false;
  const occupant = squad.find(e => e !== entry && e.posIdx === slotIdx);
  if(occupant){
    // The occupant goes to the mover's old slot, or - if the mover came from the
    // bench-less nowhere (posIdx -1) - cannot be displaced.
    if(!(from >= 0 && from < formation.length) || slotFit(occupant, formation[from].code) <= 0) return false;
    occupant.posIdx = from; occupant.pos = formation[from].code;
  }
  entry.posIdx = slotIdx; entry.pos = formation[slotIdx].code;
  participant.positionsFilled = new Set(squad.filter(e => e.posIdx >= 0).map(e => e.posIdx));
  return true;
}

/* Switches a participant to another formation and lays the squad out in it as
   well as it can. Refused (false) when the squad cannot play in it at all. */
function changeFormation(participant, formationKey){
  if(!FORMATIONS[formationKey]) return false;
  const lineup = bestLineup(participant.squad || [], formationKey);
  if(!lineup.complete) return false;
  applyLineupTo(participant, formationKey, lineup.slots);
  return true;
}

/* A lineup as it travels between players online: the formation and, for each slot,
   the squad index standing in it (-1 empty). Everyone re-checks it on arrival, so
   a hand-made payload cannot put a player where he cannot play. */
function lineupPayload(participant){
  return { formation: participant.formation, slots: lineupSlotsOf(participant) };
}

function applyLineupPayload(participant, payload){
  if(!payload || !FORMATIONS[payload.formation] || !Array.isArray(payload.slots)) return false;
  const slots = formationSlotsOf(payload.formation);
  const squad = participant.squad || [];
  if(payload.slots.length !== slots.length) return false;
  const seen = new Set();
  for(const idx of payload.slots){
    if(!Number.isInteger(idx) || idx < -1 || idx >= squad.length) return false;
    if(idx >= 0){ if(seen.has(idx)) return false; seen.add(idx); }
  }
  if(seen.size !== squad.length) return false;   // everybody has to be placed
  if(!payload.slots.every((idx, slot) => idx < 0 || slotFit(squad[idx], slots[slot].code) > 0)) return false;
  applyLineupTo(participant, payload.formation, payload.slots);
  return true;
}

// ---- Per-manager formation ---------------------------------------------

/* Everything that draws or scores a squad reads the global FORMATION (slot
   names, pitch coordinates). Managers can now be in different formations, so a
   renderer runs inside this, which makes the manager's formation the active one
   for the duration and puts the previous one back after. */
function withFormation(key, fn){
  if(!key || !FORMATIONS[key] || key === selectedFormation) return fn();
  const previous = selectedFormation;
  applyFormation(key);
  try { return fn(); }
  finally { applyFormation(previous); }
}

// ---- Names -----------------------------------------------------------

const POSITION_LABELS = {
  GK: 'Goalkeeper', LB: 'Left Back', CB: 'Centre Back', RB: 'Right Back', LWB: 'Left Wing Back', RWB: 'Right Wing Back',
  CDM: 'Defensive Midfielder', CM: 'Central Midfielder', CAM: 'Attacking Midfielder', LM: 'Left Midfielder', RM: 'Right Midfielder',
  LW: 'Left Winger', RW: 'Right Winger', CF: 'Centre Forward', ST: 'Striker',
  DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward',
};
function positionLabel(code){ return POSITION_LABELS[code] || code; }

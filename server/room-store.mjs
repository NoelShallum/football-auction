import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const CODE = /^[A-Z2-9]{6}$/;
const UID = /^[A-Za-z0-9_-]{1,100}$/;
const FORMS = {
  classic: {
    '4-3-3': ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'RW', 'ST'],
    '4-2-3-1': ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LM', 'CAM', 'RM', 'ST'],
    '4-4-2': ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'],
    '3-4-3': ['GK', 'CB', 'CB', 'CB', 'LM', 'CM', 'CM', 'RM', 'LW', 'RW', 'ST'],
    '5-3-2': ['GK', 'LWB', 'CB', 'CB', 'CB', 'RWB', 'CM', 'CM', 'CM', 'ST', 'ST'],
  },
  sixv6: {
    '2-1-2': ['GK', 'DEF', 'DEF', 'MID', 'FWD', 'FWD'],
    '2-2-1': ['GK', 'DEF', 'DEF', 'MID', 'MID', 'FWD'],
    '1-2-2': ['GK', 'DEF', 'MID', 'MID', 'FWD', 'FWD'],
  },
};

export class RoomError extends Error {
  constructor(message, code = 'PERMISSION_DENIED') { super(message); this.code = code; }
}
const requireThat = (condition, message, code) => { if (!condition) throw new RoomError(message, code); };
const clone = value => value === undefined ? null : structuredClone(value);
const ownerKey = token => createHash('sha256').update(token).digest('hex');
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const blockKey = name => (String(name ?? '').trim().toLowerCase().replace(/[.#$\[\]/]/g, '_').slice(0, 100) || '_blank_');

function safeData(value, depth = 0) {
  requireThat(depth < 40, 'Data is too deeply nested.', 'INVALID_DATA');
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      requireThat(!FORBIDDEN.has(key), 'Invalid data key.', 'INVALID_DATA');
      safeData(value[key], depth + 1);
    }
  }
}
function pathParts(path) {
  requireThat(typeof path === 'string' && path.length < 500, 'Invalid path.', 'INVALID_PATH');
  const parts = path.split('/').filter(Boolean);
  requireThat(parts.every(p => !FORBIDDEN.has(p) && !/[.#$\[\]\\]/.test(p)), 'Invalid path.', 'INVALID_PATH');
  requireThat(parts[0] === 'rooms' && CODE.test(parts[1] || ''), 'A valid room code is required.', 'INVALID_PATH');
  return parts;
}
function readAt(data, parts) {
  let value = data;
  for (const key of parts) { if (value == null || typeof value !== 'object') return null; value = value[key]; }
  return value ?? null;
}
function writeAt(data, parts, value) {
  if (!parts.length) return clone(value);
  let cursor = data;
  for (const key of parts.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  if (value === null) delete cursor[parts.at(-1)];
  else cursor[parts.at(-1)] = clone(value);
  return data;
}
function validateSettings(settings) {
  requireThat(settings && FORMS[settings.gameMode]?.[settings.formation], 'Invalid game mode or formation.', 'INVALID_SETTINGS');
  requireThat(Number.isInteger(settings.maxParticipants) && settings.maxParticipants >= 2 && settings.maxParticipants <= 6, 'Rooms support 2–6 participants.', 'INVALID_SETTINGS');
  requireThat(Number.isFinite(settings.roundSeconds) && settings.roundSeconds >= 0 && settings.roundSeconds <= 3600, 'Invalid round timer.', 'INVALID_SETTINGS');
  requireThat(['disabled', '3', 'unlimited'].includes(settings.rerollsMode), 'Invalid reroll setting.', 'INVALID_SETTINGS');
  requireThat(['all_time', 'ea_database', 'current_players', 'world_cup_2026'].includes(settings.poolId), 'Player pool is unavailable.', 'INVALID_SETTINGS');
  // Optional ('any' = flexible, or the one formation the room is locked to).
  requireThat(settings.formationChoice == null || settings.formationChoice === 'any' || Boolean(FORMS[settings.gameMode]?.[settings.formationChoice]), 'Invalid formation choice.', 'INVALID_SETTINGS');
  // Both optional: rooms created before they existed omit them and draft as they always did.
  requireThat(settings.drawOrder == null || ['phase', 'random'].includes(settings.drawOrder), 'Invalid draw order.', 'INVALID_SETTINGS');
  const filters = settings.filters;
  if (filters != null) {
    const text = value => value == null || (typeof value === 'string' && value.length <= 80);
    requireThat(typeof filters === 'object' && !Array.isArray(filters)
      && (filters.era == null || ['all', 'present', 'legends'].includes(filters.era))
      && text(filters.league) && text(filters.nation)
      && (filters.minRating == null || [0, 75, 80, 85].includes(filters.minRating)), 'Invalid draft filters.', 'INVALID_SETTINGS');
  }
}
function validateParticipant(player, budget) {
  requireThat(player && typeof player.name === 'string' && player.name.trim().length > 0 && player.name.length <= 80, 'Name must contain 1–80 characters.', 'INVALID_PARTICIPANT');
  requireThat(player.budget === budget && Array.isArray(player.squad) && player.squad.length === 0 && Array.isArray(player.positionsFilled) && player.positionsFilled.length === 0, 'A new seat must have the starting budget and an empty squad.', 'INVALID_PARTICIPANT');
  requireThat(typeof player.color === 'string' && /^#[0-9a-f]{6}$/i.test(player.color), 'Invalid participant colour.', 'INVALID_PARTICIPANT');
}
function needsSlot(room, uid, posIdx) {
  const formation = FORMS[room.settings.gameMode][room.settings.formation];
  const player = room.participants[uid];
  if (!player || !Number.isInteger(posIdx) || !formation[posIdx]) return false;
  const filled = new Set(player.positionsFilled || []);
  if (room.settings.gameMode !== 'sixv6') return !filled.has(posIdx);
  return formation.some((code, index) => code === formation[posIdx] && !filled.has(index));
}
/* Who may bid on the player on the stage. The host decides (a manager can sign a
   player only if their squad can still be arranged into an allowed formation
   with him in it - see public/js/lineup.js) and publishes the answer as
   gameState.eligibleIds, which guests cannot rewrite: a bid has to leave every
   field but its own untouched. Rooms from before flexible lineups have no list
   and keep the original slot-ownership rule. */
function canBid(room, uid, gs = room.gameState) {
  if (Array.isArray(gs?.eligibleIds)) return Boolean(room.participants[uid]) && gs.eligibleIds.includes(uid);
  return needsSlot(room, uid, gs?.currentPlayer?.posIdx);
}
function validateLineup(room, uid, value) {
  const formation = FORMS[room.settings.gameMode][value?.formation];
  const squad = room.participants[uid]?.squad || [];
  requireThat(formation && Array.isArray(value.slots) && value.slots.length === formation.length, 'Invalid lineup.', 'INVALID_DATA');
  const placed = value.slots.filter(index => index !== -1);
  requireThat(value.slots.every(index => Number.isInteger(index) && index >= -1 && index < squad.length)
    && new Set(placed).size === placed.length && placed.length === squad.length, 'A lineup must place every player once.', 'INVALID_DATA');
}
function validateOpenRound(room, now) {
  const gs = room.gameState;
  requireThat(room.status === 'playing' && gs?.roundPhase === 'bidding' && !gs.paused && gs.currentPlayer, 'Bidding is closed.', 'INVALID_BID');
  if (gs.currentRoundSeconds > 0) requireThat(Number.isFinite(gs.roundEndsAt) && gs.roundEndsAt > now, 'The round deadline has passed.', 'INVALID_BID');
}
function validateOffer(room, uid, amount, sealed = false, now = Date.now()) {
  validateOpenRound(room, now);
  const gs = room.gameState;
  requireThat(Boolean(gs.isBlindRound) === sealed, 'Wrong bid type for this round.', 'INVALID_BID');
  requireThat(room.participants[uid]?.connected !== false && canBid(room, uid, gs), 'There is no room for this player in your squad.', 'INVALID_BID');
  const player = room.participants[uid];
  const isSix = room.settings.gameMode === 'sixv6';
  const reserve = isSix ? 1 : 20;
  const slots = isSix ? 6 : 11;
  const maximum = player.budget - reserve * Math.max(0, slots - (player.squad || []).length - 1);
  const minimum = sealed || !gs.currentBid ? gs.currentPlayer.startPrice : gs.currentBid + (isSix ? 1 : 5);
  requireThat(Number.isFinite(amount) && Number.isInteger(amount) && amount >= minimum && amount <= maximum, 'Bid is outside the allowed budget or increment.', 'INVALID_BID');
  requireThat(sealed || gs.currentLeader !== uid, 'You already lead this round.', 'INVALID_BID');
}

/** Stores the original room schema; ownership metadata never travels to clients. */
export class RoomStore extends EventEmitter {
  constructor({ dataFile = null, ttlMs = 86_400_000, now = Date.now } = {}) {
    super(); this.dataFile = dataFile; this.ttlMs = ttlMs; this.now = now;
    this.rooms = new Map(); this.saveTimer = null; this.saving = Promise.resolve();
  }
  async load() {
    if (!this.dataFile) return;
    let saved;
    try { saved = JSON.parse(await readFile(this.dataFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    requireThat(saved.schemaVersion === 1 && saved.rooms && typeof saved.rooms === 'object', 'Unsupported room snapshot.', 'INVALID_DATA');
    for (const [code, entry] of Object.entries(saved.rooms)) {
      if (!CODE.test(code) || this.now() - entry.updatedAt > this.ttlMs) continue;
      safeData(entry);
      for (const player of Object.values(entry.data.participants || {})) player.connected = false;
      this.rooms.set(code, entry);
    }
  }
  member(token, code) {
    const owners = this.rooms.get(code)?.owners || {};
    const hashed = ownerKey(token);
    return Object.keys(owners).find(uid => owners[uid] === hashed) || null;
  }
  claim(token, code, uid, name) {
    const entry = this.rooms.get(code);
    const player = entry?.data.participants?.[uid];
    requireThat(player, 'That seat no longer exists.', 'NOT_FOUND');
    if (entry.owners[uid] === ownerKey(token)) return;
    requireThat(player.connected === false && player.name.trim().toLowerCase() === String(name).trim().toLowerCase(), 'This seat is still connected or has a different name.');
    requireThat(!entry.data.blockedNames?.[blockKey(name)], 'This name is blocked.');
    entry.owners[uid] = ownerKey(token);
    this.scheduleSave();
  }
  read(path, limit) {
    const [, code, ...parts] = pathParts(path);
    const entry = this.rooms.get(code);
    let value = clone(readAt(entry?.data, parts));
    if (limit && value && typeof value === 'object' && !Array.isArray(value)) {
      value = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).slice(-Math.min(limit, 200)));
    }
    return { value, revision: entry?.revision || 0 };
  }
  subscribeAllowed(token, path) {
    const [, code] = pathParts(path);
    requireThat(this.member(token, code), 'Join the room before subscribing.');
    return code;
  }
  set(token, path, value, context = {}) { return this.update(token, '', { [path]: value }, context); }
  update(token, basePath, patch, context = {}) {
    requireThat(patch && typeof patch === 'object' && !Array.isArray(patch), 'Invalid update.', 'INVALID_DATA');
    safeData(patch);
    const writes = Object.entries(patch).map(([path, value]) => ({ parts: pathParts([basePath, path].filter(Boolean).join('/')), value }));
    requireThat(writes.length > 0 && writes.length <= 300, 'Invalid update size.', 'INVALID_DATA');
    const code = writes[0].parts[1];
    requireThat(writes.every(w => w.parts[1] === code), 'An atomic update must belong to one room.');
    for (let i = 0; i < writes.length; i++) for (let j = i + 1; j < writes.length; j++) {
      const a = writes[i].parts.join('/') + '/'; const b = writes[j].parts.join('/') + '/';
      requireThat(!a.startsWith(b) && !b.startsWith(a), 'Overlapping update paths.', 'INVALID_PATH');
    }
    let entry = this.rooms.get(code);
    if (!entry) {
      requireThat(writes.length === 1 && writes[0].parts.length === 2 && writes[0].value, 'Room does not exist.', 'NOT_FOUND');
      requireThat(this.rooms.size < 500, 'Room limit reached.', 'ROOM_LIMIT');
      const room = clone(writes[0].value);
      validateSettings(room.settings);
      requireThat(UID.test(room.hostId) && room.status === 'waiting' && Object.keys(room.participants || {}).length === 1 && room.participants[room.hostId], 'Invalid new room.', 'INVALID_ROOM');
      validateParticipant(room.participants[room.hostId], room.settings.gameMode === 'sixv6' ? 100 : 1000);
      entry = { data: room, owners: { [room.hostId]: ownerKey(token) }, revision: 0, updatedAt: this.now() };
      this.rooms.set(code, entry);
    } else {
      const uid = this.member(token, code);
      const host = uid && entry.data.hostId === uid;
      const joining = !uid && writes.length === 1 && writes[0].parts.length === 4 && writes[0].parts[2] === 'participants';
      let next = clone(entry.data);
      if (joining) {
        const joiningUid = writes[0].parts[3]; const player = writes[0].value;
        requireThat(UID.test(joiningUid) && !entry.data.participants[joiningUid], 'Seat already exists.');
        requireThat(entry.data.status === 'waiting', 'This draft has already started.');
        requireThat(Object.keys(entry.data.participants).length < entry.data.settings.maxParticipants, 'Room is full.', 'ROOM_FULL');
        requireThat(!entry.data.blockedNames?.[blockKey(player?.name)], 'This name is blocked.');
        validateParticipant(player, entry.data.settings.gameMode === 'sixv6' ? 100 : 1000);
        entry.owners[joiningUid] = ownerKey(token);
      } else {
        requireThat(uid, 'Join the room before changing it.');
        for (const write of writes) {
          const parts = write.parts.slice(2);
          this.authorizeWrite(entry.data, uid, host, parts, write.value, context);
          // The receipt time, rather than a supplied client clock, breaks
          // equal sealed offers in their actual server arrival order.
          if (parts.length === 3 && parts[0] === 'gameState' && parts[1] === 'sealedBids') write.value = { amount: write.value.amount, time: this.now() };
        }
      }
      for (const write of writes) next = writeAt(next, write.parts.slice(2), write.value);
      requireThat(next, 'Rooms expire automatically; direct room deletion is not supported.');
      validateSettings(next.settings);
      entry.data = next;
      // Deleted seats lose their ownership, including seats removed by the host.
      for (const oldUid of Object.keys(entry.owners)) if (!next.participants?.[oldUid]) delete entry.owners[oldUid];
    }
    this.changed(code, entry);
    return this.read(writes[0].parts.join('/'));
  }
  authorizeWrite(room, uid, host, parts, value, context) {
    if (parts[0] === 'gameState' && parts.length === 3 && ['sealedBids', 'goingVotes', 'rerollVotes'].includes(parts[1])) {
      requireThat(parts[2] === uid, 'A round action must belong to its sender.');
      const gs = room.gameState;
      requireThat(Number.isInteger(context?.roundId) && context.roundId === gs?.roundId && context.draftId === gs?.draftId, 'That round has already changed.', 'STALE_ROUND');
      validateOpenRound(room, this.now());
      requireThat(room.participants[uid]?.connected !== false, 'Reconnect before acting in this round.');
      if (parts[1] === 'sealedBids') { validateOffer(room, uid, value?.amount, true, this.now()); return; }
      requireThat(['goingVotes', 'rerollVotes'].includes(parts[1]) && value === true, 'Invalid vote.');
      requireThat(canBid(room, uid, gs) || (parts[1] === 'rerollVotes' && room.settings.gameMode === 'sixv6'), 'This seat is not in the electorate.');
      if (parts[1] === 'rerollVotes') requireThat(!gs.isBlindRound && !gs.currentLeader && gs.rerollsRemaining > 0 && (gs.roundRerolls || 0) < 5, 'Reroll is unavailable.');
      return;
    }
    if (host) return;
    if (parts[0] === 'participants' && parts[1] === uid && parts.length === 3 && parts[2] === 'lineup') {
      // A manager re-arranging their own finished squad: the same players, a different shape.
      requireThat(room.status === 'ended' && !room.simulation, 'Lineups are locked once the draft is not finished or a tournament has been played.');
      validateLineup(room, uid, value);
      return;
    }
    if (parts[0] === 'participants' && parts[1] === uid) {
      requireThat((parts.length === 2 && value === null) || (parts.length === 3 && ['ready', 'connected'].includes(parts[2]) && typeof value === 'boolean'), 'Only the host may edit squads and budgets.');
      return;
    }
    if (parts[0] === 'chat' && parts.length === 2) {
      requireThat(value && value.uid === uid && value.name === room.participants[uid].name && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 300, 'Invalid chat message.');
      return;
    }
    if (parts.length === 1 && ['status', 'endedReason'].includes(parts[0])) {
      requireThat(room.participants[room.hostId]?.connected === false && ((parts[0] === 'status' && value === 'ended') || (parts[0] === 'endedReason' && value === 'host_left')), 'Only the host may end a connected room.');
      return;
    }
    throw new RoomError('Only the host may change this room field.');
  }
  compareAndSet(token, path, revision, value) {
    safeData(value);
    const [, code, ...parts] = pathParts(path);
    const entry = this.rooms.get(code);
    const uid = this.member(token, code);
    requireThat(entry && uid, 'Join the room before bidding.');
    requireThat(parts.length === 1 && parts[0] === 'gameState', 'Transactions are restricted to bids.');
    if (entry.revision !== revision) return { conflict: true, ...this.read(path) };
    const gs = entry.data.gameState;
    validateOffer(entry.data, uid, value?.currentBid, false, this.now());
    requireThat(value.currentLeader === uid, 'A bid must belong to its sender.');
    const allowed = new Set(['currentBid', 'currentLeader', 'roundEndsAt', 'rerollVotes', 'goingVotes', 'goingGraceApplied']);
    for (const key of new Set([...Object.keys(gs), ...Object.keys(value)])) {
      requireThat(allowed.has(key) || equal(gs[key], value[key]), 'A bid cannot change the round or player.');
    }
    requireThat(equal(value.rerollVotes, {}) && value.goingGraceApplied === false, 'A bid must reset reroll votes and the pass grace period.');
    const expectedPasses = { ...(gs.goingVotes || {}) }; delete expectedPasses[uid];
    requireThat(equal(value.goingVotes || {}, expectedPasses), 'A bid can only clear its sender’s pass.');
    let deadline = gs.roundEndsAt;
    if (gs.currentRoundSeconds > 0 && gs.roundEndsAt) {
      const expectedDeadline = gs.roundEndsAt - this.now() < 10_000 ? this.now() + 10_000 : gs.roundEndsAt;
      requireThat(Number.isFinite(value.roundEndsAt) && Math.abs(value.roundEndsAt - expectedDeadline) <= 2500, 'Invalid anti-snipe deadline.');
      deadline = expectedDeadline;
    } else requireThat(value.roundEndsAt === gs.roundEndsAt, 'An untimed round must remain untimed.');
    entry.data.gameState = { ...clone(value), roundEndsAt: deadline };
    this.changed(code, entry);
    return { committed: true, ...this.read(path) };
  }
  disconnect(token, path, value) {
    const [, code, ...parts] = pathParts(path);
    const uid = this.member(token, code);
    requireThat(uid && parts.length === 3 && parts[0] === 'participants' && parts[1] === uid && parts[2] === 'connected' && value === false, 'Invalid presence instruction.');
    return this.set(token, path, false);
  }
  changed(code, entry) {
    entry.revision++; entry.updatedAt = this.now();
    const chat = entry.data.chat;
    if (chat) for (const key of Object.keys(chat).sort().slice(0, -200)) delete chat[key];
    this.scheduleSave(); this.emit('change', code);
  }
  expire() {
    for (const [code, entry] of this.rooms) if (this.now() - entry.updatedAt > this.ttlMs) {
      this.rooms.delete(code); this.emit('change', code); this.scheduleSave();
    }
  }
  scheduleSave() {
    if (!this.dataFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush().catch(error => this.emit('persistError', error)); }, 100);
    this.saveTimer.unref();
  }
  async flush() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    if (!this.dataFile) return;
    const payload = JSON.stringify({ schemaVersion: 1, rooms: Object.fromEntries(this.rooms) });
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.dataFile), { recursive: true });
      await writeFile(this.dataFile + '.tmp', payload, { mode: 0o600 });
      await rename(this.dataFile + '.tmp', this.dataFile);
    });
    await this.saving;
  }
}

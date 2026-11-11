/* ================= MULTIPLAYER FUNCTIONS ================= */
//
// Architecture note: rooms/{code}/gameState is the single authoritative
// source of truth for an in-progress auction. Only the host ever computes
// the NEXT gameState; every client - including the host itself - only
// ever *renders* whatever the Firebase listener delivers. There is no
// per-client game logic left that can compute its own idea of "what
// round/timer/bid are we on", which is what let clients drift apart
// before. See mpOnGameStateChange / mpRenderFromState below.

/* ---- storage, which is allowed to fail ----

   Session keys are a CONVENIENCE: they let a refresh rejoin the room you were
   already in. They are not required to play, and they must never be able to
   stop you playing.

   Browser storage can throw in private browsing and wherever site
   data is blocked, and these calls sit directly in the create-room and
   join-room paths - so an unguarded write turned a privacy setting into
   "cannot start or join a game at all". js/i18n.js already treats storage as
   best-effort (see I18N_STORAGE_KEY); this file was the outlier. */
// A room identity belongs to one tab. Preferences remain in localStorage,
// while sessionStorage preserves the seat/token together across a refresh.
function mpStoreSet(k, v){ try { sessionStorage.setItem(k, v); } catch(e){} }
function mpStoreGet(k){ try { return sessionStorage.getItem(k); } catch(e){ return null; } }
function mpStoreDel(k){ try { sessionStorage.removeItem(k); } catch(e){} }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// rerollPoolSize() lives in config.js - setup.js needs it at load time.

// Marks this participant as disconnected automatically if their tab
// closes, crashes, or loses network - without requiring "Leave Room".
// This is what makes host handoff and reconnection possible at all.
function mpArmPresence(){
  if(!currentRoomCode || !currentUserId) return;
  database.ref(`rooms/${currentRoomCode}/participants/${currentUserId}/connected`)
    .onDisconnect().set(false);
}

/* The starting budget a room is playing for, derived from the room's own
   game mode rather than from any one device's local settings.

   Every budget written to Firebase goes through this. A client's global
   BUDGET tracks whatever mode that client last applied, which is not
   reliably the room's mode at the moment of writing (a guest has not
   received the host's settings yet when it first joins), and using it
   directly is what let participants start a draft on different budgets. */
function mpRoomBudget(settings){
  const mode = gameModeById((settings && settings.gameMode) || DEFAULT_GAME_MODE_ID);
  return (mode || activeMode()).budget;
}

/* Presence, re-armed on every reconnect.

   onDisconnect() is a ONE-SHOT server-side instruction: it fires once and
   is then spent. Arming it a single time at join meant that any transient
   drop - a phone locking, a tab backgrounding, a lift, a wifi handover -
   had the server set connected:false, and nothing ever set it back when
   the socket came straight back up. The player was sitting on the waiting
   screen looking at their own name greyed out as "Disconnected", excluded
   from the ready count so the host could not start, with no way back
   except leaving and re-entering the room code. Worse, the handler was
   now spent, so a genuine close afterwards left them marked online
   forever.

   Firebase's own '.info/connected' is the supported way to do this: it
   flips to true on every (re)connection, which is exactly when the
   onDisconnect has to be re-armed and our own flag restored. */
let mpPresenceRef = null;
function mpWatchPresence(){
  if(!database) return;
  if(mpPresenceRef) return;               // one listener per page, not per room
  mpPresenceRef = database.ref('.info/connected');
  mpPresenceRef.on('value', (snap) => {
    if(snap.val() !== true) return;       // dropped; the server handles marking us off
    if(!currentRoomCode || !currentUserId) return;
    mpArmPresence();
    database.ref(`rooms/${currentRoomCode}/participants/${currentUserId}/connected`)
      .set(true).catch(() => {});
  });
}

// Non-blocking notification banner, used in place of alert() for
// room-lifecycle events and errors so one participant's message doesn't
// freeze every other participant's screen too.
let mpToastTimer = null;
function mpShowToast(message, tone, ms){
  const el = document.getElementById('mpToast');
  if(!el) return;
  el.textContent = message;
  el.className = 'mp-toast show' + (tone ? ' ' + tone : '');
  clearTimeout(mpToastTimer);
  mpToastTimer = setTimeout(() => { el.classList.remove('show'); }, ms || 4000);
}

// ---- Room chat ----
// One Firebase list (rooms/{code}/chat) rendered in full on every change,
// same pattern as every other multiplayer listener in this file - chat
// volume in a small party-game room is far too low to need child_added
// incremental rendering.
function mpRenderChatMessages(messagesObj){
  const body = document.getElementById('chatMessages');
  if(!body) return;
  const messages = Object.values(messagesObj || {}).sort((a, b) => a.ts - b.ts);

  if(messages.length === 0){
    body.innerHTML = '<div class="chat-msg-empty">No messages yet - say hi!</div>';
  } else {
    const wasNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.innerHTML = messages.map(m => `
      <div class="chat-msg${m.uid === currentUserId ? ' mine' : ''}">
        <span class="chat-msg-name">${esc(m.name)}</span><span class="chat-msg-text">${esc(m.text)}</span>
      </div>
    `).join('');
    if(wasNearBottom || chatOpen) body.scrollTop = body.scrollHeight;
  }

  if(!chatOpen){
    chatUnread = Math.max(0, messages.length - chatSeenCount);
    mpUpdateChatBadge();
  } else {
    chatSeenCount = messages.length;
  }
}

function mpUpdateChatBadge(){
  const badge = document.getElementById('chatUnreadBadge');
  if(!badge) return;
  if(chatUnread > 0){
    badge.textContent = chatUnread > 99 ? '99+' : String(chatUnread);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function mpToggleChatPanel(){
  chatOpen = !chatOpen;
  document.getElementById('chatPanel').classList.toggle('show', chatOpen);
  if(chatOpen){
    chatUnread = 0;
    mpUpdateChatBadge();
    const body = document.getElementById('chatMessages');
    if(body){
      body.scrollTop = body.scrollHeight;
      // Anything visible right now counts as seen, so a message that
      // arrives while the panel is still open doesn't wait for a close/
      // reopen cycle before it's tracked as read.
      chatSeenCount = body.querySelectorAll('.chat-msg').length;
    }
    document.getElementById('chatInput').focus();
  }
}

function mpSendChatMessage(){
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text || !currentRoomCode || !currentUserId) return;
  database.ref(`rooms/${currentRoomCode}/chat`).push({
    uid: currentUserId,
    name: currentUserName || 'Player',
    text: text.slice(0, 300),
    ts: Date.now()
  });
  input.value = '';
}

document.getElementById('chatToggleBtn').onclick = mpToggleChatPanel;
document.getElementById('chatCloseBtn').onclick = mpToggleChatPanel;
document.getElementById('chatSendBtn').onclick = mpSendChatMessage;
document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') mpSendChatMessage();
});

let mpLobbyActionInFlight = false;
async function createMultiplayerRoom() {
  if (mpLobbyActionInFlight) return;
  /* Online play is the one mode that genuinely needs the network. Ask in one
     place - mpAvailable() is false when the Firebase SDK never loaded - and
     say which modes still work, rather than throwing on database.ref(). */
  if(!mpAvailable()){ showLobbyError(t('mp.offline')); return; }
  mpLobbyActionInFlight = true;
  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');
  createBtn.disabled = true; joinBtn.disabled = true;
  createBtn.textContent = t('lobby.creatingRoom');

  const nameInput = document.getElementById('hostNameInput');
  currentUserName = nameInput.value.trim() || 'Host';
  currentUserId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  isHost = true;

  try {
    // Loop (rather than recurse) so a room-code collision retry can't
    // race with the busy-flag/button reset below.
    let code, roomRef, snapshot;
    do {
      code = generateRoomCode();
      roomRef = database.ref(`rooms/${code}`);
      snapshot = await roomRef.once('value');
    } while (snapshot.exists());
    currentRoomCode = code;

    await roomRef.set({
      hostId: currentUserId,
      status: 'waiting',
      createdAt: Date.now(),
      settings: {
        // Mode must travel alongside the formation: formation keys are
        // per-mode, and the mode also decides budget, bid increment and
        // squad size, all of which the host's round engine depends on.
        gameMode: GAME_MODE_ID,
        formation: selectedFormation,
        budget: BUDGET,
        roundSeconds: ROUND_SECONDS,
        showRatings: SHOW_RATINGS,
        rerollsMode: REROLLS_MODE,
        // How players are drawn and who can come up. Always the EFFECTIVE
        // draw order (never null): the host's mode default must not depend
        // on what a guest's own saved settings happen to say.
        drawOrder: effectiveDrawOrder(),
        filters: DRAFT_FILTERS,
        maxParticipants: MP_MAX_PARTICIPANTS,
        // Only the id travels. Guests resolve it against their own copy
        // of pools/index.json for branding, and never fetch the pool
        // file itself - the host is the only client that draws players
        // from a pool, and those players ride inside gameState.
        poolId: activePoolId
      },
      participants: {
        [currentUserId]: {
          name: currentUserName,
          color: DOT_COLORS[0],
          budget: BUDGET,
          squad: [],
          positionsFilled: [],
          connected: true,
          ready: true,
          joinedAt: Date.now()
        }
      }
    });

    mpArmPresence();
    mpWatchPresence();

    mpStoreSet('auctionXI_roomCode', currentRoomCode);
    mpStoreSet('auctionXI_userId', currentUserId);
    mpStoreSet('auctionXI_isHost', 'true');

    track('room_created', {game_mode: GAME_MODE_ID, formation: selectedFormation, pool: activePoolId});

    showWaitingRoom();
    setupMultiplayerListeners();

  } catch (error) {
    mpClearLocalSession(currentRoomCode);
    showScreen('lobbyScreen');
    showLobbyError(t('mp.createFailed', {error: error.message}));
  } finally {
    mpLobbyActionInFlight = false;
    createBtn.disabled = false; joinBtn.disabled = false;
    createBtn.textContent = t('lobby.createRoom');
  }
}

/* Take on the ROOM's settings, overriding whatever this device's own
   localStorage left behind from its last offline draft.

   Every path that enters a room needs this and getting it wrong is not
   cosmetic: FORMATION.length drives the host's round and completion
   logic, and the budget is written into participant records. Applying
   only SOME of these lines on SOME of the paths is exactly how guests
   once ended up drafting on a different budget from the host, so it
   lives in one function rather than being copied per entry point. */
function mpAdoptRoomSettings(settings){
  if(!settings) return;
  // Mode before formation: it decides which formation keys exist, and
  // the budget/bid increment/squad size the engine runs on.
  applyGameMode(settings.gameMode || DEFAULT_GAME_MODE_ID, settings.formation);
  ROUND_SECONDS = settings.roundSeconds != null ? settings.roundSeconds : 30;
  RESET_SECONDS = ROUND_SECONDS === 0 ? 0 : Math.max(4, Math.round(ROUND_SECONDS * 0.4));
  SHOW_RATINGS = settings.showRatings || false;
  REROLLS_MODE = settings.rerollsMode || '3';
  // Rooms created before these existed have neither: the mode's own draw
  // order and no filters, which is exactly how those rooms were drafting.
  setDrawOrder(settings.drawOrder);
  setDraftFilters(settings.filters);
  MP_MAX_PARTICIPANTS = settings.maxParticipants || MP_MAX_PLAYERS;
}

/* The seat a lost connection left behind, if this name has one.

   leaveRoom() REMOVES a participant who deliberately leaves, while a
   dropped connection only flips `connected` to false and leaves their
   squad, budget and colour untouched. So a disconnected node is exactly
   "somebody who fell out and has not come back" - and reclaiming it is
   the only way home for a player whose stored session is gone: cleared
   storage, a different device, or a phone that killed the tab.

   Matched on NAME because there is no account system, the same reason
   the block list is keyed by name. A seat whose owner is currently
   CONNECTED is never offered - that is a different person using the
   same name, or the same person in another tab, and taking their seat
   would drop them out of their own draft. */
function mpFindReclaimableSeat(participants, name){
  const key = normalizeBlockKey(name);
  const hit = Object.entries(participants || {})
    .find(([, p]) => p && p.connected === false && normalizeBlockKey(p.name) === key);
  return hit ? {uid: hit[0], data: hit[1]} : null;
}

async function joinMultiplayerRoom() {
  if (mpLobbyActionInFlight) return;
  /* Online play is the one mode that genuinely needs the network. Ask in one
     place - mpAvailable() is false when the Firebase SDK never loaded - and
     say which modes still work, rather than throwing on database.ref(). */
  if(!mpAvailable()){ showLobbyError(t('mp.offline')); return; }

  const codeInput = document.getElementById('joinRoomCode');
  const nameInput = document.getElementById('joinNameInput');

  const roomCode = codeInput.value.trim().toUpperCase();
  currentUserName = nameInput.value.trim() || 'Player';

  if (roomCode.length !== 6) {
    showLobbyError(t('mp.invalidCode'));
    return;
  }

  mpLobbyActionInFlight = true;
  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');
  createBtn.disabled = true; joinBtn.disabled = true;
  joinBtn.textContent = t('lobby.joiningRoom');

  try {
    const roomRef = database.ref(`rooms/${roomCode}`);
    const snapshot = await roomRef.once('value');

    if (!snapshot.exists()) {
      showLobbyError(t('mp.roomNotFound'));
      return;
    }

    const roomData = snapshot.val();

    // Blocked by name, not by session id - a kicked-and-blocked player
    // gets a fresh random currentUserId on every join attempt (there's
    // no account system to key off), so the name they type in is the
    // only stable thing to check against what the host blocked.
    const blockedNames = roomData.blockedNames || {};
    if (blockedNames[normalizeBlockKey(currentUserName)]) {
      showLobbyError(t('mp.blocked'));
      return;
    }

    const participantCount = Object.keys(roomData.participants || {}).length;

    const maxParticipants = (roomData.settings && roomData.settings.maxParticipants) || MP_MAX_PLAYERS;

    // Is this somebody coming back to a seat they dropped out of?
    const reclaim = mpFindReclaimableSeat(roomData.participants, currentUserName);

    if (roomData.status === 'ended') {
      // Nothing to come back to, reclaimable seat or not.
      showLobbyError(t('mp.alreadyStarted'));
      return;
    }

    if (!reclaim) {
      // A reclaim takes a seat that is already counted, so neither of
      // these applies to one - the room is not gaining a participant.
      if (participantCount >= maxParticipants) {
        showLobbyError(t('mp.roomFull'));
        return;
      }
      if (roomData.status === 'playing') {
        // Says how to get back in, because the commonest way to see this
        // is a player who dropped and is trying to return.
        showLobbyError(t('mp.alreadyStartedRejoin'));
        return;
      }
    }

    currentRoomCode = roomCode;
    /* Reclaiming keeps the ORIGINAL id, which is the whole point. Every
       reference the draft holds - the current leader, pass votes, sealed
       bids, per-position rank floors, the squad itself - is keyed by
       participant id, so coming back under a fresh one would leave all
       of it stranded on a seat nobody occupies. */
    currentUserId = reclaim
      ? reclaim.uid
      : ('user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
    isHost = !!reclaim && roomData.hostId === currentUserId;

    /* Adopt the ROOM's settings before writing anything, so a device
       whose last offline draft was 6v6 cannot write an 11v11 room a
       100M budget. Full settings, not just the mode: for a reclaiming
       HOST the live settings listener never fires (it deliberately
       skips hosts so it cannot fight them editing the lobby), so this
       is their only chance to pick the room's real values up. */
    mpAdoptRoomSettings(roomData.settings);

    if (reclaim) {
      await database.claim(currentRoomCode, currentUserId, currentUserName);
      // Only the connection flag. Squad, budget, colour, ready state and
      // filled positions all belong to the draft already in progress and
      // have to survive exactly as they were.
      await database.ref(`rooms/${currentRoomCode}/participants/${currentUserId}/connected`).set(true);
    } else {
      await database.ref(`rooms/${currentRoomCode}/participants/${currentUserId}`).set({
        name: currentUserName,
        color: DOT_COLORS[participantCount % DOT_COLORS.length],
        budget: mpRoomBudget(roomData.settings),
        squad: [],
        positionsFilled: [],
        connected: true,
        ready: false,
        joinedAt: Date.now()
      });
    }

    mpArmPresence();
    mpWatchPresence();

    mpStoreSet('auctionXI_roomCode', currentRoomCode);
    mpStoreSet('auctionXI_userId', currentUserId);
    mpStoreSet('auctionXI_isHost', isHost ? 'true' : 'false');

    track(reclaim ? 'room_rejoined' : 'room_joined', {game_mode: GAME_MODE_ID});

    /* Straight back onto the stage if the draft is already running.
       Called before the listeners' own status callback can fire (Firebase
       delivers those asynchronously), so this wins the race and the
       listener then sees state.auctioning already true and stands down -
       the same ordering mpTryReconnect() relies on. */
    setupMultiplayerListeners();
    if (roomData.status === 'playing') {
      startMultiplayerAuction();
      mpShowToast(t('mp.reclaimed'), 'success');
    } else {
      showWaitingRoom();
      if (reclaim) mpShowToast(t('mp.reclaimed'), 'success');
    }

  } catch (error) {
    mpClearLocalSession(currentRoomCode);
    showScreen('lobbyScreen');
    showLobbyError(t('mp.joinFailed', {error: error.message}));
  } finally {
    mpLobbyActionInFlight = false;
    createBtn.disabled = false; joinBtn.disabled = false;
    joinBtn.textContent = t('lobby.joinRoom');
  }
}

function showWaitingRoom() {
  document.getElementById('lobbyScreen').style.display = 'none';
  document.getElementById('waitingScreen').style.display = 'block';
  document.getElementById('displayRoomCode').textContent = currentRoomCode;

  /* Every host-only control is set on BOTH branches, explicitly.

     The guest branch used to only show the Ready button and hide Start,
     and never touched #hostSettings - which is fine on a fresh page load
     (it starts hidden in the markup) but not once anything has shown it.
     Host a room, leave it, then join somebody else's as a guest, and the
     settings panel was still on screen and still editable, because
     nothing in the guest path ever put it back. Same for a host who
     hands over by leaving and rejoining. That is why it only happened
     "sometimes": it depended entirely on what this browser tab had been
     earlier in its life. */
  const hostOnly = isHost;
  document.getElementById('hostSettings').style.display = hostOnly ? 'block' : 'none';
  document.getElementById('hostStartBtn').style.display = hostOnly ? 'block' : 'none';
  document.getElementById('playerReadyBtn').style.display = hostOnly ? 'none' : 'block';

  if (hostOnly) {
    renderWaitingRoomSettings();
  } else {
    // Guests get no picker, but they do get the banner, so they can see
    // which pool the host has chosen before agreeing to be ready.
    renderAllPoolPickers();
  }
  // Ready state itself is set once at join/creation time (see
  // createMultiplayerRoom/joinMultiplayerRoom) and never reset here, so
  // reconnecting or re-rendering the waiting room can't clobber it.
}

function toggleReady() {
  database.ref(`rooms/${currentRoomCode}/participants/${currentUserId}/ready`).once('value', (snapshot) => {
    const currentReady = snapshot.val() || false;
    database.ref(`rooms/${currentRoomCode}/participants/${currentUserId}/ready`).set(!currentReady);
  });
}

function flashCopyButtonCopied(){
  const btn = document.getElementById('copyRoomBtn');
  if (!btn) return;
  const original = btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.innerHTML = original;
  }, 1500);
}

function copyRoomCode() {
  const roomCode = currentRoomCode;
  navigator.clipboard.writeText(roomCode).then(() => {
    flashCopyButtonCopied();
  }).catch(() => {
    // Fallback for older browsers
    const tempInput = document.createElement('input');
    tempInput.value = roomCode;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    document.body.removeChild(tempInput);
    flashCopyButtonCopied();
  });
}

// Pastes a room code from the clipboard into the join-room input.
// Pulls out just the 6-character code (using the same charset
// generateRoomCode() draws from) so pasting a whole "join me, code is
// XYZ123!" message still works instead of only a bare code.
function pasteRoomCode(){
  if(!navigator.clipboard || !navigator.clipboard.readText){
    mpShowToast(t('mp.noClipboard'), 'error');
    return;
  }
  navigator.clipboard.readText().then((text) => {
    const codeInput = document.getElementById('joinRoomCode');
    const match = (text || '').toUpperCase().match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}/);
    codeInput.value = match ? match[0] : (text || '').trim().toUpperCase().slice(0, 6);
    codeInput.focus();
  }).catch(() => {
    mpShowToast(t('mp.clipboardFailed'), 'error');
  });
}
document.getElementById('pasteRoomCodeBtn').onclick = pasteRoomCode;

function showLobbyError(message) {
  const errorDiv = document.getElementById('lobbyError');
  errorDiv.textContent = message;
  errorDiv.style.display = 'block';
  setTimeout(() => {
    errorDiv.style.display = 'none';
  }, 5000);
}

function renderWaitingRoomSettings() {
  // Max participants chips - host-only, caps how many can join. Lowering
  // it never removes anyone already in the room; it only blocks new
  // joins past the new cap (see joinMultiplayerRoom).
  const maxRow = document.getElementById('waitingMaxParticipantsRow');
  maxRow.innerHTML = '';
  [2, 3, 4, 5, 6].forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'chip-btn' + (n === MP_MAX_PARTICIPANTS ? ' active' : '');
    btn.textContent = String(n);
    btn.onclick = () => {
      MP_MAX_PARTICIPANTS = n;
      renderWaitingRoomSettings();
      database.ref(`rooms/${currentRoomCode}/settings/maxParticipants`).set(MP_MAX_PARTICIPANTS);
      updateWaitingPlayersList(mpParticipantsSnapshot);
    };
    maxRow.appendChild(btn);
  });

  // Pool picker + banner (the picker itself is host-only; see POOL_MOUNTS)
  renderAllPoolPickers();

  // Game mode chips. Switching mode replaces the whole formation table,
  // so the formation is pushed to Firebase in the same update - sending
  // only the mode would leave guests briefly holding a formation key that
  // doesn't exist in it.
  // The same mode cards the offline setup screen shows (see
  // buildGameModeCards in setup.js) rather than a second, thinner
  // description of the same choice that could drift from it.
  buildGameModeCards(document.getElementById('waitingGameModeRow'), () => {
    renderWaitingRoomSettings(); // also refreshes the pool depth warning
    const updates = {
      [`rooms/${currentRoomCode}/settings/gameMode`]: GAME_MODE_ID,
      [`rooms/${currentRoomCode}/settings/formation`]: selectedFormation,
      [`rooms/${currentRoomCode}/settings/budget`]: BUDGET,
    };
    // Switching mode changes what a squad costs, so everyone already in
    // the room is moved onto the new budget in the same write - otherwise
    // people who joined before the switch sit on the old mode's number.
    Object.keys(mpParticipantsSnapshot || {}).forEach(uid => {
      updates[`rooms/${currentRoomCode}/participants/${uid}/budget`] = BUDGET;
    });
    database.ref().update(updates);
  });

  // Formation chips
  const formRow = document.getElementById('waitingFormationRow');
  formRow.innerHTML = '';
  Object.keys(FORMATIONS).forEach(formKey => {
    const btn = document.createElement('button');
    btn.className = 'chip-btn' + (formKey === selectedFormation ? ' active' : '');
    btn.textContent = formKey;
    btn.onclick = () => {
      applyFormation(formKey);
      renderWaitingRoomSettings(); // also refreshes the pool depth warning
      database.ref(`rooms/${currentRoomCode}/settings/formation`).set(selectedFormation);
    };
    formRow.appendChild(btn);
  });

  // Timer chips (matching offline mode exactly)
  const timerRow = document.getElementById('waitingTimerRow');
  timerRow.innerHTML = '';
  [10, 30, 60, 300, 0, 'custom'].forEach(sec => {
    const btn = document.createElement('button');
    let label;
    if(sec === 0) label = 'Unlimited';
    else if(sec === 'custom') label = 'Custom';
    else if(sec === 60) label = '1 min';
    else if(sec === 300) label = '5 mins';
    else label = sec + 's';
    const isActive = sec === 'custom' ? ROUND_SECONDS === -1 : sec === ROUND_SECONDS;
    btn.className = 'chip-btn' + (isActive ? ' active' : '');
    btn.textContent = label;
    btn.onclick = () => {
      if (sec === 'custom') {
        ROUND_SECONDS = -1;
        document.getElementById('waitingCustomTimerSection').style.display = 'block';
        document.getElementById('waitingCustomTimerInput').focus();
      } else {
        document.getElementById('waitingCustomTimerSection').style.display = 'none';
        ROUND_SECONDS = sec;
        RESET_SECONDS = Math.max(4, Math.round(sec * 0.4));
        database.ref(`rooms/${currentRoomCode}/settings/roundSeconds`).set(ROUND_SECONDS);
      }
      renderWaitingRoomSettings();
    };
    timerRow.appendChild(btn);
  });

  // Custom timer input handler (matching offline mode)
  const customTimerInput = document.getElementById('waitingCustomTimerInput');
  customTimerInput.value = ROUND_SECONDS > 300 ? Math.floor(ROUND_SECONDS / 60) : '';

  // Show/hide custom timer section based on selection
  document.getElementById('waitingCustomTimerSection').style.display = ROUND_SECONDS === -1 ? 'block' : 'none';

  customTimerInput.oninput = () => {
    const minutes = parseInt(customTimerInput.value) || 0;
    if (minutes >= 1 && minutes <= 60) {
      ROUND_SECONDS = minutes * 60;
      RESET_SECONDS = Math.max(4, Math.round(ROUND_SECONDS * 0.4));
      database.ref(`rooms/${currentRoomCode}/settings/roundSeconds`).set(ROUND_SECONDS);
    }
  };

  // Rating toggle
  const ratingToggle = document.getElementById('waitingRatingToggle');
  ratingToggle.classList.toggle('on', SHOW_RATINGS);
  ratingToggle.onclick = () => {
    SHOW_RATINGS = !SHOW_RATINGS;
    ratingToggle.classList.toggle('on', SHOW_RATINGS);
    database.ref(`rooms/${currentRoomCode}/settings/showRatings`).set(SHOW_RATINGS);
  };

  // Rerolls chips
  const rerollsRow = document.getElementById('waitingRerollsRow');
  rerollsRow.innerHTML = '';
  ['disabled', '3', 'unlimited'].forEach(mode => {
    const btn = document.createElement('button');
    btn.className = 'chip-btn' + (mode === REROLLS_MODE ? ' active' : '');
    btn.textContent = mode === 'disabled' ? 'Disabled' : mode === '3' ? `Limited (${rerollPoolSize('3')})` : 'Unlimited';
    btn.onclick = () => {
      REROLLS_MODE = mode;
      renderWaitingRoomSettings();
      database.ref(`rooms/${currentRoomCode}/settings/rerollsMode`).set(REROLLS_MODE);
    };
    rerollsRow.appendChild(btn);
  });
}

let mpParticipantsSnapshot = {};

// Every path setupMultiplayerListeners() subscribes to. Firebase's
// ref.off() only removes callbacks registered at that EXACT path - it
// does not touch listeners on child paths - so leaving a room has to
// detach each one explicitly. Detaching only the room root (as before)
// left the old room's participants/status/gameState listeners live,
// and they kept overwriting state after the client joined a different
// room: that is what made re-joining impossible after leaving or being
// disconnected.
const MP_LISTENER_PATHS = ['hostId', 'participants', 'status', 'settings', 'gameState', 'simulation', 'chat'];

function detachMultiplayerListeners(code){
  if (code) {
    MP_LISTENER_PATHS.forEach(path => database.ref(`rooms/${code}/${path}`).off());
    database.ref(`rooms/${code}`).off();
  }
  firebaseListenersActive = false;
}

function setupMultiplayerListeners() {
  if (firebaseListenersActive) return;
  firebaseListenersActive = true;

  document.getElementById('chatToggleBtn').classList.add('visible');
  database.ref(`rooms/${currentRoomCode}/chat`).limitToLast(CHAT_MAX_MESSAGES).on('value', (snapshot) => {
    mpRenderChatMessages(snapshot.val());
  });

  // hostId is set once at room creation and never changes hands anymore
  // (see item 8: if the host leaves, the room ends - it is not handed
  // off). This listener just tells each client whether IT is the host,
  // including on the very first attach and on reconnect.
  database.ref(`rooms/${currentRoomCode}/hostId`).on('value', (snapshot) => {
    mpKnownHostId = snapshot.val();
    const iAmHost = mpKnownHostId === currentUserId;
    const wasHost = isHost;
    if (iAmHost && !isHost) {
      isHost = true;
      mpStoreSet('auctionXI_isHost', 'true');
      if (mpGameState && mpGameState.roundPhase === 'bidding' && !mpGameState.paused) {
        mpScheduleHostRoundTimer(mpGameState.roundEndsAt);
      }
    } else if (!iAmHost) {
      isHost = false;
      clearTimeout(mpHostTimerHandle);
    }
    /* This listener is what makes isHost authoritative, and it can land
       AFTER the waiting room has already been drawn. Redraw it when the
       answer actually changed, or the room keeps whichever set of
       controls it happened to be built with. */
    if (isHost !== wasHost &&
        document.getElementById('waitingScreen').style.display === 'block') {
      showWaitingRoom();
    }
  });

  // Listen for participants - this is the only place state.participants
  // (budgets/squads/positions) ever gets written from, in multiplayer.
  database.ref(`rooms/${currentRoomCode}/participants`).on('value', (snapshot) => {
    const participants = snapshot.val() || {};

    // If our own entry has vanished while the room itself (and other
    // participants) still exist, the host removed us specifically - a
    // self-initiated leaveRoom() never reaches this callback, since it
    // detaches this very listener in the same tick it removes our node.
    if(!isHost && currentUserId && !participants[currentUserId]){
      mpShowToast(t('mp.removed'), 'error');
      leaveRoom();
      return;
    }

    mpParticipantsSnapshot = participants;
    // Feeds the waiting room's pool-depth warning, which has to be
    // judged against the number of people actually in the room.
    const connectedNow = Object.values(participants).filter(p => p.connected !== false).length;
    if(connectedNow !== mpConnectedParticipants){
      mpConnectedParticipants = connectedNow;
      renderAllPoolPickers();
    }
    updateWaitingPlayersList(participants);

    state.participants = Object.entries(participants).map(([uid, data]) => ({
      id: uid,
      name: data.name,
      color: data.color,
      connected: data.connected !== false,
      budget: data.budget != null ? data.budget : BUDGET,
      squad: data.squad || [],
      positionsFilled: new Set(data.positionsFilled || [])
    }));

    if (mpGameState) {
      mpRenderFromState();
    }

    // If the host disconnected without cleanly leaving (crash, closed
    // tab), someone still connected has to notice and close the room -
    // there's no server-side code to do it for us. Exactly one
    // "steward" (the earliest-joined connected non-host participant)
    // takes on that job, so multiple clients don't race to do it.
    mpWatchHostPresence(participants);

    // If the room drops below 2 connected participants mid-draft, the
    // draft can't meaningfully continue - return everyone to the lobby
    // rather than let it hang.
    if (isHost) mpHostCheckMinPlayers();

    // A disconnect can *complete* a pending unanimous vote (if the only
    // remaining non-voter is the person who just left). That's a change
    // to participants, not to gameState, so mpOnGameStateChange won't
    // fire - re-check here or the vote stalls until the next bid/timeout.
    if (isHost && mpGameState) mpCheckVotesAndMaybeExecute(mpGameState);
  });

  // Listen for status changes
  database.ref(`rooms/${currentRoomCode}/status`).on('value', (snapshot) => {
    const status = snapshot.val();
    const prevStatus = mpLastKnownStatus;
    mpLastKnownStatus = status;

    if (status === 'playing' && !state.auctioning) {
      startMultiplayerAuction();
    } else if (status === 'ended') {
      mpHandleRoomEnded();
    } else if (status === 'waiting' && (prevStatus === 'playing' || prevStatus === 'ended')) {
      mpHandleReturnedToLobby();
    }
  });

  // Listen for settings changes (non-host, while still in the lobby)
  database.ref(`rooms/${currentRoomCode}/settings`).on('value', (snapshot) => {
    const settings = snapshot.val();
    if (settings && !isHost) {
      // Mode first - it swaps the formation table the key is looked up in,
      // and sets BUDGET/BID_STEP/squad size to match the host.
      applyGameMode(settings.gameMode || DEFAULT_GAME_MODE_ID, settings.formation);
      ROUND_SECONDS = settings.roundSeconds != null ? settings.roundSeconds : 30;
      RESET_SECONDS = ROUND_SECONDS === 0 ? 0 : Math.max(4, Math.round(ROUND_SECONDS * 0.4));
      SHOW_RATINGS = settings.showRatings || false;
      REROLLS_MODE = settings.rerollsMode || '3';
      setDrawOrder(settings.drawOrder);
      setDraftFilters(settings.filters);
      if((settings.maxParticipants || MP_MAX_PLAYERS) !== MP_MAX_PARTICIPANTS){
        MP_MAX_PARTICIPANTS = settings.maxParticipants || MP_MAX_PLAYERS;
        updateWaitingPlayersList(mpParticipantsSnapshot);
      }
      // Sound is a local, per-device preference (see globalSoundBtn) -
      // it deliberately does NOT sync from the room's settings, so each
      // participant controls only their own audio.

      // A guest only needs the pool's identity, for branding. It
      // deliberately does NOT call setActivePool(): fetching the pool
      // file here would be wasted work (the host resolves every player
      // and sends them inside gameState) and would introduce a way for a
      // guest to fail on a file the host had no trouble with.
      const poolId = settings.poolId || DEFAULT_POOL_ID;
      if(poolId !== activePoolId){
        activePoolId = poolId;
        activePoolMeta = poolFileCache[poolId] ? poolFileCache[poolId].meta : poolEntry(poolId);
        applyPoolTheme(activePoolDisplay());
        renderAllPoolPickers();
      }
    }
  });

  // Listen for the single authoritative game state. Every client -
  // host included - only ever renders whatever arrives here.
  database.ref(`rooms/${currentRoomCode}/gameState`).on('value', (snapshot) => {
    mpOnGameStateChange(snapshot.val());
  });

  // Post-draft match simulation the host ran, so every device shows
  // the same tournament (only {mode, seed} travels - see runSimulation).
  database.ref(`rooms/${currentRoomCode}/simulation`).on('value', (snapshot) => {
    mpOnSimulationChange(snapshot.val());
  });
}

function mpWatchHostPresence(participants){
  if (!mpKnownHostId || isHost) return;
  const hostEntry = participants[mpKnownHostId];
  if (hostEntry && hostEntry.connected !== false) return; // host is fine

  const others = Object.entries(participants).filter(([uid, d]) => uid !== mpKnownHostId && d.connected !== false);
  if (others.length === 0) return; // nobody left to act on it
  others.sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const stewardId = others[0][0];
  if (stewardId === currentUserId) {
    database.ref(`rooms/${currentRoomCode}`).update({ status: 'ended', endedReason: 'host_left' });
  }
}

function mpHostCheckMinPlayers(){
  if (!mpGameState || mpGameState.roundPhase === 'complete') return;
  const connectedCount = mpConnectedParticipantIds().length;
  if (connectedCount < 2) {
    mpHostResetToLobby('player_left');
  }
}

function mpHandleRoomEnded(){
  if (!currentRoomCode) return;
  // status:'ended' also happens on a perfectly normal draft completion
  // (see mpHostAdvanceRound) - that path already shows the results
  // screen via mpRenderFromState()'s roundPhase==='complete' handling
  // and must NOT be interrupted by kicking everyone back to Home here.
  // Only an explicit host-left/aborted ending should force navigation.
  database.ref(`rooms/${currentRoomCode}/endedReason`).once('value').then((snap) => {
    const reason = snap.val();
    if (reason !== 'host_left') return;
    mpShowToast(t('mp.hostEnded'), 'error');
    leaveRoom();
  });
}

function mpHandleReturnedToLobby(){
  unlockGameplayZoom();
  clearInterval(mpTickHandle);
  mpTickHandle = null;
  mpGameState = null;
  mpRenderedKey = null;

  /* Clear everything scoped to the draft that just ended, so the next one
     starts from the same blank slate a freshly-loaded tab would have.
     Deliberately NOT state.participants - those people are still sitting
     in this room; it is only the round that is over. Without this a
     restart could carry a live bid, a leader, or a half-rendered bidder
     grid into the lobby and on into the next draft. */
  state.auctioning = false;
  state.currentPlayer = null;
  state.currentBid = 0;
  state.currentLeader = null;
  state.goingVotes = {};
  state.sealedBids = {};
  state.isBlindRound = false;
  bidInputs = {};

  document.getElementById('auctionScreen').style.display = 'none';
  document.getElementById('resultsScreen').style.display = 'none';
  showWaitingRoom();

  database.ref(`rooms/${currentRoomCode}/lastEvent`).once('value').then((snap) => {
    const evt = snap.val();
    if (evt && evt.type === 'player_left') {
      mpShowToast(t('mp.playerLeft'), 'error');
    } else if (evt && evt.type === 'host_returned_to_lobby') {
      mpShowToast(t('mp.hostReturned'), 'error');
    } else if (evt && evt.type === 'restarted') {
      mpShowToast(t('mp.readyAnother'), 'success');
    }
  });
}

function updateWaitingPlayersList(participants) {
  const list = document.getElementById('waitingPlayersList');
  const count = document.getElementById('playerCount');
  const readyCount = document.getElementById('readyCount');

  const totalPlayers = Object.keys(participants).length;
  const readyPlayers = Object.values(participants).filter(p => p.ready).length;
  // "Ready to start" is judged only among currently-connected
  // participants, so a player who disconnected without formally leaving
  // the lobby can never block everyone else from starting.
  const connectedList = Object.values(participants).filter(p => p.connected !== false);
  const connectedCount = connectedList.length;
  const connectedReadyCount = connectedList.filter(p => p.ready).length;

  count.textContent = totalPlayers;
  if (readyCount) readyCount.textContent = readyPlayers;

  // Update room information card
  const roomPlayerCount = document.getElementById('roomPlayerCount');
  const roomMaxPlayers = document.getElementById('roomMaxPlayers');
  const roomHostName = document.getElementById('roomHostName');
  const roomStatus = document.getElementById('roomStatus');

  if (roomPlayerCount) roomPlayerCount.textContent = totalPlayers;
  if (roomMaxPlayers) {
    roomMaxPlayers.textContent = MP_MAX_PARTICIPANTS;
  }

  // Find and display host name
  const hostEntry = Object.entries(participants).find(([uid]) => {
    // Host is the first participant (created the room)
    return participants[uid].joinedAt === Math.min(...Object.values(participants).map(p => p.joinedAt || 0));
  });
  if (roomHostName && hostEntry) {
    roomHostName.textContent = hostEntry[1].name || 'Host';
  }

  // Update status
  if (roomStatus) {
    if (connectedCount >= 2 && connectedReadyCount === connectedCount) {
      roomStatus.textContent = t('waiting.readyToStart');
      roomStatus.style.color = 'var(--green)';
    } else {
      roomStatus.textContent = t('waiting.waitingForPlayers');
      roomStatus.style.color = 'var(--amber)';
    }
  }

  // Update ready button text for non-host
  const readyBtn = document.getElementById('playerReadyBtn');
  if (readyBtn && !isHost && currentUserId) {
    const myStatus = participants[currentUserId]?.ready;
    if (myStatus) {
      readyBtn.textContent = t('waiting.imReady');
      readyBtn.style.background = 'var(--green)';
    } else {
      readyBtn.textContent = t('waiting.clickWhenReady');
      readyBtn.style.background = 'var(--amber)';
    }
  }

  // Update host's start button and warning
  if (isHost) {
    const allReady = connectedCount >= 2 && connectedReadyCount === connectedCount;
    const startBtn = document.getElementById('hostStartBtn');
    const warning = document.getElementById('readyWarning');

    if (allReady) {
      startBtn.disabled = false;
      startBtn.style.opacity = '1';
      if (warning) warning.style.display = 'none';
    } else {
      startBtn.disabled = true;
      startBtn.style.opacity = '0.5';
      if (warning) warning.style.display = 'block';
    }
  }

  list.innerHTML = Object.entries(participants).map(([uid, player]) => {
    const isYou = uid === currentUserId;
    const readyStatus = player.ready ? t('waiting.readyStatus') : t('waiting.notReady');
    const readyColor = player.ready ? 'var(--green)' : 'var(--stone)';
    const statusText = isYou ? t('waiting.you') : (player.connected ? readyStatus : t('waiting.disconnected'));
    const statusColor = isYou ? 'var(--amber)' : (player.connected ? readyColor : 'var(--red)');
    const kickBtnHTML = (isHost && !isYou)
      ? `<button class="kick-btn" data-kick-uid="${esc(uid)}" title="${esc(t('waiting.kickTitle', {name: player.name}))}">${esc(t('dialog.kick'))}</button>`
      : '';

    return `
      <div style="background:var(--bg-alt); border:1px solid var(--line); border-radius:8px; padding:12px 16px; margin-bottom:8px; display:flex; align-items:center; gap:10px;">
        <span style="width:10px; height:10px; border-radius:50%; background:${player.color}; flex-shrink:0;"></span>
        <span style="flex:1; font-weight:600;">${esc(player.name)}</span>
        <span style="font-size:12px; color:${statusColor};">${statusText}</span>
        ${kickBtnHTML}
      </div>
    `;
  }).join('');

  [...list.querySelectorAll('.kick-btn')].forEach(btn => {
    btn.onclick = () => mpKickParticipant(btn.dataset.kickUid);
  });
}

let mpStartInFlight = false;
async function hostStartAuction() {
  if (!isHost) {
    mpShowToast(t('mp.onlyHostStart'));
    return;
  }
  if (mpStartInFlight) return; // guard against double-clicks firing this twice

  // Same guard single-player's startAuction() has. Without it a host who
  // clicks Start before players.json has finished loading builds the
  // ENTIRE draft out of selectPlayer()'s "Unknown Player" fallback -
  // for every participant in the room, unrecoverably.
  await ensureActivePoolLoaded();
  if (playerDatabase.length === 0) {
    mpShowToast(t('mp.stillLoading'), 'error');
    return;
  }

  mpStartInFlight = true;

  try {
    const snapshot = await database.ref(`rooms/${currentRoomCode}/participants`).once('value');
    const participants = snapshot.val() || {};
    const connectedCount = Object.values(participants).filter(p => p.connected !== false).length;

    if (connectedCount < 2) {
      mpShowToast(t('mp.needTwoPlayers'));
      return;
    }

    // Only the host draws players from the pool, so this is the one
    // place online can catch a pool that is too thin for the room.
    const poolProblem = poolReadinessMessage(connectedCount);
    if (poolProblem) {
      mpShowToast(poolProblem, 'error');
      renderAllPoolPickers();
      return;
    }

    /* Every participant starts the draft on the SAME budget, written by
       the host from the room's own mode, immediately before play begins.

       Belt and braces on top of fixing the join-time write: a stored
       budget can also go stale later (the host switches mode after people
       have joined, someone reconnects into a room whose settings moved
       on), and there is no point in the room where a wrong number is
       cheaper to catch than right here. Squad and positionsFilled are
       reset with it so a re-run after "Play Again" cannot inherit the
       previous draft's picks either. */
    const settingsSnap = await database.ref(`rooms/${currentRoomCode}/settings`).once('value');
    const startBudget = mpRoomBudget(settingsSnap.val());
    const resetUpdates = {};
    Object.keys(participants).forEach(uid => {
      resetUpdates[`rooms/${currentRoomCode}/participants/${uid}/budget`] = startBudget;
      resetUpdates[`rooms/${currentRoomCode}/participants/${uid}/squad`] = [];
      resetUpdates[`rooms/${currentRoomCode}/participants/${uid}/positionsFilled`] = [];
    });
    await database.ref().update(resetUpdates);

    await database.ref(`rooms/${currentRoomCode}/status`).set('playing');
  } finally {
    mpStartInFlight = false;
  }
}

function startMultiplayerAuction() {
  liveSquadsPid = null; // default the Live Squads panel back to "your squad" for the new draft
  state.rerollsInitial = null; // re-derived on the first gameState render for this draft
  // Hide waiting room, show auction screen (online layout: two columns
  // on desktop, stacked on mobile - see .online-mode in the stylesheet)
  document.getElementById('waitingScreen').style.display = 'none';
  applyAuctionScreenMode(true);
  // Same reasoning as the offline path in auction.js's startAuction() -
  // the waiting room / lobby settings can leave the page scrolled well
  // down, and nothing else resets it before the stage appears.
  window.scrollTo(0, 0);
  // Online has its own reroll rules but the same controls - they must be
  // put back on screen explicitly, since a previous local draft in this
  // tab may have hidden them (see applyRerollChrome).
  applyRerollChrome();
  lockGameplayZoom();
  if (!mpTickHandle) mpTickHandle = setInterval(mpTickDisplay, 150);

  // Fired by every client, not just the host, so the funnel counts people
  // who PLAYED a draft rather than people who started one.
  track('draft_started', trackDraftContext({
    mode: 'online',
    participants: Object.keys(mpParticipantsSnapshot || {}).length || null,
    is_host: !!isHost,
  }));

  // Non-host clients never compute game state - they just wait for the
  // gameState listener (already attached in setupMultiplayerListeners)
  // to deliver the current snapshot and render it.
  if (!isHost) return;

  database.ref(`rooms/${currentRoomCode}/gameState`).once('value').then(async (snap) => {
    const existing = snap.val();
    if (existing && existing.roundPhase) {
      // A draft is already in progress (e.g. the host refreshed the
      // page) - resume driving it instead of rebuilding from scratch.
      mpGameState = existing;
      positionPhaseTracking = existing.positionPhaseTracking || {};
      positionRankFloor = existing.positionRankFloor || {};
      // Read participants directly instead of trusting the cached
      // listener snapshot: on a fresh page load the participants
      // listener may not have delivered yet, and rebuilding the
      // drafted-player exclusion set from an empty snapshot would let
      // the host re-offer players that are already on someone's squad.
      const pSnap = await database.ref(`rooms/${currentRoomCode}/participants`).once('value');
      mpParticipantsSnapshot = pSnap.val() || {};
      mpRebuildUsedPlayerIds();
      if (existing.roundPhase === 'bidding' && !existing.paused) {
        mpScheduleHostRoundTimer(existing.roundEndsAt);
      } else if (existing.roundPhase === 'settled') {
        const elapsed = existing.settledAt ? (serverNow() - existing.settledAt) : MP_SETTLE_DISPLAY_MS;
        const delay = Math.max(0, MP_SETTLE_DISPLAY_MS - elapsed);
        mpAdvanceTimerHandle = setTimeout(() => {
          const gs2 = mpCloneGameState();
          gs2.currentRound++;
          mpGameState = gs2;
          mpHostAdvanceRound();
        }, delay);
      }
      return;
    }
    mpBuildFreshGameState();
  });
}

// Rebuilds the "already drafted" exclusion set from every squad in the
// room, so a host that refreshes mid-draft can't redraw a player who's
// already been sold (usedPlayerIds itself only lives in this tab's
// memory and is lost on reload).
function mpRebuildUsedPlayerIds(){
  usedPlayerIds.clear();
  Object.values(mpParticipantsSnapshot).forEach(participant => {
    (participant.squad || []).forEach(entry => {
      if (entry && entry.id != null) usedPlayerIds.add(entry.id);
    });
  });
  if (mpGameState && mpGameState.currentPlayer && mpGameState.currentPlayer.id != null) {
    usedPlayerIds.add(mpGameState.currentPlayer.id);
  }
  // Players waiting at the back of the pack are drawn already - never redraw them.
  ((mpGameState && mpGameState.unsold) || []).forEach(entry => {
    if (entry && entry.id != null) usedPlayerIds.add(entry.id);
  });
}

async function mpBuildFreshGameState(){
  document.getElementById('ticker').innerHTML = '';

  // Drop the previous draft's match simulation. Otherwise a client that
  // rejoins later gets it delivered by the simulation listener's initial
  // value event and renders last draft's tournament on this draft's
  // results screen.
  database.ref(`rooms/${currentRoomCode}/simulation`).remove().catch(() => {});
  simLastRenderedKey = null;

  const snap = await database.ref(`rooms/${currentRoomCode}/participants`).once('value');
  const participants = snap.val() || {};
  mpParticipantsSnapshot = participants;
  state.participants = Object.entries(participants).map(([uid, data]) => ({
    id: uid,
    name: data.name,
    color: data.color,
    budget: data.budget != null ? data.budget : BUDGET,
    squad: data.squad || [],
    positionsFilled: new Set(data.positionsFilled || [])
  }));
  state.totalPhases = state.participants.length - 1;

  usedPlayerIds.clear();
  positionPhaseTracking = {};
  positionRankFloor = {};

  const positionOrder = FORMATION.map((_, i) => i);
  for (let i = positionOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positionOrder[i], positionOrder[j]] = [positionOrder[j], positionOrder[i]];
  }

  mpGameState = {
    draftId: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 11),
    roundPhase: 'bidding',
    phaseNum: 1,
    totalPhases: state.totalPhases,
    currentRound: 0,
    unsold: [],   // the back of the pack - see js/unsold.js
    positionOrder,
    positionPhaseTracking,
    positionRankFloor,
    currentPlayer: null,
    roundId: 0,
    currentBid: 0,
    currentLeader: null,
    roundEndsAt: null,
    roundSeconds: ROUND_SECONDS,
    resetSeconds: RESET_SECONDS,
    rerollsRemaining: rerollPoolSize(REROLLS_MODE),
    roundRerolls: 0,
    paused: false,
    pausedRemainingMs: null,
    settleInfo: null,
    settledAt: null,
    rerollVotes: {},
    goingVotes: {},
    goingGraceApplied: false,
    // A single sealed-bid ("blind") round happens once per draft - see
    // mpHostAdvanceRound()/mpHostSettleRound(). Mirrors single-player exactly,
    // including the randomized target (see startAuction()'s comment).
    isBlindRound: false,
    sealedBids: {},
    blindRoundUsed: false,
    biddingRoundsSoFar: 0,
    blindRoundTarget: pickBlindRoundTarget(state.participants.length)
  };

  mpHostAdvanceRound();
}

// ---- Host-authoritative round engine ----
// Every function below is only ever invoked on the host's tab. Each one
// takes a clone of the last-known gameState, mutates it to reflect the
// single next decision (next round / settle / reroll / etc.), and writes
// the WHOLE object back in one atomic call - so every client always
// receives one complete, consistent snapshot instead of piecemeal field
// updates that could arrive out of order.

function mpCloneGameState(){
  return JSON.parse(JSON.stringify(mpGameState));
}

function mpCommitGameState(gs, extraUpdates){
  const updates = extraUpdates ? {...extraUpdates} : {};
  updates[`rooms/${currentRoomCode}/gameState`] = gs;
  return database.ref().update(updates);
}

function mpScheduleHostRoundTimer(endsAt){
  clearTimeout(mpHostTimerHandle);
  if (!isHost || !endsAt) return;
  const ms = Math.max(0, endsAt - serverNow());
  mpHostTimerHandle = setTimeout(() => mpHostSettleRound(), ms + 60);
}

function mpHostAdvanceRound(){
  if (!isHost || !mpGameState) return;
  const gs = mpCloneGameState();

  const allComplete = state.participants.every(p => p.squad.length === FORMATION.length);
  if (allComplete) {
    gs.roundPhase = 'complete';
    gs.currentPlayer = null;
    mpGameState = gs;
    mpCommitGameState(gs);
    database.ref(`rooms/${currentRoomCode}/status`).set('ended');
    return;
  }

  if (gs.currentRound >= FORMATION.length) { gs.phaseNum++; gs.currentRound = 0; }

  if (gs.phaseNum > maxDraftPhases(state.participants.length)) {
    gs.roundPhase = 'complete';
    gs.currentPlayer = null;
    mpGameState = gs;
    mpCommitGameState(gs);
    database.ref(`rooms/${currentRoomCode}/status`).set('ended');
    return;
  }

  // rerollsRemaining is intentionally NOT reset here - it's a single
  // pool for the whole draft (set once in mpBuildFreshGameState) and
  // only ever decremented by mpHostExecuteReroll/the no-bids auto-reroll
  // path, exactly like single-player's state.rerollsRemaining.
  // The PER-ROUND ceiling is a different thing and does reset, here,
  // exactly as single-player resets state.roundRerolls in startRound().
  gs.roundRerolls = 0;

  const posIdx = gs.positionOrder[gs.currentRound];
  const eligible = state.participants.filter(p => participantNeedsSlot(p, posIdx));

  if (eligible.length === 0) {
    gs.currentRound++;
    mpGameState = gs;
    return mpHostAdvanceRound();
  }

  const phase = gs.positionPhaseTracking[posIdx] || 0;

  // Mirrors single-player's startRound(): a player nobody bid on earlier is
  // offered BEFORE a fresh draw, and neither the ladder nor this slot's
  // phase counter moves for him.
  gs.unsold = pruneUnsold(gs.unsold, state.participants);
  const back = takeUnsoldForSlot(gs.unsold, posIdx, gs.phaseNum);
  let player;
  let settleInfo = null;
  if (back.player) {
    gs.unsold = back.queue;
    player = back.player;
    settleInfo = { mode: 'packReturn', playerName: player.name, price: player.startPrice };
  } else {
    // Occasionally a flash pick from the top tier instead (see
    // maybeGenerateFlashPlayer()) - mirrors single-player exactly,
    // including bypassing the dynamic floor entirely for that pick.
    const flashPlayer = maybeGenerateFlashPlayer(posIdx, phase, state.participants.length, eligible.length);
    if(flashPlayer){
      player = flashPlayer;
    } else {
      const picked = generateRoundPlayer(posIdx, phase, state.participants.length, (gs.positionRankFloor || {})[posIdx]);
      player = picked.player;
      gs.positionRankFloor = {...gs.positionRankFloor, [posIdx]: picked.rankFloor};
    }
    gs.positionPhaseTracking = {...gs.positionPhaseTracking, [posIdx]: phase + 1};
  }
  gs.roundId = (gs.roundId || 0) + 1;
  gs.currentPlayer = player;
  gs.currentBid = 0;
  gs.currentLeader = null;
  gs.settleInfo = settleInfo;
  gs.rerollVotes = {};
  gs.goingVotes = {};
  gs.goingGraceApplied = false;

  // Only one participant still needs this position - assign it to them
  // immediately, no bidding (mirrors single-player's autoAssign). Modes
  // without auto-assignment (6v6) skip this and run the round anyway, so
  // the last eligible participant wins it unopposed at the minimum bid.
  if (eligible.length === 1 && activeMode().autoAssignLastEligible) {
    const winner = eligible[0];
    const price = player.startPrice;
    const slotIdx = resolveFilledSlot(winner, posIdx);
    const newBudget = winner.budget - price;
    const newSquad = [...winner.squad, {...player, posIdx: slotIdx, price, newlyPlaced: true}];
    const newPositionsFilled = Array.from(winner.positionsFilled).concat(slotIdx);

    gs.roundPhase = 'settled';
    gs.settledAt = serverNow();
    gs.settleInfo = { mode: 'autoSingle', winnerId: winner.id, winnerName: winner.name, price, playerName: player.name, playerPos: player.pos, playerRating: player.rating, isFlash: !!player.isFlash };
    mpGameState = gs;

    const updates = {};
    updates[`rooms/${currentRoomCode}/participants/${winner.id}/budget`] = newBudget;
    updates[`rooms/${currentRoomCode}/participants/${winner.id}/squad`] = newSquad;
    updates[`rooms/${currentRoomCode}/participants/${winner.id}/positionsFilled`] = newPositionsFilled;
    mpCommitGameState(gs, updates);

    winner.budget = newBudget; winner.squad = newSquad; winner.positionsFilled = new Set(newPositionsFilled);

    mpAdvanceTimerHandle = setTimeout(() => {
      const gs2 = mpCloneGameState();
      gs2.currentRound++;
      mpGameState = gs2;
      mpHostAdvanceRound();
    }, MP_SETTLE_DISPLAY_MS);
    return;
  }

  // A single sealed-bid ("blind") round happens once per draft, on
  // gs.blindRoundTarget - see single-player's startRound() for the
  // identical randomized-trigger logic. Both engines go through
  // shouldBlindRoundFireNow() so they can't disagree about when it lands.
  gs.biddingRoundsSoFar = (gs.biddingRoundsSoFar || 0) + 1;
  gs.isBlindRound = shouldBlindRoundFireNow(
    gs.blindRoundUsed, gs.biddingRoundsSoFar,
    gs.blindRoundTarget, slotsRemainingInDraft());
  if(gs.isBlindRound) gs.blindRoundUsed = true;
  gs.sealedBids = {};

  gs.roundPhase = 'bidding';
  gs.currentRoundSeconds = roundSecondsForPhase(gs.roundSeconds, gs.phaseNum);
  gs.roundEndsAt = gs.currentRoundSeconds > 0 ? serverNow() + gs.currentRoundSeconds * 1000 : null;
  mpGameState = gs;
  mpCommitGameState(gs);
  mpScheduleHostRoundTimer(gs.roundEndsAt);
}

// Host-only: resolves the blind round's sealed bids into
// gs.currentBid/gs.currentLeader (highest valid bid wins, ties go to
// whoever locked theirs in first) - mirrors single-player's
// resolveSealedBids() exactly, operating on a gs clone instead of
// state directly. Leaves currentBid/currentLeader at their initial
// 0/null if nobody submitted anything valid, which the existing
// "no bids" fallback below already handles with no special-casing.
function mpResolveSealedBids(gs){
  if(!gs.isBlindRound) return;
  const p = gs.currentPlayer;
  let winnerId = null, winnerAmount = 0, winnerTime = Infinity;

  Object.entries(gs.sealedBids || {}).forEach(([pid, entry]) => {
    const participant = state.participants.find(x => x.id === pid);
    if(!participant) return;
    if(entry.amount < p.startPrice) return;
    if(entry.amount > getMaxAffordable(participant)) return;
    if(entry.amount > winnerAmount || (entry.amount === winnerAmount && entry.time < winnerTime)){
      winnerId = pid; winnerAmount = entry.amount; winnerTime = entry.time;
    }
  });

  if(winnerId){
    gs.currentBid = winnerAmount;
    gs.currentLeader = winnerId;
  }
  gs.isBlindRound = false;
}

// Called when the bidding clock for the current round has expired
// (scheduled by mpScheduleHostRoundTimer), or immediately when the host
// forces "Calling Final Bids" on a round with no bids yet.
function mpHostSettleRound(){
  if (!isHost || !mpGameState || mpGameState.roundPhase !== 'bidding') return;
  clearTimeout(mpHostTimerHandle);

  const gs = mpCloneGameState();

  // A blind round never wrote a public currentBid/currentLeader as
  // people bid - resolve the sealed bids into that exact same shape
  // right now, so every line below runs completely unchanged, exactly
  // as if it had been a normal live bid all along (mirrors
  // single-player's resolveSealedBids()/settleRound()).
  mpResolveSealedBids(gs);

  const p = gs.currentPlayer;
  const posIdx = p.posIdx;

  // Treat a leader who has since left the room the same as "no bids" -
  // otherwise we'd try to award the player to (and pay/deduct from)
  // someone who no longer exists in the room.
  const leaderStillHere = gs.currentLeader && state.participants.some(x => x.id === gs.currentLeader);
  if (!leaderStillHere) {
    // Nobody bid: back of the pack, or - the second time - a leftover pick.
    // See js/unsold.js; single-player's handleNoBids() does the same.
    const decision = unsoldDecision(p);
    if (decision.action === 'requeue') {
      gs.unsold = [...(gs.unsold || []), unsoldEntry(p, decision.noBids, gs.phaseNum)];
      gs.roundPhase = 'settled';
      gs.settledAt = serverNow();
      gs.settleInfo = { mode: 'unsold', playerName: p.name, playerPos: p.pos, playerRating: p.rating, isFlash: !!p.isFlash };
      gs.currentLeader = null;
      mpGameState = gs;
      mpCommitGameState(gs);
      // The slot is still open: it comes round again on the next pass.
      mpAdvanceTimerHandle = setTimeout(() => {
        const gs2 = mpCloneGameState();
        gs2.currentRound++;
        mpGameState = gs2;
        mpHostAdvanceRound();
      }, MP_SETTLE_DISPLAY_MS);
      return;
    }
    const winner = pickLeftoverWinner(state.participants, posIdx);
    if (!winner) {
      gs.currentRound++;
      mpGameState = gs;
      return mpHostAdvanceRound();
    }
    mpFinishSettle(gs, winner, leftoverPrice(p, winner, decision.noBids), 'leftover', posIdx);
    return;
  }

  const winner = state.participants.find(x => x.id === gs.currentLeader);
  const price = gs.currentBid;
  mpFinishSettle(gs, winner, price, 'bid', posIdx);
}

function mpFinishSettle(gs, winner, price, mode, posIdx){
  const p = gs.currentPlayer;
  const slotIdx = resolveFilledSlot(winner, posIdx);
  const newBudget = winner.budget - price;
  const newSquad = [...winner.squad, {...p, posIdx: slotIdx, price, newlyPlaced: true}];
  const newPositionsFilled = Array.from(winner.positionsFilled).concat(slotIdx);

  gs.roundPhase = 'settled';
  gs.settledAt = serverNow();
  gs.settleInfo = { mode, winnerId: winner.id, winnerName: winner.name, price, playerName: p.name, playerPos: p.pos, playerRating: p.rating, isFlash: !!p.isFlash };
  gs.currentLeader = null;
  mpGameState = gs;

  const updates = {};
  updates[`rooms/${currentRoomCode}/participants/${winner.id}/budget`] = newBudget;
  updates[`rooms/${currentRoomCode}/participants/${winner.id}/squad`] = newSquad;
  updates[`rooms/${currentRoomCode}/participants/${winner.id}/positionsFilled`] = newPositionsFilled;
  mpCommitGameState(gs, updates);

  winner.budget = newBudget; winner.squad = newSquad; winner.positionsFilled = new Set(newPositionsFilled);

  // Modes without auto-assignment (6v6) skip this shortcut and run a
  // normal round instead, so the last slot is still won by bidding -
  // mirrors single-player's settleRound() exactly.
  const stillNeed = state.participants.filter(pp => participantNeedsSlot(pp, posIdx));
  if (stillNeed.length === 1 && activeMode().autoAssignLastEligible) {
    mpAdvanceTimerHandle = setTimeout(() => mpHostAutoAssignLast(stillNeed[0], posIdx), MP_SETTLE_DISPLAY_MS);
  } else {
    mpAdvanceTimerHandle = setTimeout(() => {
      const gs2 = mpCloneGameState();
      gs2.currentRound++;
      mpGameState = gs2;
      mpHostAdvanceRound();
    }, MP_SETTLE_DISPLAY_MS);
  }
}

// Mirrors single-player's autoAssignLastPlayer(): the position's last
// remaining eligible participant gets a (possibly weaker) player without
// bidding, right after the previous winner's SOLD flash.
function mpHostAutoAssignLast(participant, posIdx){
  if (!isHost) return;
  const gs = mpCloneGameState();
  const pos = FORMATION[posIdx];
  const currentPhase = gs.positionPhaseTracking[posIdx] || 0;
  const numParticipants = state.participants.length;

  // Same reasoning as single-player's autoAssignLastPlayer(): currentPhase
  // is already the last (weakest) percentile band by this point, so
  // selectPlayerDynamic does the whole job - still through the dynamic
  // floor so this final pick continues the same downward progression.
  const picked = pickAutoAssignPlayer(pos.code, currentPhase, numParticipants, (gs.positionRankFloor || {})[posIdx]);
  const realPlayer = picked.player;
  gs.positionRankFloor = {...gs.positionRankFloor, [posIdx]: picked.rankFloor};

  // Shared builder, not a third hand-written copy of the same object -
  // see the note in single-player's autoAssignLastPlayer().
  const lastPlayer = buildRoundPlayer(realPlayer, pos, posIdx, currentPhase);
  gs.positionPhaseTracking = {...gs.positionPhaseTracking, [posIdx]: currentPhase + 1};

  const maxAfford = getMaxAffordable(participant);
  let price = lastPlayer.startPrice;
  if (price > maxAfford) {
    price = MIN_PER_POSITION;
    lastPlayer.startPrice = MIN_PER_POSITION;
    lastPlayer.rating = Math.min(lastPlayer.rating, 69);
  }

  const slotIdx = resolveFilledSlot(participant, posIdx);
  const newBudget = participant.budget - price;
  const newSquad = [...participant.squad, {...lastPlayer, posIdx: slotIdx, price, newlyPlaced: true}];
  const newPositionsFilled = Array.from(participant.positionsFilled).concat(slotIdx);

  gs.currentPlayer = lastPlayer;
  gs.roundPhase = 'settled';
  // roundId must change here too, even though we're still within the
  // same "round slot" - otherwise the render layer's isNewKey check
  // (roundId+roundPhase) sees the exact same key as the winner's SOLD
  // flash that just played and silently skips this animation entirely.
  gs.roundId = (gs.roundId || 0) + 1;
  gs.settledAt = serverNow();
  gs.settleInfo = { mode: 'autoLast', winnerId: participant.id, winnerName: participant.name, price, playerName: lastPlayer.name, playerPos: lastPlayer.pos, playerRating: lastPlayer.rating, isFlash: false };
  gs.currentBid = 0;
  gs.currentLeader = null;
  mpGameState = gs;

  const updates = {};
  updates[`rooms/${currentRoomCode}/participants/${participant.id}/budget`] = newBudget;
  updates[`rooms/${currentRoomCode}/participants/${participant.id}/squad`] = newSquad;
  updates[`rooms/${currentRoomCode}/participants/${participant.id}/positionsFilled`] = newPositionsFilled;
  mpCommitGameState(gs, updates);

  participant.budget = newBudget; participant.squad = newSquad; participant.positionsFilled = new Set(newPositionsFilled);

  mpAdvanceTimerHandle = setTimeout(() => {
    const gs2 = mpCloneGameState();
    gs2.currentRound++;
    mpGameState = gs2;
    mpHostAdvanceRound();
  }, MP_SETTLE_DISPLAY_MS);
}

// ---- Actions any client can request (host executes, everyone renders) ----

// Bidding uses a Firebase transaction on the whole gameState node so two
// simultaneous bids from different clients can never both "win" - the
// transaction re-runs against the latest server value until exactly one
// commits, which is what actually prevents the race the old direct
// .update() write was vulnerable to.
function mpPlaceBid(amount){
  if (!currentRoomCode || !currentUserId) return;
  if (!mpGameState || mpGameState.roundPhase !== 'bidding' || mpGameState.paused) return;
  const pid = currentUserId;
  const expectedDraftId = mpGameState.draftId;
  const expectedRoundId = mpGameState.roundId;
  const gsRef = database.ref(`rooms/${currentRoomCode}/gameState`);
  gsRef.transaction((gs) => {
    if (!gs || gs.roundPhase !== 'bidding' || gs.paused || !gs.currentPlayer) return; // abort
    if (gs.draftId !== expectedDraftId || gs.roundId !== expectedRoundId) return;
    if (gs.currentLeader === pid) return; // already leading, abort
    /* Having passed no longer aborts the bid. A pass means "I am out
       unless I change my mind", and bidding IS changing your mind - it
       clears your own pass below. */
    const minBid = gs.currentBid === 0 ? gs.currentPlayer.startPrice : gs.currentBid + BID_STEP;
    if (amount < minBid) return; // abort
    const participant = state.participants.find(p => p.id === pid);
    if (!participant) return; // abort
    // Formation limits, enforced on the write rather than only in the UI:
    // a participant who has already filled every slot for this position
    // cannot take another one.
    if (!participantNeedsSlot(participant, gs.currentPlayer.posIdx)) return; // abort
    const maxAfford = getMaxAffordable(participant);
    if (amount > maxAfford) return; // abort

    gs.currentBid = amount;
    gs.currentLeader = pid;

    // Anti-snipe, mirroring single-player's applyAntiSnipe(). Done inside
    // the transaction so two simultaneous late bids can't both read the
    // same pre-extension deadline and clobber each other's extension.
    // Every client re-derives its countdown from gs.roundEndsAt (see
    // mpTick), and the host reschedules its settle timer on every
    // gameState change (mpOnGameStateChange), so writing the new deadline
    // here is all that's needed to move it for everyone.
    if (gs.currentRoundSeconds > 0 && gs.roundEndsAt) {
      const now = serverNow();
      if (gs.roundEndsAt - now < ANTI_SNIPE_MS) {
        gs.roundEndsAt = now + ANTI_SNIPE_MS;
      }
    }

    // A fresh bid invalidates any in-progress Reroll vote - people who
    // voted to reroll did so when nobody wanted this player, and that is
    // no longer the situation.
    gs.rerollVotes = {};

    /* The BIDDER's own pass is cleared, and nobody else's. Your state
       answers to your actions: bidding is how you take back a pass,
       while another participant bidding leaves you exactly where you
       chose to be. Done inside the transaction so it lands atomically
       with the bid itself - a pass surviving a committed bid would lock
       someone out of a round they just re-entered. */
    if (gs.goingVotes && gs.goingVotes[pid]) delete gs.goingVotes[pid];

    // Re-arm the grace window: the bid changed what everyone was voting
    // about, so the countdown has to be winnable again.
    gs.goingGraceApplied = false;
    return gs;
  }, (error, committed) => {
    if (error) { console.error('Bid failed', error); return; }
    if (committed) {
      haptics.bid();
    } else {
      const errorEl = document.querySelector(`[data-pid="${pid}"] .bid-error`);
      if (errorEl) {
        errorEl.textContent = t('auction.bidRejected');
        setTimeout(() => errorEl.textContent = '', 2000);
      }
    }
  });
}

// ---- Reroll / Call Final Bids: unanimous vote among connected players ----
// Any connected participant can cast a vote by writing their own uid into
// gameState/rerollVotes or gameState/goingVotes (a small, safe sub-path
// write - it can't collide with the host's whole-node writes). The HOST
// alone watches those vote counts and executes the action exactly once,
// the moment every currently-connected participant has voted; a
// disconnected participant is excluded from the count entirely so a
// vote can never hang on someone who isn't there.

let mpVoteBusy = false; // guards against double-executing while a commit is in flight

// Rerolls still available in the CURRENT round of an online draft -
// bounded by the draft-wide pool and by the per-round ceiling that
// applies even on Unlimited (see MAX_REROLLS_PER_ROUND in config.js).
function mpRerollsLeftThisRound(gs){
  if(!gs) return 0;
  return rerollsLeftThisRound(gs.rerollsRemaining, gs.roundRerolls);
}

function mpConnectedParticipantIds(){
  return Object.entries(mpParticipantsSnapshot)
    .filter(([, d]) => d.connected !== false)
    .map(([uid]) => uid);
}

// Who a unanimous vote actually has to wait for.
//
// Calling Final Bids is always decided by connected participants who
// still NEED this round's position: someone who has already filled it
// can't bid, so the round's outcome is none of their business - counting
// them meant everyone else sat waiting on a person with no reason to
// press anything, which stalled the draft until the full timer expired.
//
// Reroll follows the MODE (see modeRerollElectorate). Classic keeps the
// same eligible-only rule for the same reason. 6v6 hands the vote to
// every connected participant instead: its rounds are short, its picks
// are drawn at random rather than laddered, and a player nobody present
// can bid for is precisely the case where the whole room wants to move
// on - so there, rerolling is the room's decision, not the decision of
// whoever happens to still have a slot open.
function mpVoterIdsFor(gs, kind){
  const connected = mpConnectedParticipantIds();
  if (kind === 'reroll' && modeRerollElectorate() === 'all') return connected;

  const posIdx = gs && gs.currentPlayer ? gs.currentPlayer.posIdx : null;
  if (posIdx == null) return connected;

  const eligible = connected.filter(uid => {
    const p = state.participants.find(x => x.id === uid);
    if (!p) return false;
    return participantNeedsSlot(p, posIdx);
  });

  // Never return an empty electorate: a zero denominator would make
  // "everyone has voted" trivially true and fire the action instantly,
  // in a loop. Shouldn't be reachable (a round only opens for bidding
  // with 2+ eligible), but the cost of being wrong here is a runaway.
  return eligible.length > 0 ? eligible : connected;
}

// Does THIS client still need the position currently up for auction?
function mpIsEligibleThisRound(){
  if (!mpGameState || !mpGameState.currentPlayer) return false;
  const me = state.participants.find(x => x.id === currentUserId);
  if (!me) return false;
  return participantNeedsSlot(me, mpGameState.currentPlayer.posIdx);
}

// Whether this client gets a say in a reroll - which, unlike bidding, is
// not the same question as "can I use this player" once the mode hands
// the vote to the whole room.
function mpCanVoteReroll(){
  if (modeRerollElectorate() === 'all') return true;
  return mpIsEligibleThisRound();
}

function mpRoundContext(){
  return { draftId: mpGameState && mpGameState.draftId, roundId: mpGameState && mpGameState.roundId };
}

function mpVoteReroll(){
  if (!currentRoomCode || !currentUserId || !mpGameState) return;
  if (mpGameState.roundPhase !== 'bidding') return;
  if (!mpCanVoteReroll()) return; // Classic: already has this position, not their call
  if (mpGameState.isBlindRound) return; // no leader to reroll away from mid-blind-round
  if (mpRerollsLeftThisRound(mpGameState) <= 0) return;
  if (mpGameState.currentLeader) return; // locked once bidding has started, same as single-player
  if (mpGameState.rerollVotes && mpGameState.rerollVotes[currentUserId]) return; // already voted
  database.ref(`rooms/${currentRoomCode}/gameState/rerollVotes/${currentUserId}`).set(true, mpRoundContext());
}

function mpVoteGoing(){
  if (!currentRoomCode || !currentUserId || !mpGameState) return;
  if (mpGameState.roundPhase !== 'bidding') return;
  if (!mpIsEligibleThisRound()) return; // already has this position - not their call
  // Still allowed during a blind round - here it means "reveal now"
  // rather than "shorten to 5 seconds" (see mpHostExecuteGoing(), which
  // already goes straight to mpHostSettleRound() whenever there's no
  // live currentLeader - always true mid-blind-round).
  // Already counted, either explicitly or by leading. Writing an explicit
  // vote while leading would be actively wrong: it's sticky, so being
  // outbid later would leave them locked out of a round they clearly
  // still wanted.
  if (mpGoingVoteIsIn(mpGameState, currentUserId)) return;
  database.ref(`rooms/${currentRoomCode}/gameState/goingVotes/${currentUserId}`).set(true, mpRoundContext());
}

// Submits (or replaces) this participant's sealed offer during the
// draft's one blind round. A plain .set() on this participant's own
// sub-path is safe (no collision with anyone else's write, exactly like
// the reroll/going votes above) - no transaction needed.
// NOTE on privacy: like the votes above, this is NOT cryptographically
// sealed - Firebase RTDB has no field-level read restrictions here, so
// gameState/sealedBids technically travels to every client (the same
// way rerollVotes/goingVotes already do). The UI simply never displays
// anyone else's amount (each device only ever renders its own bidder
// card - see renderBidderGrid()), the same trust model most casual
// hidden-info party games rely on.
function mpSubmitSealedBid(amount){
  if (!currentRoomCode || !currentUserId || !mpGameState) return;
  if (!mpGameState.isBlindRound || mpGameState.roundPhase !== 'bidding' || !mpGameState.currentPlayer) return;

  const participant = state.participants.find(p => p.id === currentUserId);
  if (!participant) return;

  const errorEl = document.querySelector(`[data-pid="${currentUserId}"] .bid-error`);
  const showError = (msg) => {
    if (!errorEl) return;
    errorEl.textContent = msg;
    setTimeout(() => errorEl.textContent = '', 2000);
  };

  const minBid = mpGameState.currentPlayer.startPrice;
  if (amount < minBid) { showError(`Must be at least ${fmt(minBid)}`); return; }
  const maxAfford = getMaxAffordable(participant);
  if (amount > maxAfford) { showError(`Max affordable: ${fmt(maxAfford)}`); return; }

  database.ref(`rooms/${currentRoomCode}/gameState/sealedBids/${currentUserId}`).set({ amount, time: serverNow() }, mpRoundContext());
  haptics.bid();
}

// Called (host-only) every time gameState changes while bidding is open.
function mpCheckVotesAndMaybeExecute(gs){
  if (!isHost || gs.roundPhase !== 'bidding' || mpVoteBusy) return;

  // Two separate electorates - in 6v6 the reroll one is the whole room
  // while Calling Final Bids stays with those who can actually bid.
  const rerollVoterIds = mpVoterIdsFor(gs, 'reroll');
  const goingVoterIds = mpVoterIdsFor(gs, 'going');
  if (goingVoterIds.length === 0) return;

  const rerollVotes = gs.rerollVotes || {};
  const rerollCount = rerollVoterIds.filter(uid => rerollVotes[uid]).length;
  if (mpRerollsLeftThisRound(gs) > 0 && !gs.currentLeader && !gs.isBlindRound
      && rerollVoterIds.length > 0 && rerollCount >= rerollVoterIds.length) {
    mpVoteBusy = true;
    mpHostExecuteReroll();
    return;
  }

  // goingGraceApplied stops this re-firing forever: votes are no longer
  // cleared once the action runs (they're sticky now), so without the
  // flag every subsequent gameState change would see a full count again
  // and commit another state write, which would trigger another change.
  // A new bid clears the flag, because that genuinely is a new question.
  const goingCount = goingVoterIds.filter(uid => mpGoingVoteIsIn(gs, uid)).length;
  if (goingCount >= goingVoterIds.length && !gs.goingGraceApplied) {
    mpVoteBusy = true;
    mpHostExecuteGoing();
  }
}

/* Online twin of single-player's goingVoteIsIn() - see that function for
   why an explicit pass is sticky while the leader's implicit one is not. */
function mpGoingVoteIsIn(gs, uid){
  return !!(gs.goingVotes && gs.goingVotes[uid]) || gs.currentLeader === uid;
}

function mpHostExecuteGoing(){
  if (!isHost || !mpGameState || mpGameState.roundPhase !== 'bidding') { mpVoteBusy = false; return; }
  if (!mpGameState.currentLeader) { mpHostSettleRound(); mpVoteBusy = false; return; }
  if (mpGameState.roundSeconds === 0) { mpHostSettleRound(); mpVoteBusy = false; return; }
  const remaining = mpGameState.roundEndsAt - serverNow();
  const gs = mpCloneGameState();
  // Votes are NOT cleared here any more - a pass has to survive until the
  // round actually moves on. The flag is what keeps this from re-running
  // on every subsequent gameState change (see mpCheckVotesAndMaybeExecute).
  gs.goingGraceApplied = true;
  if (remaining > 5000) {
    gs.roundEndsAt = serverNow() + 5000;
  }
  mpGameState = gs;
  mpCommitGameState(gs).then(() => { mpVoteBusy = false; });
  mpScheduleHostRoundTimer(gs.roundEndsAt);
}

function mpHostExecuteReroll(){
  if (!isHost || !mpGameState || mpGameState.roundPhase !== 'bidding' || mpGameState.currentLeader) { mpVoteBusy = false; return; }

  const gs = mpCloneGameState();
  if (mpRerollsLeftThisRound(gs) <= 0) { mpVoteBusy = false; return; }
  const posIdx = gs.currentPlayer.posIdx;
  const phase = gs.currentPlayer.phase - 1;
  // Same mode-awareness as single-player: Classic continues its ladder,
  // 6v6 swaps in a player of comparable rating (see generateRerollPlayer).
  const picked = generateRerollPlayer(posIdx, phase, state.participants.length, (gs.positionRankFloor || {})[posIdx], gs.currentPlayer.rating);
  const newPlayer = picked.player;
  gs.positionRankFloor = {...gs.positionRankFloor, [posIdx]: picked.rankFloor};
  gs.currentPlayer = newPlayer;
  gs.currentBid = 0;
  gs.currentLeader = null;
  gs.rerollsRemaining--;
  gs.roundRerolls = (gs.roundRerolls || 0) + 1;
  gs.roundId++;
  gs.currentRoundSeconds = roundSecondsForPhase(gs.roundSeconds, gs.phaseNum);
  gs.roundEndsAt = gs.currentRoundSeconds > 0 ? serverNow() + gs.currentRoundSeconds * 1000 : null;
  gs.settleInfo = { mode: 'manualReroll', playerName: newPlayer.name };
  gs.rerollVotes = {};
  gs.goingVotes = {};
  gs.goingGraceApplied = false;
  mpGameState = gs;
  mpCommitGameState(gs).then(() => { mpVoteBusy = false; });
  mpScheduleHostRoundTimer(gs.roundEndsAt);
}

function mpHostPause(){
  if (!isHost || !mpGameState || mpGameState.roundPhase !== 'bidding' || mpGameState.paused) return;
  const gs = mpCloneGameState();
  gs.pausedRemainingMs = gs.roundEndsAt ? Math.max(0, gs.roundEndsAt - serverNow()) : null;
  gs.paused = true;
  mpGameState = gs;
  clearTimeout(mpHostTimerHandle);
  mpCommitGameState(gs);
}

function mpHostResume(){
  if (!isHost || !mpGameState || !mpGameState.paused) return;
  const gs = mpCloneGameState();
  gs.paused = false;
  if (gs.pausedRemainingMs != null) {
    gs.roundEndsAt = serverNow() + gs.pausedRemainingMs;
  }
  gs.pausedRemainingMs = null;
  mpGameState = gs;
  mpCommitGameState(gs);
  mpScheduleHostRoundTimer(gs.roundEndsAt);
}

// Resets the room to a fresh lobby: every participant's budget/squad
// are wiped back to a clean slate, the gameState is cleared, and status
// goes back to 'waiting'. Used both by "Play Another Auction" (reason
// 'restarted') and by the too-few-players safety valve (reason
// 'player_left') - see mpHostCheckMinPlayers.
function mpHostResetToLobby(reason){
  if (!isHost || !currentRoomCode) return;

  clearTimeout(mpHostTimerHandle);
  clearTimeout(mpAdvanceTimerHandle);
  mpVoteBusy = false;

  const updates = {};
  Object.keys(mpParticipantsSnapshot).forEach((uid) => {
    updates[`rooms/${currentRoomCode}/participants/${uid}/budget`] = BUDGET;
    updates[`rooms/${currentRoomCode}/participants/${uid}/squad`] = [];
    updates[`rooms/${currentRoomCode}/participants/${uid}/positionsFilled`] = [];
    updates[`rooms/${currentRoomCode}/participants/${uid}/ready`] = (uid === currentUserId);
  });
  updates[`rooms/${currentRoomCode}/gameState`] = null;
  updates[`rooms/${currentRoomCode}/status`] = 'waiting';
  updates[`rooms/${currentRoomCode}/lastEvent`] = { type: reason || 'restarted', ts: Date.now() };

  mpGameState = null;
  mpRenderedKey = null;
  database.ref().update(updates);
}

// ---- Rendering: the ONLY place multiplayer DOM updates happen ----
// Every client (host included) reaches the DOM exclusively through this
// function and mpTickDisplay(). Nothing else in multiplayer mode ever
// touches state.currentPlayer/currentBid/currentLeader/etc directly.

let mpLastTickShown = -1;

function mpOnGameStateChange(gs){
  mpGameState = gs;
  if (!gs) {
    /* No gameState means no draft in progress - the host reset the room
       (mpHostResetToLobby deletes this node).

       state.auctioning is otherwise recomputed ONLY inside
       mpRenderFromState(), which this early return skips. So a client
       that was mid-round when the reset landed kept auctioning === true
       indefinitely, and the status listener's `!state.auctioning` guard
       then swallowed the next 'playing' - that client silently never
       joined the new draft while everyone else played it. Whether it hit
       you depended on which phase your last render was, which is exactly
       why only SOME players were affected each time. */
    state.auctioning = false;
    return;
  }

  if (isHost && gs.roundPhase === 'bidding' && !gs.paused) {
    mpScheduleHostRoundTimer(gs.roundEndsAt);
    mpCheckVotesAndMaybeExecute(gs);
  } else {
    clearTimeout(mpHostTimerHandle);
  }

  mpRenderFromState();
}

// Renders the "x/y voted" counters for Reroll / Call Final Bids next to
// their buttons. Reroll's counter only shows while a reroll vote is
// actually possible (rerolls remaining, nobody leading yet) - Going's
// counter is always shown while bidding is open, since it's always votable.
function mpRenderVotePanel(gs){
  // Exactly the electorates the host actually counts (see
  // mpCheckVotesAndMaybeExecute), each read separately - they differ in
  // 6v6, where a reroll needs the whole room - so "2/3" on screen always
  // means what it says instead of showing a total that never gets reached.
  const countWithin = (voterIds, votes) => voterIds.filter(uid => votes && votes[uid]).length;

  const rerollVoterIds = mpVoterIdsFor(gs, 'reroll');
  const rerollCountEl = document.getElementById('mpRerollVoteCount');
  // Reroll voting is blocked entirely during a blind round (see
  // mpVoteReroll()) - its counter shouldn't show alongside Going's.
  const showReroll = mpRerollsLeftThisRound(gs) > 0 && !gs.currentLeader && !gs.isBlindRound;
  if (showReroll) {
    const total = rerollVoterIds.length;
    const n = countWithin(rerollVoterIds, gs.rerollVotes);
    rerollCountEl.style.display = 'inline-block';
    rerollCountEl.textContent = `${n}/${total}`;
    rerollCountEl.classList.toggle('all-in', n === total && total > 0);
  } else {
    rerollCountEl.style.display = 'none';
  }

  const goingVoterIds = mpVoterIdsFor(gs, 'going');
  const goingTotal = goingVoterIds.length;
  const goingCountEl = document.getElementById('mpGoingVoteCount');
  // Counted exactly the way the host counts it (mpGoingVoteIsIn), so the
  // leader's implicit vote is included and "2/2" on screen never sits
  // there looking stuck while the host is already settling.
  const nGoing = goingVoterIds.filter(uid => mpGoingVoteIsIn(gs, uid)).length;
  goingCountEl.style.display = 'inline-block';
  goingCountEl.textContent = `${nGoing}/${goingTotal}`;
  goingCountEl.classList.toggle('all-in', nGoing === goingTotal && goingTotal > 0);
}

function mpRenderFromState(){
  const gs = mpGameState;
  if (!gs) return;

  if (gs.roundPhase === 'complete') {
    clearInterval(mpTickHandle);
    mpTickHandle = null;
    if (document.getElementById('resultsScreen').style.display !== 'block') {
      endAuction();
    }
    return;
  }

  state.currentBid = gs.currentBid;
  state.currentLeader = gs.currentLeader;
  state.currentRound = gs.currentRound;
  state.phaseNum = gs.phaseNum;
  state.totalPhases = gs.totalPhases;
  state.rerollsRemaining = gs.rerollsRemaining;
  state.roundRerolls = gs.roundRerolls || 0;
  state.currentRoundSeconds = gs.currentRoundSeconds;
  state.isBlindRound = !!gs.isBlindRound;
  state.sealedBids = gs.sealedBids || {};
  // Mirrored so bidderCardView() can lock this client's own bid controls
  // once they've passed - a pass is sticky for the round, so the card has
  // to keep saying so even after somebody else bids.
  state.goingVotes = gs.goingVotes || {};
  // Set once per draft from the first snapshot seen (every client gets
  // the same value since it's host-computed), so the results screen can
  // report rerolls-used the same way single-player does.
  if (state.rerollsInitial == null) state.rerollsInitial = rerollPoolSize(REROLLS_MODE);
  state.paused = !!gs.paused;
  state.roundEndsAt = gs.roundEndsAt;
  state.auctioning = gs.roundPhase === 'bidding';

  document.getElementById('pausedOverlay').classList.toggle('show', !!gs.paused);

  if (!gs.currentPlayer) return; // nothing to paint yet (very first tick)
  state.currentPlayer = gs.currentPlayer;

  const p = gs.currentPlayer;
  const pos = FORMATION[p.posIdx] || {code: p.pos, label: p.pos};
  const key = gs.roundId + ':' + gs.roundPhase;
  const isNewKey = key !== mpRenderedKey;

  document.getElementById('posTag').textContent = slotLabel(p.posIdx);
  state.unsold = gs.unsold || [];
  document.getElementById('progressTag').textContent = progressText(gs.phaseNum, gs.totalPhases, gs.currentRound);
  renderUnsoldPile();

  if (gs.roundPhase === 'bidding') {
    document.getElementById('soldFlash').classList.remove('show');
    document.getElementById('playerPos').classList.remove('forced');
    document.getElementById('playerPos').textContent = slotCode(p.posIdx);
    document.getElementById('flashBadge').style.display = (p.isFlash && !gs.isBlindRound) ? 'inline-block' : 'none';
    document.getElementById('blindBadge').style.display = gs.isBlindRound ? 'inline-block' : 'none';

    const nameDisplay = playerNameHTML(p, {nation:false});
    document.getElementById('playerName').innerHTML = nameDisplay;
    document.getElementById('playerNat').innerHTML = playerNationalityLineHTML(p);
    document.getElementById('playerSub').textContent = t('auction.startingPrice', {price: fmt(p.startPrice)});
    // Matches single-player's phaseEligible wording exactly - state.participants
    // is already mirrored from mpParticipantsSnapshot by this point in the render.
    const eligibleCount = state.participants.filter(x => participantNeedsSlot(x, p.posIdx)).length;
    document.getElementById('phaseTag').textContent = t('auction.phaseEligible', {phase: p.phase, count: eligibleCount});

    // A blind round never shows a public current bid/leader - see
    // single-player's startBidding() for the identical treatment.
    document.getElementById('bidDisplayLabel').textContent = t(gs.isBlindRound ? 'auction.sealedRound' : 'auction.currentBid');
    const leaderEl = document.getElementById('currentLeader');
    if (gs.isBlindRound) {
      document.getElementById('currentBid').textContent = t('auction.hidden');
      leaderEl.textContent = t('auction.revealedWhenTimeUp');
      leaderEl.className = 'leader none';
    } else {
      document.getElementById('currentBid').textContent = fmt(gs.currentBid || p.startPrice);
      if (gs.currentLeader) {
        const leaderP = state.participants.find(x => x.id === gs.currentLeader);
        leaderEl.textContent = t('auction.leaderLine', {name: leaderP ? leaderP.name : '...'});
        leaderEl.className = 'leader';
        if (leaderP) leaderEl.style.color = leaderP.color;
      } else {
        leaderEl.textContent = t('auction.noBids');
        leaderEl.className = 'leader none';
      }
    }

    // Keep whatever figure the user has dialled in for as long as it is
    // still a legal bid. This render runs on EVERY gameState and
    // participant change (including someone's connection flickering),
    // so blindly resetting to the minimum used to wipe out a bid the
    // user had just built up with the + button the moment anyone else
    // acted. Only snap back when their number has actually been
    // overtaken, or when a brand-new round makes it meaningless.
    const minBid = gs.currentBid === 0 ? p.startPrice : gs.currentBid + BID_STEP;
    state.participants.forEach(participant => {
      const current = bidInputs[participant.id];
      const maxAfford = getMaxAffordable(participant);
      // Never touch a figure someone is part-way through typing. This
      // render runs on every rival bid, so the old clamp could rewrite
      // "12" into the new minimum the instant before it became "120".
      // A brand-new round (isNewKey) still resets: the old number refers
      // to a player who is no longer on the stage.
      if (!isNewKey && bidInputIsFocused(participant.id)) return;
      if (isNewKey || current == null || current < minBid) {
        bidInputs[participant.id] = minBid;
      } else if (current > maxAfford && maxAfford >= minBid) {
        // They had typed more than they can now afford - clamp down
        // rather than leave a figure the bid transaction would reject.
        bidInputs[participant.id] = maxAfford;
      }
    });

    if (gs.isBlindRound) {
      // Reroll still doesn't make sense mid-blind-round (mpVoteReroll()
      // already refuses to register a vote for it). Going IS available
      // though - waiting out the full timer once everyone's already
      // locked in their sealed offer means just sitting there for no
      // reason, so it doubles as "reveal now" (see mpVoteGoing()/
      // mpHostExecuteGoing(), which settles immediately whenever
      // there's no live currentLeader - always true mid-blind-round).
      const iVotedGoing = !!(gs.goingVotes && gs.goingVotes[currentUserId]);
      const amEligible = mpIsEligibleThisRound();
      const goingBtnEl = document.getElementById('goingBtn');
      goingBtnEl.disabled = iVotedGoing || !amEligible;
      goingBtnEl.textContent = !amEligible ? t('auction.youAlreadyHavePosition')
        : (iVotedGoing ? t('auction.votedWaiting') : t('auction.revealNow'));

      document.getElementById('rerollBtn').disabled = true;
      document.getElementById('rerollBtn').textContent = t('auction.reroll');

      mpRenderVotePanel(gs);
    } else {
      // Reroll/Going are now unanimous-vote actions: every connected
      // client can cast its own vote, and the button reflects only
      // whether *this* client has already voted, not who's host.
      // Leading counts as having called final bids (mpGoingVoteIsIn), so
      // the button reads "voted" rather than inviting the leader to cast
      // a vote the host already counts for them.
      const iVotedGoing = mpGoingVoteIsIn(gs, currentUserId);
      const iVotedReroll = !!(gs.rerollVotes && gs.rerollVotes[currentUserId]);
      // Someone who already filled this position isn't part of the
      // Calling Final Bids vote at all (mpVoterIdsFor excludes them), so
      // that button says why rather than sitting there looking
      // clickable-but-broken. Reroll is judged separately below.
      const amEligible = mpIsEligibleThisRound();

      const goingBtnEl = document.getElementById('goingBtn');
      goingBtnEl.disabled = iVotedGoing || !amEligible;
      goingBtnEl.textContent = !amEligible ? t('auction.youAlreadyHavePosition')
        : (iVotedGoing ? t('auction.votedWaiting') : t('auction.skipTimer'));

      // updateRerollButton() only exists to refresh the "Rerolls Left"
      // count display here (it's the same element in every mode) - its
      // own disabled/AI_MODE early-return logic is for offline/AI play
      // and must never be trusted for online's enabled state, which is
      // fully and unconditionally decided below instead. Previously the
      // "eligible and haven't voted yet" case never set .disabled itself
      // and just inherited whatever updateRerollButton() left behind -
      // when that helper bailed out early (e.g. AI_MODE still true from
      // a single-device draft played earlier in the same tab), a host
      // could get stuck with a disabled/unusable Reroll button for the
      // rest of the online draft even though they were fully eligible
      // to vote.
      updateRerollButton();
      const rerollBtnEl = document.getElementById('rerollBtn');

      /* The button's enabled state must mirror mpVoteReroll()'s OWN
         guards exactly, or it sits there looking clickable and silently
         does nothing. It previously ignored two of them:

           - currentLeader: once anybody has bid, rerolling is off (you
             can't pull a player somebody has already committed money to).
             This is the case people hit constantly - Classic offline
             greys out here, online did not, so the two modes disagreed
             about the same rule.
           - rerolls left: the draft pool, and now the five-per-round
             ceiling that applies even on Unlimited.

         Deliberately NOT amEligible: in 6v6 a reroll is the whole room's
         call, so someone who can't bid on this player still has to press
         this for the vote to carry (see modeRerollElectorate). */
      const rerollsLeft = mpRerollsLeftThisRound(gs) > 0;
      const canReroll = mpCanVoteReroll() && rerollsLeft && !gs.currentLeader;
      if (!canReroll) {
        rerollBtnEl.disabled = true;
        rerollBtnEl.textContent = t(!rerollsLeft ? 'auction.noRerollsLeft' : 'auction.reroll');
      } else if (iVotedReroll) {
        rerollBtnEl.disabled = true;
        rerollBtnEl.textContent = t('auction.votedWaiting');
      } else {
        rerollBtnEl.disabled = false;
        rerollBtnEl.textContent = t('auction.reroll');
      }

      mpRenderVotePanel(gs);
    }

    if (isNewKey) {
      document.getElementById('countdownBanner').classList.remove('show');
      mpLastTickShown = -1;
      if (gs.settleInfo && gs.settleInfo.mode === 'packReturn') {
        addTicker(tVariant('ticker.unsoldReturns', pickVariantIndex(), {name: esc(gs.settleInfo.playerName), price: fmt(gs.settleInfo.price)}));
      } else if (gs.settleInfo && gs.settleInfo.mode === 'manualReroll') {
        addTicker(buildRerolledTickerHTML(gs.settleInfo.playerName));
      }
      sounds.newRound();
    }
  } else if (gs.roundPhase === 'settled') {
    document.getElementById('goingBtn').disabled = true;
    document.getElementById('rerollBtn').disabled = true;
    document.getElementById('mpGoingVoteCount').style.display = 'none';
    document.getElementById('mpRerollVoteCount').style.display = 'none';
    document.getElementById('flashBadge').style.display = 'none';
    document.getElementById('blindBadge').style.display = 'none';

    if (isNewKey && gs.settleInfo && gs.settleInfo.mode === 'unsold') {
      // Nobody bid: no winner, no price - the player just goes to the back of the pack.
      document.getElementById('playerPos').classList.add('forced');
      document.getElementById('playerPos').textContent = slotCode(p.posIdx);
      document.getElementById('playerName').innerHTML = playerNameHTML(p, {nation:false});
      document.getElementById('playerNat').innerHTML = playerNationalityLineHTML(p);
      document.getElementById('playerSub').textContent = t('auction.backOfPack');
      document.getElementById('soldWord').textContent = t('auction.unsold');
      document.getElementById('soldWord').className = 'word unsold';
      document.getElementById('soldDetail').textContent = t('auction.soldDetailUnsold', {player: playerNameText(p)});
      document.getElementById('soldFlash').classList.add('show');
      document.getElementById('countdownBanner').classList.remove('show');
      addTicker(tVariant('ticker.unsoldPack', pickVariantIndex(), {name: esc(p.name)}));
    } else if (isNewKey && gs.settleInfo) {
      const info = gs.settleInfo;
      // isSold distinguishes the wording; the tracked mode strings below
      // ('random'/'autoSingle'/'autoLast') never change, only their labels.
      let isSold, wordKey, cls, detailSuffix, tickerSuffix;
      if (info.mode === 'leftover') { isSold = false; wordKey = 'auction.leftoverPick'; cls = 'word forced'; detailSuffix = ' (leftover)'; tickerSuffix = ' (leftover)'; }
      else if (info.mode === 'autoSingle' || info.mode === 'autoLast') { isSold = false; wordKey = 'auction.autoAssigned'; cls = 'word forced'; detailSuffix = ''; tickerSuffix = ' (auto)'; }
      else { isSold = true; wordKey = 'auction.sold'; cls = 'word sold'; detailSuffix = ''; tickerSuffix = ''; }
      const word = t(wordKey);

      document.getElementById('playerPos').classList.toggle('forced', !isSold);
      document.getElementById('playerPos').textContent = slotCode(p.posIdx);
      const nameDisplay = playerNameHTML(p, {nation:false});
      document.getElementById('playerName').innerHTML = nameDisplay;
      document.getElementById('playerNat').innerHTML = playerNationalityLineHTML(p);
      document.getElementById('playerSub').textContent = t(isSold ? 'auction.soldFor' : 'auction.autoAssignedAt', {price: fmt(info.price)});

      document.getElementById('soldWord').textContent = word;
      document.getElementById('soldWord').className = cls;
      document.getElementById('soldDetail').textContent = t(detailSuffix ? 'auction.soldDetailLeftover' : 'auction.soldDetail',
        {player: playerNameText(p), winner: info.winnerName, price: fmt(info.price)});
      document.getElementById('soldFlash').classList.add('show');
      document.getElementById('countdownBanner').classList.remove('show');

      addTicker(buildSaleTickerHTML(info.playerName, slotCode(p.posIdx), info.winnerName, info.price, tickerSuffix, info.playerRating, info.isFlash));
      sounds.sold();
      haptics.sold();
    }
  }

  mpRenderedKey = key;
  renderBidderGrid();
}

// Repaints the timer ring/number and the going-once/twice countdown
// purely from gs.roundEndsAt + the corrected server clock, every ~150ms.
// This never decides anything (only the host's mpHostSettleRound does) -
// it just displays the same authoritative countdown identically on
// every client.
function mpTickDisplay(){
  if (!currentRoomCode || !mpGameState) return;
  if (mpGameState.roundPhase !== 'bidding' || mpGameState.paused) return;

  if (!mpGameState.roundEndsAt) {
    document.getElementById('timerNum').textContent = '∞';
    document.getElementById('timerFill').style.strokeDasharray = 0;
    return;
  }

  const remaining = Math.max(0, Math.ceil((mpGameState.roundEndsAt - serverNow()) / 1000));
  state.timer = remaining;
  updateTimerUI();

  if (remaining !== mpLastTickShown) {
    // An anti-snipe extension (see mpPlaceBid) moves the deadline back
    // out, so a banner already showing "GOING TWICE!" is now stale.
    // Clearing it whenever the clock jumps UP lets it replay cleanly if
    // the extended round reaches 5s again.
    if (remaining > mpLastTickShown && mpLastTickShown >= 0) {
      document.getElementById('countdownBanner').classList.remove('show');
    }
    mpLastTickShown = remaining;
    if (remaining === 5) { showCountdownBanner('🔥', t('auction.goingOnce'), 5); sounds.countdown(); }
    else if (remaining === 4) { updateCountdownNum(4); }
    else if (remaining === 3) { showCountdownBanner('🔥', t('auction.goingTwice'), 3); sounds.countdown(); }
    else if (remaining === 2) { updateCountdownNum(2); }
    else if (remaining === 1) { updateCountdownNum(1); sounds.countdown(); }
    else if (remaining === 0) {
      showCountdownBanner('🔨', t('auction.soldBang'), '');
      setTimeout(() => { document.getElementById('countdownBanner').classList.remove('show'); }, 800);
    }
  }
}

// Firebase Realtime Database keys can't contain . # $ [ ] / - and since
// this is only ever used as a Set-membership check (not displayed), a
// lossy lowercase/trim/strip is fine. There's no account system in this
// app, so a blocked player's session id is different on every join
// attempt - their typed name is the only stable thing to check against,
// which also means the block is inherently soft: a different name (or
// device, or clearing local data) gets back in. Worth being upfront
// about that limit rather than implying it's a real ban.
function normalizeBlockKey(name){
  return (String(name).trim().toLowerCase().replace(/[.#$\[\]/]/g, '_').slice(0, 100)) || '_blank_';
}

// Host-only. Removing their participant node is exactly what already
// happens when that same person voluntarily leaves (see the non-host
// branch of leaveRoom() below) - every eligibility/vote/min-players check
// already treats a vanished participant correctly, so kicking needs no
// new game-state handling of its own, just this one write (plus,
// optionally, a blocklist entry - see mpExecuteKick).
function mpKickParticipant(uid){
  if(!isHost || !currentRoomCode || !uid || uid === currentUserId) return;
  const name = (mpParticipantsSnapshot[uid] && mpParticipantsSnapshot[uid].name) || t('dialog.unnamedPlayer');
  kickPendingUid = uid;
  document.getElementById('kickConfirmTitle').textContent = t('dialog.removePlayer');
  document.getElementById('kickConfirmText').textContent = t('dialog.removePlayerText', {name});
  document.getElementById('kickConfirmOverlay').classList.add('show');
}

let kickPendingUid = null;
function hideKickConfirm(){
  document.getElementById('kickConfirmOverlay').classList.remove('show');
  kickPendingUid = null;
}

function mpExecuteKick(block){
  const uid = kickPendingUid;
  hideKickConfirm();
  if(!isHost || !currentRoomCode || !uid) return;
  const entry = mpParticipantsSnapshot[uid];
  const updates = {};
  updates[`rooms/${currentRoomCode}/participants/${uid}`] = null;
  if(block && entry && entry.name){
    updates[`rooms/${currentRoomCode}/blockedNames/${normalizeBlockKey(entry.name)}`] = { name: entry.name, blockedAt: Date.now() };
  }
  database.ref().update(updates);
}

document.getElementById('kickConfirmCancelBtn').onclick = hideKickConfirm;
document.getElementById('kickConfirmOverlay').onclick = (e) => {
  if(e.target.id === 'kickConfirmOverlay') hideKickConfirm();
};
document.getElementById('kickConfirmKickBtn').onclick = () => mpExecuteKick(false);
document.getElementById('kickConfirmBlockBtn').onclick = () => mpExecuteKick(true);

/* ---- Leaving a live online draft ----

   Two genuinely different intentions that the single "Return to Home"
   button used to collapse into one:

     Back to Room  - done with THIS draft, not with these people. The
                     room survives and everyone lands back in the lobby
                     ready to set another one up.
     Quit to Home  - done entirely. Same leaveRoom() path as before.

   Only the host can send the room back to the lobby, because the room's
   status is what every client follows (see the status listener) and a
   guest writing it would be reaching into shared state. There is also no
   "in the room but sitting this draft out" state to put a guest in - the
   draft would simply stall waiting on votes they were no longer there to
   cast - so for a guest the button is shown disabled with the reason
   rather than silently missing or, worse, quietly breaking the draft. */
function mpShowReturnMenu(){
  if(!currentRoomCode) return;
  const roomBtn = document.getElementById('mpReturnRoomBtn');
  const note = document.getElementById('mpReturnNote');

  document.getElementById('mpReturnText').textContent = t(isHost
    ? 'dialog.leaveDraftHostText'
    : 'dialog.leaveDraftGuestText');

  roomBtn.disabled = !isHost;
  note.textContent = t(isHost
    ? 'dialog.backToRoomNoteHost'
    : 'dialog.backToRoomNoteGuest');

  document.getElementById('mpReturnOverlay').classList.add('show');
}

function mpHideReturnMenu(){
  document.getElementById('mpReturnOverlay').classList.remove('show');
}

document.getElementById('mpReturnCancelBtn').onclick = mpHideReturnMenu;
document.getElementById('mpReturnOverlay').onclick = (e) => {
  if(e.target.id === 'mpReturnOverlay') mpHideReturnMenu();
};

document.getElementById('mpReturnRoomBtn').onclick = () => {
  if(!isHost || !currentRoomCode) return;
  mpHideReturnMenu();
  // Deliberately does NOT leave the room or touch currentRoomCode: the
  // status flip to 'waiting' is what moves every client (this one
  // included) to the lobby, through the same listener a normal
  // end-of-draft "Play Another Auction" uses.
  teardownRunningDraft('host_reset');
  mpHostResetToLobby('host_returned_to_lobby');
};

document.getElementById('mpReturnHomeBtn').onclick = () => {
  mpHideReturnMenu();
  /* returnToHomeScreen() FIRST, leaveRoom() second - reversed from how
     this reads naturally. teardownRunningDraft() (called inside
     returnToHomeScreen) fires the draft_abandoned analytics event and
     tells online apart from offline by checking currentRoomCode - which
     leaveRoom() clears. Firing the event after the room code is already
     gone would mislabel every online departure as offline. leaveRoom()
     only reads currentRoomCode/currentUserId/isHost, captured into its
     own local consts before it touches anything else, so it has nothing
     left to lose by going second. */
  returnToHomeScreen();
  leaveRoom();
};

function leaveRoom() {
  unlockGameplayZoom();
  const code = currentRoomCode;
  const uid = currentUserId;
  const wasHost = isHost;

  if (code && uid) {
    database.ref(`rooms/${code}/participants/${uid}/connected`).onDisconnect().cancel();

    if (wasHost) {
      // Per design: the host leaving always ends the draft for everyone
      // - there is no silent handoff to a new host. Every other client
      // reacts to status:'ended' via mpHandleRoomEnded().
      database.ref(`rooms/${code}`).update({ status: 'ended', endedReason: 'host_left' });
    } else {
      // A non-host leaving is removed outright (not just marked
      // disconnected), so the draft's eligibility checks immediately
      // stop waiting on them and can continue normally.
      database.ref(`rooms/${code}/participants/${uid}`).remove();
    }
  }

  mpClearLocalSession(code);
}

// Reset local UI/session state without sending any room mutations. A failed
// seat claim must never leave stale host privileges attached to local play.
function mpClearLocalSession(code = currentRoomCode, forget = true) {
  unlockGameplayZoom();

  if (forget) {
    mpStoreDel('auctionXI_roomCode');
    mpStoreDel('auctionXI_userId');
    mpStoreDel('auctionXI_isHost');
  }

  // Detach EVERY subscribed path (not just the room root), so this
  // room can never push state into the client again once it has left.
  detachMultiplayerListeners(code);

  clearInterval(mpTickHandle);
  clearTimeout(mpHostTimerHandle);
  clearTimeout(mpAdvanceTimerHandle);
  mpTickHandle = null;
  mpVoteBusy = false;
  mpStartInFlight = false;

  currentRoomCode = null;
  currentUserId = null;
  isHost = false;
  mpGameState = null;
  mpRenderedKey = null;
  mpKnownHostId = null;
  mpLastKnownStatus = null;
  mpParticipantsSnapshot = {};
  mpConnectedParticipants = 0;
  liveSquadsPid = null;
  state.rerollsInitial = null;
  simStopPlayback();
  simLastRenderedKey = null;
  bidInputs = {};
  state.participants = [];
  state.auctioning = false;
  state.currentPlayer = null;
  state.currentBid = 0;
  state.currentLeader = null;

  chatOpen = false;
  chatSeenCount = 0;
  chatUnread = 0;
  document.getElementById('chatPanel').classList.remove('show');
  document.getElementById('chatToggleBtn').classList.remove('visible');
  document.getElementById('chatMessages').innerHTML = '';
  mpUpdateChatBadge();

  document.getElementById('waitingScreen').style.display = 'none';
  document.getElementById('auctionScreen').style.display = 'none';
  document.getElementById('resultsScreen').style.display = 'none';
  document.getElementById('homeScreen').style.display = 'block';
}

// Restore an in-progress multiplayer session after a refresh/reconnect.
// Returns true if a reconnection attempt was made (screen routing is
// handled asynchronously inside), false if there was nothing to restore.
function mpTryReconnect(){
  /* Offline this is reached with database === null, and the very next line
     would throw inside the load handler - so the home screen would never be
     shown and the app would sit on the loading overlay forever. Returning
     false hands the visitor their home screen and the two modes that need no
     network; the saved room is left untouched for when they are back online. */
  if (!mpAvailable()) return false;

  const savedRoom = mpStoreGet('auctionXI_roomCode');
  const savedUser = mpStoreGet('auctionXI_userId');
  if (!savedRoom || !savedUser) return false;

  database.ref(`rooms/${savedRoom}`).once('value').then(async (snapshot) => {
    const room = snapshot.val();
    const stillThere = room && room.participants && room.participants[savedUser];
    if (!stillThere) {
      mpStoreDel('auctionXI_roomCode');
      mpStoreDel('auctionXI_userId');
      mpStoreDel('auctionXI_isHost');
      showScreen('homeScreen');
      return;
    }

    currentRoomCode = savedRoom;
    currentUserId = savedUser;
    isHost = room.hostId === savedUser;
    currentUserName = room.participants[savedUser].name;

    // Adopt the ROOM's settings, not this device's localStorage ones.
    // The live settings listener only applies to non-hosts (so it can't
    // fight the host editing them in the lobby), which means a host who
    // refreshed mid-draft would otherwise keep whatever formation and
    // rerolls their last offline setup left behind - and FORMATION.length
    // drives the host's round/completion logic, so a mismatch corrupts
    // the draft for everyone.
    mpAdoptRoomSettings(room.settings);

    await database.claim(currentRoomCode, currentUserId, currentUserName);
    await database.ref(`rooms/${currentRoomCode}/participants/${currentUserId}/connected`).set(true);
    mpArmPresence();
    mpWatchPresence();
    setupMultiplayerListeners();

    if (room.status === 'playing') {
      startMultiplayerAuction();
    } else if (room.status === 'ended') {
      // Draft already finished (or the room was closed) before we got
      // back - there's nothing to resume, so leave cleanly rather than
      // leaving listeners attached to a dead room.
      leaveRoom();
      showScreen('homeScreen');
    } else {
      showWaitingRoom();
    }
  }).catch((error) => {
    const forget = error && ['PERMISSION_DENIED', 'NOT_FOUND'].includes(error.code);
    mpClearLocalSession(currentRoomCode, forget);
    showScreen('homeScreen');
  });

  return true;
}

/* Resolves once boot has decided which screen the app opens on.

   tutorial.js needs this. Both files listen for 'load' and then await a
   DIFFERENT promise - this one waits for playersReady, the tutorial waits for
   i18nReady - and the tutorial then SAMPLED whether the home screen was
   visible, bailing silently if it was not. So whichever fetch happened to
   finish first decided whether a brand-new player was ever shown the welcome
   and the language chooser. Measured at roughly one visit in two.

   Publishing the moment instead of racing it also keeps the original intent
   intact: the tutorial must not interrupt somebody dropped straight back into
   a live draft after a refresh. It can now read the screen the app actually
   settled on, rather than guessing from a half-finished boot. */
let mpBootSettled;
const bootReady = new Promise(resolve => { mpBootSettled = resolve; });

// Initialize app - show home screen on load, unless there's an
// in-progress multiplayer session to restore first.
window.addEventListener('load', async () => {
  console.log('🎮 Page loaded, initializing...');

  /* Wait for the players before handing the app over. Everything below
     this line assumes a populated database - reconnecting into a live
     draft especially - and the loading screen is covering the app until
     it resolves, so there is nothing to interact with in the meantime. */
  let ok = false;
  try { ok = await playersReady; }
  catch(err){ console.error('Player database failed to load', err); }

  if(!ok){
    showBootFailure();
    mpBootSettled();   // the tutorial must not wait forever on a failed boot
    return;
  }
  // Is there a room server to talk to? Settled before the home screen shows,
  // so the online button never flashes up and then disappears.
  await probeOnlinePlay();
  hideBootOverlay();

  if (!mpTryReconnect()) {
    showScreen('homeScreen');
  }
  mpBootSettled();
});

console.log('🎮 Multiplayer functions loaded');

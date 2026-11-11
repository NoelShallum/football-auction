/* Local multiplayer configuration. No external credentials required. */
let database = typeof LocalRealtimeDatabase === 'function' ? new LocalRealtimeDatabase() : null;

/* Whether online play can work at all. One place to ask, so the answer cannot
   differ between the button that starts a room and the code that joins one. */
function mpAvailable(){ return !!database; }

// Multiplayer session variables
let currentRoomCode = null;
let currentUserId = null;
let currentUserName = null;
let isHost = false;
let firebaseListenersActive = false;

// ---- Server clock sync (fixes per-client timer drift) ----
// Every client corrects Date.now() by this offset so all timer math
// (countdowns, round-end timestamps) agrees across devices.
let serverTimeOffset = 0;
if(database){
  database.ref('.info/serverTimeOffset').on('value', (snap) => {
    serverTimeOffset = snap.val() || 0;
  });
}
function serverNow(){ return Date.now() + serverTimeOffset; }

// ---- Multiplayer authoritative game state ----
// mpGameState mirrors exactly what is stored at rooms/{code}/gameState.
// Only the host ever computes the NEXT value; every client (host included)
// only ever renders whatever the listener delivers - there is no
// client-side game logic that can drift from this single source of truth.
let mpGameState = null;
let mpHostTimerHandle = null;    // host-only: fires when the bidding round should settle
let mpAdvanceTimerHandle = null; // host-only: fires after a "settled" flash to advance
let mpTickHandle = null;         // all clients: repaints the timer/countdown display
let mpRenderedKey = null;        // last (roundId+roundPhase) rendered, to gate one-shot effects
let mpKnownHostId = null;        // last-seen rooms/{code}/hostId, used both for isHost and for host-presence watch
let mpLastKnownStatus = null;    // last-seen rooms/{code}/status, so we only react to real transitions
const MP_SETTLE_DISPLAY_MS = 1500;
const MP_MAX_PLAYERS = 6; // absolute ceiling - also the chip range (2-6) and the fallback for rooms created before this setting existed
let MP_MAX_PARTICIPANTS = MP_MAX_PLAYERS; // the current room's host-chosen cap

// ---- Room chat ----
let chatOpen = false;
let chatSeenCount = 0;   // how many messages we've already surfaced to the badge
let chatUnread = 0;
const CHAT_MAX_MESSAGES = 200; // trims older history on send so a long-running room doesn't grow unbounded


window.addEventListener('auctionxi:transport-error', event => {
  if (typeof mpShowToast === 'function' && currentRoomCode) mpShowToast(event.detail, 'error');
});

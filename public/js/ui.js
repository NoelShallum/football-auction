// ---- Mobile: gameplay-only pinch-zoom lock ----
// Fast repeated tapping during bidding is where accidental pinch/zoom
// actually hurts, so the viewport is only locked while a draft is live
// (see startAuction()/startMultiplayerAuction()) and always restored the
// moment gameplay ends (endAuction(), leaveRoom(), Back to Home, and
// returning to the lobby) - every other screen (Home, About, Privacy,
// Terms, lobby, results) keeps normal pinch-zoom for accessibility.
function lockGameplayZoom(){
  const vp = document.querySelector('meta[name="viewport"]');
  if(vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
}
function unlockGameplayZoom(){
  const vp = document.querySelector('meta[name="viewport"]');
  if(vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0');
}

/* ---- Loading screen ----
   Taken down once there are players to draft, or switched to a failed
   state that offers a retry. Removed from the DOM after the fade so it
   can never intercept a click, and so a screen reader is not left with a
   hidden "Loading players" region it can still reach. */
function hideBootOverlay(){
  const el = document.getElementById('bootOverlay');
  if(!el || el.classList.contains('gone')) return;
  el.classList.add('gone');
  setTimeout(() => { if(el.parentNode) el.parentNode.removeChild(el); }, 320);
}

/* The one screen that has to work when loading itself has failed.

   t() returns the key unchanged when it has no string for it, and the
   locale files are fetched over the same connection as everything else -
   so the case this screen exists to report is exactly the case where the
   translations may be missing too. Falling back to English text beats
   showing somebody "common.dbLoadFailed". */
function bootText(key, english){
  const s = t(key);
  return (!s || s === key) ? english : s;
}

function showBootFailure(){
  const el = document.getElementById('bootOverlay');
  if(!el) return;
  el.classList.add('failed');
  const msg = document.getElementById('bootMsg');
  if(msg) msg.textContent = bootText('common.dbLoadFailed',
    'Could not load the player database. Check your connection and try again.');
  const retry = document.getElementById('bootRetryBtn');
  if(retry){
    retry.textContent = bootText('common.retry', 'Try again');
    retry.style.display = '';
    // A reload rather than a re-fetch: whatever left the database empty
    // (a bad deploy, a dropped connection at the wrong moment) is most
    // reliably cleared by starting the page over.
    retry.onclick = () => location.reload();
  }
}

// Screen navigation
function showScreen(screenId){
  // Hide all screens
  document.getElementById('homeScreen').style.display = 'none';
  document.getElementById('lobbyScreen').style.display = 'none';
  document.getElementById('waitingScreen').style.display = 'none';
  document.getElementById('setupScreen').style.display = 'none';
  document.getElementById('auctionScreen').style.display = 'none';
  document.getElementById('resultsScreen').style.display = 'none';
  document.getElementById('aboutScreen').style.display = 'none';
  document.getElementById('privacyScreen').style.display = 'none';
  document.getElementById('termsScreen').style.display = 'none';

  // Show requested screen
  document.getElementById(screenId).style.display = 'block';

  /* Name the current screen on <body> so CSS can react to it.
     The masthead - the Auction XI wordmark and the tagline under it - is
     ninety pixels of branding that belongs on the home screen and competes
     for space during a thirty-second round, where the lot, the timer and
     PLACE BID all have to be visible at once. See the .screen-auction rule
     in styles.css. */
  document.body.setAttribute('data-screen', screenId);

  // Scroll to top
  window.scrollTo(0, 0);
}

// In-page replacement for window.confirm(). confirm() blocks the entire
// tab: in multiplayer that also stalls this client's Firebase callbacks,
// so the timer freezes and other players' bids stop arriving until the
// native box is dismissed. This version is purely visual and resolves
// through a callback instead.
let confirmPendingAction = null;
function showConfirm({title, text, okLabel, danger}, onConfirm){
  confirmPendingAction = onConfirm;
  document.getElementById('confirmTitle').textContent = title || 'Are you sure?';
  document.getElementById('confirmText').textContent = text || '';
  const okBtn = document.getElementById('confirmOkBtn');
  okBtn.textContent = okLabel || 'Confirm';
  okBtn.classList.toggle('danger', danger !== false);
  document.getElementById('confirmOverlay').classList.add('show');
}

function hideConfirm(){
  document.getElementById('confirmOverlay').classList.remove('show');
  confirmPendingAction = null;
}

document.getElementById('confirmCancelBtn').onclick = hideConfirm;
document.getElementById('confirmOkBtn').onclick = () => {
  const action = confirmPendingAction;
  hideConfirm();
  if (typeof action === 'function') action();
};
// Clicking the backdrop or pressing Escape cancels, same as Cancel.
document.getElementById('confirmOverlay').onclick = (e) => {
  if (e.target.id === 'confirmOverlay') hideConfirm();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('confirmOverlay').classList.contains('show')) {
    hideConfirm();
  }
  if (e.key === 'Escape' && document.getElementById('kickConfirmOverlay').classList.contains('show')) {
    hideKickConfirm();
  }
  if (e.key === 'Escape' && document.getElementById('mpReturnOverlay').classList.contains('show')) {
    mpHideReturnMenu();
  }
  if (e.key === 'Escape' && document.getElementById('playerInfoOverlay').classList.contains('show')) {
    hidePlayerInfoPanel();
  }
});

// Results screen player-info panel: close button or tapping the backdrop
// dismiss it, same convention as every other overlay in the game.
document.getElementById('playerInfoCloseBtn').onclick = hidePlayerInfoPanel;
document.getElementById('playerInfoOverlay').onclick = (e) => {
  if (e.target.id === 'playerInfoOverlay') hidePlayerInfoPanel();
};

// ---- PWA: Add to Home Screen ----
// The service worker itself is required by Chrome before it will ever
// fire beforeinstallprompt - it does no caching (see sw.js), it's purely
// there to satisfy that installability check.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

function isRunningStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

let deferredInstallPrompt = null;
const isIOSDevice = /iphone|ipad|ipod/i.test(navigator.userAgent);

// Chrome/Android: holds the native prompt until our own button is
// clicked, instead of showing the browser's own mini-infobar immediately.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if(!isRunningStandalone()){
    document.getElementById('installAppRow').style.display = 'block';
  }
});

// iOS Safari never fires beforeinstallprompt and has no programmatic
// install API at all - the best we can do is surface the button and,
// on tap, tell people the manual Share -> Add to Home Screen steps.
if(isIOSDevice && !isRunningStandalone()){
  document.getElementById('installAppRow').style.display = 'block';
}

document.getElementById('installAppBtn').onclick = async () => {
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('installAppRow').style.display = 'none';
  } else if(isIOSDevice){
    mpShowToast(t('home.installIOSHint'));
  }
};

window.addEventListener('appinstalled', () => {
  document.getElementById('installAppRow').style.display = 'none';
});

// Everything that has to stop when a draft is abandoned mid-flight -
// timers, the AI think loop, and every scrap of round state. Shared by
// "Back to Home", "Restart" and the online host resetting the room to
// its lobby, which differ only in where they go next - and in `reason`,
// which is the only thing distinguishing the analytics event below.
function teardownRunningDraft(reason){
  /* The other half of draft_started/draft_completed: without this, a
     drop-off mid-draft was invisible - it showed up as neither a
     completion nor anything else, which is indistinguishable from a
     browser tab nobody ever closed. Guarded on there actually having
     been a draft (participants only populate once one starts, and stay
     populated until the caller clears them right after this returns),
     so calling this from a screen with nothing running - which does not
     currently happen, but nothing enforces it - cannot fire a hollow
     event with no draft behind it. */
  if(state.participants && state.participants.length){
    const totalSlots = FORMATION.length * state.participants.length;
    const filledSlots = state.participants.reduce((n, p) => n + (p.squad ? p.squad.length : 0), 0);
    track('draft_abandoned', trackDraftContext({
      mode: currentRoomCode ? 'online' : (AI_MODE ? 'vs_ai' : 'shared_screen'),
      reason: reason || 'left',
      participants: state.participants.length,
      squad_size: FORMATION.length,
      percent_complete: totalSlots ? Math.round(100 * filledSlots / totalSlots) : 0,
    }));
  }

  aiStopThinking();
  state.auctioning = false;
  state.paused = false;

  if(state.timerInterval){
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  state.currentRound = 0;
  state.positionOrder = [];
  state.currentPlayer = null;
  state.currentBid = 0;
  state.currentLeader = null;
  state.goingVotes = {};
  state.sealedBids = {};

  usedPlayerIds.clear();
  positionPhaseTracking = {};
  positionRankFloor = {};

  bidInputs = {};

  document.getElementById('ticker').innerHTML = '';
  document.getElementById('pausedOverlay').classList.remove('show');
  document.getElementById('countdownBanner').classList.remove('show');
  document.getElementById('soldFlash').classList.remove('show');
}

/* Everything the Home button has to undo locally, whichever way the
   player got here. Shared so the offline path and both online paths
   can't drift on what "back to home" actually resets. */
function returnToHomeScreen(){
  unlockGameplayZoom(); // no-op if leaveRoom() already handled it (offline has no such call)
  teardownRunningDraft('left');
  state.participants = [];
  state.rerollsRemaining = 3;
  state.rerollsInitial = null;
  document.getElementById('auctionScreen').style.display = 'none';
  document.getElementById('homeScreen').style.display = 'block';
}

// Back to Home button handler. Offline there is only one thing this can
// mean; online there are two (see mpShowReturnMenu), so it asks.
document.getElementById('backHomeBtn').onclick = () => {
  if(currentRoomCode){
    mpShowReturnMenu();
    return;
  }
  showConfirm({
    title: t('dialog.returnHome'),
    text: t('dialog.returnHomeText'),
    okLabel: t('dialog.returnHomeOk')
  }, returnToHomeScreen);
};

/* Restart the draft with the settings it is already running on - no trip
   back through the setup screen. startAuction() rebuilds participants
   from the (still populated) setup inputs and resets every counter
   itself, so this only has to stop the current draft first.
   Offline/AI only; the button is hidden online. */
function restartAuctionSameSettings(){
  teardownRunningDraft('restarted');
  document.getElementById('resultsScreen').style.display = 'none';
  startAuction();
}

document.getElementById('restartAuctionBtn').onclick = () => {
  showConfirm({
    title: t('dialog.restartAuction'),
    text: t('dialog.restartAuctionText'),
    okLabel: t('dialog.restartOk')
  }, restartAuctionSameSettings);
};

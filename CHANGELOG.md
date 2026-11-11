# Local releases

## 1.0.1 — 2026-11-11

- Keep room identities in per-tab session storage so another tab can join with its own seat while preferences remain shared.
- Preserve the host's unlimited timer for guests and keep its derived reset duration at zero.
- Clear stale room/host state after rejected restores, creations and joins, including a join that races with the draft starting.
- Bind bids, votes and sealed offers to their original draft/round. Reject timed actions after the server deadline and timestamp sealed offers on receipt.
- Compute accepted anti-snipe deadlines from the server clock.
- Expand the automated suite to 26 passing tests, including these regressions and a full six-player online draft.
- Verify the production Docker build, two-client multiplayer, persistent volume restart and seat restoration. Add `npm run test:container` for a repeatable check.

## 1.0.0 — 2026-11-11

- Preserve the public game interface, player pools, five locales, both game modes, AI managers, simulations and exports.
- Replace the original Firebase service with an independent Node/WebSocket backend and persistent local room data.
- Bundle fonts/data and generate a complete offline cache.
- Document behavior, architecture, source provenance and verification limits.
- Establish the local Git repository and pass the initial 18 automated tests.

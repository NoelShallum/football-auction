# Local releases

## 1.1.0 — 2026-11-11

- **Stadium Broadcast redesign.** New theme (`public/theme.css`): mown-pitch background, scorebug, a large player name over outlined position lettering, a paper-white bid card, broadcast line-up pitches, and a setup screen with a live match sheet.
- **Pro Database** pool: 10,863 players (7x the previous largest), built from the FIFA 15-23 ratings data by `scripts/import-ea.mjs`. Static server now gzips compressible assets.
- **Unsold players go to the back of the pack.** No more random assignment: an unsold player returns on the next pass at a 10% lower price, and the second time the manager with the most empty slots takes him, so squads always fill. No reroll is spent. Works offline, against AI and online.
- **Draw order** (phase-wise or random) is now a setting in both modes. Random uses the rating-weighted odds 6v6 already had.
- **Draft filters**: era (past & present, present day, legends), league, nation, and a quality floor, with an automatic floor for deep pools. Filters and draw order sync through online room settings; the server validates them.
- Fixed the AI opponent rows collapsing on the setup screen.
- 44 automated tests (new: unsold queue, draw order, filters, full drafts where nobody bids, 10,000-player drafts, server settings validation).

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

# Local releases

## Unreleased

- **No automatic assignment, anywhere.** A manager only ever gets a player by bidding for him. Removed: the Classic hand-out to the last manager who can use a position (it is now an unopposed round: bid the asking price, or decline; on a shared screen or against the AI the sale closes the moment they bid, online within the vote check), the leftover pick after a second no-bid (unsold players now keep coming back, 10% cheaper each time down to the floor, with no limit), and the fallback hand-out for positions the template never offers. If the table stops bidding for an extreme number of laps the draft ends with the squads as they stand and says so. Applies offline, against AI and online; the room server is unchanged (it never assigned players).
- **Flexible positions and lineups.** Players now carry every position they can play (`positions`, primary first; Messi is a striker, a centre-forward, an attacking midfielder and a right winger). Curated alternates for the best-known players live in `public/pools/positions.json`; the rest come from the pool data (EA secondary positions) and the mode's cover rules. The formation is no longer chosen before the draft: the default **Any** lets each manager build a squad and end up in whichever formation suits it, while a specific formation still locks the draft to that shape. A signing is legal when the squad can still be arranged into an allowed formation with everyone in a position he can play (`public/js/lineup.js`, bipartite matching), which replaces per-slot ownership in the local engine, the online host engine and the room server (`gameState.eligibleIds`).
- **Lineup editor** on the results screen: change formation, tap a player then a highlighted position to move him (he swaps with whoever is there when they can cover), or take the best lineup. Out-of-position players are marked, and the simulation only penalises a player for covering a position he has not played. Online, each manager edits their own lineup and shares it as `participants/{uid}/lineup`, re-checked by every client and validated by the server; lineups lock once a tournament is played.
- **Phase counter fixed.** A clean draft is one pass per participant, so six managers show "Phase 6/6"; passes after that (caused by unsold players) read "Extra lap N" instead of "Phase 7/6".
- **Smarter AI managers.** Value hunting: each manager also knows the going rate for a rating (scaled to the mode's economy) and bids on anyone on offer below it, if he would actually help the squad. New archetypes: **The Patriot** (backs one nation), **The Tinkerman** (loves versatile players) and **The Sniper** (waits for the last seconds); the Showman and Wildcard hold a grudge against the human leader. Opponents are now a random selection of the nine archetypes, fixed until the AI setup is reopened.
- 66 automated tests (new: lineups, position data, AI value hunting and tendencies, flexible-position drafts, server lineup validation, the no-auto-assignment guarantees).
- `npm run build:static`: a ready-to-upload bundle for static hosts such as Cloudflare Pages (no-room-server flag, `_headers`, `404.html`).
- The service worker now has its own opt-out flag (`AUCTION_NO_SERVICE_WORKER`, used by the artifact build), so static hosts keep offline play while still hiding online rooms.

## 1.1.0 — 2026-11-11

- **Stadium Broadcast redesign.** New theme (`public/theme.css`): mown-pitch background, scorebug, a large player name over outlined position lettering, a paper-white bid card, broadcast line-up pitches, and a setup screen with a live match sheet.
- **Pro Database** pool: 13,122 players (9x the previous largest). EA SPORTS FC 26 men's ratings are the present day; players from FIFA 15-23 who are no longer in FC 26 are the past, at their best rating in that data. Built by `scripts/import-ea.mjs`. The static server now gzips compressible assets.
- **Unsold players go to the back of the pack.** No more random assignment: an unsold player returns on the next pass at a 10% lower price, and the second time the manager with the most empty slots takes him, so squads always fill. No reroll is spent. Works offline, against AI and online.
- **Draw order** (phase-wise or random) is now a setting in both modes. Random uses the rating-weighted odds 6v6 already had.
- **Draft filters**: era (past & present, present day, legends), league, nation, and a quality floor, with an automatic floor for deep pools. Filters and draw order sync through online room settings; the server validates them.
- **Claude artifact build** (`npm run build:artifact`): the whole game as one self-contained page. Online play is hidden where no room server answers, notices show in the page instead of `alert()`, and exports use the host's `downloads` capability (plain download elsewhere). The service worker registration is guarded for sandboxed frames.
- Fixed the AI opponent rows collapsing on the setup screen.
- 49 automated tests (new: unsold queue, draw order, filters, full drafts where nobody bids, 10,000-player drafts, server settings validation).

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

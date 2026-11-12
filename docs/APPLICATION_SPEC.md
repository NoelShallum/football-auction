# Application specification

Reference inspected: `https://auctionxi.app/`, retrieved on 2026-11-11 UTC. This specification describes the public game delivered on that date. The source files, not marketing copy or outdated comments, determine the rules below.

## Screens and navigation

The frontend is a single document with screens toggled by JavaScript. There is no account/login or paid checkout flow.

1. **Loading:** player manifest/default pool load before the home screen is usable; failed loading offers retry.
2. **First visit:** language choice followed by illustrated onboarding; the home toolbar can reopen the tutorial. In-context control and sealed-bid explanations appear on first relevant use.
3. **Home:** Play with Friends, Shared Screen, Against AI, language picker, help, install controls, sound toggle, informational pages.
4. **Shared/AI setup:** player pool picker, participant count, game mode cards, formation, **draw order, the back-of-the-pack rule and draft filters**, participant names, per-manager budget, timer choices, ratings toggle, reroll setting, and a live **match sheet** summarising the draft. AI mode identifies the human and manager archetypes and hides rerolls.
5. **Online lobby:** create a room with a name or join using a six-character code and name. Name defaults are supplied for blank input.
6. **Waiting room:** code/share controls, participant list and ready state, host configuration, capacity, selected player pool, start/leave controls. Hosts can remove or remove-and-block a participant. A blocked name is a convenience restriction, not an account ban.
7. **Auction:** current formation slot, player name/nationality/club, optional rating, opening/current bid, leader, countdown, phase/round progress, bidding controls, passes/final-bids, reroll control, ticker, sold flash, pause/resume. Online shows the local bidder controls and a live squad panel, with shared state supplied by the host. Shared-screen shows controls for each participant. AI controls computer managers automatically.
8. **Results:** squads ranked by average rating (ties favor lower spend), formation pitches, total/remaining spend, squad breakdowns, draft statistics, player detail overlays, simulation format selection, exports, PNG shares, and another-draft/home actions.
9. **Simulation:** seeded fixtures, animated textual commentary, events, live score/statistics, match detail, ratings, tournament table/bracket, awards and share cards.

The visual design is the **Stadium Broadcast** theme in `public/theme.css`, loaded after `public/styles.css` (which keeps every structural and responsive rule): a mown-pitch background, a white-and-lime scorebug, the player as a large name over outlined position lettering, a paper-white bid card, and broadcast line-up pitches. Fonts, SVG artwork and pitch coordinates are unchanged. The clone updates the informational/privacy copy to describe its own server accurately.

## Modes and participant limits

| Property | Classic | 6 v 6 futsal |
| --- | --- | --- |
| Squad size | 11 | 6 |
| Budget per manager | 1,000M | 100M |
| Bid increment | 5M | 1M |
| Reserve per remaining empty slot | 20M | 1M |
| Opening price | Rating-based, rounded to 5M | 1M for every player |
| Selection | Progressive rank/phase ladder | Weighted random within filtered position categories |
| Repeated positions | A squad must fit an allowed formation; players stand in any position they can play | The same rule; DEF, MID and FWD are the positions |
| Last eligible participant | Automatic assignment at asking price | A bidding round still occurs |
| Match length | 90 minutes, with extra time where needed | 40 minutes, with shorter extra time |
| Match base expected goals per team | 1.32 | 3.9 |
| Red cards in simulation | Enabled | Disabled; bookings remain |

- Shared screen: 2–10 participants.
- Against AI: 2–6 total participants, including one human.
- Online: 2–6; host can select the room capacity.

Classic formations: **4-3-3, 4-2-3-1, 4-4-2, 3-4-3, 5-3-2**.

Futsal formations: **2-1-2, 2-2-1, 1-2-2**, plus one goalkeeper in each.

Classic labels duplicate roles using pitch coordinates, such as LCB/RCB and LCM/CM/RCM. Within one formation, slot indices are canonical for a squad's lineup (`posIdx`); managers can be in different formations, so a slot index only means something together with that manager's `formation`. Futsal categories fold GK separately, DEF from backs/wing-backs/centre-backs, MID from midfield roles, and FWD from ST/CF/LW/RW.

## Player catalogue and selection

The pool manifest is `public/pools/index.json`. Three available entries point to complete local JSON files:

| Pool | Records | Player keys |
| --- | ---: | --- |
| All-Time Greats | 1,501 | `id`, `name`, `position`, `rating`, `nationality`, `club`, `era`, `years` |
| Current Players | 840 | `id`, `name`, `nationality`, `club`, `league`, `position`, `secondaryPositions`, `rating`, `marketValue`, `foot`, `age` |
| Pro Database | 13,122 | `id`, `name`, `nationality`, `club`, `league`, `position`, `secondaryPositions`, `rating`, `era`, `years`, `foot`, plus `age` for current players |
| World Cup 2026 | 591 | `id`, `name`, `position`, `rating`, `nationality`, `club`, `group`, `team`, `era`, `years` |

IDs are unique within a pool, not across all pools. Every original data field is preserved in these source files. Auction round objects carry the fields the original game uses: identity, primary/base position, bought slot, rating, opening price, phase, nationality and club; a squad entry also carries its sale price. The extra catalogue fields are not additional simulation inputs.

Champions League, Copa América, Wonderkids, and Legends of the Game are disabled manifest entries without published player files. No speculative data is substituted.

Classic positional eligibility comes from the explicit cover map in `js/modes/classic.js`. A GK and a CB are specialists. Midfield/attacking/full-back cover is declared directionally and inverted into the map used to find candidates. The original draft uses the primary-position map, rather than interpreting the Current Players `secondaryPositions` arrays.

For Classic drafts of at most four participants, each underlying database position retains its top 83% by rating before cover positions are combined. Larger Classic drafts use the full eligible position pool. Futsal always retains the top 83% of goalkeepers and top 70% of each outfield category. Its draw weights are `normalized_rating ** 2.2 + 0.12`, so lower ratings remain possible.

Classic selections maintain a per-slot rank floor that moves down the stable pool order. Phase boundaries guarantee minimum depth; used player IDs are excluded across the entire draft. Empty bands widen down the pool before falling back to any unused eligible player. A truly exhausted pool has a synthetic fallback, but the setup depth check aims to prevent that situation.

Classic flash picks can draw a phase-zero elite player on eligible later rounds with probability 0.14 and a 1.35 opening-price multiplier, rounded to the pricing increment. Futsal disables flash picks.

## Positions and lineups

Every player has a `positions` list, primary first. It comes from the pool data (EA secondary positions), curated alternates in `public/pools/positions.json` for the best-known players, and is normalised in `public/js/players.js` (`normalizePlayerPositions`). A slot's fit for a player is 4 (his own position), 3 (a listed alternate), 2 (his primary covers it through the mode's cover map, a CM at CDM), 1 (an alternate covers it) or 0 (cannot play there) - `slotFit()` in `public/js/lineup.js`.

The formation is chosen by the manager after the draft, not before it. `FORMATION_CHOICE` is `any` (default: any formation of the mode is allowed) or one formation key (the draft is restricted to it). A manager may sign a player only if their squad plus him can still be assigned, one player per slot with fit above 0, in at least one allowed formation (`participantCanTake()`; maximum bipartite matching). This replaces slot ownership everywhere: bidding eligibility, auto-assignment, leftover picks, votes, the online host (`gameState.eligibleIds`, written by the host and checked by the server) and the AI.

After each signing `refreshLineup()` lays the squad out in its best formation: as many players as possible in positions they can play, then the best total fit, higher ratings winning contested slots, and the current formation winning ties. The results screen lets a manager change formation (refused unless the whole squad can play it), move a player to any position he can play (swapping with the occupant when the occupant can cover the vacated slot), or take the best lineup. Online each manager's edit is shared as `participants/{uid}/lineup {formation, slots[]}`; every client re-validates fit, the server validates the shape, and edits lock once the room has a `simulation`.

## Auction rules

The draft is paced by a **template** formation (the mode's default when the formation is `any`): its slots are shuffled into tokens and each pass offers one player per token, from that position's ladder. A token is a position, not a seat: whoever wins the player decides where he plays. A token nobody could use is skipped; if a whole pass is skipped while someone is still short of players, the first such manager is handed a player for a position they can still take (a "straggler" round), and the same happens if the pass cap is reached. The same player ID cannot be drafted twice from the active pool.

Maximum affordable bid:

```text
remaining_slots = squad_size - acquired_players
maximum = budget - reserve_per_slot * max(0, remaining_slots - 1)
```

Normal bids must be at least the opening price, or at least the current bid plus the mode's increment. A manager cannot bid while leading or when the player does not fit their squad (`participantCanTake`). A later valid bid clears that manager's own pass, preserving other managers' passes.

Timer choices are 10, 30, 60, 300 seconds, unlimited, or custom minutes up to 60. Later phases use:

```text
factor = max(0.5, 1 - max(0, phase - 1) * 0.1)
duration = max(10, round(base_duration * factor))
```

Unlimited stays unlimited. Timers derive from absolute deadlines, with server clock correction online. A valid bid within the closing 10 seconds extends the deadline to 10 seconds after that bid. Pausing preserves time remaining and gives it back on resume.

Passing/calling final bids is explicit and sticky until a new round or that manager bids again. The current leader counts as an implicit pass while leading. Once the eligible electorate has passed, the round shortens to a five-second grace window or settles immediately when untimed/without a live leader, as appropriate.

Exactly one bidding round per draft is selected for sealed bids. Only bidding rounds count, excluding Classic automatic assignments. The randomly selected target and final-slots safeguard prevent the round from being skipped. Offers remain visually hidden until reveal; highest valid offer wins, with equal offers resolved by earlier server receipt time. Sealed bids use the original party-game trust model; the transport is not a cryptographic sealed auction.

The clone binds each online action to its draft and round. Delayed bids, votes and sealed offers cannot apply to a replacement player or a restarted draft. The server also rejects bids/votes after a timed round's deadline, even when host settlement is delayed, and computes anti-snipe extensions using its own clock.

Reroll settings:

- Disabled: zero rerolls.
- Limited: five rerolls across the entire draft, despite the legacy internal key being `'3'`.
- Unlimited: a large internal sentinel, still limited to five rerolls in any individual round.
- AI mode: no rerolls.
- Once bidding has a leader, rerolling is unavailable. Sealed rounds cannot be rerolled manually.
- Classic votes count eligible connected managers; futsal reroll votes count the whole connected room. Final-bid votes count eligible connected managers in both modes.
- Futsal rerolls prefer a replacement of similar rating, widening the rating band if necessary. Classic continues its progressive ladder.
- Nobody bidding no longer spends a reroll or hands the player to a random manager. See **Unsold players** below.

## Draw order

How the next player is chosen is a setting of its own, `phase` or `random`, available in both modes. Each mode's default is its previous behaviour (Classic `phase`, 6v6 `random`), which is also what a saved game or a room created before the setting existed uses.

- **Phase-wise** is the ladder described above: each pass through the formation offers a weaker slice of the pool, stars first.
- **Random** draws any eligible unused player, weighted by `normalised_rating ** 2.2 + 0.12` (the 6v6 curve, now shared). Flash picks only occur on the ladder, and the last-eligible auto-assignment is another random draw rather than a "weakest band" pick.
- Online, the host's choice travels in the room settings; only the host draws.

## Draft filters

Narrow who can appear, on top of any pool: **era** (`all`, `present`, `legends`), **league**, **nation**, and a **quality floor** (`auto`, 75, 80, 85). Everything the draft reads goes through one filtered view, so selection, the AI's replacement estimates and the depth check agree. Filters that leave a position too thin block the start with the usual pool-depth message plus a hint to loosen them. Switching pools drops any filter the new pool cannot honour.

A pool may declare `draft.autoMinRating` (`[{upTo: participants, min: rating}]`); *auto* then applies the matching floor. The Pro Database uses 80 up to 4 managers, 76 up to 6 and 72 beyond, so phase 1 is not a random 73-rated player. Pools that declare none are unchanged. "Present" means in the pool's newest data (for the Pro Database, the EA FC 26 ratings, 2025-26); "Legends" are the pool's explicitly retired icons.

## Unsold players

A player who draws no bids goes to the **back of the pack**:

1. He joins the unsold queue and the draft moves on. His slot stays open, so it comes round on the next pass through the formation. Neither the ladder nor that slot's phase counter advances.
2. When that slot's turn comes round (a later pass, never the same one), he is offered **before** a fresh draw, opening 10% lower (from his original price, snapped to the bid step, never below the floor).
3. If he draws no bids a second time, someone must take him: the manager still needing the slot with the **most empty squad slots** (ties: the smaller budget, then seat order) at the lowered price, or the floor price if they cannot afford it past their reserve.

No reroll is spent, nobody is picked at random, and every squad fills. The extra passes are counted as "Extra lap N"; the safety cap on passes is `participants x 2 + 5`. Entries whose slot nobody needs any more are dropped. Online the queue travels in `gameState.unsold`.

## AI managers

Profiles: **The Gaffer, The Showman, The Accountant, The Rock, The Maestro, The Wildcard, The Patriot, The Tinkerman, The Sniper**. Opponents are a random selection of these, fixed until the AI setup is reopened. They have separate aggression, randomness, jump-bid likelihood, line preferences, willingness to prioritize stars over balanced spending, and:

- `valueSense`: trust in the going rate for a rating (`aiMarketValue`, the expected price scaled to the mode's budget per slot). A manager pays up to the higher of the squad-need ceiling and `market x valueSense`, so a player on offer below his worth draws bids even when the position is not an urgent need - but only if he is at least about as good as the replacement they expect (paying market price for a worse player is not value). The Accountant (1.3) is the bargain hunter; the Showman (0.55) barely cares.
- `rivalry`: a grudge - extra they will pay while the human is the leader.
- `patience`: The Sniper holds back until the clock is nearly out, never in a sealed or untimed round and never once everyone else has finished.
- `flagPull` / `flexPull`: extra for a favourite nation (The Patriot picks one at the start of the draft) and for each additional position a player can play (The Tinkerman).

The AI reuses the same auction and validation functions as shared-screen play. Valuations consider the player relative to replacements, remaining budget/slots, squad needs, position line and personality. Its thinking loop bids, passes, and submits sealed offers; it does not run a separate game engine.

## Multiplayer lifecycle

1. Create a six-character room code and host seat.
2. Join while waiting, within capacity; reuse a disconnected same-name seat when reclaiming.
3. Guests ready up and the host configures settings.
4. Starting resets every participant's budget/squad/filled positions from the room's selected mode.
5. The host draws players, schedules deadlines and settles each round. All clients render the same committed state.
6. Bids use optimistic compare-and-set with revision retries. Seat-scoped votes/sealed offers update their own subpaths. Settlement atomically updates game state and the winner's budget/squad/filled slots.
7. Disconnect instructions mark seats offline; reconnect re-arms presence. Room/user keys and the transport token are scoped to the browser tab in session storage and restore a seat on refresh. Same-name reclamation is allowed only for an offline seat. Rejected restores, creations and joins clear transient online identity before local play can begin.
8. A host departure ends the room. Falling below two connected managers mid-draft returns the room to waiting. These retain the original application's behavior rather than inventing a different host migration system.
9. Finished rooms show results. The host can start another draft with fresh budgets and squads. Host-published simulation format/seed yields identical results for all clients.

## Simulation and export

The simulation computes attacking, midfield, defensive and goalkeeper strength from ratings and positional weights. Its seeded generator drives expected goals, possession, chances, goals/assists, bookings, applicable dismissals, extra time and penalties. It also computes player ratings, man of the match, team of the tournament, and awards. Futsal has separate tempo/scoring configuration.

With two teams, the UI offers a single final or a two-leg aggregate tie. With three or more, it offers knockout or a double round-robin mini-league. Knockout formats handle byes. Teams are sorted by ID before seeding to ensure consistent online results.

Exports include JSON draft results, text via clipboard with download fallback, 1080×1350 PNG squad cards, and PNG result cards. The clone fixes the original text export's missing futsal/CF position codes and includes the mode and pool IDs in JSON settings.

## Persistence, languages, and offline use

Settings, sound preference, tutorial progress, chosen language and reconnection identifiers use browser storage. The five locales are English, French, Arabic, Spanish and Portuguese. Arabic switches the document to RTL; player names/country names and position codes remain original data. Missing translations fall back to English.

The clone precaches its complete local asset list, including fonts and databases. Offline shared-screen and AI play can use that cache after an initial online visit; multiplayer requires a reachable server. Runtime room snapshots reside only in the clone's data directory and are not part of the source repository.

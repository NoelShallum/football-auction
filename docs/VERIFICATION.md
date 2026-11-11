# Verification scope

Run the complete check with:

```sh
npm run verify
```

The verification uses Node's test runner, jsdom for DOM integration, actual loopback HTTP/WebSocket connections, temporary persistence files, and a native canvas implementation for PNG output. jsdom is a DOM test environment, not a graphical browser.

## Automated coverage

- Syntax of all frontend, server, build and test JavaScript.
- Local HTML/CSS asset references; no production Firebase configuration or analytics endpoints in runtime resources.
- Correct pool totals, unique pool-local IDs, and all five locale dictionaries.
- Boot, all published pool prefetches, all five language switches and Arabic direction.
- First-run language onboarding and saved settings.
- Formation/position eligibility, slot ownership, reserves, clocks and per-draft/per-round reroll caps.
- Pool depth for every offered formation at 2, 4, 6 and 10 participants.
- Complete local Classic draft and futsal drafts using each of the three player pools.
- Complete AI draft with distinct manager profiles.
- Full online Classic/futsal drafts with separate client DOMs and a real room server.
- Identical client squads, ready states, escaped chat, restarting drafts and resetting budgets/squads.
- Disconnected-seat restoration with the original seat ID and transport session.
- Deterministic seeded tournament results, both single finals/two-leg ties and multi-team formats.
- Shared simulation seeds producing identical online results.
- JSON/text exports, futsal text completeness, clipboard-unavailable fallback and real PNG card generation.
- Late-bid extension and pause/resume deadline preservation.
- HTTP/static/health responses, private-file/path handling, and browser-origin rejection on WebSocket upgrades.
- Room capacity, seat ownership, unauthorized state writes, and private ownership metadata.
- Simultaneous compare-and-set bids, reserve budgets, round/player integrity and paused-round rejection.
- Atomic update snapshots, seat-scoped chat/votes, and chat retention limits.
- WebSocket disconnect presence, reconnect ownership and offline-seat reclamation.
- Atomic snapshot persistence, token hashing, startup presence reset, expiration and invalid-path rejection.
- Service-worker precache completeness, offline asset/shell fallback and exclusion of live API/foreign-origin requests.

## Verification limits

Visual/pixel comparison, browser-specific layout, real touch/haptics/audio, native share sheets, and actual PWA installation have not been exercised in a graphical browser. The original HTML/CSS, fonts and active UI code are retained, but automated DOM checks do not prove pixel-perfect rendering.

The managed environment exposes no `cua_repl.js` browser-control tool in this session. The applicable [Sites skill](skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites/SKILL.md) explicitly states: “If `cua_repl.js` is unavailable, skip browser QA: do not start a preview server, install a browser, or improvise another browser-control path.” Consequently no preview server or substitute browser was used. Loopback servers in this suite are ephemeral protocol/test fixtures and are closed by the tests.

The Dockerfile is provided but a Docker image build has not been verified. There is no deployment or GitHub remote to verify yet. Internet-wide multiplayer latency, multiple backend replicas and load testing are outside the current local verification.

## Manual acceptance once a browser is available

1. Run `npm start`; inspect desktop and narrow mobile widths, including Arabic RTL and all screens.
2. Play a shared-screen draft, a solo AI draft, and an online room from two actual devices/profiles.
3. Exercise controls in normal and sealed rounds, pause/resume, rerolls/passes, and reconnect one device.
4. Complete drafts in both game modes, run each applicable tournament format, and use PNG/text/JSON sharing.
5. Install the PWA, reopen after disabling the network, and verify shared-screen/AI play from cached assets.

This checklist distinguishes the remaining device/browser verification from the automated functional tests already provided.

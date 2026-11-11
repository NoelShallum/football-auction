# Source and adaptation record

The reference is the public application at **https://auctionxi.app/**, inspected on **2026-11-11 UTC**. Its browser-delivered HTML, stylesheet, classic scripts, player pool files, translations, manifest, icons and social preview image were available as ordinary public HTTP assets. This repository retains that provenance; the reference application is not represented as originally authored for this project.

`source-inventory.json` records the original source URLs, byte counts and SHA-256 hashes at retrieval. These hashes describe source downloads, including files intentionally adapted afterward. The player pool files themselves are preserved byte-for-byte. Local fonts were downloaded through the same Google Fonts families/weights specified by the reference page, then their stylesheet was rewritten to relative local files.

Application source/translation text is normalized to LF line endings and stripped of trailing whitespace for Git maintenance. Database files retain their original bytes through explicit Git attributes.

## Preserved

- Original application screen structure, CSS, responsive breakpoints and visuals.
- Original Classic/futsal formation definitions, position maps, budget rules, timers, selection/pricing, rerolls, flashes, sealed bids, AI logic, result scoring and match simulation.
- All 2,932 pool records and their original metadata; all five translations.
- The host-authoritative room engine and shared snapshot schema.
- Player information panels, sound/haptics, tutorials, export controls, PNG card renderers and PWA installation controls.
- Original outbound social links as attribution hyperlinks. They do not load third-party scripts.

## Adapted for independent operation

1. Removed Google Analytics scripts/configuration and made existing analytics calls no-ops.
2. Removed Firebase SDK loading and the original Firebase configuration. The original project identifiers/credentials are not checked in.
3. Added `js/realtime.js`, `js/multiplayer-config.js`, and a new Node/WebSocket room service. Only the local service receives room state.
4. Added token-bound ownership, validated participant writes, atomic bid comparison/retries, clock sync, heartbeat presence, snapshots and room expiration.
5. Added explicit seat-claim calls to the original join/reconnect paths, so a connected seat cannot be replaced by an unrelated session.
6. Replaced Firebase server timestamps in simulation publication with the local corrected server clock.
7. Bundled the original fonts locally and removed production canonical/social metadata URLs that would misidentify this host as the original service.
8. Replaced privacy/terms/contact statements with accurate local-build information; the visible version line identifies this as the local edition.
9. Generated an asset-complete service worker with content-based revisioning. The original worker listed some files that were not part of the active page; the clone uses its actual tree instead.
10. Fixed text exports to include futsal `DEF/MID/FWD` and `CF` roles and to download when clipboard access is unavailable. JSON export settings also include game-mode and pool identifiers.
11. Escaped participant names in the results-card heading, consistent with the app's other text renderers.
12. Scoped room identities to individual tabs, preserved unlimited timer settings for guests, and cleared transient identity after failed room operations. Added draft/round guards for delayed actions, server deadline validation, server anti-snipe normalization, and server timestamps for sealed-offer ties.

The original page contains a comment describing an additional “FS SIM” engine but no corresponding active script includes. It is not an active public feature in the retrieved application. The real seeded match/tournament functionality is present in `js/results.js` and is included here. No undocumented private server source or database rules were accessed or assumed.

## Data observations

The manifest's `updated` value is `2026-08-05`. This is the source's own metadata, not an independently verified data-freshness claim. The World Cup source still contains an instructional “TEMPLATE” status despite having 591 actual player records; that original metadata is preserved. The four disabled “coming soon” pools have no published data-file entry, and remain disabled.

This clone is an independent local development project. The original application and its asset/source attribution remain distinct from the new room service, build tooling, tests and project documentation.

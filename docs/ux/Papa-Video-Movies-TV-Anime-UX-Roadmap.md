# Papa Video — Movies, TV & Anime: 150-item experience roadmap

Prepared 15 September 2026. Separate companion to the saved **Papa Audio — 160-item experience roadmap**. The original document remains preserved and unchanged.

## What was actually inspected

The Movies & TV feature is on **`feature/papa-video`**, not the main branch used for the first music review. Baseline: **`4f40eb46c4c69d4236cee2e528e0c649832461fa`**. This review inspected the video renderer, player, keymap, watch rules/store, anime numbering, playback planning, and existing video design/handoff documents. No application code was modified.

The branch already implements theatre controls, a web rendering path with native mpv fallback, mini-player motion, subtitle/audio selection, episode progression, skip handling, watch history, anime browsing, source selection, and offline-related workflows. This is a roadmap to refine and verify those capabilities, not a claim that they are missing. Old documents describe earlier missing controls and playback failures; those historical descriptions are **not** treated as proof of current defects.

No live desktop interaction, network-provider availability, real video playback, subtitle rendering, or hardware performance was verified in this review. Every runtime quality claim still needs a test. Network-facing validation should use owned, licensed, or public-domain fixtures and permitted sources.

## The experience standard

Find the right title. Know exactly which episode, cut, language, and version will play. Start watching promptly. Change controls without losing the scene. Leave and resume without losing progress. Recover from failure without guessing. For anime, respect numbering, release groups, dubbed/subtitled availability, and spoilers as first-class concerns.

“Every interaction” means every interactive surface × every supported input × every meaningful state. Passing a normal mouse click is insufficient: double activation, cancellation, keyboard focus, slow responses, unavailable media, and mode changes must also behave predictably. An exhaustive matrix is a release discipline, not a promise that bugs become impossible.

## How to use the list

- **P0:** playback, wrong-content prevention, data integrity, or essential access. A confirmed unresolved gap blocks the relevant release.
- **P1:** core experience quality. Build or verify in the next iteration.
- **P2:** refinement or distinctive functionality, after core quality.
- **F:** a source-level observation motivates the item; runtime impact remains unverified.
- **E:** an improvement target; may be partially or fully implemented already.
- **V:** verification or delivery process; not a feature request.

All entries start **Proposed / awaiting verification**. Resolve as Already satisfied, Implemented and verified, Deferred, or Rejected with rationale. Preserve IDs `V001`–`V150`; link existing code/tests and old plan IDs rather than creating duplicate work. Do not automatically carry main-branch music findings onto this newer feature branch.

## 1. Entering Movies & TV and browsing the catalog

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V001 | P1 · E | Make the video destination understandable. | Movies, TV, and Anime are visible choices with a clear active state; users never need to infer anime support from movie artwork. |
| V002 | P1 · E | Make source setup contextual. | Missing catalog credentials explain exactly what is unavailable; locally available video remains usable. |
| V003 | P1 · E | Remember the browsing context per tab. | Returning to Anime restores its position and preferences without borrowing Movies’ filters. |
| V004 | P1 · E | Put Continue Watching before promotional content. | An unfinished episode is reachable immediately with its title, episode, progress, and Resume action. |
| V005 | P1 · E | Make rail navigation predictable. | Ordinary vertical scrolling scrolls the page; horizontal gestures and explicit arrows move rails. |
| V006 | P1 · E | Prevent catalog refreshes from moving targets. | New artwork or recommendations do not displace a focused or hovered card mid-interaction. |
| V007 | P1 · E | Handle empty, stale, and unavailable catalogs separately. | A failed provider never appears as “There are no anime”; cached rows show their freshness. |
| V008 | P1 · E | Make hero rotation controllable. | Focus/hover pauses rotation; explicit controls work; reduced-motion preferences are honored; no unsolicited audio starts. |
| V009 | P2 · E | Let viewers customize useful shelves. | Users can hide/reorder shelves and recover defaults without losing My List or history. |
| V010 | P1 · E | Keep metadata badges truthful. | Ratings, year, runtime, and availability distinguish unknown values from zero or verified availability. |

## 2. Title details, trailers, and choosing to watch

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V011 | P1 · E | Use a consistent detail-page hierarchy. | Title, year, format, synopsis, primary watch action, and availability can be understood without scrolling through secondary facts. |
| V012 | P0 · E | Distinguish Play, Resume, and Start over. | Each label names its real behavior; Start over does not erase prior progress until playback actually starts. |
| V013 | P1 · E | Make trailer viewing a separate intent. | Trailers do not mark the film watched, replace its resume point, or trigger episode autoplay. |
| V014 | P1 · E | Preserve the journey into a title. | Back returns to the originating search or shelf with focus and scroll restored. |
| V015 | P0 · E | Prevent remake and edition confusion. | Year, runtime, and relevant edition/cut are visible before source playback; conflicting matches require a clear choice. |
| V016 | P1 · E | Make My List actions immediate and reversible. | Button and cards agree after add/remove; failed persistence rolls back and explains what happened. |
| V017 | P2 · E | Make cast and crew exploration useful. | Selecting a person opens relevant work, supports Back, and preserves the title context. |
| V018 | P1 · E | Order franchise collections honestly. | Release order is labeled; chronological order is offered only when supported by reliable data. |
| V019 | P1 · E | Make partial metadata a valid screen. | Missing poster, synopsis, rating, or cast does not prevent playback of a known file or show broken placeholders. |
| V020 | P1 · E | Add spoiler-safe detail presentation. | Unwatched episode descriptions, thumbnails, and revealing titles can be concealed until requested. |

## 3. Search, filtering, and discovery

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V021 | P1 · E | Make tab changes during search intentional. | Either retain the query as a scoped search or clearly reset it; behavior is consistent and tested rather than silently surprising. |
| V022 | P1 · E | Separate content discovery from source discovery. | Finding a catalog title does not imply that a playable copy exists; source status is communicated separately. |
| V023 | P1 · E | Match alternate title spellings. | English, native, romanized, and known alternate titles find the same anime without multiplying duplicate entries. |
| V024 | P1 · E | Make year and format disambiguation easy. | Same-name films, TV series, anime movies, OVAs, and specials are distinguishable in results. |
| V025 | P1 · E | Keep filters consistent between shelves and search. | Year ranges, decades, genre, media type, and availability have matching options and semantics. |
| V026 | P1 · E | Return useful results progressively. | Fast providers populate results without waiting for all sources; late results never steal focus. |
| V027 | P0 · E | Reject stale asynchronous results. | Query A cannot overwrite query B or repaint a closed detail page after navigation. |
| V028 | P1 · E | Make search failure recoverable. | Retry, simplify query, and check source status are offered appropriately; cancellation is not reported as no matches. |
| V029 | P2 · E | Explain recommendations and support rejection. | “Because you watched…” reflects real history; hide/less-like-this affects suggestions without altering watch records. |
| V030 | P1 · E | Make saved searches transparent. | A saved query retains its filters and clearly distinguishes manual reuse from optional background checks. |

## 4. TV seasons, episodes, and binge watching

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V031 | P1 · E | Make episode rows informative. | Number, title, runtime, air date, progress, and availability are readable with a distinct Play/Resume action. |
| V032 | P0 · E | Keep selected season and episode synchronized. | Detail page, source request, player title, next-episode target, and watch key identify the same episode. |
| V033 | P1 · E | Preserve season choice during refresh. | Metadata arriving late cannot jump the user back to season one or clear their selected episode. |
| V034 | P0 · E | Handle specials and split episodes explicitly. | Specials, double episodes, and differing provider numbering never silently resolve to a different episode. |
| V035 | P0 · E | Protect credits and post-credit scenes. | Next-episode prompts do not cover essential content or force an early transition; auto-advance can be disabled. |
| V036 | P1 · E | Make the next-episode countdown controllable. | Hover and keyboard focus both suspend it; Cancel remains reachable; Play now has a single effect. |
| V037 | P0 · E | Verify season-boundary handoffs. | A finale advances only to an existing appropriate next season; the final episode offers an honest end state. |
| V038 | P1 · E | Treat future episodes as future. | Air date is shown in the viewer’s timezone; an announced episode is never labeled playable without a source. |
| V039 | P1 · E | Make binge preparation optional and bounded. | Prefetch uses a visible policy and storage budget; stopping autoplay prevents further speculative work. |
| V040 | P1 · E | Make “Still watching?” dependable. | Genuine user interaction resets the inactivity count; background events do not; the prompt works with mouse and keyboard. |

## 5. Anime-specific precision and delight

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V041 | P0 · E | Make seasonal and absolute numbering visible when needed. | A viewer can inspect “Season 2 episode 1 / absolute 13” before choosing a release. |
| V042 | P0 · E | Preview and undo numbering overrides. | Changing the existing numbering override shows affected episode mappings and can be reset without deleting progress. |
| V043 | P1 · E | Distinguish sequels, split cours, movies, and side stories. | Related-title links explain their relationship and do not imply an unsupported definitive watch order. |
| V044 | P1 · E | Respect preferred release group per series. | The preferred group is highlighted; absence leads to a visible fallback choice instead of a silent mismatch. |
| V045 | P0 · E | Make intro/outro skip matching edition-aware. | Segments are validated against the episode duration/version; uncertain matches offer a button rather than an automatic jump. |
| V046 | P1 · E | Keep dub and subtitle availability distinct. | English audio, English subtitles, dual audio, and unknown language are separate states rather than interchangeable labels. |
| V047 | P1 · E | Remember anime language preferences at the right scope. | Global defaults can be overridden per series; an unavailable preferred dub does not silently claim to be selected. |
| V048 | P1 · E | Support ongoing anime without false completeness. | Known episode count, aired count, and available episodes remain distinct; unknown totals are not invented. |
| V049 | P2 · E | Offer spoiler-safe seasonal tracking. | Followed shows appear with next airing time and watched progress without exposing upcoming plot details. |
| V050 | P0 · V | Verify difficult anime identities with fixtures. | Split cours, absolute numbering, recap specials, multi-episode files, and a manual override all play the intended episode. |

## 6. Source selection and availability

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V051 | P1 · E | Explain why a source is recommended. | Match confidence, language, edition, expected compatibility, and availability matter more than a resolution badge alone. |
| V052 | P0 · E | Differentiate inferred from measured source information. | Filename-derived codec/language badges are labeled or replaced after probing; unsupported claims are not presented as verified. |
| V053 | P1 · E | Keep full release names inspectable. | Long names can expand or copy without making the ordinary source list unreadable. |
| V054 | P1 · E | Expose source health in plain language. | Connecting, no peers, stalled, ready, and failed are distinct; diagnostic counts are available on demand. |
| V055 | P0 · E | Validate the selected file inside season packs. | Episode choice resolves to the intended file, excludes samples/extras by default, and allows manual correction. |
| V056 | P1 · E | Preserve useful work when changing sources. | Completed valid data and preferences are retained where compatible; incompatible resume/edition changes are explained. |
| V057 | P0 · E | Make source switching transactional. | Only one intended playback session becomes active; late results cannot restart an abandoned source. |
| V058 | P1 · E | Make fallback choice explicit enough to trust. | An unavailable source can be replaced without silent changes to language, episode, cut, or quality constraints. |
| V059 | P1 · E | Retain usable cached catalog information during outages. | Offline details remain browsable; stale catalog data is not treated as proof that a source currently works. |
| V060 | P0 · E | Make cancellation stop the whole opening attempt. | Discovery, buffering, probing, transcoding, and pending player opening all respect the cancelled session identity. |

## 7. Starting playback and protecting picture and sound

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V061 | P0 · E | Show the real stage of startup. | Finding source, connecting, reading media, preparing playback, and buffering have meaningful states rather than one indefinite spinner. |
| V062 | P0 · E | Acknowledge Play before the network finishes. | The interface responds promptly, prevents duplicate sessions, and offers Cancel while work continues. |
| V063 | P0 · E | Avoid false “Playing” claims. | Playing state corresponds to advancing media; stalled audio/video, black frames, or failed decoding trigger appropriate feedback. |
| V064 | P0 · E | Keep music and video audio ownership clear. | Starting video follows a defined music pause policy; closing video does not unexpectedly restart or overlap music. |
| V065 | P0 · E | Restore playback through ordinary interruption. | Sleep, app backgrounding, engine restart, and recoverable connection loss preserve identity, position, and paused state. |
| V066 | P0 · E | Make rendering-path fallback understandable. | Switching between the web player and native mpv preserves progress and explains changed controls or capabilities. |
| V067 | P0 · E | Report picture transformations honestly. | Remux, video transcode, and HDR-to-SDR conversion are distinguished; no transcoded path claims untouched original output. |
| V068 | P0 · V | Verify color, aspect, and motion with media fixtures. | Reference clips retain intended geometry and color behavior; unsupported HDR or codec combinations have documented fallbacks. |
| V069 | P0 · E | Keep audio selection and output truthful. | Requested language, active track, decoded channels, and output layout are distinguishable; switching preserves synchronization. |
| V070 | P0 · V | Verify A/V synchronization across transitions. | Start, seek, speed change, track change, and native fallback stay within an agreed measured sync tolerance on supported hardware. |

## 8. Seeking, timeline controls, and scene navigation

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V071 | P1 · E | Give the timeline a generous hit target. | A thin visual line has a larger interactive area without covering neighboring controls or subtitles. |
| V072 | P0 · E | Separate scrub preview from committed position. | Dragging previews the target; background updates do not fight the thumb; release commits a single final target. |
| V073 | P0 · E | Make cancelled scrubs harmless. | Pointer cancellation or capture loss returns to the defined pre-drag state without an unintended final seek. |
| V074 | P1 · E | Make repeated seeks accumulate correctly. | Held keys or repeated taps show the pending target and do not oscillate because engine state arrives late. |
| V075 | P1 · E | Distinguish buffered, cached, and seekable regions. | Timeline coverage represents actual readiness rather than total bytes downloaded somewhere in a file. |
| V076 | P1 · E | Keep thumbnails accurate under rapid movement. | A late thumbnail never appears for the wrong timestamp or previous title; missing previews do not block seeking. |
| V077 | P1 · E | Make chapter navigation accessible. | Chapter names, times, and current state are available by keyboard; selecting one closes its menu predictably. |
| V078 | P1 · E | Support fine adjustment after a seek. | Frame stepping and small steps have visible controls/help and preserve pause state as specified. |
| V079 | P1 · E | Make remaining-time toggles discoverable. | Clicking the time readout has a tooltip/accessibility label and identical behavior in theatre and mini-player. |
| V080 | P0 · V | Stress test seeking through uncached media. | Rapid backward/forward seeks settle at the last requested scene; abandoned conversion runs do not accumulate without bounds. |

## 9. Subtitles, captions, language, and synchronization

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V081 | P1 · E | Name subtitle tracks meaningfully. | Language, forced, SDH, commentary, external, and release-specific labels help users choose the intended track. |
| V082 | P0 · E | Make subtitle selection state truthful. | A selected checkmark appears only when the active playback path can display that track; failure offers recovery. |
| V083 | P1 · E | Preview subtitle style changes. | Size, position, background, and contrast adjustments are visible and reversible without restarting the title. |
| V084 | P0 · V | Verify anime styling and fonts. | ASS/SSA positioning, signs, karaoke, embedded fonts, and image subtitles are checked on supported paths; limitations are explicit. |
| V085 | P1 · E | Keep subtitle text clear of controls. | Controls and up-next cards do not obscure dialogue; repositioning returns to the user’s chosen baseline afterward. |
| V086 | P1 · E | Make subtitle delay adjustment intuitive. | Earlier/later actions explain the direction, expose the offset, and offer reset while preserving playback. |
| V087 | P1 · E | Support local subtitle attachment. | Drag/drop and file-picker routes validate format, attach to the current title, and report failure without stopping video. |
| V088 | P0 · E | Match downloaded subtitles to the correct cut. | Language, duration/release match, and source are visible; replacing an existing track is deliberate. |
| V089 | P1 · E | Remember language choices without locking out exceptions. | Preferences apply on the next episode, with a clear fallback and an easy per-title override. |
| V090 | P0 · V | Test track changes on both rendering paths. | Audio/subtitle changes preserve position, mute, pause state, and sync; conversion delays show progress and can be cancelled. |

## 10. Mini-player, theatre, fullscreen, and window changes

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V091 | P1 · E | Make mini-player entry preserve continuity. | Picture, audio, timestamp, subtitles, and playback state survive minimize/restore without duplicate players. |
| V092 | P1 · E | Keep dragging attached to the pointer. | Card and picture move together within a measured frame budget; native-path differences are tested rather than hidden by animation. |
| V093 | P1 · E | Distinguish tap from drag consistently. | A small click movement does not reposition the card; a completed drag never also toggles playback. |
| V094 | P1 · E | Make settling interruptible. | Grabbing the card during a corner animation starts from its visible position without snapping backward. |
| V095 | P1 · E | Keep mini-player geometry safe. | Resizing, zoom changes, and a smaller window keep the entire card reachable without covering essential app controls. |
| V096 | P1 · E | Provide non-drag movement and resize controls. | Keyboard/menu actions choose a corner and size; a Reset position action recovers an awkward saved layout. |
| V097 | P0 · E | Distinguish Close from Minimize. | Close stops the intended video session; Minimize keeps it playing; labels and shortcuts match these outcomes. |
| V098 | P1 · E | Make fullscreen transitions predictable. | Double-click, button, F, and Escape follow one policy and preserve play/pause, focus, and subtitle settings. |
| V099 | P0 · V | Test multiple displays and scaling. | Moving between monitors, DPI changes, disconnects, and native fallback never orphan the picture or place controls offscreen. |
| V100 | P2 · E | Offer explicit system picture-in-picture where supported. | In-app mini-player and cross-app PiP are named separately, share session state, and have an obvious return action. |

## 11. Every click, tap, gesture, and key

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V101 | P0 · F | Separate mini drag cancellation from release. | `bindMiniDrag` does not let `pointercancel` take the tap-to-toggle path or fling/snap as if released intentionally. |
| V102 | P0 · F | Resolve single-click versus double-click ambiguity. | Theatre/mini double-click changes display mode without extra pause/play commands, regardless of delayed player-state updates. |
| V103 | P1 · F | Normalize wheel volume behavior. | Zero vertical delta does nothing; horizontal scrolling does not change volume; high-resolution trackpads do not cause sudden large jumps. |
| V104 | P0 · E | Give input focus priority over global playback shortcuts. | Typing, selecting options, and editing subtitle fields never triggers seek, play, screenshot, or next episode. |
| V105 | P1 · E | Make controls activate once. | Enter/Space, pointer release, and synthesized clicks cannot double-trigger the same button or source request. |
| V106 | P1 · E | Define touch behavior only on supported devices. | Single tap, double tap, and drag have documented non-conflicting roles, with visible alternatives for every gesture. |
| V107 | P1 · E | Keep menus usable while the player is active. | Outside click dismisses without accidental playback; wheel scrolls a long menu instead of changing volume; focus stays contained appropriately. |
| V108 | P1 · E | Make idle control hiding respect interaction. | Controls stay visible while hovered, focused, dragging, or editing; waking them does not accidentally activate a hidden target. |
| V109 | P0 · E | Route media keys to one active session. | Music, theatre, mini-player, native window, and OS controls do not compete or apply the same key twice. |
| V110 | P0 · V | Build and maintain the interaction coverage matrix. | Every interactive element has supported inputs, states, cancellation rules, expected outcome, and evidence; no required cell is left untested. |

## 12. Resume, watched state, diary, and personal lists

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V111 | P1 · F | Reconsider percentage-only resume eligibility. | The existing 5%/30-second start rule does not discard meaningful progress in long films; replay behavior is evaluated with real examples. |
| V112 | P0 · E | Keep one watched-state policy across surfaces. | Cards, player, Continue Watching, episode ticks, and external sync share the same tested rules and manual overrides. |
| V113 | P0 · E | Preserve the latest position on close and crash. | Graceful close flushes progress; interrupted shutdown recovers a recent checkpoint without overwriting newer history. |
| V114 | P1 · E | Let users remove a title from Continue Watching safely. | Hide from this shelf is separate from delete history or mark watched, and offers undo. |
| V115 | P1 · E | Make manual watched/unwatched changes reversible. | Single-episode and whole-season changes state their scope and restore previous records through undo. |
| V116 | P0 · E | Keep episode watch identity stable across sources. | Changing source or numbering display does not duplicate progress or attach it to another episode. |
| V117 | P1 · E | Separate rewatches from first-view completion. | Starting a rewatch preserves the earlier diary entry and tracks current progress without confusing recommendations. |
| V118 | P1 · E | Make diary edits and deletion trustworthy. | Notes, ratings, dates, and deletion persist accurately; cancellation changes nothing; destructive edits have recovery. |
| V119 | P0 · E | Make external watch synchronization conflict-aware. | Offline changes, remote edits, and reconnects merge by a stated policy without repeatedly toggling watched status. |
| V120 | P1 · E | Provide portable watch-data export and restore. | Lists, history, notes, preferences, and episode identities round-trip with a preview and backup before import. |

## 13. Saved video, offline use, storage, and privacy

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V121 | P0 · E | Distinguish streaming cache from saved media. | Cached temporarily, saving, saved, and available offline have separate labels based on actual file readiness. |
| V122 | P1 · E | Make season saves selective. | Users choose episodes, inspect size and language, and avoid downloading unwanted extras or entire packs by accident. |
| V123 | P0 · E | Protect explicitly kept videos from eviction. | Automatic cache cleanup respects saved items and active playback; storage accounting explains what can be removed. |
| V124 | P1 · E | Make storage management understandable. | Users see temporary cache, saved media, conversion cache, and free space with separate cleanup controls. |
| V125 | P0 · E | Recover from insufficient disk space. | Saving/conversion stops safely, keeps valid data, explains the required action, and resumes after space is available. |
| V126 | P0 · E | Preserve identity when saved files move. | Relinking a directory restores availability without deleting watch history, subtitles, or numbering overrides. |
| V127 | P1 · E | Verify offline readiness before promising it. | A saved title starts without network access and includes required subtitles/audio or explicitly states what is missing. |
| V128 | P1 · E | Make bandwidth limits apply to background work. | Saving, prefetch, and source checks respect user limits and do not undermine active viewing. |
| V129 | P0 · E | Explain source connections and sharing behavior. | Users understand which services receive queries and whether peer sharing occurs; controls reflect actual behavior. |
| V130 | P0 · E | Keep credentials and viewing data out of diagnostics by default. | Support exports redact tokens, local paths, and history unless the user deliberately includes reviewed information. |

## 14. Accessibility, visual clarity, and low-friction feedback

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V131 | P0 · V | Complete core workflows without a mouse. | Browse, select episode/source, play, seek, change subtitles, switch modes, and recover from failure work by keyboard. |
| V132 | P0 · E | Give every control a name, role, value, and state. | Screen readers can identify sliders, toggles, tabs, selected tracks, expanded menus, and current episode. |
| V133 | P0 · V | Verify focus across all player modes. | Theatre, fullscreen, mini-player, native fallback, and closed playback return focus predictably without traps. |
| V134 | P1 · E | Make text and controls readable at larger scaling. | At 200% scaling, core controls remain available and long titles do not overlap source or episode actions. |
| V135 | P1 · E | Use consistent loading and error presentation. | Errors identify the failed task and next action; background failures do not obscure the picture with repeated notices. |
| V136 | P1 · V | Verify contrast and non-color state cues. | Focus, selected source, watched state, buffer state, and failed downloads remain understandable without color discrimination. |
| V137 | P1 · E | Honor reduced motion throughout video browsing. | Hero movement, card effects, mini flights, and drawer animations reduce cleanly without losing feedback. |
| V138 | P1 · E | Support mixed-script metadata and captions. | Native/romanized titles, RTL text, punctuation, and subtitle alignment display correctly in fixtures. |
| V139 | P1 · E | Keep overlays within a defined visual hierarchy. | Subtitle menus, errors, up-next, skip buttons, and playback controls do not block each other or essential dialogue. |
| V140 | P2 · E | Give the video experience a coherent identity. | Cinema-focused artwork and restrained controls complement the music app while preserving predictable shared navigation and settings. |

## 15. Delivery process and release gates

Targets below are proposed acceptance budgets, not observed performance. Record reference hardware, OS, render path, media fixture, cache state, and network conditions before measuring.

| ID | Priority / type | Improvement | Done when |
|---|---|---|---|
| V141 | P0 · V | Reconcile this roadmap with existing video plans. | Completed work is linked and preserved; outdated “missing feature” claims are not treated as current bugs. |
| V142 | P0 · V | Test both playback paths and every advertised platform. | Web and native behavior have separate evidence; unsupported combinations are not implied to work by shared UI. |
| V143 | P0 · V | Build representative media and interaction fixtures. | Tests include film, episodic TV, anime, local file, controlled stream, season pack, multilingual tracks, styled/image subs, and variable codecs. |
| V144 | P0 · V | Define responsiveness and startup budgets. | UI acknowledgment targets 100 ms; warm supported local playback targets first frame within 1 second at p95; network timings are measured separately. |
| V145 | P1 · V | Measure mini-player motion and seeking. | Drag frame time targets a 16.7 ms p95 budget at 60 Hz; warm local seeks target visible settling within 500 ms on the reference setup. |
| V146 | P0 · V | Run an eight-hour viewing soak. | Mode switches, episode changes, track changes, and background saves cause no unexplained stop, wrong-title playback, or unbounded resource growth. |
| V147 | P0 · V | Inject failures at each asynchronous boundary. | Cancel, disconnect, engine crash, disk full, bad subtitle, expired source, and app close have verified outcomes without orphan sessions. |
| V148 | P1 · V | Conduct observed movie/TV/anime usability sessions. | Representative viewers complete core tasks without coaching; record confusion and gesture mistakes, not only completion counts. |
| V149 | P0 · V | Require behavioral evidence for each completed item. | A passing source-string assertion alone cannot prove gesture, playback, picture-quality, or focus behavior; evidence matches the claimed outcome. |
| V150 | P0 · V | Release only with a reviewed quality decision. | No unresolved critical playback, wrong-episode, data-loss, or essential-access blocker remains; supported capabilities and limitations are documented. |

## Interaction contract — the required behavior to test

This matrix defines proposed contracts. Validate them with users, then keep the chosen rules consistent. Native fallback may need a different input mechanism, but should not silently change the outcome. Touch rows apply only where touch support is claimed; they are not a claim that an Android app exists here.

| Surface / input | Expected result | Must not happen |
|---|---|---|
| Poster body: click/tap/Enter | Open that title’s details; retain return context. | Also start playback or toggle My List. |
| Poster Play button: click/Enter/Space | Start or resume that title once. | Bubble into card navigation and start a second session. |
| My List toggle: click/tap/Space | Change membership once with immediate truthful feedback. | Start playback or lose the change silently. |
| Episode row body | Reveal/select episode information under a consistent policy. | Start a different episode because metadata arrived late. |
| Episode Play/Resume | Open exactly the selected season/episode. | Reuse a stale previous episode’s source. |
| Source row activation | Commit one source-opening attempt, visibly cancellable. | Let repeated clicks launch concurrent players. |
| Theatre picture: single click | Toggle play/pause once after click arbitration. | Activate a control layered above the picture as well. |
| Theatre picture: double click | Toggle fullscreen and preserve prior playback intent. | Issue transient pause/play commands that race engine updates. |
| Mini picture: single tap/click | Toggle playback once if it was not a drag. | Move the card or restore theatre accidentally. |
| Mini picture: double click | Restore theatre without altering paused state. | Treat both releases as separate playback toggles. |
| Mini drag: move then release | Move, clamp, and settle at a reachable destination. | Toggle playback, trigger a source, or jump from stale coordinates. |
| Mini drag: pointercancel/lost capture | Abort safely, release capture, keep playback unchanged. | Treat cancellation as a tap or intentional flick. |
| Mini resize | Resize within reachable bounds with legible controls. | Seek, drag the whole card, or distort aspect ratio unexpectedly. |
| Seek click | Commit the selected timestamp once. | Also toggle play/pause through event bubbling. |
| Seek drag | Preview target, commit the final position under the agreed scrub policy. | Fight incoming timestamps or leave competing seeks active. |
| Seek cancellation | Restore the defined pre-drag intent; clear pending scrub work. | Commit a target solely because capture was cancelled. |
| Wheel over catalog | Scroll the page or an explicitly horizontal gesture. | Change video volume in the background. |
| Wheel over player picture | Apply optional normalized volume behavior. | Treat zero vertical delta as volume up or cause trackpad spikes. |
| Wheel over open track menu | Scroll the menu. | Seek or change volume underneath it. |
| Space on focused button | Activate that button once. | Also reach the global play/pause handler. |
| Typing in a field | Enter text and use ordinary editing shortcuts. | Trigger player shortcuts, including number-key seeks. |
| Held seek key | Accumulate an understandable target with bounded engine requests. | Stall the interface or snap back on each state update. |
| Escape | Close topmost menu/dialog, then leave fullscreen/theatre according to the documented hierarchy. | Close multiple layers or stop playback unexpectedly. |
| Up Next keyboard focus/hover | Pause countdown and preserve actionable controls. | Auto-advance while the user is choosing Cancel. |
| Skip Intro activation | Jump once to the validated segment end. | Skip a stale segment from the previous episode. |
| Subtitle selection | Apply the chosen track and show actual selected state. | Show a success checkmark while application failed. |
| Mini Close | Stop the session and save progress. | Leave hidden audio, download work, or conversion processes unintentionally active. |
| Change display/mode | Preserve session, picture geometry, focus, and progress. | Spawn duplicate video/audio or orphan a native window. |

## Coverage dimensions: what “through and through” means

For each interactive control, record the applicable combinations rather than claiming all possible devices were tested:

- **Inputs:** mouse click, double-click, wheel, high-resolution trackpad, keyboard, touch where supported, OS media keys.
- **States:** idle, loading, playing, paused, buffering, seeking, error, offline, finished, unavailable, disabled.
- **Surfaces:** catalog, detail, episode list, source picker, theatre, fullscreen, mini-player, native fallback, menus, dialogs.
- **Interruptions:** pointer cancellation, focus loss, app switching, rapid navigation, out-of-order responses, window resize, device disconnect, sleep, close.
- **Media:** movie, TV episode, anime episode, trailer, alternate edition, pack file, local saved file, remote stream.
- **Access:** normal and large text, keyboard-only, screen reader, reduced motion, mixed-script metadata.

Every required matrix cell should have a result, fixture, environment, and evidence link. Use pairwise coverage for broad compatibility; test high-risk combinations explicitly, especially source change during seek, cancellation during mode transition, and next episode during subtitle conversion.

## Source-grounded risks to reproduce first

1. **Cancellation can reach release behavior.** In `src/video-player.js`, `bindMiniDrag` assigns `endDrag` to both `pointerup` and `pointercancel`. That function includes the short unmoved picture-press playback toggle and release settling. Verify cancellation separately; do not assume pointer cancellation is a deliberate action. See V101.
2. **Double-click competes with playback toggling.** Theatre has both immediate click-to-toggle and dblclick-to-fullscreen handlers. Mini-player has release-based taps plus dblclick restore. Player state is delivered asynchronously, so “the second click undoes the first” is not a safe correctness contract without testing. See V102.
3. **Wheel input is direction-only.** The deck and stage use the sign of `deltaY` to apply a fixed 5-point change. A zero value follows the volume-up branch, and event frequency controls gain changes. Verify trackpad and horizontal cases. See V103.
4. **Resume uses percentage thresholds.** Current `src/watch-rules.js` uses 5%, at least 30 seconds, and a 92% watched threshold. For a two-hour film, stopping at five minutes is below the resume threshold. Review that experience without reintroducing inconsistent rules across surfaces. See V111–V112.
5. **Playback has meaningful rendering tradeoffs.** `src/stream-plan.js` and `web-stream.js` support remux/transcode choices and HDR conversion. `pictureInPage()` in the player gates smooth in-page behavior versus native embedding. Old blanket claims about untouched picture or identical mini-player interactions must be verified per route. See V066–V070 and V091–V100.

These observations are source findings, not claims of a completed live bug reproduction.

## Recommended implementation order

1. **Baseline and reproducibility:** V141–V143. Run the existing targeted tests and establish actual supported playback paths. Do not rebuild existing features from old plans.
2. **Interaction correctness:** V101–V110, V071–V080, V091–V099. Prioritize cancellation, double activation, focus ownership, and mini-player continuity.
3. **Trustworthy watching:** V032, V034–V037, V041–V047, V055–V070, V081–V090, V111–V116. Wrong episode, missing subtitle, false state, and lost progress outweigh cosmetic polish.
4. **Browsing and ownership:** V001–V030, V117–V130. Make selection, lists, offline use, and personal data coherent.
5. **Access and release:** V131–V150. Accessibility is implemented throughout; the final pass verifies it, rather than postponing it until the end.

Do not choose a new rendering architecture on appearance alone. Measure frame pacing, original picture preservation, subtitle fidelity, audio formats, seeking latency, CPU/GPU use, and fallback behavior first. A smooth mini-player is valuable only if it does not weaken watching quality.

## Source references

All implementation references below are pinned to the inspected commit so the roadmap does not silently change meaning when the branch moves.

- [Video player and interaction handlers](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/src/video-player.js)
- [Movies/TV/anime renderer](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/src/renderer.js)
- [Player keyboard map](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/src/video-keymap.js)
- [Shared watch rules](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/src/watch-rules.js)
- [Watch data persistence](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/src/video-store.js)
- [Anime numbering override](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/src/anime-numbering.js)
- [Playback format planning](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/src/stream-plan.js)
- [Web stream implementation](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/web-stream.js)
- [Existing video experience plan](https://github.com/swagofthenerd-gif/papa-audio/blob/4f40eb46c4c69d4236cee2e528e0c649832461fa/docs/video-experience-plan.md)

The original music roadmap remains a separate main-branch review. Before implementing shared-shell changes, compare both branches and retain the newer working behavior.

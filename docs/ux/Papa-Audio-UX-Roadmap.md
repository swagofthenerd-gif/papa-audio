# Papa Audio — 160-item experience roadmap

Prepared 15 September 2026. Source baseline: `e8e6013378c5d62c6a0870d6acd4e73edb665429`. Planning document; no application code changed.

## Product direction

An album-first music companion that makes a personal collection effortless to enjoy, understand, and grow. Local music, discovery, audio quality, and collection management should feel like parts of one product. The machinery stays available to enthusiasts without becoming homework for everyone else.

The standard is not maximum feature count or an untestable promise of perfection. It is reliable sound, predictable actions, truthful information, preserved user effort, accessible controls, and a reason to choose Papa Audio again tomorrow. Advanced features ship only when they strengthen those outcomes.

## Evidence, priorities, and use

This roadmap is grounded in inspection of the main-branch source obtained for this conversation. It is not a hands-on desktop usability study, audio measurement, security audit, or claim that all 160 features are absent. The first 12 preserve the previous review. Further entries include improvements to existing functionality, new proposals, and verification work.

- **F — Source finding:** the relevant behavior or implementation was observed in the source; runtime impact still needs confirmation where applicable.
- **E — Experience proposal:** a target experience to add or improve after checking existing coverage. Not a confirmed missing feature.
- **V — Verification/process:** a test, measurement, or working practice. Existing implementations may already satisfy it.
- **P0:** trust, playback correctness, user data, or essential access; address before broad release when the gap is confirmed.
- **P1:** core workflow quality; next product iteration.
- **P2:** differentiation or refinement; after core workflows meet their gates.

All items are **proposed or awaiting verification**, not completed. A row can be closed as Already satisfied, Implemented and verified, Deferred, or Rejected with rationale. Do not implement features merely to reach a number.

The repository already contains `docs/STABILITY-250.md` and `docs/AUDIT-2026-08-28.md`, with many fixes recorded. Link relevant entries to those records before implementation; preserve their existing decisions and regression coverage. Their historical claims were not independently rerun for this roadmap.

## A. The original 12 — preserved

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 001 | P1 · F | Remove the mandatory music-folder gate at first launch. | Offer Add my music, Explore music, and Set up later; browsing works with zero configured folders. |
| 002 | P1 · F | Move general settings out of Music Agent → Settings. | A permanent Settings entry opens General, Playback, Library, Connections, and Assistant without opening chat. |
| 003 | P1 · F | Make “Made for you” mixes deliver the experience their labels promise. | Cards open playable track lists with duration and explanation; otherwise rename them Browse by genre. No invented genre placeholders. |
| 004 | P0 · F | Separate clearing upcoming tracks from stopping playback. | Clear upcoming preserves the current song; Stop and clear is explicit; undo restores the intended playback and queue state. |
| 005 | P1 · F | Stop converting ordinary vertical wheel input into horizontal carousel movement. | The page continues scrolling vertically over album rows; horizontal gestures, Shift+wheel, and arrow buttons navigate the row. |
| 006 | P1 · F | Make search sources and availability understandable. | Local, online, and combined scopes are obvious; every result distinguishes Play, Download, and unavailable/waiting states. |
| 007 | P1 · F | Present downloads as album progress before transfer administration. | An album shows tracks ready, blockers, and next action; Rebalance and peer scheduling remain in advanced controls. |
| 008 | P0 · F | Make playback dependency setup platform-aware. | Missing-engine guidance matches the OS; Linux commands never appear as Windows instructions; non-playback browsing remains usable. |
| 009 | P1 · F | Reduce primary navigation density. | Home, Library, Explore, and Downloads lead; library subviews and management tools are grouped; advanced sidebar sections collapse. |
| 010 | P1 · F | Improve readability and offer Comfortable/Compact density. | Essential metadata and status text are readable at normal scaling; density changes spacing without hiding functionality. |
| 011 | P1 · F | Reduce repetition and give Home a listening-first hierarchy. | Continue listening, recent albums, and one discovery section lead; users can hide or reorder supplementary sections. |
| 012 | P1 · F | Bundle the intended font locally. | The chosen typeface loads offline under the app’s content policy; the current remote Google Fonts import is unnecessary. |

Source anchors: `src/index.html` (setup, settings, navigation, engine blocker), `src/renderer.js` (`init`, `renderHome`, mix handlers, `renderQueuePanel`, `setupListeners`, `renderSearch`, `renderDownloads`), `src/styles.css` (font import and text sizing), `package.json` (platform builds).

## B. First use and onboarding

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 013 | P1 · E | Explain the product in one plain sentence before setup. | A newcomer can distinguish local listening, online discovery, and optional assistant features without knowing mpv or slskd. |
| 014 | P1 · E | Make setup resumable. | Closing setup or restarting preserves completed steps and unfinished choices without forcing account reconnection. |
| 015 | P1 · E | Show import progress in useful units. | Scanning reports folders/tracks processed and makes found music playable before the full collection finishes. |
| 016 | P1 · E | Accept music folders through drag and drop. | Supported files/folders import through a visible drop target; rejected items receive a useful explanation. |
| 017 | P0 · E | Explain what adding a folder does. | The UI states whether files are indexed, copied, moved, or shared before the user commits. |
| 018 | P1 · E | Make online connections optional and independently configurable. | Failure or refusal to connect one service never prevents playing local files or configuring another source. |
| 019 | P1 · E | Provide actionable first-run empty states. | Empty library, inaccessible folder, unsupported files, and scan in progress have different messages and actions. |
| 020 | P1 · E | Offer a short optional listening walkthrough. | A user can learn Play, Queue, and Add to library using actual controls, and dismiss the walkthrough permanently. |
| 021 | P1 · E | Explain the download destination before the first download. | Users can see location, available space, and change destination without leaving the task. |
| 022 | P1 · V | Measure time to first successful listening session. | On a documented reference setup, at least four of five first-time testers play a supplied local track within two minutes without assistance. |

## C. Navigation and finding controls

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 023 | P1 · E | Unify navigation history across content types. | Back/Forward returns to the previous album, artist, search, or playlist with its filters and scroll position. |
| 024 | P1 · E | Make the current location explicit. | Selected navigation, page title, and nested location agree; users can return from an album to its originating collection. |
| 025 | P1 · E | Give every frequently used action a discoverable route. | Essential actions never require knowing a keyboard shortcut, middle-click, or right-click gesture. |
| 026 | P1 · E | Clarify Library versus folders on disk. | The app explains the distinction and offers an obvious switch between collection browsing and folder browsing. |
| 027 | P1 · E | Make sidebar preferences persist. | Group expansion, width, and pinned collections survive restart and remain usable after window resizing. |
| 028 | P1 · E | Make overlapping drawers cooperate. | Queue, lyrics, and assistant panels do not obscure essential controls; opening a panel has predictable layout behavior. |
| 029 | P1 · E | Give the command palette context. | Commands reflect the selected item and current page; unavailable commands explain why rather than silently doing nothing. |
| 030 | P1 · E | Standardize Escape behavior. | Escape closes only the topmost transient surface, then restores focus to its opener. |
| 031 | P2 · E | Add user-controlled pins for favorite destinations. | Albums, playlists, or saved searches can be pinned and reordered without duplicating their underlying data. |
| 032 | P1 · V | Check navigation with real task scenarios. | First-time testers can find output settings, a downloaded album, their queue, and a playlist without coaching. |

## D. Playback and listening continuity

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 033 | P0 · E | Use one truthful playback state everywhere. | Player bar, fullscreen player, tray, media keys, and assistant agree on loading, playing, paused, recovering, and failed. |
| 034 | P0 · E | Acknowledge Play immediately. | Pressing Play changes the visible state promptly, then reports actual engine playback or a recoverable error. |
| 035 | P0 · V | Verify gapless playback with real audio. | Known continuous-wave and live-album fixtures cross boundaries without unexpected inserted gaps on supported outputs. |
| 036 | P0 · V | Verify crossfade behavior end to end. | Short tracks, rapid skips, queue edits, and mode changes produce no doubled playback, wrong track, or unintended silence. |
| 037 | P0 · E | Preserve place through sleep and recovery. | Resume behavior respects the saved track, position, and paused state after sleep or an engine restart. |
| 038 | P0 · E | Handle output-device loss deliberately. | Unplugging headphones or a DAC does not unexpectedly blast speakers; the selected pause/fallback policy is clear and remembered. |
| 039 | P1 · E | Make seeking precise and forgiving. | Hover previews time; dragging has a generous target; keyboard seeking works; failed seeks do not leave a false timestamp. |
| 040 | P1 · E | Define Previous consistently. | The restart-current versus previous-track threshold is documented in the shortcut help and works identically across controls. |
| 041 | P1 · E | Make sleep timer state persistent and visible. | Users see remaining time, can extend/cancel it, and understand how it interacts with Stop after this track. |
| 042 | P0 · V | Preserve audio while background work is busy. | Imports, metadata fetches, downloads, and navigation do not cause audible dropouts in a defined stress scenario. |

## E. Queue and playlist behavior

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 043 | P1 · E | Make queue replacement intentional. | Album Play has a consistent replacement policy; a user can recover a displaced queue without a confirmation on every play. |
| 044 | P1 · E | Separate Now playing, Next up, and Previously played. | The queue exposes current position clearly and shows remaining listening time separately from total duration. |
| 045 | P1 · E | Specify insertion order for Play next. | Multiple Play next actions follow a documented order that matches visible feedback; no surprising reversals. |
| 046 | P1 · E | Support accessible queue reordering. | Dragging, keyboard movement, and menu commands preserve the current track and announce the new position. |
| 047 | P1 · E | Explain shuffle without hiding its effects. | Users can inspect upcoming shuffled order; toggling shuffle preserves the current song and a recoverable original sequence. |
| 048 | P1 · E | Make missing queue entries recoverable. | Missing files stay identifiable with Locate, Skip, or Remove actions instead of disappearing without explanation. |
| 049 | P1 · E | Distinguish saved queues from playlists. | A saved queue can represent a listening session and position; a playlist represents an ordered collection; labels explain the difference. |
| 050 | P1 · E | Make multi-track playlist editing safe. | Bulk add, remove, and reorder report the count affected and support undo without deleting audio files. |
| 051 | P1 · E | Let users choose duplicate policy per playlist action. | Adding existing tracks offers Skip duplicates or Keep both, with no silent global deduplication. |
| 052 | P2 · E | Make smart playlists explainable. | Rule previews show sample matches and counts; users can inspect why a song is included and freeze a snapshot. |

## F. Search and matching

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 053 | P1 · E | Return local matches before network results. | Local results remain usable while independent source indicators show which online searches are still running. |
| 054 | P1 · E | Keep result positions stable while results arrive. | A row under the pointer or keyboard focus never moves because a new source returned data; reranking is explicit. |
| 055 | P1 · E | Offer visible filter builders alongside operators. | Artist, year, format, source, and availability can be selected without memorizing query syntax. |
| 056 | P1 · E | Make result counts and “show more” honest. | Truncated sets show how many results are displayed and provide access to the remaining matches. |
| 057 | P1 · E | Distinguish empty results from source failure. | Offline, cancelled, timed out, rate limited, and truly no matches have distinct messages and recovery actions. |
| 058 | P1 · E | Improve multilingual matching. | Case, diacritics, Unicode normalization, and mixed-script titles are tested; exact artist/title matches stay highly ranked. |
| 059 | P1 · E | Group recordings without merging distinct editions. | Duplicate source listings can collapse, while remasters, live versions, and different releases remain selectable. |
| 060 | P1 · E | Preserve the search working context. | Opening a result and returning retains query, source scope, sort, filters, selection, and scroll position. |
| 061 | P1 · E | Make search cancellation complete. | Cancelling stops relevant work and prevents late results from replacing a newer query, without cancelling unrelated assistant work. |
| 062 | P2 · E | Turn saved searches into understandable subscriptions. | Users explicitly choose manual search or background checks and can inspect frequency, source, and stop controls. |

## G. Discovery and the collector experience

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 063 | P2 · E | Create a unified album page across sources. | One album view presents local copies, available editions, downloads, credits, and notes without conflating recordings. |
| 064 | P2 · E | Compare editions side by side. | Release year, label, track list, duration, format, and known provenance are compared; unknown fields stay unknown. |
| 065 | P2 · E | Explain recommendations in plain language. | Each recommendation offers a concrete reason such as a followed artist or selected genre, without overstating personalization. |
| 066 | P2 · E | Give users control over discovery breadth. | Familiar versus adventurous preferences affect recommendations and are easy to reset. |
| 067 | P2 · E | Support “less like this” without hiding the collection. | Recommendation feedback changes suggestions but never deletes or silently excludes owned music from Library. |
| 068 | P2 · E | Make rediscovery useful. | Forgotten favorites use actual listening history, show the reason for resurfacing, and exclude unavailable tracks by default. |
| 069 | P2 · E | Respect complete-album listening. | Album mode preserves disc order, avoids inserting recommendations between tracks, and keeps bonus-track choices explicit. |
| 070 | P2 · E | Add a listening journal with useful anchors. | Notes can attach to an album or timestamp and survive file moves; users can export them. |
| 071 | P2 · E | Offer a focused listening view. | Artwork, essential controls, and optional lyrics remain readable; decorative motion and extra metadata can be hidden. |
| 072 | P2 · V | Validate the product’s distinctive promise. | Collector interviews show that edition comparison, collection continuity, or album listening solves a repeated problem before expansion. |

## H. Downloads and online-source resilience

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 073 | P1 · E | Separate transfer completion from library readiness. | Downloaded, validating, importing, and ready-to-play are distinct; “Ready” means the file can actually be opened. |
| 074 | P1 · E | Make partial albums useful without looking complete. | Play available tracks works, missing tracks are explicit, and album completion remains visible. |
| 075 | P1 · E | Give failures a useful next step. | Offline peer, permission, disk-full, invalid file, and connection errors have tailored Retry, Change source, or Choose folder actions. |
| 076 | P1 · E | Make retries bounded and transparent. | Retry attempts/backoff are visible, stoppable, and never create an endless silent loop. |
| 077 | P1 · E | Preserve progress when switching sources. | Alternate sources are matched to the requested recording; completed valid files are retained rather than downloaded again. |
| 078 | P1 · E | Add user-controlled bandwidth and concurrency budgets. | Download limits persist and respect a listening-priority mode without misreporting paused work as failed. |
| 079 | P0 · E | Check disk capacity and destination access early. | Insufficient space or unwritable paths are detected before avoidable transfer work and produce a recoverable choice. |
| 080 | P1 · E | Specify Pause, Cancel, and Remove behavior. | Each action explains whether partial files are retained, transfers can resume, and local audio is removed. |
| 081 | P1 · E | Notify once at the useful completion boundary. | Album-ready notices aggregate track completions and offer Play album; a large batch does not flood notifications. |
| 082 | P1 · E | Make wishlist automation explicit. | Each wishlist entry shows manual versus automatic behavior, last check, and pause/remove controls; copy matches actual automation. |

## I. Library integrity and metadata

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 083 | P0 · E | Keep identity stable when files move. | Likes, history, notes, playlist membership, and queue references survive a supported move or rename. |
| 084 | P0 · E | Distinguish disconnected storage from deletion. | An unplugged drive marks tracks temporarily unavailable without pruning their personal metadata. |
| 085 | P1 · E | Offer a guided relink workflow. | Selecting the new root repairs matching paths with a preview of matches and unresolved files. |
| 086 | P1 · E | Separate exact duplicates from alternate editions. | Duplicate review distinguishes byte-identical files, matching recordings, and different releases before any removal. |
| 087 | P0 · E | Make tag-write scope and persistence explicit. | Every editor states file tags versus app-only metadata, reports partial failures, and shows durable success only after saving. |
| 088 | P1 · E | Preview artwork changes. | Users see the candidate, resolution, target albums, and replacement behavior before applying artwork. |
| 089 | P1 · E | Model compilations and multi-disc albums correctly. | Album artist, track artist, disc order, and disc totals remain distinct in browsing and playback. |
| 090 | P1 · E | Make health reports action-oriented. | Missing files, unreadable tags, duplicates, and incomplete albums link to repair actions with previews and outcomes. |
| 091 | P0 · E | Preserve file-operation undo and recovery. | Move, rename, and trash operations either complete consistently or leave a recoverable operation record after interruption. |
| 092 | P1 · E | Support portable collection exports. | Playlists, likes, notes, and metadata can export in documented formats with clear handling of missing or external paths. |

## J. Audio quality and honest technical information

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 093 | P0 · F | Correct overconfident quality badges. | `updateBitPerfectBadge` must not label arbitrary non-HTTP files LOSSLESS; bit-perfect claims must account for codec, active processing, and verified output conditions. |
| 094 | P1 · E | Explain the signal path. | A details view separates source format, decoder, processing, output sample rate, and device; unavailable measurements are labeled unknown. |
| 095 | P1 · E | Make ReplayGain choices understandable. | Track and Album leveling have short explanations and missing-tag behavior; users can hear changes without losing their place. |
| 096 | P0 · E | Prevent surprising gain jumps. | Boost, preamp, normalization, and device switches obey a documented gain policy and show clipping risk when relevant. |
| 097 | P1 · E | Explain exclusive-mode tradeoffs before activation. | Users understand device access and other-app behavior; failure leaves a clear route back to system output. |
| 098 | P1 · E | Show the actual active device. | The player distinguishes requested from active output and reports fallback rather than retaining a misleading device label. |
| 099 | P1 · E | Make EQ presets reversible. | Preview, bypass, reset, and restore work without overwriting a custom preset unintentionally. |
| 100 | P1 · E | Distinguish channel layout from channel count. | Stereo, surround, and downmix status follow actual media/output information rather than filename assumptions. |
| 101 | P2 · E | Remember settings per output device. | Headphones and speakers can have separate profiles; unavailable devices never silently activate inappropriate gain/EQ. |
| 102 | P0 · V | Verify quality labels against audio fixtures. | Lossy, lossless, high-resolution, resampled, EQ-enabled, and speed-adjusted fixtures produce accurate labels and explanations. |

## K. The music assistant

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 103 | P1 · E | Show supported assistant capabilities before prompting. | Example requests reflect available connections and real tools; unavailable capabilities are explained. |
| 104 | P1 · E | Preview consequential multi-step plans. | Bulk downloads, file changes, or queue replacement show scope before execution when the user has not already authorized it. |
| 105 | P1 · E | Separate recommendations from actions. | “You might like” never looks like “Added”; action receipts identify what actually played, downloaded, or changed. |
| 106 | P0 · E | Make Stop stop the assistant’s work. | Cancellation prevents new actions, reports in-flight work honestly, and leaves the user’s current playback alone unless requested. |
| 107 | P1 · E | Use structured result cards. | Suggested albums expose source, edition, availability, and direct actions rather than requiring another chat message. |
| 108 | P1 · E | Ask targeted questions for genuine ambiguity. | Two similarly named artists or releases produce a small choice; obvious local playback requests execute directly. |
| 109 | P1 · E | Explain taste memory and let users edit it. | Users can inspect, correct, exclude, and delete individual preferences rather than only clearing everything. |
| 110 | P0 · E | Make cloud data sharing explicit. | Provider setup states what leaves the device; secrets and unrelated local paths are excluded from prompts and receipts. |
| 111 | P1 · E | Make provider failure recoverable. | Invalid key, quota, timeout, and offline states have specific guidance; playback and non-assistant controls remain usable. |
| 112 | P2 · E | Support bounded session requests. | “Play 45 minutes of familiar instrumental music” produces an inspectable queue and explains any unmet duration or availability constraint. |

## L. Accessibility and inclusive interaction

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 113 | P0 · V | Complete a keyboard-only task pass. | Import, search, play, seek, queue edit, settings, and error recovery are possible without a pointer. |
| 114 | P0 · E | Give sliders proper accessible semantics. | Seek and volume expose names, current values, bounds, and keyboard operations to assistive technology. |
| 115 | P0 · V | Test focus through dialogs and redraws. | Focus remains visible and meaningful after search updates, modal dismissal, row removal, and restored navigation. |
| 116 | P0 · E | Announce useful state changes without chatter. | Errors, completed actions, and loading transitions are announced; elapsed time does not flood screen-reader output. |
| 117 | P1 · V | Measure contrast in all interaction states. | Text, focus indicators, selected rows, and disabled controls meet the chosen accessibility criteria in both densities. |
| 118 | P1 · E | Offer alternatives to drag and hover. | Reorder, resize, reveal actions, and swipe outcomes can be achieved using visible buttons or menus. |
| 119 | P1 · V | Preserve reduced-motion preferences throughout the app. | Artwork, greetings, drawers, carousels, and loading effects honor the setting without hiding progress. |
| 120 | P1 · E | Support zoom and larger system text. | Essential controls remain visible and operable at 200% content scaling in a supported desktop window. |
| 121 | P1 · E | Support right-to-left and mixed-language metadata. | Arabic/Urdu titles, Latin artist names, punctuation, and durations display and truncate in a readable order. |
| 122 | P1 · V | Test with actual assistive technology. | Document results using a supported screen reader on each release OS; semantic markup alone is not the acceptance test. |

## M. Visual consistency and feedback

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 123 | P1 · E | Establish a small shared component system. | Buttons, fields, tabs, menus, and status messages use consistent dimensions and state behavior across pages. |
| 124 | P1 · E | Make primary actions visually consistent. | The main action on a page is identifiable; destructive actions never resemble ordinary collection navigation. |
| 125 | P1 · E | Create a coherent icon language. | The same concept uses the same icon and name; unfamiliar icons have discoverable text labels. |
| 126 | P1 · E | Standardize loading feedback by duration and task. | Brief work gets lightweight feedback; longer work exposes progress/cancellation instead of an indefinite generic spinner. |
| 127 | P1 · E | Use one notification hierarchy. | Routine success is quiet, actionable failure persists appropriately, and a notice history retains relevant missed events. |
| 128 | P1 · E | Make long metadata usable. | Long titles have sensible truncation plus a way to read the full value without constant scrolling animation. |
| 129 | P1 · E | Improve absent-artwork presentation. | Fallbacks remain consistent and distinguish albums without implying that a fabricated image is official artwork. |
| 130 | P1 · E | Keep status independent of color alone. | Playing, selected, unavailable, failed, and complete states include shape, text, or icon cues. |
| 131 | P2 · E | Give Papa Audio a distinct visual identity. | Typography, spacing, artwork treatment, and a restrained accent system feel intentional while retaining familiar player conventions. |
| 132 | P1 · V | Review visual states as a matrix. | Empty, loading, partial, error, offline, selected, and populated screens are checked at supported sizes before release. |

## N. Desktop behavior, performance, and trust

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 133 | P0 · V | Test fresh-machine installation for each supported OS. | A clean install launches, imports, and plays a supplied file without developer tools or undocumented setup. |
| 134 | P1 · E | Support useful compact desktop windows. | A narrow supported window preserves playback and navigation; the minimum width follows tested layout needs. |
| 135 | P1 · V | Verify media keys, tray, and close behavior together. | Each action follows user settings and does not create hidden duplicate instances or leave playback uncontrollable. |
| 136 | P0 · E | Protect credentials at rest and in logs. | Use appropriate OS-backed secret storage where available; exports, diagnostics, and errors redact credentials. |
| 137 | P0 · E | Explain and control network sharing. | Users know whether folders are shared to peers; defaults, scope, and disable controls are explicit. |
| 138 | P1 · E | Keep cached collection use functional offline. | Library, playlists, notes, history, and local playback work while network features show bounded unavailable states. |
| 139 | P0 · E | Make updates recoverable. | Updates preserve user data and settings, have migration backups, and offer a documented recovery route if launch fails. |
| 140 | P1 · E | Make large-library views scale with visible content. | Rendering/indexing strategy keeps scrolling, searching, and selection responsive at the agreed collection-size benchmark. |
| 141 | P1 · E | Provide a user-reviewed diagnostic export. | A support bundle shows included information, redacts secrets, and lets users exclude identifying paths and listening history. |
| 142 | P0 · V | Test long-session resource behavior. | A defined multi-hour listening/search/download run shows no unbounded resource growth or accumulation of abandoned work. |

## O. Engineering and design processes

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 143 | P1 · V | Maintain one linked improvement backlog. | This roadmap references existing audits; fixed issues are not reopened without evidence, and duplicate proposals share one owner. |
| 144 | P1 · V | Validate risky workflows before detailed styling. | Onboarding, search, queue replacement, and download recovery have reviewed interaction prototypes before broad implementation. |
| 145 | P1 · V | Recruit users with different listening habits. | Feedback covers a casual listener, album collector, large-library user, keyboard user, and accessibility participant. |
| 146 | P0 · V | Convert important failures into behavioral regressions. | Tests exercise observable outcomes such as preserved queue position or truthful errors, not only expected source strings. |
| 147 | P0 · V | Separate simulated tests from hardware verification. | Release notes identify what passed with stubs and what passed using real mpv, devices, and operating systems. |
| 148 | P1 · E | Refactor state ownership incrementally. | Playback, queue, library, search, and settings have clear owners; migration preserves behavior rather than replacing the entire app at once. |
| 149 | P0 · V | Exercise failure injection deliberately. | Network loss, full disk, stale credentials, missing files, cancelled dialogs, and engine crashes each have a verified recovery path. |
| 150 | P1 · V | Collect friction evidence with explicit consent. | Optional feedback/metrics exclude listening content by default and identify task failures rather than collecting unnecessary personal data. |
| 151 | P1 · V | Ship in small validated batches. | Every batch identifies changed workflows, completion evidence, risks, and rollback; no large feature dump bypasses verification. |
| 152 | P1 · V | Keep user documentation aligned with shipped behavior. | Installation, shortcuts, supported formats, source setup, and troubleshooting match the tested release rather than aspirational plans. |

## P. Release gates — the standard to earn trust

These are proposed targets, not measurements already achieved. Agree a reference computer, OS, storage, output device, and dataset before recording results. Measure local and network-dependent tasks separately.

| ID | Priority / evidence | Change | Completion criterion |
|---|---|---|---|
| 153 | P0 · V | Establish a playback response budget. | Local Play feedback appears within 100 ms; warm local audio starts within 500 ms at p95 on the reference setup, or the target is revised with evidence. |
| 154 | P1 · V | Establish startup and search budgets. | With a 10,000-track cached library, usable startup is under 3 seconds and local search under 200 ms at p95 on the reference setup. |
| 155 | P0 · V | Pass a continuity soak. | Eight hours of local listening with queued transitions, navigation, and background imports produces no unexplained stop or wrong-track transition. |
| 156 | P0 · V | Pass an interruption-recovery matrix. | For each agreed interruption, the app preserves user data and offers a working recovery path; none requires guessing whether an operation succeeded. |
| 157 | P0 · V | Pass a data-preservation round trip. | Export/restore and supported migrations retain playlist order, likes, notes, queue references, and metadata associations in fixture comparisons. |
| 158 | P0 · V | Pass essential accessibility journeys. | No keyboard trap or unnamed essential control remains in the core-task matrix; screen-reader findings have explicit resolutions. |
| 159 | P1 · V | Validate usability with representative participants. | At least four of five participants complete the agreed core tasks without help; record every failure rather than treating a small sample as universal proof. |
| 160 | P0 · V | Apply a release decision with evidence. | No unresolved critical playback/data-loss issue ships; all claimed differentiators work end to end; known limitations and verification scope are documented. |

## Implementation sequence

1. **Establish the baseline.** Reconcile existing audits and reproduce source findings. Record OS/device support and reference performance. Preserve already-working behavior.
2. **Protect trust.** Resolve confirmed P0 gaps: queue clearing, playback setup, audio claims, data integrity, and core accessibility. Validate on real playback hardware.
3. **Simplify daily use.** Implement the original P1 recommendations, search clarity, queue semantics, download readiness, and metadata persistence. Test complete tasks after each batch.
4. **Build the distinctive experience.** Develop the unified album page and edition comparison first; add explanatory discovery and listening notes only after collector feedback.
5. **Earn release readiness.** Run gates 153–160, resolve failures, and publish an honest support/limitations statement. P2 breadth never compensates for a failed P0 gate.

Dependencies: stable library identity (083) underpins relinking, exports, notes, and unified album pages; truthful playback state (033) underpins recovery and assistant receipts; source/edition matching (059) underpins alternate downloads and comparison; a shared component system (123) underpins consistent accessible controls.

## Additional source findings worth verifying first

- `updateBitPerfectBadge` currently checks exclusive mode, source metadata, speed, and ReplayGain before claiming BIT-PERFECT, without evaluating all processing/output conditions. Its fallback labels non-HTTP paths LOSSLESS without codec classification. This directly motivates 093 and 102.
- `editField` contains an app-only update path that announces “visual only — save to file coming soon.” Other tag-editing modules exist. Verify each entry point rather than concluding that all tag editing is nonpersistent; this motivates 087.
- `playAlbum` and `playTrack` replace the queue; standalone helpers preserve a previous queue separately. This motivates a unified user-facing policy in 043, not a claim that every queue replacement is a bug.
- The desktop window currently declares a 950px minimum width. Evaluate compact desktop support in 134 rather than assuming responsive CSS makes the shipped window small-screen compatible.
- The code already contains accessibility work, recovery notices, a context-sensitive menu model, persistence helpers, and many tests. Items in those areas are extensions or verification obligations, not instructions to recreate them.

## Sources

- [Interface markup](https://github.com/swagofthenerd-gif/papa-audio/blob/main/src/index.html)
- [Renderer and interaction logic](https://github.com/swagofthenerd-gif/papa-audio/blob/main/src/renderer.js)
- [Styles](https://github.com/swagofthenerd-gif/papa-audio/blob/main/src/styles.css)
- [Desktop main process](https://github.com/swagofthenerd-gif/papa-audio/blob/main/main.js)
- [Build configuration](https://github.com/swagofthenerd-gif/papa-audio/blob/main/package.json)
- [Context-menu behavior](https://github.com/swagofthenerd-gif/papa-audio/blob/main/src/ctx-menu-model.js)
- [Existing stability backlog](https://github.com/swagofthenerd-gif/papa-audio/blob/main/docs/STABILITY-250.md)
- [Existing August audit](https://github.com/swagofthenerd-gif/papa-audio/blob/main/docs/AUDIT-2026-08-28.md)

## How to maintain this roadmap

Keep IDs stable. For each implementation, add status, owner, related existing-audit ID, reproduction evidence, design decision, implementation link, and acceptance result. Mark an existing feature Already satisfied only after checking its completion criterion. Keep rejected ideas with their rationale. A completed item means the user outcome was verified, not merely that code was written.

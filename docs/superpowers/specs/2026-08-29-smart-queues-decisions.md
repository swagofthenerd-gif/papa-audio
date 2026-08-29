# Smart Queues — decisions made during implementation

Written 2026-08-29. Companion to `docs/superpowers/specs/2026-08-29-smart-queues-design.md`.

The plan for this feature contained **15 real defects**, each found during execution. Every one was
ruled on rather than silently patched, because a quiet correction to a broken spec is
indistinguishable from a bug to whoever reads the code next. These are those rulings, in order.

Six were caught by implementers who stopped and reported instead of working around the problem.
Three were caught by driving the running app rather than by any test. The most serious — that
`aspectralstats` prints nothing, so half the feature vector was unobtainable — passed every unit
test in the suite, because they all used a fake.

---

### 1

Task 7's surround-ratio test may be flaky as written — its fixture pool is 50% surround, and SURROUND_BONUS 1.2 at surprise temperature 2.5 gives roughly exp(0.48)=1.62x weight, i.e. ~62% expected, right on the test's 0.6 lower bound. Implementer is instructed to run that test repeatedly across seeds and, if it flakes, raise SURROUND_BONUS rather than widen the assertion — the spec's 70-80% target is the binding requirement, not the test's bound. Cost if wrong: a tuned constant that needs re-tuning against the real library later.

### 2

the plan's Task 11 leaves `allLibraryTracks()` and `readHistoryEntries()` as contracts. Resolved before dispatch from the real codebase so the implementer does not guess — library cache is `sideStores.libraryCache` (name 'library-cache'), history is `sideStores.playHistory` (name 'play-history', fallback []), `USER_DATA` is defined at main.js:290, and `player.getState()` exists on both MpvEngine and MpvCrossfade. Cost if wrong: Task 11 needs a correction round.

### 3

the BRIEF'S OWN CODE is also wrong, so this is a plan defect, not just an implementer error.
`Math.sqrt(varc) || 1` never fires for a constant dimension: float error in the mean leaves
varc≈3e-33, so sqrt≈5.5e-17 which is truthy, sd becomes 5.5e-17, and z = (v-mean)/sd = **1.0** —
full-scale noise on a dimension that never varies. Verified numerically before ruling.
Correct floor is a threshold, not a truthiness check:
const s = Math.sqrt(varc); sd[k] = s < 1e-9 ? 1 : s
This preserves real spreads (the implementer's bug) AND neutralises constant dimensions (the
brief's bug). Cost if wrong: similarity weighting is off across all four queue modes, visible as
queues that feel arbitrary; caught by the ratio/coherence tests in Task 7.

### 4

revert to the brief's `s / max`. The implementer's stated reason (preserving LIKED_BOOST)
is wrong — s/max divides every score by the same scalar, so it preserves ordering and the boost
alike. Cost if wrong: favourites stop surfacing; caught by Task 7's affinity test.

### 5

KEEP the implementer's `historyCount` addition, and document it as a correction. The brief
is defective here, not the implementer: its code derives `count` from playCounts only, so a
history-only track scores log1p(0)=0 and is filtered by the `score > 0` gate — yet the brief's own
legacy-timestamp test asserts that track has affinity > 0. The brief could not pass its own test.
Second plan defect found this task. Cost if wrong: history-only tracks get no affinity, which is
exactly the 463 legacy entries this feature exists to recover.

### 6

the brief's liked-boost test is ALSO impossible under the correct `s / max` normalisation —
with a single track in the map, max == s, so affinity is 1.0 whether liked or not, and the brief's
`liked > base` assertion can never hold. Verified numerically. Third plan defect this task.
The implementer's replacement (two tracks; liking x raises the max so y's relative score falls)
tests the same property validly and is accepted. Cost if wrong: the liked boost could regress
undetected; mitigated because Task 7 exercises affinity end to end.

### 7

add an injected `now = Date.now()` parameter and pass it to normaliseHistory, matching
buildAffinity and buildColdSet. Cost if wrong: none material — it is a determinism fix; the risk
of NOT doing it is a time-dependent test that passes today and fails at a date boundary.

### 8

adopt the implementer's integer-mix before the first LCG step. Measured: range becomes
[0.0005, 0.9969] and test 4 scores 119/200, comfortably inside its 60..180 band.
Applied as a SHARED helper at test/helpers/seeded-rng.js rather than inline, because Tasks 7 and 8
use the same helper and three drifting copies is exactly the duplication the review rubric flags.
Cost if wrong: only test determinism is affected, never shipped behaviour — src/queue-sampler.js
itself is untouched by this ruling.

### 9

lookback becomes `gap - 1`, and selection prefers the artist with the MOST remaining tracks,
tie-broken by distance. Verified: 0 violations, all 9 tracks, and all six brief tests pass —
including the smoothness test (jump 1.00 vs 4.00 unsorted) and the all-one-artist relax case.
Rejected the implementer's option B (weaken the test): the assertion encodes the actual product
requirement, that a queue must not repeat an artist within three tracks.
Cost if wrong: queues cluster one artist; caught by Task 7's end-to-end spacing test.

### 10

AFFINITY_WEIGHT = 6.0. It must exceed SURROUND_BONUS or a maximally-loved stereo track can
never beat an unloved surround one — which contradicts the user's own choice that stereo is admitted
when it is genuinely the better match. 3.5 lands exactly on the boundary and 4.5 dips below it;
only 6.0 has margin. Verified against a realistic library (200 tracks, spread affinity): surround
share 79.3% at weight 6.0 versus 80.3% at 1.5, so the stronger affinity costs ~1 point of surround
share and nothing else. Cost if wrong: favourites crowd the queue; visible immediately in use and
tunable by one constant.

### 11

fix the root cause, not the symptom. Initialise `assign` with -1 (an impossible cluster) so
the first pass always registers as movement, because assigning a previously-unassigned point IS a
change. Rejected the implementer's `if (!moved && iter > 0) break`: it forces a minimum of two
iterations, which happens to work here but leaves the real defect — a sentinel that collides with
a real value — in place for the next edge case.
Both verified across 50 seeds: 50/50 separate correctly. Chose the one that states the invariant.
Cost if wrong: daily mixes collapse into one undifferentiated mix; caught by the brief's test 1.

### 12

reorder — call finish() BEFORE proc.kill(). Rejected the implementer's `timedOut` flag: same
result, but it adds state to express an ordering that the ordering itself can express. finish()
already latches on `done`, so the later close is a no-op for free.
Honest note on severity: real child_process emits 'close' asynchronously, so this bug does NOT
manifest in production — only against a fake that closes synchronously. The reorder is still
correct, because the outcome should not depend on when an external event happens to arrive.
Cost if wrong: a hung ffmpeg would be reported with the wrong reason, never silently.

### 13

two changes, both verified end-to-end against the real Camel 5.1 file.
(a) Filter chain gains `aspectralstats=win_size=8192:overlap=0,ametadata=mode=print` and astats
drops `metadata=1` (it flooded per-frame metadata; the summary prints regardless). Measured:
stderr 1.0MB -> 304KB per track, all summaries intact, 177 spectral frames for a 65s track.
(b) parseAnalysis averages the four spectral keys across frames instead of reading summary lines.
win_size 8192 with no overlap chosen deliberately: it cuts output ~8x versus the default, and the
absolute centroid shifts (1128 -> 1328 across configs) do not matter because every track is
measured with the same config and then z-scored within the library. Consistency is the requirement,
not absolute accuracy.
Cost if wrong: brightness and density are noisier than intended; energy and dynamics unaffected.

### 14

park the partial as deferred minors rather than spend a third round. Only `centroid` differs
across the two fixture frames, so only centroid is constrained against last-wins; flatness, rolloff
and entropy use identical values in both, and `spread` is no longer exercised at all. The reviewer
rates this Minor itself, the averaging requirement IS proven by centroid, and the substantive
behaviour is verified far more strongly by the real-file run than any fixture could manage.
Cost if wrong: a future regression in one of three spectral keys could slip past the unit test;
it would still be caught by the real-file check, which is now a documented step in the report.

### 15

allLibraryTracks supplies `size: t.fileSize || 0` and `mtimeMs: 0`. Change detection is then
by file size plus FEATURE_VERSION. Rejected stat-ing every file to get a real mtime: that is 2,245
synchronous disk operations on the main thread, which is precisely the class of work this app's
stability round spent itself removing. Cost if wrong: an edit that preserves byte size is not
re-analysed; FEATURE_VERSION still forces a full pass whenever the algorithm changes.

### 16

allLibraryTracks spreads the whole track and adds album identity plus the analysis fields.
The analysis path reads only filePath/size/mtimeMs, so the extra fields cost it nothing.
Cost if wrong: none material; it is strictly more data on a path that already carries it.

### 17

the Important (mix mode reclusters the whole library per call, "unbounded") is a NON-ISSUE.
Measured on the live app with the real 2,304-track library: mix 10ms, surprise 17ms. Clustering is
cheaper than the sampling it feeds. Parked with no change. Cost if wrong: none; it is measured.

### 18

poolFor must fall back to the whole library when clustering produced no clusters, and
queue-build must report that features are not ready so Task 12 can say so in the UI.
Cost if wrong: a mix would be a plain surprise queue until analysis completes — which is exactly
the documented fallback, and strictly better than playing nothing.

### 19

do NOT load them in the renderer, and drop that test. The requirement is a leftover from a
design where the renderer computed queues; Task 11 moved all of it into the main process, so the
renderer needs nothing but window.api.queueBuild. Loading them would be both fatal and pointless.
Cost if wrong: none — the renderer has no call site for these modules.

### 20

add `queue-mixes` returning [{index, name, size}] from clusterLibrary, and let queue-build
accept `mixIndex` to target one cluster. When features are not ready it returns [] and the UI shows
one honest "analyse to unlock your mixes" prompt instead of five cards that all do the same thing.
Cost if wrong: the row is one prompt until analysis finishes, which is the documented degraded mode.

# Smart Queues from the Local Library — Design

**Date:** 2026-08-29
**Status:** Approved in brainstorming, ready for implementation planning

---

## In plain terms

Papa Audio should be able to build good queues on its own: press Radio and it keeps
playing music that fits; a few standing mixes ready on the home screen; a shuffle that
feels curated rather than jumbled; and a way to resurface albums gone cold.

It cannot do this the way Spotify does. Spotify watches millions of people and
recommends by consensus. This library has 26 surround artists. There is nobody to
compare against, so the signal has to come from two places Spotify does not use as
well: **what the music actually sounds like**, measured from the files, and **one
person's real listening history**.

---

## The library this is built for

Measured 2026-08-29 from `library-cache.json`, `play-history.json` and `config.json`:

| | |
|---|---|
| Albums / tracks | 237 / 2,245 |
| Surround albums (≥6ch) | **69** (65 at 6ch, 4 at 8ch) |
| Surround tracks | **699** |
| Surround artists | **26** — Pink Floyd, Yes, Porcupine Tree, King Crimson, Radiohead lead |
| Genre coverage (surround) | 63%; of those present, "Progressive Rock" dominates at 30 |
| Play history | 1,097 entries with timestamps |
| Tracks with play counts | 1,723 |
| Liked albums / tracks | 6 / 1 |

Three consequences drive the whole design:

1. **Genre tags are unusable as the primary signal.** A third missing, and the rest
   collapse into one bucket. Anything keyed on genre would produce one undifferentiated
   playlist.
2. **The surround pool is small.** 699 tracks across 26 artists exhausts fast. Confirmed
   with the user: surround-first, stereo admitted when it is genuinely the better match.
3. **The behavioural signal is strong.** 1,097 timestamped plays over one listener is
   dense enough for transition and recency modelling. This is the advantage over Spotify,
   not the deficit.

---

## Feasibility, measured

A 5m20s 24-bit 5.1 FLAC (184 MB) analysed in **1.76 s wall, 193× realtime**, using
filters confirmed present in the installed ffmpeg: `ebur128`, `astats`, `aspectralstats`.

Extrapolated to 2,245 tracks: **~50 min single-threaded, ~15 min across a worker pool.**
One time, incremental thereafter. This is cheap enough that no approximation or sampling
shortcut is justified.

---

## Architecture

Five new units, each independently testable. Four are pure functions with no I/O.

```
                    ┌──────────────────────┐
   library files ──▶│ analysis-runner      │  main process, worker pool
                    │ (ffmpeg, incremental)│  writes side store
                    └──────────┬───────────┘
                               ▼
                    audio-features.json      ~2,245 × 12 floats ≈ 400 KB
                               │
                               ▼
   play-history ───▶┌──────────────────────┐
   play-counts  ───▶│ taste-model  (pure)  │  affinity, transitions, cold set
   liked        ───▶└──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ queue-engine (pure)  │  select → constrain → sequence
                    └──────────┬───────────┘
                               ▼
                          state.queue
```

| Unit | File | Purpose | Depends on |
|---|---|---|---|
| Feature extraction | `src/audio-features.js` | Parse ffmpeg output → normalised vector; distance function | nothing (pure) |
| Analysis runner | `analysis-runner.js` | Spawn ffmpeg over the library, incrementally, off the hot path | ffmpeg, side-store |
| Feature store | reuses `side-store.js` | Persist vectors | existing module |
| Taste model | `src/taste-model.js` | Affinity, transition matrix, time-of-day, cold set | nothing (pure) |
| Queue engine | `src/queue-engine.js` | The four modes; selection, constraints, sequencing | the two above (pure) |

`side-store.js` already exists from the stability work and is the correct home for a new
file — features must not go into the shared config, which is written on every playback event.

---

## 1. Feature extraction

**One ffmpeg pass per track**, downmixed to mono at 22.05 kHz (halves the work and
discards spatial information that says nothing about musical similarity — channel count
is already known from the library metadata and handled separately).

```
-af aresample=22050,aformat=channel_layouts=mono,
    ebur128=peak=true,astats=metadata=1:reset=0,aspectralstats
```

**Raw measurements taken:** integrated loudness (LUFS), loudness range (LRA), true peak,
RMS level, crest factor, zero-crossing rate, flat factor, spectral centroid, spread,
flatness, rolloff, entropy.

**Derived feature vector** — five dimensions, each z-scored **against this library**, not
against absolute scales. "Bright" must mean bright relative to what the user owns.

| Dimension | Built from | What it separates |
|---|---|---|
| `energy` | RMS, crest factor, centroid | *Dogs* from *Us and Them* |
| `brightness` | spectral centroid, rolloff | early-70s analogue from modern digital masters |
| `dynamics` | LRA, crest factor | a 1975 mix from a loudness-war remaster — heavily weighted, since this library is prog and dynamics carry it |
| `density` | spectral flatness, entropy | wall-of-sound from sparse arrangement |
| `punch` | zero-crossing rate, transient ratio | percussive from sustained |

Stored with a `featureVersion` integer. A version bump invalidates and re-analyses; the
store records `mtime` and `size` per file so unchanged files are never re-read.

**Deliberately deferred:** tempo and musical key. ffmpeg gives neither directly, `aubio`
is not installed, and onset-autocorrelation tempo is unreliable on prog rock, which
changes metre mid-piece. The five dimensions above are sufficient to ship; tempo can be
added later behind the same `featureVersion` mechanism without redesign.

---

## 2. Similarity

Weighted Euclidean distance over the z-scored vector.

Euclidean rather than cosine: magnitude is meaningful here. Two tracks with the same
*shape* but very different loudness and dynamics are not interchangeable — that is exactly
the remaster-versus-original distinction this library is full of.

Default weights favour `dynamics` and `energy`; `brightness` and `density` next; `punch`
lowest. Weights live in one exported constant so they can be tuned without touching logic.

---

## 3. Taste model

Derived from `play-history.json` (1,097 timestamped entries) and `playCounts` (1,723).

- **Affinity** — per track: play count, log-damped, multiplied by a recency half-life,
  plus a bonus for liked. Damping matters: one track played 40 times must not dominate
  every queue.
- **Transitions** — from consecutive history entries, at artist and album level.
  P(next artist | current artist). Track-level is too sparse at 1,097 entries and is not
  attempted.
- **Time of day** — listening histogram by hour, as a gentle bias only.
- **Cold set** — owned, played at least twice historically, nothing in **90 days**. Two plays
  filters out tracks that were sampled once and correctly abandoned; 90 days is long enough that
  resurfacing feels like rediscovery rather than repetition.

**Data note:** history entries changed key from `timestamp` to `ts` on 2026-08-04 and the
migration landed in the stability work. The model must read through the migrated accessor
in `history.js`, never raw keys, or it silently loses 463 of the 1,097 entries.

---

## 4. The four modes

All four are one function — `buildQueue({ mode, seed, length, surroundBias })` — differing
only in candidate pool, scoring weights and sampling temperature.

| Mode | Pool | Scored by | Temperature |
|---|---|---|---|
| **Radio** | whole library | distance from seed, then affinity | low — stay close |
| **Daily mixes** | one cluster | affinity within cluster | medium |
| **Surprise me** | whole library | affinity, lightly | high — spread wide |
| **Rediscover** | cold set | historical affinity × time since last play | medium |

**Daily mixes** come from k-means over the feature vectors with **k = 5**, re-fit weekly and
whenever the library grows by more than 5% since the last fit. k=5 gives roughly 450 tracks per
mix at current library size — enough that a mix does not repeat within a session, few enough that
each one has a recognisable character. Each mix is named from its dominant artists rather than a
genre tag — "Pink Floyd, Yes and more" is honest and works with no genre data at all.
Cluster assignment is stable across re-fits by seeding from previous centroids.

---

## 5. Surround-first, stereo when it earns it

Per the user's decision:

- Surround tracks receive a scoring bonus, tuned so a queue lands around **70–80% surround**.
- A stereo track enters only when its similarity score exceeds the best remaining surround
  candidate by a clear margin — never as filler because the pool ran dry.
- Stereo entries in a surround-first queue carry a small marker in the UI, so the user is
  never surprised by what comes out of the speakers.

---

## 6. Sequencing — the part that makes it feel curated

Selection alone produces a bag of good tracks in a bad order. A separate ordering pass runs
over the chosen candidates.

**Hard constraints:**
- No same artist within 3 tracks
- No same album within 5 (relaxed when Radio is seeded from that album)

**Soft objective:** limit the step change in `energy` and `brightness` between adjacent
tracks, via a greedy walk that prefers the nearest acceptable next candidate. This is what
prevents a quiet acoustic piece slamming into a heavy one.

**Shape:** a gentle rise across the first third and a settle toward the end, rather than a
flat line — closer to how a listener actually sequences a session.

---

## 7. Randomness

Softmax sampling over candidate scores with a per-mode temperature, not top-N selection.
The same seed produces a different queue every time while staying in the right
neighbourhood. This is the difference between "random" that clumps and jars, and random
that feels chosen.

For tests, the sampler accepts an injected RNG so sequences are reproducible.

---

## 8. Performance and failure

- Analysis runs in a worker pool of `cpus - 1`, and **pauses while audio is playing.** The
  stability round established that heavy work on the main path is what breaks playback;
  this must not reintroduce it.
- Queue generation is pure in-memory arithmetic over ≤2,245 short vectors — well under a
  millisecond, no need for indexing structures at this scale.
- A file that fails analysis is marked failed, excluded from feature-based modes, and stays
  fully playable everywhere else.
- With no features yet, the modes fall back to history-and-metadata scoring and **say so**
  in the UI rather than silently producing worse results.
- Analysis failure never blocks playback, and never blocks the app starting.

---

## 9. User interface

- **Radio** — a button on the now-playing bar and in the track/album context menus.
- **Made for you** — a row on Home holding the daily mixes, Surprise Me and Rediscover.
- **Stereo marker** — a small badge on stereo tracks inside a surround-first queue.
- **Analysis progress** — a line in Manage showing how many tracks are analysed, with the
  ability to pause it.

---

## 10. Testing

Everything that decides anything is a pure function and is tested without ffmpeg, without
mpv and without the app running:

- Feature parsing from captured ffmpeg output fixtures
- Normalisation and distance, including degenerate cases — one track, identical tracks,
  a missing dimension
- Affinity damping, so a single obsessively-played track cannot dominate
- History reading through the migrated accessor, asserting all 1,097 entries are seen
- Sequencing constraints — artist and album spacing provably hold on adversarial input
- Softmax determinism under an injected RNG, and that two different seeds differ
- Cluster stability across re-fits
- The surround ratio lands in the intended band on the real library shape

Integration checks that do need the app: analysis pauses when playback starts; a queue
generated end to end plays through.

---

## Out of scope

- Tempo and key detection (deferred, see §1)
- Any network lookup — no Last.fm, no MusicBrainz, no online similarity
- Cross-user or collaborative filtering, which is not possible for one listener
- Changing how playback itself works

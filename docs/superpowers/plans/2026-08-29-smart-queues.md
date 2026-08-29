# Smart Queues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate Radio, daily mixes, smart shuffle and rediscover queues from the local library, matching on how the music actually sounds plus this listener's own history.

**Architecture:** One ffmpeg pass per track produces a five-dimension feature vector, stored in its own side file. Four pure modules — feature maths, taste model, sequencing, queue engine — turn those vectors plus play history into an ordered queue. Only the analysis runner touches the filesystem or spawns processes; everything that makes a decision is a pure function testable without ffmpeg, mpv or a running app.

**Tech Stack:** Node 18 / Electron 28, `node --test`, ffmpeg (`ebur128`, `astats`, `aspectralstats`), existing `SideStore` for persistence.

**Spec:** `docs/superpowers/specs/2026-08-29-smart-queues-design.md`

## Global Constraints

- Feature vector is exactly five keys, in this order: `energy`, `brightness`, `dynamics`, `density`, `punch`. Exported as `FEATURE_KEYS`.
- `FEATURE_VERSION = 1`. Any change to extraction or derivation bumps it and invalidates stored vectors.
- Analysis **pauses while audio is playing**. Heavy work on that path is what broke playback in the stability round.
- Play history is read **only** through `normaliseHistory` from `history.js`. Reading `entry.ts` directly loses the 463 entries written under the old `timestamp` key.
- Features live in their own `SideStore` named `audio-features`. Never in `config.json`.
- Analysis downmixes to mono at 22050 Hz. Channel count comes from library metadata, never from the analysis pass.
- No network calls. No Last.fm, no MusicBrainz.
- Every pure module is `'use strict'` CommonJS, exported via `module.exports`, and loaded in `src/index.html` as a classic script when the renderer needs it — matching the existing `queue-repair.js` pattern.
- Tests live in `test/<module>.test.js` and run under `npm test`.

---

### Task 1: Parse ffmpeg analysis output

**Files:**
- Create: `src/audio-features.js`
- Test: `test/audio-features.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `parseAnalysis(stderrText) -> { integratedLufs, lra, truePeak, rms, crest, zcr, flatFactor, centroid, spread, flatness, rolloff, entropy }`, all numbers; any measurement absent from the text comes back `null`.

- [ ] **Step 1: Write the failing test**

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { parseAnalysis } = require('../src/audio-features')

const SAMPLE = `
[Parsed_ebur128_2 @ 0x1] Summary:
  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.6 LUFS
  Loudness range:
    LRA:        11.4 LU
  True peak:
    Peak:        -0.3 dBFS
[Parsed_astats_3 @ 0x2] Overall
[Parsed_astats_3 @ 0x2] RMS level dB: -18.372
[Parsed_astats_3 @ 0x2] Crest factor: 6.221
[Parsed_astats_3 @ 0x2] Zero crossings rate: 0.041270
[Parsed_astats_3 @ 0x2] Flat factor: 0.000000
[Parsed_aspectralstats_4 @ 0x3] Overall
[Parsed_aspectralstats_4 @ 0x3] mean centroid: 1842.310
[Parsed_aspectralstats_4 @ 0x3] mean spread: 2210.775
[Parsed_aspectralstats_4 @ 0x3] mean flatness: 0.128
[Parsed_aspectralstats_4 @ 0x3] mean rolloff: 4820.500
[Parsed_aspectralstats_4 @ 0x3] mean entropy: 0.712
`

test('parseAnalysis pulls every measurement out of ffmpeg stderr', () => {
  const r = parseAnalysis(SAMPLE)
  assert.strictEqual(r.integratedLufs, -14.2)
  assert.strictEqual(r.lra, 11.4)
  assert.strictEqual(r.truePeak, -0.3)
  assert.strictEqual(r.rms, -18.372)
  assert.strictEqual(r.crest, 6.221)
  assert.strictEqual(r.zcr, 0.04127)
  assert.strictEqual(r.centroid, 1842.31)
  assert.strictEqual(r.flatness, 0.128)
  assert.strictEqual(r.rolloff, 4820.5)
  assert.strictEqual(r.entropy, 0.712)
})

test('parseAnalysis returns null for anything missing, never NaN', () => {
  const r = parseAnalysis('nothing useful here')
  for (const k of Object.keys(r)) {
    assert.strictEqual(r[k], null, `${k} should be null`)
  }
})

test('parseAnalysis ignores per-channel blocks and takes Overall', () => {
  const txt = `
[Parsed_astats_3 @ 0x2] Channel: 1
[Parsed_astats_3 @ 0x2] RMS level dB: -99.000
[Parsed_astats_3 @ 0x2] Overall
[Parsed_astats_3 @ 0x2] RMS level dB: -18.372
`
  assert.strictEqual(parseAnalysis(txt).rms, -18.372)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/audio-features.test.js`
Expected: FAIL — `Cannot find module '../src/audio-features'`

- [ ] **Step 3: Write the minimal implementation**

```js
'use strict'
// Feature extraction and comparison for the local library.
//
// Pure on purpose: nothing here spawns ffmpeg or touches disk, so every
// decision the queue engine makes is testable without audio.

const FEATURE_KEYS = ['energy', 'brightness', 'dynamics', 'density', 'punch']
const FEATURE_VERSION = 1

// astats and aspectralstats print per-channel blocks BEFORE the Overall block.
// Taking the last match is what selects Overall; taking the first would report
// channel 1 and quietly mis-measure every multichannel file in the library.
function lastNumber(text, pattern) {
  const re = new RegExp(pattern, 'g')
  let m, found = null
  while ((m = re.exec(text)) !== null) found = m[1]
  return found === null ? null : Number(found)
}

function parseAnalysis(stderrText) {
  const t = String(stderrText || '')
  return {
    integratedLufs: lastNumber(t, 'I:\\s*(-?[\\d.]+)\\s*LUFS'),
    lra:            lastNumber(t, 'LRA:\\s*(-?[\\d.]+)\\s*LU'),
    truePeak:       lastNumber(t, 'Peak:\\s*(-?[\\d.]+)\\s*dBFS'),
    rms:            lastNumber(t, 'RMS level dB:\\s*(-?[\\d.]+)'),
    crest:          lastNumber(t, 'Crest factor:\\s*(-?[\\d.]+)'),
    zcr:            lastNumber(t, 'Zero crossings rate:\\s*(-?[\\d.]+)'),
    flatFactor:     lastNumber(t, 'Flat factor:\\s*(-?[\\d.]+)'),
    centroid:       lastNumber(t, 'mean centroid:\\s*(-?[\\d.]+)'),
    spread:         lastNumber(t, 'mean spread:\\s*(-?[\\d.]+)'),
    flatness:       lastNumber(t, 'mean flatness:\\s*(-?[\\d.]+)'),
    rolloff:        lastNumber(t, 'mean rolloff:\\s*(-?[\\d.]+)'),
    entropy:        lastNumber(t, 'mean entropy:\\s*(-?[\\d.]+)'),
  }
}

module.exports = { FEATURE_KEYS, FEATURE_VERSION, parseAnalysis }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/audio-features.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/audio-features.js test/audio-features.test.js
git commit -m "feat(queues): parse ffmpeg analysis output into raw measurements"
```

---

### Task 2: Derive the feature vector and compare vectors

**Files:**
- Modify: `src/audio-features.js`
- Modify: `test/audio-features.test.js`

**Interfaces:**
- Consumes: `parseAnalysis` from Task 1
- Produces:
  - `rawToVector(raw) -> { energy, brightness, dynamics, density, punch } | null` (null when a required measurement is missing)
  - `buildNormaliser(vectors) -> { mean: {...}, sd: {...} }`
  - `normalise(vec, norm) -> vector` (z-scored)
  - `distance(a, b, weights = DEFAULT_WEIGHTS) -> number`
  - `DEFAULT_WEIGHTS = { energy: 1.0, brightness: 0.8, dynamics: 1.3, density: 0.8, punch: 0.5 }`

- [ ] **Step 1: Write the failing test**

```js
const {
  rawToVector, buildNormaliser, normalise, distance, DEFAULT_WEIGHTS, FEATURE_KEYS,
} = require('../src/audio-features')

const RAW = {
  integratedLufs: -14.2, lra: 11.4, truePeak: -0.3, rms: -18.372, crest: 6.221,
  zcr: 0.04127, flatFactor: 0, centroid: 1842.31, spread: 2210.775,
  flatness: 0.128, rolloff: 4820.5, entropy: 0.712,
}

test('rawToVector produces exactly the five keys, all finite', () => {
  const v = rawToVector(RAW)
  assert.deepStrictEqual(Object.keys(v).sort(), [...FEATURE_KEYS].sort())
  for (const k of FEATURE_KEYS) assert.ok(Number.isFinite(v[k]), `${k} not finite`)
})

test('rawToVector returns null when a required measurement is missing', () => {
  assert.strictEqual(rawToVector({ ...RAW, rms: null }), null)
  assert.strictEqual(rawToVector({ ...RAW, centroid: null }), null)
})

test('a louder, brighter track scores higher on energy and brightness', () => {
  const quiet = rawToVector({ ...RAW, rms: -30, centroid: 900 })
  const loud  = rawToVector({ ...RAW, rms: -8,  centroid: 5200 })
  assert.ok(loud.energy > quiet.energy)
  assert.ok(loud.brightness > quiet.brightness)
})

test('a wide loudness range scores higher on dynamics', () => {
  const squashed = rawToVector({ ...RAW, lra: 2, crest: 3 })
  const open     = rawToVector({ ...RAW, lra: 18, crest: 12 })
  assert.ok(open.dynamics > squashed.dynamics)
})

test('normalise z-scores against the library, so identical input is all zeros', () => {
  const vs = [rawToVector(RAW), rawToVector(RAW), rawToVector(RAW)]
  const n = buildNormaliser(vs)
  const z = normalise(vs[0], n)
  for (const k of FEATURE_KEYS) assert.strictEqual(z[k], 0, `${k} should be 0`)
})

test('buildNormaliser never divides by zero on a constant dimension', () => {
  const n = buildNormaliser([rawToVector(RAW), rawToVector(RAW)])
  for (const k of FEATURE_KEYS) assert.ok(Number.isFinite(n.sd[k]) && n.sd[k] > 0)
})

test('distance is zero to itself and grows with difference', () => {
  const a = { energy: 0, brightness: 0, dynamics: 0, density: 0, punch: 0 }
  const b = { energy: 1, brightness: 0, dynamics: 0, density: 0, punch: 0 }
  const c = { energy: 3, brightness: 0, dynamics: 0, density: 0, punch: 0 }
  assert.strictEqual(distance(a, a), 0)
  assert.ok(distance(a, b) < distance(a, c))
})

test('dynamics is weighted above punch, because this library is prog', () => {
  assert.ok(DEFAULT_WEIGHTS.dynamics > DEFAULT_WEIGHTS.punch)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/audio-features.test.js`
Expected: FAIL — `rawToVector is not a function`

- [ ] **Step 3: Write the minimal implementation**

Append to `src/audio-features.js`, and add the new names to `module.exports`:

```js
const DEFAULT_WEIGHTS = { energy: 1.0, brightness: 0.8, dynamics: 1.3, density: 0.8, punch: 0.5 }

const REQUIRED = ['rms', 'crest', 'lra', 'centroid', 'rolloff', 'flatness', 'entropy', 'zcr']

// Squash an open-ended measurement into roughly 0..1 before z-scoring. This is
// only to stop one wild outlier dominating the mean and standard deviation --
// the real scaling is the z-score in normalise().
function unit(value, lo, hi) {
  if (!Number.isFinite(value)) return 0
  const t = (value - lo) / (hi - lo)
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function rawToVector(raw) {
  if (!raw) return null
  for (const k of REQUIRED) {
    if (!Number.isFinite(raw[k])) return null
  }
  const loudness = unit(raw.rms, -40, -5)
  const bright   = unit(raw.centroid, 400, 6000)
  const roll     = unit(raw.rolloff, 1000, 12000)
  const range    = unit(raw.lra, 0, 20)
  const crest    = unit(raw.crest, 2, 15)

  return {
    energy:     0.6 * loudness + 0.2 * crest + 0.2 * bright,
    brightness: 0.6 * bright + 0.4 * roll,
    dynamics:   0.7 * range + 0.3 * crest,
    density:    0.5 * unit(raw.flatness, 0, 0.5) + 0.5 * unit(raw.entropy, 0, 1),
    punch:      unit(raw.zcr, 0, 0.15),
  }
}

function buildNormaliser(vectors) {
  const list = (vectors || []).filter(Boolean)
  const mean = {}, sd = {}
  for (const k of FEATURE_KEYS) {
    if (!list.length) { mean[k] = 0; sd[k] = 1; continue }
    const m = list.reduce((s, v) => s + v[k], 0) / list.length
    const varc = list.reduce((s, v) => s + (v[k] - m) ** 2, 0) / list.length
    mean[k] = m
    // A constant dimension has zero spread. Dividing by it yields Infinity and
    // poisons every distance, so it is floored -- a dimension that never varies
    // simply contributes nothing.
    sd[k] = Math.sqrt(varc) || 1
  }
  return { mean, sd }
}

function normalise(vec, norm) {
  const out = {}
  for (const k of FEATURE_KEYS) out[k] = (vec[k] - norm.mean[k]) / norm.sd[k]
  return out
}

function distance(a, b, weights = DEFAULT_WEIGHTS) {
  let sum = 0
  for (const k of FEATURE_KEYS) {
    const d = (a[k] - b[k]) * (weights[k] ?? 1)
    sum += d * d
  }
  return Math.sqrt(sum)
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/audio-features.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/audio-features.js test/audio-features.test.js
git commit -m "feat(queues): derive the five-dimension feature vector and compare vectors"
```

---

### Task 3: Taste model — affinity from play history

**Files:**
- Create: `src/taste-model.js`
- Test: `test/taste-model.test.js`

**Interfaces:**
- Consumes: `normaliseHistory` from `history.js`
- Produces: `buildAffinity({ history, playCounts, likedTracks, now }) -> Map<filePath, number>` in 0..1

- [ ] **Step 1: Write the failing test**

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { buildAffinity } = require('../src/taste-model')

const NOW = Date.UTC(2026, 7, 29)
const day = 86400000

test('affinity rises with play count but is damped, so one obsession cannot dominate', () => {
  const a = buildAffinity({ playCounts: { '/a.flac': 2, '/b.flac': 40 }, history: [], now: NOW })
  assert.ok(a.get('/b.flac') > a.get('/a.flac'))
  // 20x the plays must not buy 20x the affinity
  assert.ok(a.get('/b.flac') < a.get('/a.flac') * 5)
})

test('a recent play outranks an old one at equal play count', () => {
  const a = buildAffinity({
    playCounts: { '/new.flac': 3, '/old.flac': 3 },
    history: [
      { filePath: '/new.flac', ts: NOW - 2 * day },
      { filePath: '/old.flac', ts: NOW - 400 * day },
    ],
    now: NOW,
  })
  assert.ok(a.get('/new.flac') > a.get('/old.flac'))
})

test('liked tracks are boosted', () => {
  const base = buildAffinity({ playCounts: { '/x.flac': 3 }, history: [], now: NOW })
  const liked = buildAffinity({ playCounts: { '/x.flac': 3 }, history: [], likedTracks: ['/x.flac'], now: NOW })
  assert.ok(liked.get('/x.flac') > base.get('/x.flac'))
})

test('affinity stays within 0..1', () => {
  const a = buildAffinity({ playCounts: { '/x.flac': 9999 }, history: [], likedTracks: ['/x.flac'], now: NOW })
  assert.ok(a.get('/x.flac') <= 1 && a.get('/x.flac') > 0)
})

test('history written under the old timestamp key still counts', () => {
  const a = buildAffinity({
    playCounts: {},
    history: [{ filePath: '/legacy.flac', timestamp: NOW - day }],
    now: NOW,
  })
  assert.ok(a.get('/legacy.flac') > 0, 'legacy entry was dropped')
})

test('an unplayed track has no entry rather than a zero', () => {
  const a = buildAffinity({ playCounts: {}, history: [], now: NOW })
  assert.strictEqual(a.get('/never.flac'), undefined)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/taste-model.test.js`
Expected: FAIL — `Cannot find module '../src/taste-model'`

- [ ] **Step 3: Write the minimal implementation**

```js
'use strict'
// What this listener actually returns to, derived from their own history.
// Pure: no disk, no clock of its own -- `now` is always passed in so tests
// are not time-dependent.

const { normaliseHistory } = require('../history')

const HALF_LIFE_DAYS = 120
const LIKED_BOOST = 1.4
const DAY = 86400000

function buildAffinity({ history = [], playCounts = {}, likedTracks = [], now = Date.now() } = {}) {
  // Through normaliseHistory, never raw entry.ts: 463 of the 1,097 entries in
  // this library were written under the old `timestamp` key and are invisible
  // to a direct read.
  const { entries } = normaliseHistory(history, { now })

  const lastPlayed = new Map()
  for (const e of entries) {
    const prev = lastPlayed.get(e.filePath) || 0
    if (e.ts > prev) lastPlayed.set(e.filePath, e.ts)
  }

  const liked = new Set(likedTracks || [])
  const paths = new Set([...Object.keys(playCounts || {}), ...lastPlayed.keys()])

  const raw = new Map()
  let max = 0
  for (const p of paths) {
    const count = Math.max(0, Number(playCounts[p]) || 0)
    // log damping: 40 plays is worth more than 2, but not twenty times more.
    let score = Math.log1p(count)
    const last = lastPlayed.get(p)
    if (last) {
      const ageDays = Math.max(0, (now - last) / DAY)
      score *= Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
    } else {
      score *= 0.5
    }
    if (liked.has(p)) score *= LIKED_BOOST
    if (score > 0) {
      raw.set(p, score)
      if (score > max) max = score
    }
  }

  const out = new Map()
  for (const [p, s] of raw) out.set(p, max > 0 ? s / max : 0)
  return out
}

module.exports = { buildAffinity, HALF_LIFE_DAYS, LIKED_BOOST }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/taste-model.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/taste-model.js test/taste-model.test.js
git commit -m "feat(queues): affinity model from play counts, recency and likes"
```

---

### Task 4: Taste model — cold set and artist transitions

**Files:**
- Modify: `src/taste-model.js`
- Modify: `test/taste-model.test.js`

**Interfaces:**
- Consumes: `normaliseHistory`
- Produces:
  - `buildColdSet({ history, playCounts, now, days = 90, minPlays = 2 }) -> Set<filePath>`
  - `buildTransitions({ history, trackArtist }) -> Map<artist, Map<artist, number>>` where `trackArtist` is `Map<filePath, artist>` and inner values are probabilities summing to 1

- [ ] **Step 1: Write the failing test**

```js
const { buildColdSet, buildTransitions } = require('../src/taste-model')

test('cold set holds tracks played twice or more but not in 90 days', () => {
  const cold = buildColdSet({
    playCounts: { '/cold.flac': 5, '/warm.flac': 5, '/once.flac': 1 },
    history: [
      { filePath: '/cold.flac', ts: NOW - 200 * day },
      { filePath: '/warm.flac', ts: NOW - 3 * day },
      { filePath: '/once.flac', ts: NOW - 300 * day },
    ],
    now: NOW,
  })
  assert.ok(cold.has('/cold.flac'), 'old favourite should be cold')
  assert.ok(!cold.has('/warm.flac'), 'recent play is not cold')
  assert.ok(!cold.has('/once.flac'), 'a single play is not a favourite gone cold')
})

test('a track never played is not cold, it is unheard', () => {
  const cold = buildColdSet({ playCounts: { '/x.flac': 4 }, history: [], now: NOW })
  assert.ok(!cold.has('/x.flac'))
})

test('transitions record what actually followed what, as probabilities', () => {
  const trackArtist = new Map([['/p1.flac', 'Pink Floyd'], ['/p2.flac', 'Pink Floyd'], ['/y1.flac', 'Yes']])
  // normaliseHistory sorts newest first, so listening order here is y1 -> p2 -> p1
  const t = buildTransitions({
    history: [
      { filePath: '/p1.flac', ts: NOW },
      { filePath: '/p2.flac', ts: NOW - 1000 },
      { filePath: '/y1.flac', ts: NOW - 2000 },
    ],
    trackArtist,
  })
  const fromYes = t.get('Yes')
  assert.ok(fromYes, 'Yes should have an outgoing row')
  assert.strictEqual(fromYes.get('Pink Floyd'), 1)
})

test('each transition row sums to 1', () => {
  const trackArtist = new Map([['/a.flac', 'A'], ['/b.flac', 'B'], ['/c.flac', 'C']])
  const t = buildTransitions({
    history: [
      { filePath: '/c.flac', ts: NOW },
      { filePath: '/a.flac', ts: NOW - 1000 },
      { filePath: '/b.flac', ts: NOW - 2000 },
      { filePath: '/a.flac', ts: NOW - 3000 },
    ],
    trackArtist,
  })
  for (const [, row] of t) {
    const total = [...row.values()].reduce((s, v) => s + v, 0)
    assert.ok(Math.abs(total - 1) < 1e-9)
  }
})

test('transitions ignore a track whose artist is unknown', () => {
  const t = buildTransitions({
    history: [{ filePath: '/a.flac', ts: NOW }, { filePath: '/ghost.flac', ts: NOW - 1000 }],
    trackArtist: new Map([['/a.flac', 'A']]),
  })
  assert.strictEqual(t.size, 0)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/taste-model.test.js`
Expected: FAIL — `buildColdSet is not a function`

- [ ] **Step 3: Write the minimal implementation**

Append to `src/taste-model.js` and extend `module.exports`:

```js
function buildColdSet({ history = [], playCounts = {}, now = Date.now(), days = 90, minPlays = 2 } = {}) {
  const { entries } = normaliseHistory(history, { now })
  const lastPlayed = new Map()
  for (const e of entries) {
    const prev = lastPlayed.get(e.filePath) || 0
    if (e.ts > prev) lastPlayed.set(e.filePath, e.ts)
  }
  const cutoff = now - days * DAY
  const cold = new Set()
  for (const [p, last] of lastPlayed) {
    if ((Number(playCounts[p]) || 0) < minPlays) continue
    if (last < cutoff) cold.add(p)
  }
  return cold
}

function buildTransitions({ history = [], trackArtist = new Map() } = {}) {
  const { entries } = normaliseHistory(history, { now: Date.now() })
  // normaliseHistory returns newest first; listening order is the reverse.
  const chron = [...entries].reverse()

  const counts = new Map()
  for (let i = 1; i < chron.length; i++) {
    const from = trackArtist.get(chron[i - 1].filePath)
    const to = trackArtist.get(chron[i].filePath)
    if (!from || !to) continue
    if (!counts.has(from)) counts.set(from, new Map())
    const row = counts.get(from)
    row.set(to, (row.get(to) || 0) + 1)
  }

  const out = new Map()
  for (const [from, row] of counts) {
    const total = [...row.values()].reduce((s, v) => s + v, 0)
    const probs = new Map()
    for (const [to, c] of row) probs.set(to, c / total)
    out.set(from, probs)
  }
  return out
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/taste-model.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/taste-model.js test/taste-model.test.js
git commit -m "feat(queues): cold set for rediscover and artist transition probabilities"
```

---

### Task 5: Weighted sampling with an injected RNG

**Files:**
- Create: `src/queue-sampler.js`
- Test: `test/queue-sampler.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `softmaxSample(items, scores, { count, temperature, rng }) -> item[]` — picks `count` distinct items without replacement

- [ ] **Step 1: Write the failing test**

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { softmaxSample } = require('../src/queue-sampler')

// Deterministic RNG so a sampling test can assert exact output.
function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

test('returns the requested count, all distinct', () => {
  const items = ['a', 'b', 'c', 'd', 'e']
  const out = softmaxSample(items, [1, 2, 3, 4, 5], { count: 3, temperature: 1, rng: seeded(1) })
  assert.strictEqual(out.length, 3)
  assert.strictEqual(new Set(out).size, 3)
})

test('never returns more than it was given', () => {
  const out = softmaxSample(['a', 'b'], [1, 1], { count: 10, temperature: 1, rng: seeded(2) })
  assert.strictEqual(out.length, 2)
})

test('low temperature concentrates on the top scorer', () => {
  const items = ['low', 'high']
  let highCount = 0
  for (let i = 0; i < 200; i++) {
    const out = softmaxSample(items, [0, 5], { count: 1, temperature: 0.2, rng: seeded(i) })
    if (out[0] === 'high') highCount++
  }
  assert.ok(highCount > 180, `expected near-always high, got ${highCount}/200`)
})

test('high temperature spreads the picks', () => {
  const items = ['low', 'high']
  let highCount = 0
  for (let i = 0; i < 200; i++) {
    const out = softmaxSample(items, [0, 5], { count: 1, temperature: 8, rng: seeded(i) })
    if (out[0] === 'high') highCount++
  }
  assert.ok(highCount > 60 && highCount < 180, `expected a spread, got ${highCount}/200`)
})

test('the same seed gives the same result, different seeds differ', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const scores = items.map((_, i) => i)
  const a = softmaxSample(items, scores, { count: 4, temperature: 2, rng: seeded(7) })
  const b = softmaxSample(items, scores, { count: 4, temperature: 2, rng: seeded(7) })
  const c = softmaxSample(items, scores, { count: 4, temperature: 2, rng: seeded(99) })
  assert.deepStrictEqual(a, b)
  assert.notDeepStrictEqual(a, c)
})

test('an empty pool returns an empty array rather than throwing', () => {
  assert.deepStrictEqual(softmaxSample([], [], { count: 3, temperature: 1, rng: seeded(1) }), [])
})

test('a huge score does not produce NaN', () => {
  const out = softmaxSample(['a', 'b'], [1e6, 0], { count: 1, temperature: 1, rng: seeded(1) })
  assert.strictEqual(out[0], 'a')
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/queue-sampler.test.js`
Expected: FAIL — `Cannot find module '../src/queue-sampler'`

- [ ] **Step 3: Write the minimal implementation**

```js
'use strict'
// Weighted random selection without replacement.
//
// Top-N selection would give the same queue every time from the same seed,
// which is the opposite of what "surprise me" means. Softmax sampling stays in
// the right neighbourhood while never repeating itself.

function softmaxSample(items, scores, { count = 1, temperature = 1, rng = Math.random } = {}) {
  const pool = items.map((item, i) => ({ item, score: Number(scores[i]) || 0 }))
  if (!pool.length) return []
  const t = temperature > 0 ? temperature : 1e-6

  // Subtracting the max before exponentiating is what keeps a large score from
  // overflowing to Infinity and turning every weight into NaN.
  const out = []
  const want = Math.min(count, pool.length)
  while (out.length < want) {
    const max = Math.max(...pool.map(p => p.score))
    const weights = pool.map(p => Math.exp((p.score - max) / t))
    const total = weights.reduce((s, w) => s + w, 0)
    let r = rng() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i]
      if (r <= 0) { idx = i; break }
    }
    out.push(pool[idx].item)
    pool.splice(idx, 1)
  }
  return out
}

module.exports = { softmaxSample }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/queue-sampler.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/queue-sampler.js test/queue-sampler.test.js
git commit -m "feat(queues): softmax sampling so the same seed never gives the same queue"
```

---

### Task 6: Sequencing — spacing rules and smooth transitions

**Files:**
- Create: `src/queue-sequencer.js`
- Test: `test/queue-sequencer.test.js`

**Interfaces:**
- Consumes: `distance`, `FEATURE_KEYS` from `src/audio-features.js`
- Produces: `sequence(candidates, { vectors, artistGap = 3, albumGap = 5 }) -> track[]` where `candidates` are track objects carrying `filePath`, `artist`, `albumId`, and `vectors` is `Map<filePath, vector>`

- [ ] **Step 1: Write the failing test**

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { sequence } = require('../src/queue-sequencer')

function tr(i, artist, albumId) {
  return { filePath: `/t${i}.flac`, artist, albumId, title: `T${i}` }
}
function vec(energy) {
  return { energy, brightness: 0, dynamics: 0, density: 0, punch: 0 }
}

test('no two tracks by the same artist land within 3 of each other', () => {
  const cands = [
    tr(1, 'Pink Floyd', 'a'), tr(2, 'Pink Floyd', 'a'), tr(3, 'Pink Floyd', 'a'),
    tr(4, 'Yes', 'b'), tr(5, 'Yes', 'b'), tr(6, 'King Crimson', 'c'),
    tr(7, 'Rush', 'd'), tr(8, 'Camel', 'e'), tr(9, 'Genesis', 'f'),
  ]
  const vectors = new Map(cands.map((t, i) => [t.filePath, vec(i / 10)]))
  const out = sequence(cands, { vectors })
  const seen = new Map()
  out.forEach((t, i) => {
    const prev = seen.get(t.artist)
    if (prev !== undefined) assert.ok(i - prev >= 3, `${t.artist} repeated at ${prev} and ${i}`)
    seen.set(t.artist, i)
  })
})

test('every candidate appears exactly once', () => {
  const cands = [tr(1, 'A', 'a'), tr(2, 'B', 'b'), tr(3, 'C', 'c'), tr(4, 'D', 'd')]
  const vectors = new Map(cands.map(t => [t.filePath, vec(0.5)]))
  const out = sequence(cands, { vectors })
  assert.strictEqual(out.length, cands.length)
  assert.strictEqual(new Set(out.map(t => t.filePath)).size, cands.length)
})

test('adjacent energy jumps are smaller than a worst-case ordering', () => {
  const cands = [
    tr(1, 'A', 'a'), tr(2, 'B', 'b'), tr(3, 'C', 'c'),
    tr(4, 'D', 'd'), tr(5, 'E', 'e'), tr(6, 'F', 'f'),
  ]
  const energies = [0, 1, 0.1, 0.9, 0.2, 0.8]
  const vectors = new Map(cands.map((t, i) => [t.filePath, vec(energies[i])]))
  const out = sequence(cands, { vectors })
  const jump = arr => arr.slice(1).reduce(
    (s, t, i) => s + Math.abs(vectors.get(t.filePath).energy - vectors.get(arr[i].filePath).energy), 0)
  assert.ok(jump(out) < jump(cands), 'sequencing did not smooth the transitions')
})

test('spacing relaxes rather than dropping tracks when the pool is all one artist', () => {
  const cands = [tr(1, 'Solo', 'a'), tr(2, 'Solo', 'a'), tr(3, 'Solo', 'a')]
  const vectors = new Map(cands.map(t => [t.filePath, vec(0.5)]))
  const out = sequence(cands, { vectors })
  assert.strictEqual(out.length, 3, 'tracks were dropped instead of relaxing the rule')
})

test('a track with no vector is still placed, never dropped', () => {
  const cands = [tr(1, 'A', 'a'), tr(2, 'B', 'b')]
  const vectors = new Map([['/t1.flac', vec(0.5)]])
  const out = sequence(cands, { vectors })
  assert.strictEqual(out.length, 2)
})

test('an empty candidate list returns empty', () => {
  assert.deepStrictEqual(sequence([], { vectors: new Map() }), [])
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/queue-sequencer.test.js`
Expected: FAIL — `Cannot find module '../src/queue-sequencer'`

- [ ] **Step 3: Write the minimal implementation**

```js
'use strict'
// Ordering, which is what separates a curated queue from a bag of good tracks.
//
// Selection decides WHAT plays; this decides IN WHAT ORDER. Without it the
// queue slams a quiet acoustic piece into a heavy one and plays three albums by
// the same artist back to back.

const { distance } = require('./audio-features')

const ZERO = { energy: 0, brightness: 0, dynamics: 0, density: 0, punch: 0 }

function sequence(candidates, { vectors = new Map(), artistGap = 3, albumGap = 5 } = {}) {
  const pool = [...(candidates || [])]
  if (pool.length <= 1) return pool

  const vecOf = t => vectors.get(t.filePath) || ZERO
  const out = []

  // Start from the least energetic track so the queue has somewhere to rise to.
  let startIdx = 0
  for (let i = 1; i < pool.length; i++) {
    if (vecOf(pool[i]).energy < vecOf(pool[startIdx]).energy) startIdx = i
  }
  out.push(pool.splice(startIdx, 1)[0])

  const tooClose = (track, gap, key) => {
    const limit = Math.min(gap, out.length)
    for (let i = 1; i <= limit; i++) {
      const prev = out[out.length - i]
      if (prev && track[key] && prev[key] === track[key]) return true
    }
    return false
  }

  while (pool.length) {
    const last = out[out.length - 1]
    let best = -1, bestScore = Infinity, bestRelaxed = -1, bestRelaxedScore = Infinity

    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]
      const d = distance(vecOf(last), vecOf(cand))
      const blocked = tooClose(cand, artistGap, 'artist') || tooClose(cand, albumGap, 'albumId')
      if (!blocked && d < bestScore) { bestScore = d; best = i }
      if (d < bestRelaxedScore) { bestRelaxedScore = d; bestRelaxed = i }
    }

    // When everything left violates spacing -- a pool that is all one artist --
    // relax the rule rather than dropping tracks. A shorter queue is a worse
    // failure than a repeated artist.
    const pick = best >= 0 ? best : bestRelaxed
    out.push(pool.splice(pick, 1)[0])
  }

  return out
}

module.exports = { sequence }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/queue-sequencer.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/queue-sequencer.js test/queue-sequencer.test.js
git commit -m "feat(queues): sequence a queue so it flows instead of jarring"
```

---

### Task 7: The queue engine — four modes over one core

**Files:**
- Create: `src/queue-engine.js`
- Test: `test/queue-engine.test.js`

**Interfaces:**
- Consumes: `distance`, `normalise`, `buildNormaliser` (Task 2); `softmaxSample` (Task 5); `sequence` (Task 6)
- Produces: `buildQueue({ mode, seed, tracks, vectors, affinity, coldSet, length, surroundBias, rng }) -> track[]`
  - `mode` is one of `'radio' | 'mix' | 'surprise' | 'rediscover'`
  - `tracks` are library track objects with `filePath`, `artist`, `albumId`, `channels`
  - Also exports `MODE_TEMPERATURE = { radio: 0.4, mix: 1.0, surprise: 2.5, rediscover: 1.2 }` and `SURROUND_BONUS = 1.2`

- [ ] **Step 1: Write the failing test**

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { buildQueue, MODE_TEMPERATURE } = require('../src/queue-engine')

function seeded(s0) {
  let s = s0 >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

const V = e => ({ energy: e, brightness: e, dynamics: e, density: e, punch: e })

function lib(n, surroundEvery = 2) {
  const tracks = [], vectors = new Map()
  for (let i = 0; i < n; i++) {
    const t = {
      filePath: `/t${i}.flac`, title: `T${i}`,
      artist: `Artist${i % 12}`, albumId: `alb${i % 20}`,
      channels: i % surroundEvery === 0 ? 6 : 2,
    }
    tracks.push(t)
    vectors.set(t.filePath, V(i / n))
  }
  return { tracks, vectors }
}

test('radio returns the requested length and excludes the seed', () => {
  const { tracks, vectors } = lib(60)
  const seed = tracks[10]
  const q = buildQueue({ mode: 'radio', seed, tracks, vectors, length: 20, rng: seeded(1) })
  assert.strictEqual(q.length, 20)
  assert.ok(!q.some(t => t.filePath === seed.filePath), 'seed should not repeat in its own radio')
})

test('radio stays near the seed rather than wandering the library', () => {
  const { tracks, vectors } = lib(120)
  const seed = tracks[60]
  const q = buildQueue({ mode: 'radio', seed, tracks, vectors, length: 15, rng: seeded(3) })
  const seedE = vectors.get(seed.filePath).energy
  const avg = q.reduce((s, t) => s + Math.abs(vectors.get(t.filePath).energy - seedE), 0) / q.length
  assert.ok(avg < 0.3, `radio drifted too far: mean energy gap ${avg}`)
})

test('surround-first lands between 60 and 95 percent surround', () => {
  const { tracks, vectors } = lib(200)
  const q = buildQueue({ mode: 'surprise', tracks, vectors, length: 40, rng: seeded(5) })
  const ratio = q.filter(t => t.channels >= 6).length / q.length
  assert.ok(ratio >= 0.6 && ratio <= 0.95, `surround ratio was ${ratio}`)
})

test('rediscover only draws from the cold set', () => {
  const { tracks, vectors } = lib(60)
  const coldSet = new Set(tracks.slice(0, 12).map(t => t.filePath))
  const q = buildQueue({ mode: 'rediscover', tracks, vectors, coldSet, length: 8, rng: seeded(7) })
  assert.ok(q.length > 0)
  for (const t of q) assert.ok(coldSet.has(t.filePath), `${t.filePath} was not cold`)
})

test('the same seed reproduces, a different seed does not', () => {
  const { tracks, vectors } = lib(80)
  const a = buildQueue({ mode: 'surprise', tracks, vectors, length: 12, rng: seeded(11) })
  const b = buildQueue({ mode: 'surprise', tracks, vectors, length: 12, rng: seeded(11) })
  const c = buildQueue({ mode: 'surprise', tracks, vectors, length: 12, rng: seeded(12) })
  assert.deepStrictEqual(a.map(t => t.filePath), b.map(t => t.filePath))
  assert.notDeepStrictEqual(a.map(t => t.filePath), c.map(t => t.filePath))
})

test('artist spacing survives the whole pipeline', () => {
  const { tracks, vectors } = lib(120)
  const q = buildQueue({ mode: 'surprise', tracks, vectors, length: 30, rng: seeded(13) })
  const seen = new Map()
  q.forEach((t, i) => {
    const prev = seen.get(t.artist)
    if (prev !== undefined) assert.ok(i - prev >= 3, `${t.artist} at ${prev} and ${i}`)
    seen.set(t.artist, i)
  })
})

test('affinity raises a favourite track into the queue', () => {
  const { tracks, vectors } = lib(100)
  const fav = tracks[77].filePath
  const affinity = new Map([[fav, 1]])
  let hits = 0
  for (let i = 0; i < 40; i++) {
    const q = buildQueue({ mode: 'surprise', tracks, vectors, affinity, length: 15, rng: seeded(i) })
    if (q.some(t => t.filePath === fav)) hits++
  }
  assert.ok(hits > 10, `a strong favourite appeared only ${hits}/40 times`)
})

test('no features at all still returns a playable queue', () => {
  const { tracks } = lib(40)
  const q = buildQueue({ mode: 'surprise', tracks, vectors: new Map(), length: 10, rng: seeded(2) })
  assert.strictEqual(q.length, 10)
})

test('a library smaller than the requested length returns what exists', () => {
  const { tracks, vectors } = lib(5)
  const q = buildQueue({ mode: 'surprise', tracks, vectors, length: 50, rng: seeded(2) })
  assert.strictEqual(q.length, 5)
})

test('an empty library returns an empty queue', () => {
  assert.deepStrictEqual(buildQueue({ mode: 'surprise', tracks: [], vectors: new Map(), length: 10 }), [])
})

test('radio is the tightest mode and surprise the loosest', () => {
  assert.ok(MODE_TEMPERATURE.radio < MODE_TEMPERATURE.mix)
  assert.ok(MODE_TEMPERATURE.mix < MODE_TEMPERATURE.surprise)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/queue-engine.test.js`
Expected: FAIL — `Cannot find module '../src/queue-engine'`

- [ ] **Step 3: Write the minimal implementation**

```js
'use strict'
// The four queue modes. One selection core; the modes differ only in candidate
// pool, scoring and how widely the sampler is allowed to roam.

const { distance, buildNormaliser, normalise } = require('./audio-features')
const { softmaxSample } = require('./queue-sampler')
const { sequence } = require('./queue-sequencer')

const MODE_TEMPERATURE = { radio: 0.4, mix: 1.0, surprise: 2.5, rediscover: 1.2 }
const SURROUND_BONUS = 1.2
const AFFINITY_WEIGHT = 1.5
const ZERO = { energy: 0, brightness: 0, dynamics: 0, density: 0, punch: 0 }

function poolFor(mode, tracks, seed, coldSet, clusterOf, seedCluster) {
  if (mode === 'rediscover') {
    const cold = coldSet || new Set()
    return tracks.filter(t => cold.has(t.filePath))
  }
  if (mode === 'mix' && clusterOf) {
    return tracks.filter(t => clusterOf.get(t.filePath) === seedCluster)
  }
  if (mode === 'radio' && seed) {
    return tracks.filter(t => t.filePath !== seed.filePath)
  }
  return tracks
}

function buildQueue({
  mode = 'surprise', seed = null, tracks = [], vectors = new Map(),
  affinity = new Map(), coldSet = null, clusterOf = null, seedCluster = null,
  length = 30, surroundBias = SURROUND_BONUS, rng = Math.random,
} = {}) {
  const pool = poolFor(mode, tracks || [], seed, coldSet, clusterOf, seedCluster)
  if (!pool.length) return []

  // Z-score against this library so "bright" means bright relative to what the
  // user owns, not against an absolute scale that means nothing here.
  const present = pool.map(t => vectors.get(t.filePath)).filter(Boolean)
  const norm = buildNormaliser(present)
  const zOf = t => {
    const v = vectors.get(t.filePath)
    return v ? normalise(v, norm) : ZERO
  }
  const seedZ = seed ? zOf(seed) : null

  const scores = pool.map(t => {
    let s = 0
    if (seedZ && mode === 'radio') s -= distance(seedZ, zOf(t))
    s += AFFINITY_WEIGHT * (affinity.get(t.filePath) || 0)
    if ((t.channels || 0) >= 6) s += surroundBias
    return s
  })

  // Oversample, then let sequencing choose the order from a slightly wider set.
  const want = Math.min(length, pool.length)
  const picked = softmaxSample(pool, scores, {
    count: Math.min(pool.length, Math.ceil(want * 1.5)),
    temperature: MODE_TEMPERATURE[mode] ?? 1,
    rng,
  })

  const zVectors = new Map(picked.map(t => [t.filePath, zOf(t)]))
  return sequence(picked, { vectors: zVectors }).slice(0, want)
}

module.exports = { buildQueue, MODE_TEMPERATURE, SURROUND_BONUS, AFFINITY_WEIGHT }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/queue-engine.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/queue-engine.js test/queue-engine.test.js
git commit -m "feat(queues): the four modes, surround-first, over one selection core"
```

---

### Task 8: Cluster the library into daily mixes

**Files:**
- Create: `src/queue-clusters.js`
- Test: `test/queue-clusters.test.js`

**Interfaces:**
- Consumes: `FEATURE_KEYS`, `distance`, `buildNormaliser`, `normalise` (Task 2)
- Produces: `clusterLibrary({ tracks, vectors, k = 5, rng, previousCentroids = null }) -> { clusterOf: Map<filePath, number>, centroids: vector[], names: string[] }`

- [ ] **Step 1: Write the failing test**

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { clusterLibrary } = require('../src/queue-clusters')

function seeded(s0) {
  let s = s0 >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

function twoBlobs() {
  const tracks = [], vectors = new Map()
  for (let i = 0; i < 40; i++) {
    const quiet = i < 20
    const t = { filePath: `/t${i}.flac`, artist: quiet ? 'Quiet Band' : 'Loud Band', albumId: `a${i}` }
    tracks.push(t)
    const base = quiet ? 0.1 : 0.9
    vectors.set(t.filePath, {
      energy: base, brightness: base, dynamics: base, density: base, punch: base,
    })
  }
  return { tracks, vectors }
}

test('separates two obvious groups', () => {
  const { tracks, vectors } = twoBlobs()
  const { clusterOf } = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(1) })
  const first = clusterOf.get('/t0.flac')
  for (let i = 0; i < 20; i++) assert.strictEqual(clusterOf.get(`/t${i}.flac`), first)
  for (let i = 20; i < 40; i++) assert.notStrictEqual(clusterOf.get(`/t${i}.flac`), first)
})

test('every track is assigned', () => {
  const { tracks, vectors } = twoBlobs()
  const { clusterOf } = clusterLibrary({ tracks, vectors, k: 5, rng: seeded(2) })
  for (const t of tracks) assert.ok(Number.isInteger(clusterOf.get(t.filePath)))
})

test('names a mix after its dominant artists, never a genre tag', () => {
  const { tracks, vectors } = twoBlobs()
  const { names } = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(3) })
  assert.strictEqual(names.length, 2)
  assert.ok(names.some(n => n.includes('Quiet Band')))
  assert.ok(names.some(n => n.includes('Loud Band')))
})

test('k larger than the library does not throw or produce empty clusters', () => {
  const tracks = [{ filePath: '/a.flac', artist: 'A', albumId: 'x' }]
  const vectors = new Map([['/a.flac', { energy: 1, brightness: 1, dynamics: 1, density: 1, punch: 1 }]])
  const r = clusterLibrary({ tracks, vectors, k: 5, rng: seeded(4) })
  assert.strictEqual(r.clusterOf.get('/a.flac'), 0)
  assert.strictEqual(r.centroids.length, 1)
})

test('seeding from previous centroids keeps assignments stable across refits', () => {
  const { tracks, vectors } = twoBlobs()
  const first = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(5) })
  const again = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(999), previousCentroids: first.centroids })
  for (const t of tracks) {
    assert.strictEqual(again.clusterOf.get(t.filePath), first.clusterOf.get(t.filePath))
  }
})

test('an empty library returns empty structures', () => {
  const r = clusterLibrary({ tracks: [], vectors: new Map(), k: 5, rng: seeded(6) })
  assert.strictEqual(r.centroids.length, 0)
  assert.strictEqual(r.names.length, 0)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/queue-clusters.test.js`
Expected: FAIL — `Cannot find module '../src/queue-clusters'`

- [ ] **Step 3: Write the minimal implementation**

```js
'use strict'
// Daily mixes: group the library by how it sounds, then name each group after
// the artists in it. Naming from artists rather than genre is deliberate --
// 37% of this library's surround albums have no genre tag at all, and those
// that do nearly all say "Progressive Rock".

const { FEATURE_KEYS, distance, buildNormaliser, normalise } = require('./audio-features')

const MAX_ITERATIONS = 25

function meanVector(vectors) {
  const out = {}
  for (const k of FEATURE_KEYS) {
    out[k] = vectors.length ? vectors.reduce((s, v) => s + v[k], 0) / vectors.length : 0
  }
  return out
}

function nameCluster(members) {
  const counts = new Map()
  for (const t of members) {
    if (!t.artist) continue
    counts.set(t.artist, (counts.get(t.artist) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0])
  if (!top.length) return 'Mix'
  return top.length === 1 ? `${top[0]} and more` : `${top[0]}, ${top[1]} and more`
}

function clusterLibrary({ tracks = [], vectors = new Map(), k = 5, rng = Math.random, previousCentroids = null } = {}) {
  const usable = tracks.filter(t => vectors.has(t.filePath))
  if (!usable.length) return { clusterOf: new Map(), centroids: [], names: [] }

  const norm = buildNormaliser(usable.map(t => vectors.get(t.filePath)))
  const pts = usable.map(t => normalise(vectors.get(t.filePath), norm))
  const kk = Math.max(1, Math.min(k, usable.length))

  // Reusing the previous centroids is what stops "your prog mix" becoming a
  // different mix every week for no reason the listener can see.
  let centroids = previousCentroids && previousCentroids.length === kk
    ? previousCentroids.map(c => ({ ...c }))
    : Array.from({ length: kk }, () => ({ ...pts[Math.floor(rng() * pts.length)] }))

  let assign = new Array(pts.length).fill(0)
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = false
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bestD = Infinity
      for (let c = 0; c < centroids.length; c++) {
        const d = distance(pts[i], centroids[c])
        if (d < bestD) { bestD = d; best = c }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true }
    }
    for (let c = 0; c < centroids.length; c++) {
      const members = pts.filter((_, i) => assign[i] === c)
      if (members.length) centroids[c] = meanVector(members)
    }
    if (!moved) break
  }

  const clusterOf = new Map()
  usable.forEach((t, i) => clusterOf.set(t.filePath, assign[i]))
  const names = centroids.map((_, c) => nameCluster(usable.filter((_, i) => assign[i] === c)))

  return { clusterOf, centroids, names }
}

module.exports = { clusterLibrary, MAX_ITERATIONS }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/queue-clusters.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/queue-clusters.js test/queue-clusters.test.js
git commit -m "feat(queues): cluster the library into named daily mixes"
```

---

### Task 9: Analysis runner — one file, end to end

**Files:**
- Create: `analysis-runner.js`
- Test: `test/analysis-runner.test.js`

**Interfaces:**
- Consumes: `parseAnalysis`, `rawToVector`, `FEATURE_VERSION` (Tasks 1–2)
- Produces:
  - `buildFfmpegArgs(filePath) -> string[]`
  - `analyseOne(filePath, { spawnFn, timeoutMs = 120000 }) -> Promise<{ ok: true, vector } | { ok: false, error }>`

- [ ] **Step 1: Write the failing test**

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { buildFfmpegArgs, analyseOne } = require('../analysis-runner')

const GOOD = `
    I:         -14.2 LUFS
    LRA:        11.4 LU
    Peak:        -0.3 dBFS
[astats] RMS level dB: -18.372
[astats] Crest factor: 6.221
[astats] Zero crossings rate: 0.041270
[astats] Flat factor: 0.000000
[aspectralstats] mean centroid: 1842.310
[aspectralstats] mean spread: 2210.775
[aspectralstats] mean flatness: 0.128
[aspectralstats] mean rolloff: 4820.500
[aspectralstats] mean entropy: 0.712
`

function fakeSpawn({ stderr = '', code = 0, delay = 0 }) {
  return () => {
    const proc = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => { proc.emit('close', null) }
    setTimeout(() => {
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr))
      proc.emit('close', code)
    }, delay)
    return proc
  }
}

test('args downmix to mono 22050 and request all three filter sets', () => {
  const args = buildFfmpegArgs('/music/a.flac')
  const af = args[args.indexOf('-af') + 1]
  assert.ok(args.includes('/music/a.flac'))
  assert.ok(af.includes('aresample=22050'))
  assert.ok(af.includes('channel_layouts=mono'))
  assert.ok(af.includes('ebur128'))
  assert.ok(af.includes('astats'))
  assert.ok(af.includes('aspectralstats'))
  assert.ok(args.includes('-nostats'))
})

test('a clean run returns a vector', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: GOOD }) })
  assert.strictEqual(r.ok, true)
  assert.ok(Number.isFinite(r.vector.energy))
})

test('a non-zero exit is reported, not thrown', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: 'boom', code: 1 }) })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /exit|1/)
})

test('output that parses to nothing usable is a failure, not a null vector', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ stderr: 'nothing here', code: 0 }) })
  assert.strictEqual(r.ok, false)
})

test('a hung ffmpeg is killed and reported rather than hanging forever', async () => {
  const r = await analyseOne('/a.flac', { spawnFn: fakeSpawn({ delay: 5000 }), timeoutMs: 30 })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /timed out/i)
})

test('a spawn error is reported', async () => {
  const spawnFn = () => {
    const proc = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    setTimeout(() => proc.emit('error', new Error('ENOENT')), 0)
    return proc
  }
  const r = await analyseOne('/a.flac', { spawnFn })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /ENOENT/)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/analysis-runner.test.js`
Expected: FAIL — `Cannot find module '../analysis-runner'`

- [ ] **Step 3: Write the minimal implementation**

```js
'use strict'
// Runs ffmpeg over the library to produce feature vectors.
//
// spawnFn is injectable so the whole path is testable without ffmpeg and
// without touching the disk.

const { spawn } = require('child_process')
const { parseAnalysis, rawToVector, FEATURE_VERSION } = require('./src/audio-features')

const DEFAULT_TIMEOUT_MS = 120000

function buildFfmpegArgs(filePath) {
  return [
    '-hide_banner', '-nostats', '-nostdin',
    '-i', filePath,
    '-map', '0:a:0',
    '-af', 'aresample=22050,aformat=channel_layouts=mono,ebur128=peak=true,astats=metadata=1:reset=0,aspectralstats',
    '-f', 'null', '-',
  ]
}

function analyseOne(filePath, { spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }

    let proc
    try {
      proc = spawnFn('ffmpeg', buildFfmpegArgs(filePath), { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      return finish({ ok: false, error: String(e && e.message || e) })
    }

    // ffmpeg writes its measurements to stderr, so the buffer is the result,
    // not a diagnostic. A file with no timeout can wedge the whole pool.
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, error: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    let buf = ''
    proc.stderr.on('data', d => { buf += d.toString() })
    proc.on('error', e => finish({ ok: false, error: String(e && e.message || e) }))
    proc.on('close', code => {
      if (code !== 0) return finish({ ok: false, error: `ffmpeg exit ${code}` })
      const vector = rawToVector(parseAnalysis(buf))
      if (!vector) return finish({ ok: false, error: 'analysis produced no usable measurements' })
      finish({ ok: true, vector, featureVersion: FEATURE_VERSION })
    })
  })
}

module.exports = { buildFfmpegArgs, analyseOne, DEFAULT_TIMEOUT_MS }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/analysis-runner.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add analysis-runner.js test/analysis-runner.test.js
git commit -m "feat(queues): analyse one file with ffmpeg, with a timeout and no throwing"
```

---

### Task 10: Analysis pool — incremental, bounded, and it stops for playback

**Files:**
- Modify: `analysis-runner.js`
- Modify: `test/analysis-runner.test.js`

**Interfaces:**
- Consumes: `analyseOne` (Task 9)
- Produces: `runAnalysis({ tracks, existing, concurrency, isPlaying, analyseFn, onProgress, shouldStop }) -> Promise<{ analysed, skipped, failed, results: Map<filePath, entry> }>` where an entry is `{ vector, featureVersion, mtimeMs, size }`
- Also: `needsAnalysis(track, entry) -> boolean`

- [ ] **Step 1: Write the failing test**

```js
const { runAnalysis, needsAnalysis } = require('../analysis-runner')
const { FEATURE_VERSION } = require('../src/audio-features')

const V = { energy: 1, brightness: 1, dynamics: 1, density: 1, punch: 1 }
const okFn = async () => ({ ok: true, vector: V, featureVersion: FEATURE_VERSION })

function trk(i, mtimeMs = 100, size = 10) {
  return { filePath: `/t${i}.flac`, mtimeMs, size }
}

test('a track with a current entry is skipped', () => {
  const t = trk(1)
  const entry = { vector: V, featureVersion: FEATURE_VERSION, mtimeMs: 100, size: 10 }
  assert.strictEqual(needsAnalysis(t, entry), false)
})

test('a changed file, a resized file, or a stale version is re-analysed', () => {
  const t = trk(1, 100, 10)
  const base = { vector: V, featureVersion: FEATURE_VERSION, mtimeMs: 100, size: 10 }
  assert.strictEqual(needsAnalysis(t, { ...base, mtimeMs: 99 }), true)
  assert.strictEqual(needsAnalysis(t, { ...base, size: 11 }), true)
  assert.strictEqual(needsAnalysis(t, { ...base, featureVersion: FEATURE_VERSION - 1 }), true)
  assert.strictEqual(needsAnalysis(t, undefined), true)
})

test('only unanalysed tracks are processed', async () => {
  const tracks = [trk(1), trk(2), trk(3)]
  const existing = new Map([['/t1.flac', { vector: V, featureVersion: FEATURE_VERSION, mtimeMs: 100, size: 10 }]])
  const seen = []
  const r = await runAnalysis({
    tracks, existing, concurrency: 2,
    analyseFn: async fp => { seen.push(fp); return { ok: true, vector: V, featureVersion: FEATURE_VERSION } },
  })
  assert.deepStrictEqual(seen.sort(), ['/t2.flac', '/t3.flac'])
  assert.strictEqual(r.analysed, 2)
  assert.strictEqual(r.skipped, 1)
})

test('concurrency is never exceeded', async () => {
  let inFlight = 0, peak = 0
  const analyseFn = async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 5))
    inFlight--
    return { ok: true, vector: V, featureVersion: FEATURE_VERSION }
  }
  await runAnalysis({ tracks: Array.from({ length: 12 }, (_, i) => trk(i)), existing: new Map(), concurrency: 3, analyseFn })
  assert.ok(peak <= 3, `peak concurrency was ${peak}`)
})

test('analysis stops while audio is playing', async () => {
  let calls = 0
  const r = await runAnalysis({
    tracks: Array.from({ length: 10 }, (_, i) => trk(i)),
    existing: new Map(), concurrency: 2,
    isPlaying: () => true,
    analyseFn: async () => { calls++; return { ok: true, vector: V, featureVersion: FEATURE_VERSION } },
  })
  assert.strictEqual(calls, 0, 'analysis ran while audio was playing')
  assert.strictEqual(r.analysed, 0)
})

test('one failure does not abort the batch', async () => {
  const r = await runAnalysis({
    tracks: [trk(1), trk(2), trk(3)], existing: new Map(), concurrency: 2,
    analyseFn: async fp => fp === '/t2.flac'
      ? { ok: false, error: 'bad file' }
      : { ok: true, vector: V, featureVersion: FEATURE_VERSION },
  })
  assert.strictEqual(r.analysed, 2)
  assert.strictEqual(r.failed, 1)
  assert.ok(r.results.has('/t1.flac') && r.results.has('/t3.flac'))
})

test('progress is reported and shouldStop halts cleanly', async () => {
  const seenProgress = []
  const r = await runAnalysis({
    tracks: Array.from({ length: 20 }, (_, i) => trk(i)), existing: new Map(), concurrency: 1,
    analyseFn: okFn,
    onProgress: p => seenProgress.push(p),
    shouldStop: () => seenProgress.length >= 3,
  })
  assert.ok(seenProgress.length >= 3)
  assert.ok(r.analysed < 20, 'shouldStop did not halt the run')
})

test('an empty track list resolves rather than hanging', async () => {
  const r = await runAnalysis({ tracks: [], existing: new Map(), analyseFn: okFn })
  assert.strictEqual(r.analysed, 0)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/analysis-runner.test.js`
Expected: FAIL — `runAnalysis is not a function`

- [ ] **Step 3: Write the minimal implementation**

Append to `analysis-runner.js` and extend `module.exports`:

```js
const os = require('os')

function defaultConcurrency() {
  return Math.max(1, (os.cpus() || []).length - 1)
}

function needsAnalysis(track, entry) {
  if (!entry || !entry.vector) return true
  if (entry.featureVersion !== FEATURE_VERSION) return true
  if (Number(entry.mtimeMs) !== Number(track.mtimeMs)) return true
  if (Number(entry.size) !== Number(track.size)) return true
  return false
}

async function runAnalysis({
  tracks = [], existing = new Map(), concurrency = defaultConcurrency(),
  isPlaying = () => false, analyseFn = analyseOne,
  onProgress = () => {}, shouldStop = () => false,
} = {}) {
  const todo = []
  let skipped = 0
  for (const t of tracks) {
    if (needsAnalysis(t, existing.get(t.filePath))) todo.push(t)
    else skipped++
  }

  const results = new Map()
  let analysed = 0, failed = 0, cursor = 0, halted = false

  async function worker() {
    while (!halted) {
      // Playback owns the machine. The stability round established that heavy
      // background work on this path is what breaks audio; this yields to it
      // rather than competing.
      if (isPlaying() || shouldStop()) { halted = true; return }
      const i = cursor++
      if (i >= todo.length) return
      const t = todo[i]
      const r = await analyseFn(t.filePath)
      if (r && r.ok) {
        results.set(t.filePath, {
          vector: r.vector, featureVersion: FEATURE_VERSION,
          mtimeMs: t.mtimeMs, size: t.size,
        })
        analysed++
      } else {
        failed++
      }
      onProgress({ done: analysed + failed, total: todo.length, filePath: t.filePath })
    }
  }

  const n = Math.max(1, Math.min(concurrency, todo.length || 1))
  await Promise.all(Array.from({ length: n }, worker))
  return { analysed, skipped, failed, results }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/analysis-runner.test.js`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add analysis-runner.js test/analysis-runner.test.js
git commit -m "feat(queues): incremental bounded analysis that yields to playback"
```

---

### Task 11: Wire it into the app — store, IPC, preload

**Files:**
- Modify: `main.js` (add the feature store, the analysis IPC handlers, and the queue-build handler)
- Modify: `preload.js` (expose the three new channels)
- Test: `test/queue-ipc.test.js`

**Interfaces:**
- Consumes: everything above
- Produces three IPC endpoints:
  - `queue-build` — `invoke({ mode, seedFilePath, length }) -> { ok, tracks }`
  - `queue-analysis-status` — `invoke() -> { analysed, total, running }`
  - `queue-analysis-start` — `invoke() -> { ok }`

- [ ] **Step 1: Write the failing test**

The existing `test/ipc-channel-wiring.test.js` asserts every invoked channel has a handler. Add a test that the three new channels are wired on both sides:

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

const CHANNELS = ['queue-build', 'queue-analysis-status', 'queue-analysis-start']

test('every queue channel has a handler in main', () => {
  for (const c of CHANNELS) {
    assert.ok(main.includes(`ipcMain.handle('${c}'`), `${c} has no handler`)
  }
})

test('every queue channel is exposed through preload', () => {
  for (const c of CHANNELS) {
    assert.ok(preload.includes(`'${c}'`), `${c} is not exposed in preload`)
  }
})

test('the feature store is a side store, never the shared config', () => {
  assert.ok(main.includes("name: 'audio-features'"), 'audio-features side store missing')
  assert.ok(!/store\.set\(\s*['"]audioFeatures/.test(main), 'features must not go into config.json')
})

test('analysis is gated on playback', () => {
  assert.ok(/isPlaying\s*:/.test(main), 'runAnalysis must be passed an isPlaying gate')
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/queue-ipc.test.js`
Expected: FAIL — `queue-build has no handler`

- [ ] **Step 3: Write the minimal implementation**

In `main.js`, near the other side stores:

```js
const { SideStore } = require('./side-store')
const { runAnalysis } = require('./analysis-runner')
const { buildQueue } = require('./src/queue-engine')
const { clusterLibrary } = require('./src/queue-clusters')
const { buildAffinity, buildColdSet } = require('./src/taste-model')

const featureStore = new SideStore({
  dir: USER_DATA, name: 'audio-features', fallback: { features: {} },
  onError: e => console.error('[features]', e.message),
})

let analysisRunning = false

function featureMap() {
  const raw = (featureStore.get() || {}).features || {}
  return new Map(Object.entries(raw))
}

ipcMain.handle('queue-analysis-status', async () => {
  const tracks = allLibraryTracks()
  return { analysed: featureMap().size, total: tracks.length, running: analysisRunning }
})

ipcMain.handle('queue-analysis-start', async () => {
  if (analysisRunning) return { ok: true, alreadyRunning: true }
  analysisRunning = true
  const tracks = allLibraryTracks()
  runAnalysis({
    tracks,
    existing: featureMap(),
    isPlaying: () => Boolean(player && player.getState && !player.getState().paused),
    onProgress: p => mainWindow?.webContents.send('queue-analysis-progress', p),
  }).then(r => {
    featureStore.update(v => {
      const features = { ...((v || {}).features || {}) }
      for (const [fp, entry] of r.results) features[fp] = entry
      return { features }
    })
    analysisRunning = false
    mainWindow?.webContents.send('queue-analysis-progress', { done: r.analysed, total: tracks.length, finished: true })
  }).catch(e => {
    analysisRunning = false
    console.error('[features] run failed:', e && e.message)
  })
  return { ok: true }
})

ipcMain.handle('queue-build', async (_e, { mode = 'surprise', seedFilePath = null, length = 30 } = {}) => {
  const tracks = allLibraryTracks()
  const vectors = new Map([...featureMap()].map(([fp, entry]) => [fp, entry.vector]))
  const history = readHistoryEntries()
  const playCounts = store.get('playCounts', {})
  const affinity = buildAffinity({ history, playCounts, likedTracks: store.get('likedTracks', []) })
  const coldSet = mode === 'rediscover' ? buildColdSet({ history, playCounts }) : null
  let clusterOf = null, seedCluster = null
  if (mode === 'mix') {
    const c = clusterLibrary({ tracks, vectors, k: 5 })
    clusterOf = c.clusterOf
    seedCluster = seedFilePath ? c.clusterOf.get(seedFilePath) ?? 0 : 0
  }
  const seed = seedFilePath ? tracks.find(t => t.filePath === seedFilePath) : null
  return { ok: true, tracks: buildQueue({ mode, seed, tracks, vectors, affinity, coldSet, clusterOf, seedCluster, length }) }
})
```

`allLibraryTracks()` returns every track from the library cache with `filePath`, `artist`, `albumId`, `channels`, `mtimeMs` and `size`. `readHistoryEntries()` returns the raw array from the play-history side store — `buildAffinity` normalises it.

In `preload.js`, alongside the other invoke wrappers:

```js
  queueBuild:          (opts) => ipcRenderer.invoke('queue-build', opts),
  queueAnalysisStatus: () => ipcRenderer.invoke('queue-analysis-status'),
  queueAnalysisStart:  () => ipcRenderer.invoke('queue-analysis-start'),
```

and add `'queue-analysis-progress'` to the receive-only channel allowlist.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/queue-ipc.test.js && npm test`
Expected: PASS — the new file, and the existing `ipc-channel-wiring` test still green

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js test/queue-ipc.test.js
git commit -m "feat(queues): wire the queue engine and analysis runner into the app"
```

---

### Task 12: The interface

**Files:**
- Modify: `src/renderer.js` (Radio action, Made-for-you row, stereo badge, analysis progress)
- Modify: `src/index.html` (load the five new scripts)
- Modify: `src/styles.css`
- Test: `test/queue-ui.test.js`

**Interfaces:**
- Consumes: `window.api.queueBuild`, `queueAnalysisStatus`, `queueAnalysisStart`

- [ ] **Step 1: Write the failing test**

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const p = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const renderer = p('src/renderer.js')
const html = p('src/index.html')
const css = p('src/styles.css')

test('every new module is loaded as a script', () => {
  for (const f of ['audio-features', 'taste-model', 'queue-sampler', 'queue-sequencer', 'queue-engine', 'queue-clusters']) {
    assert.ok(html.includes(`${f}.js`), `${f}.js not loaded in index.html`)
  }
})

test('the renderer can start each of the four modes', () => {
  for (const m of ['radio', 'mix', 'surprise', 'rediscover']) {
    assert.ok(renderer.includes(`'${m}'`), `mode ${m} unreachable from the renderer`)
  }
})

test('stereo tracks in a surround-first queue get a marker with a real rule', () => {
  assert.ok(renderer.includes('q-stereo-badge'), 'no stereo badge emitted')
  assert.ok(/\.q-stereo-badge\s*\{/.test(css), 'q-stereo-badge has no CSS rule')
})

test('every new class the renderer emits has a CSS rule', () => {
  for (const c of ['q-madeforyou', 'q-mix-card', 'q-analysis-progress']) {
    assert.ok(renderer.includes(c), `${c} not emitted`)
    assert.ok(new RegExp(`\\.${c}\\s*[{,]`).test(css), `.${c} has no CSS rule`)
  }
})

test('the empty state says features are still being built rather than showing nothing', () => {
  assert.ok(/still (listening|analysing|analyzing)/i.test(renderer), 'no "still analysing" empty state')
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test test/queue-ui.test.js`
Expected: FAIL — `audio-features.js not loaded in index.html`

- [ ] **Step 3: Write the minimal implementation**

Add the six scripts to `src/index.html` before `renderer.js`, matching the existing classic-script pattern:

```html
    <script src="audio-features.js"></script>
    <script src="taste-model.js"></script>
    <script src="queue-sampler.js"></script>
    <script src="queue-sequencer.js"></script>
    <script src="queue-clusters.js"></script>
    <script src="queue-engine.js"></script>
```

In `src/renderer.js` add:

- `startSmartQueue(mode, seedFilePath)` — calls `window.api.queueBuild({ mode, seedFilePath, length: 40 })`, assigns `state.queue`, sets `state.queueIndex = 0`, calls `playCurrentTrack()`, and on `{ tracks: [] }` shows a snackbar reading `Still analysing your library — try again shortly`.
- A **Radio** entry in the track and album context menus and a Radio button on the now-playing bar, each calling `startSmartQueue('radio', track.filePath)`.
- A **Made for you** row on Home containing five `q-mix-card` elements from the cluster names, plus a Surprise Me card and a Rediscover card.
- In the queue panel, `<span class="q-stereo-badge">STEREO</span>` on any track whose `channels < 6` when the queue contains at least one surround track.
- A `q-analysis-progress` line in Manage bound to `queue-analysis-progress`.

In `src/styles.css` add rules for `.q-madeforyou`, `.q-mix-card`, `.q-stereo-badge` and `.q-analysis-progress`, using the existing `:root` tokens — no new colour literals.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, all suites including the existing renderer-hygiene and ipc-channel-wiring tests

- [ ] **Step 5: Verify in the running app, then commit**

```bash
bash .qa/relaunch.sh
node .qa/ev.js "startSmartQueue('surprise').then(() => ({ len: state.queue.length, surround: state.queue.filter(t => (t.channels||0) >= 6).length }))"
```
Expected: a queue of 40 with roughly 28–36 surround tracks, and `tools/mpv-probe.js` showing `pause: false` on a real file.

```bash
git add src/renderer.js src/index.html src/styles.css test/queue-ui.test.js
git commit -m "feat(queues): radio, daily mixes, surprise and rediscover in the interface"
```

---

## Self-review

**Spec coverage** — §1 features → Tasks 1, 2, 9; §2 similarity → Task 2; §3 taste model → Tasks 3, 4; §4 four modes → Tasks 7, 8; §5 surround-first → Task 7 (ratio test); §6 sequencing → Task 6; §7 randomness → Task 5; §8 performance and failure → Tasks 9, 10 (timeout, playback gate, per-file failure isolation, fallback with no features → Task 7 "no features at all" test and Task 12 empty state); §9 interface → Task 12; §10 testing → every task.

**Placeholders** — none. Every code step carries the actual code.

**Type consistency** — `FEATURE_KEYS` order fixed in Task 1 and used unchanged in 2, 6, 8. `vectors` is `Map<filePath, vector>` in Tasks 6, 7, 8, 11. `affinity` and `coldSet` are `Map` and `Set` in Tasks 3, 4, 7, 11. `analyseFn` returns the same `{ ok, vector, featureVersion }` shape in Tasks 9 and 10.

**Known gap, deliberate** — `allLibraryTracks()` and `readHistoryEntries()` in Task 11 are described by contract rather than shown, because they are thin adapters over the existing library-cache and play-history side stores whose exact shape the implementer will read at that point. Every function that makes a decision is fully specified.

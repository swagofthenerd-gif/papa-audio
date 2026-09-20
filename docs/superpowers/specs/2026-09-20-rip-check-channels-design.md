# Soulseek rip check — channel-layout half

## What this adds

The rip check already downloads one track from a peer and measures its bit depth, dynamic range and high-frequency ceiling; this adds the one fact it was throwing away — how many channels the file actually has, and what layout they form. It also reports the two things that reading can prove: a folder listed as 5.1 whose track is plain stereo, and a multichannel container whose surround channels hold nothing but silence.

---

## Measured facts the rules rest on

All output below is verbatim from ffmpeg/ffprobe **8.1.2** at `/usr/bin` on this machine. Everything in this section was re-run during this review; nothing is quoted from the draft.

### ffprobe, key=value form (`-of default=noprint_wrappers=1`)

Plain stereo FLAC:

```
codec_name=flac
sample_rate=44100
channels=2
channel_layout=stereo
bits_per_sample=0
bits_per_raw_sample=16
```

Genuine 5.1 FLAC:

```
codec_name=flac
sample_rate=48000
channels=6
channel_layout=5.1(side)
bits_per_sample=0
bits_per_raw_sample=24
```

Dolby Atmos in `.m4a` (re-measured on `Space Oddity/01 Space Oddity (2019 Mix).m4a`):

```
codec_name=eac3
profile=Dolby Digital Plus + Dolby Atmos
sample_rate=48000
channels=6
channel_layout=5.1(side)
bits_per_sample=0
bits_per_raw_sample=N/A
```

Facts a parser must survive:

* **ffprobe emits its own field order**, not the order requested. Parse by key name, never by line position.
* **`channels` is always present and is always an integer.** It was present on all 2,550 files probed. It is the authoritative figure.
* **`channel_layout` is decoration with an open vocabulary.** Strings observed on this machine: `stereo`, `mono`, `2.1`, `3.0`, `3.0(back)`, `quad(side)`, `5.0`, `5.1`, `5.1(side)`, `5.1.2`, `6.1`, `7.1`, `7.1.4`, `9.1.4`, `unknown`. Both `5.1` and `5.1(side)` mean six-channel surround; `5.1(side)` is ~380 of ~560 six-channel FLACs here plus every ac3/eac3/dts file. An equality test against `'5.1'` misses most real surround.
* **`unknown` is a real value**, not an error; in `-of json` the key is omitted entirely instead. Treat absent, `''`, `unknown` and `N/A` as one null case.
* **`bits_per_sample` is `0` for every compressed codec**, FLAC included; the real depth is `bits_per_raw_sample`, which is the literal string `N/A` for mp3/opus/eac3/ac3/raw-dts.
* **Six FLACs on this machine report `channels=0`, `sample_rate=0` and exit 0.** `if (probe.err)` does not catch them.
* `format=duration` is `N/A` for raw `.ac3` and `.dts`.

### ffmpeg `astats=measure_perchannel=all`, whole track

Captured from `1977 - Animals (2022 BluRay 5.1)/1-01 - Pigs On The Wing (Part One).flac` (6 ch, `5.1(side)`, 86.665 s). One complete channel block:

```
[Parsed_astats_0 @ 0x7ff72c004880] Channel: 1
[Parsed_astats_0 @ 0x7ff72c004880] DC offset: -0.000015
[Parsed_astats_0 @ 0x7ff72c004880] Min level: -9930.000000
[Parsed_astats_0 @ 0x7ff72c004880] Max level: 10529.000000
[Parsed_astats_0 @ 0x7ff72c004880] Min difference: 0.000000
[Parsed_astats_0 @ 0x7ff72c004880] Max difference: 2610.000000
[Parsed_astats_0 @ 0x7ff72c004880] Mean difference: 75.427499
[Parsed_astats_0 @ 0x7ff72c004880] RMS difference: 131.912559
[Parsed_astats_0 @ 0x7ff72c004880] Peak level dB: -9.860991
[Parsed_astats_0 @ 0x7ff72c004880] RMS level dB: -30.765484
[Parsed_astats_0 @ 0x7ff72c004880] RMS peak dB: -19.519624
[Parsed_astats_0 @ 0x7ff72c004880] RMS through dB: -inf
[Parsed_astats_0 @ 0x7ff72c004880] Crest factor: 11.097488
[Parsed_astats_0 @ 0x7ff72c004880] Flat factor: 0.000000
[Parsed_astats_0 @ 0x7ff72c004880] Peak count: 2
[Parsed_astats_0 @ 0x7ff72c004880] Abs Peak count: 1
[Parsed_astats_0 @ 0x7ff72c004880] Noise floor dB: -inf
[Parsed_astats_0 @ 0x7ff72c004880] Noise floor count: 144053
[Parsed_astats_0 @ 0x7ff72c004880] Entropy: 0.652411
[Parsed_astats_0 @ 0x7ff72c004880] Bit depth: 14/16/16/16
[Parsed_astats_0 @ 0x7ff72c004880] Dynamic range: 86.468342
[Parsed_astats_0 @ 0x7ff72c004880] Zero crossings: 167956
[Parsed_astats_0 @ 0x7ff72c004880] Zero crossings rate: 0.040375
```

The complete `Overall` block from the same run:

```
[Parsed_astats_0 @ 0x7f41c4004880] Overall
[Parsed_astats_0 @ 0x7f41c4004880] DC offset: -0.000015
[Parsed_astats_0 @ 0x7f41c4004880] Min level: -9930.000000
[Parsed_astats_0 @ 0x7f41c4004880] Max level: 10529.000000
[Parsed_astats_0 @ 0x7f41c4004880] Min difference: 0.000000
[Parsed_astats_0 @ 0x7f41c4004880] Max difference: 2610.000000
[Parsed_astats_0 @ 0x7f41c4004880] Mean difference: 23.155128
[Parsed_astats_0 @ 0x7f41c4004880] RMS difference: 70.639666
[Parsed_astats_0 @ 0x7f41c4004880] Peak level dB: -9.860991
[Parsed_astats_0 @ 0x7f41c4004880] RMS level dB: -36.218651
[Parsed_astats_0 @ 0x7f41c4004880] RMS peak dB: -19.519624
[Parsed_astats_0 @ 0x7f41c4004880] RMS through dB: -inf
[Parsed_astats_0 @ 0x7f41c4004880] Flat factor: 131.958961
[Parsed_astats_0 @ 0x7f41c4004880] Peak count: 2773280.666667
[Parsed_astats_0 @ 0x7f41c4004880] Abs Peak count: 35808.000000
[Parsed_astats_0 @ 0x7f41c4004880] Noise floor dB: -inf
[Parsed_astats_0 @ 0x7f41c4004880] Noise floor count: 2774168.666667
[Parsed_astats_0 @ 0x7f41c4004880] Entropy: 0.214124
[Parsed_astats_0 @ 0x7f41c4004880] Bit depth: 14/16/16/16
[Parsed_astats_0 @ 0x7f41c4004880] Number of samples: 4159920
```

Structural facts, all re-verified:

* One `Channel: N` block per channel, 1-based, in layout order, then exactly one `Overall` block. Block count before `Overall` equals ffprobe's `channels`.
* **`Overall` has no colon and no value** — the bare line `[…] Overall`. A parser that requires a colon skips it and merges Overall's metrics into the last channel.
* **`Overall` omits `Crest factor`, `Dynamic range`, `Zero crossings`, `Zero crossings rate` and adds `Number of samples`.** `Dynamic range` exists only per channel. `Bit depth` exists in both, and Overall's value is the max across channels (`14/16/16/16` = max of 14, 14, 1, 1, 1, 1).
* Integer fields in channel blocks become floats in `Overall` (`Peak count: 2` vs `2773280.666667`).
* **`-inf` is a real token** in any dB field. `parseFloat('-inf')` and `Number('-inf')` are both `NaN`, not `-Infinity`.
* `Bit depth` is four slash-separated values, not a number.
* The prefix `[Parsed_astats_0 @ 0x7ff72c004880]` carries a heap pointer that changes every run and an ordinal that changes with chain position. Anchor on `^\[[^\]]*\]\s+`, never on the label text.
* **astats logs at ffmpeg `info` level on stderr.** `-v error` / `-loglevel error` silences it completely. It must not be added.
* Because info level is required, the same stderr carries the input metadata dump — i.e. **peer-supplied tag text**. Reproduced here: a FLAC whose `comment` tag holds `Dynamic range: 99.9\nBit depth: 24/24` prints

  ```
      comment         : Dynamic range: 99.9
                      : Bit depth: 24/24
  ```

  Those lines do **not** start with `[`, so the `^\[[^\]]*\]` anchor rejects them. The anchor is a security control, not a style preference.

### The two files the accusation rules are calibrated against

**Genuine 5.1 that looks fake in any 60-second head window** — `1977 - Animals (2022 BluRay 5.1)/1-01 - Pigs On The Wing (Part One).flac`, a solo acoustic piece on an official Blu-Ray 5.1 remix.

```
-t 60 from t=0:   ch1 -9.924746  ch2 -11.343409  ch3 -inf  ch4 -inf  ch5 -inf  ch6 -inf
whole track:      ch1 -9.860991  ch2 -11.343409  ch3..ch6 all -90.308734   (Bit depth 1/16/16/16)
```

Over the sampled window the four non-front channels are literally `-inf`; over the **whole track** they sit one LSB above digital zero. This single measurement settles two design questions: window-based sampling condemns a genuine release, and any dead-channel threshold above about −90 dB condemns it too.

**Measured fake** — real stereo padded to six channels: `Peak level dB: -inf` and `RMS level dB: -inf` on all five non-front channels, whole file.

**Genuine 5.1 with permanently silent channels that is *not* fake** — `2007 In Rainbows Disk 2 (4.0)/04 MK2.flac`: ch3 and ch4 are `-inf` for the entire track while the rears run at ≈ −9.6 dB.

### Cost of measuring the whole track (this is what makes the windowing debate moot)

| pass | file | wall clock |
|---|---|---|
| astats `measure_perchannel=all`, whole file | Animals 1-01, 8.2 MB, 16/48 6 ch | **0.29 s** |
| astats `measure_perchannel=all`, whole file | Division Bell "Cluster One", **303 MB**, 24/96 6 ch, 359 s | **1.88 s** |
| astats `measure_perchannel=all`, whole file | Space Oddity Atmos `.m4a`, eac3 6 ch | **1.07 s** |
| one `highpass+volumedetect` band, whole file | Division Bell "Cluster One" | **0.69 s** |

Eight whole-file passes on the largest surround FLAC on this machine cost **≈ 6.7 s** against the 120 s of non-transfer budget in the 300 s IPC deadline (`main.js:128`, 180 s reserved for the transfer at `main.js:11199`). There is no time argument for sampling a window.

### Channel order (from `ffmpeg -layouts`, verified)

```
2.1            FL+FR+LFE
3.1            FL+FR+FC+LFE
5.1            FL+FR+FC+LFE+BL+BR
5.1(side)      FL+FR+FC+LFE+SL+SR
6.1            FL+FR+FC+LFE+BC+SL+SR
6.1(front)     FL+FR+LFE+FLC+FRC+SL+SR
7.1            FL+FR+FC+LFE+BL+BR+SL+SR
5.1.2          FL+FR+FC+LFE+SL+SR+TFL+TFR
7.1.4          FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR+TBL+TBR
9.1.4          FL+FR+FC+LFE+BL+BR+FLC+FRC+SL+SR+TFL+TFR+TBL+TBR
```

astats never prints a channel name, so LFE position must come from this table. Note `6.1(front)` puts LFE at index **3**, so stripping the parenthetical before looking up LFE is wrong; look up the full string.

### Name-based claim detection, re-run against the shipped `src/slsk-filters.js`

```
"Grateful Dead 1977-5-1 Barton Hall"        -> {"kind":"ch51","label":"5.1"}
"gd77-5-1.sbd.miller.flac16"                -> {"kind":"ch51","label":"5.1"}
"Phish 1995 12-5-1 set"                     -> {"kind":"ch51","label":"5.1"}
"Disc 5-1"                                  -> {"kind":"ch51","label":"5.1"}
"Album [5.1GB]"                             -> {"kind":"ch51","label":"5.1"}
"Firmware v5.1 tools"                       -> {"kind":"ch51","label":"5.1"}
"Quad City DJs - Space Jam"                 -> {"kind":"quad","label":"QUAD"}
"Tipper - Surrounded (Virtual Surround)"    -> {"kind":"mch","label":"MCH"}
"Pink Floyd - Animals (2022 BluRay 5.1)"    -> {"kind":"ch51","label":"5.1"}
```

Every unpadded date-named taper folder claims 5.1. This is why the accusing rules get a narrowed claim of their own.

---

## Parse functions

All new code is pure and lives in `/home/shaharyar/flac-player/src/rip-check.js`. Nothing here spawns a process.

### argv changes

```js
// What the file claims to be, in the key=value form parseProbe expects.
function probeArgs(file) {
  return ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,channels,channel_layout,profile' +
    ':format=duration',
    '-of', 'default=noprint_wrappers=1', file]
}

// Whole-track per-channel statistics. No -t: the whole track is measured
// because a 60-second window reads -inf on four channels of a genuine 5.1
// Blu-Ray remix that reads -90.3 dB over its full length. Cost measured at
// 0.29-1.88 s. No -v error: astats logs at info level and -v error silences it.
// -map 0:a:0 so ffmpeg measures the stream ffprobe described (ffprobe takes the
// first audio stream; ffmpeg's default takes the one with the most channels)
// and so an attached cover-art stream is not mapped.
function astatsArgs(file) {
  return ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', 'astats=measure_perchannel=all', '-f', 'null', '-']
}

// One ceiling band, also whole-track and also stream-pinned, so the ceiling
// and the channel read describe the same audio.
function ceilingArgs(file, hz) {
  return ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', `highpass=f=${hz}:poles=2,volumedetect`, '-f', 'null', '-']
}
```

`args.slice(0, 2)` stays `['-hide_banner', '-nostats']`, so the pinned prefix assertion at `test/rip-check-ipc.test.js:28` still holds.

### `parseProbe(text) -> { sampleRate, bitDepth, codec, channels, channelLayout, atmos, duration }`

Keeps its existing per-key anchored regex (`^<key>=(.+)$` with `/m`) — never positional. New behaviour:

```js
function layoutOf(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s || s === 'unknown' || s === 'N/A') return null
  return s                       // verbatim, e.g. '5.1(side)'
}
```

* `channels: num(get('channels'))` — `null` when the key is absent.
* `channelLayout: layoutOf(get('channel_layout'))`.
* `atmos: /atmos/i.test(get('profile') || '')`.
* `duration: num(get('duration'))` — `null` for the literal `N/A` (raw `.ac3`/`.dts`), because the shipped `num()` maps non-finite to `null`.
* `bitDepth` keeps its `bits_per_raw_sample || bits_per_sample` fallback.

Malformed input (`''`, garbage, a JSON blob): every field `null`, `atmos` `false`. Never throws.

### `dbNum(tok) -> number | null`

```js
function dbNum(tok) {
  const t = String(tok == null ? '' : tok).trim()
  if (t === '-inf' || t === '-Infinity') return -Infinity
  if (t === 'inf' || t === '+inf' || t === 'Infinity') return Infinity
  const n = Number(t)
  return Number.isFinite(n) ? n : null      // 'nan', '-nan', '' -> null
}
```

Mandatory: `parseFloat('-inf')` is `NaN`, and `NaN > -100` is `false`, so without this a silent channel is counted as dead by accident rather than by rule and every other comparison in the module is poisoned.

### `parseChannels(text) -> { channels, perChannel, complete }`

Line rules, applied in this order, per line:

1. `/^\[[^\]]*\]\s+Overall\s*$/` — stop. Everything after is ignored.
2. `/^\[[^\]]*\]\s+Channel:\s+(\d+)\s*$/` — open block `N`, push `{ index: N, peakDb: null, rmsDb: null }`.
3. `/^\[[^\]]*\]\s+Peak level dB:\s*(\S+)\s*$/` — `peakDb = dbNum($1)` on the open block.
4. `/^\[[^\]]*\]\s+RMS level dB:\s*(\S+)\s*$/` — `rmsDb = dbNum($1)` on the open block.

Anything else is ignored. Rule 2 must be tested **before** any generic `key: value` rule, or `Channel: 1` is recorded as a metric named `Channel`. The `^\[[^\]]*\]` anchor is what rejects the peer-tag injection reproduced above.

Returns:

* `channels` — the count of `Channel:` blocks seen before `Overall`, or `null` when there were none.
* `perChannel` — the blocks, in order.
* `complete` — `perChannel.length > 0 && perChannel.every(c => c.peakDb != null)`.

Malformed input (empty stderr, an `-ss` past EOF run that prints only `Output file is empty`, a truncated stream): `{ channels: null, perChannel: [], complete: false }`.

### `parseAstats(text) -> { measuredBits, dynamicRange }` — revised

With `measure_perchannel=all` the per-channel blocks now carry `Dynamic range` and `Bit depth`, and the unscoped `last()` would return **channel 6's** numbers. Scope it:

1. Split at the first line matching `/^\[[^\]]*\]\s+Overall\s*$/m`. Read only the text **after** that line. If there is no `Overall` line, fall back to the whole text (preserves today's behaviour on an empty or odd stream).
2. `measuredBits` from `/^\[[^\]]*\]\s+Bit depth:\s*(\d+)\/\d+/m` in that tail. Overall's first field is the max across channels — verified (`14/16/16/16` with per-channel firsts 14, 14, 1, 1, 1, 1) — which is the honest whole-file figure.
3. `dynamicRange` from `/^\[[^\]]*\]\s+Dynamic range:\s*([\d.]+)/m` in that tail. On ffmpeg 8.1.2 the Overall block never carries this line, so it stays `null`. *Absent is not zero* — the existing rule — still holds.

Both regexes gain the `^\[[^\]]*\]` anchor, which closes the peer-tag injection.

### `parseCeiling(text, floorDb = FLOOR_DB) -> number | null`

Unchanged logic; gains an optional floor argument (default `FLOOR_DB`, so existing callers and the existing test are untouched).

### `floorFor(channels) -> number`

```js
function floorFor(channels) {
  const c = Number(channels) || 0
  if (c <= 2) return FLOOR_DB
  return FLOOR_DB - 10 * Math.log10(c / 2)     // 6ch -> -89.77, 8ch -> -91.02
}
```

`volumedetect` histograms every sample across all channels, so `mean_volume` is a power mean over channels; identical high-frequency content living in 2 of 6 channels reads `10*log10(2/6)` = 4.77 dB lower than the same content as stereo. Without this, a genuine 5.1 rip is pushed toward the existing `lossless && ceil <= 16000` → `transcoded` branch. The compensation only ever **lowers** the floor, so it can only make the app less accusatory.

### `layoutLabel(channels, channelLayout) -> string | null`

```js
function layoutLabel(channels, channelLayout) {
  const base = String(channelLayout || '').replace(/\(.*$/, '').trim()
  if (base && base.toLowerCase() !== 'unknown') return base
  const c = classify(channels)                 // from ./surround-verify
  return c === 'unknown' ? null : c
}
```

ffprobe's own name wins, with the parenthesised qualifier stripped for display. `classify()` is the fallback only — it returns `'7.1'` for any count ≥ 8, which would announce a measured `5.1.2` bed as 7.1 and a 12-channel `7.1.4` bed as 7.1. `src/rip-check.js` gains `const { classify } = require('./surround-verify')`; both modules are pure CommonJS and load under plain node. **Do not write a third channel→label mapping** — `format-badges.surroundLabel` and `library-manage.channelLabel` already disagree.

### `lfeIndex(channels, channelLayout) -> number | null`

Exact lookup on the **full, unstripped** layout string:

```js
const LFE_INDEX = {
  '2.1': 3, '3.1': 4, '3.1.2': 4,
  '5.1': 4, '5.1(side)': 4,
  '6.1': 4, '6.1(back)': 4, '6.1(front)': 3,
  '7.1': 4, '7.1(wide)': 4, '7.1(wide-side)': 4,
  '5.1.2': 4, '5.1.2(back)': 4, '5.1.4': 4,
  '7.1.2': 4, '7.1.4': 4, '9.1.4': 4,
}
function lfeIndex(channels, channelLayout) {
  const i = LFE_INDEX[String(channelLayout || '')]
  if (!i) return null                                    // unknown layout: guess nothing
  return i <= (Number(channels) || 0) ? i : null
}
```

`6.1(front)` is why the lookup uses the full string. When the layout is unknown, returning `null` includes every channel in the liveness tally, which makes the fakery rule **harder** to fire — the safe direction.

### `accusableClaim(label, text) -> string | null`

The narrowed claim used only by the rules that accuse. Tested against the strings in the measured-facts section:

```js
const CLAIM_NUM = { '5.1': /5[._-]1/, '7.1': /7[._-]1/ }

function accusableClaim(label, text) {
  const s = String(text || '')
  if (label === 'ATMOS' || label === 'MCH') return label
  if (label === 'QUAD') return /\bquadr[ao]phonic\b/i.test(s) ? 'QUAD' : null
  const re = CLAIM_NUM[label]
  if (!re) return null
  const g = new RegExp(re.source, 'gi')
  let m
  while ((m = g.exec(s)) !== null) {
    const before = s.slice(Math.max(0, m.index - 12), m.index)
    const after  = s.slice(m.index + m[0].length, m.index + m[0].length + 6)
    if (/\d[._\-/]$/.test(before)) continue                                    // 1977-5-1, 12-5-1
    if (/[vV]$/.test(before)) continue                                          // v5.1
    if (/\b(disc|disk|cd|vol|volume|part|pt|track|tr)[._\- ]*$/i.test(before)) continue
    if (/^[._\-/]\d/.test(after)) continue                                      // 5-1-77
    if (/^[._\- ]?(gb|mb|kb|tb)\b/i.test(after)) continue                       // 5.1GB
    return label
  }
  return null
}
```

Verified results: `null` for `1977-5-1`, `gd77-5-1`, `12-5-1`, `Disc 5-1`, `cd5-1`, `5.1GB`, `v5.1`, `Quad City DJs`; `'5.1'` for `Animals (2022 BluRay 5.1)`, `5-1 Surround Mix`, `2011 5.1 Surround Mix`, `[5.1 DTS]`, `5_1 mix`; `'7.1'` for `2020 7.1 Multichannel`; `'QUAD'` for `Quadraphonic Mix`; `'MCH'` for `Virtual Surround`.

Note the narrowing also rejects `5.1.2` (the `after` is `.2`). Such a file lands in `bonus-surround`, which is harmless.

### `siblingSurroundHint(files, sampled) -> boolean`

```js
function siblingSurroundHint(files, sampled) {
  const bps = f => {
    const s = Number(f && f.size), l = Number(f && f.length)
    return (Number.isFinite(s) && Number.isFinite(l) && l > 30) ? s / l : null
  }
  const mine = bps(sampled)
  return (files || []).some(f => {
    if (f === sampled) return false
    if (!AUDIO_RE.test(f.name || f.filename || '')) return false
    const b = bps(f)
    return b !== null && b >= 400000 && (mine === null || b >= mine * 2)
  })
}
```

Bytes-per-second measured on this library: 16/44 stereo FLAC ≈ 88 kB/s, 24/96 stereo ≈ 250 kB/s, 24/48 6 ch ≈ 520 kB/s, 24/96 6 ch ≈ 840 kB/s. This only ever **suppresses** an accusation (a 24/192 stereo sibling at ≈ 500 kB/s would falsely suppress, which is the safe direction). It never creates one.

### `pickTrackInfo(files) -> { file, fallback } | null`

`pickTrack` keeps its signature (`pickTrackInfo(files) && pickTrackInfo(files).file`) so nothing else breaks. One deliberate behaviour change inside it: within the under-cap list, **sort by `size` descending, tie-broken by `length` descending**, instead of by `length` alone.

Reason, measured: in the Animals folder the two under-cap files are 8,164,901 and 11,371,400 bytes. The current comparator sorts on `Number(f.length)`, which slskd often omits; when both are `0` the comparator is a no-op and selection falls to input order — so whether the app accuses a genuine Blu-Ray release depends on whether a stranger's client filled in an optional metadata field. Sorting on `size`, which slskd always supplies, makes selection deterministic.

`fallback` is `true` when every audio file exceeded `MAX_SAMPLE_BYTES` and the smallest was taken — the normal path on genuine 24/96 surround albums, and the path most likely to land on a stereo bonus track.

### `expectedCh(claim) -> number | null`

`'7.1'` → 8, `'5.1'` → 6, `'QUAD'` → 4, `'ATMOS'` → `null`, `'MCH'` → `null`, anything else → `null`.

### `isPcmFamily(codec) -> boolean`

`/^(flac|alac|wav|pcm_|ape|wavpack|aiff?)/i.test(String(codec || ''))`.

---

## Verdict rules

New pure export `channelVerdict(input) -> { kind, severity, … }`, **separate from the existing `verdict()`**. `verdict()` is not touched: its five kinds map straight onto the CSS class `slr-rip-${kind}` (`src/slsk-room.css:190-191`) and drive the ✓/⚠ glyph, so a new kind there would paint a warning triangle on a good 5.1 rip and land on an unstyled class.

```js
channelVerdict({ channels, channelLayout, claim, perChannel, complete,
                 measuredChannels, codec, atmos, durationSec, siblingHint })
```

### Preamble

```js
const ch     = Number(channels)
const label  = layoutLabel(ch, channelLayout)          // '5.1', 'stereo', '5.1.2', …
const lfe    = lfeIndex(ch, channelLayout)             // 4, 3 or null
const agreed = measuredChannels === ch && ch > 0
const read   = agreed && perChannel.length === ch && complete
const silent = perChannel.filter(c => c.peakDb === -Infinity).map(c => c.index)
const surroundIdx  = []
for (let i = 3; i <= ch; i++) if (i !== lfe) surroundIdx.push(i)
const frontAlive   = [1, 2].filter(i => {
  const c = perChannel.find(x => x.index === i)
  return c && c.peakDb != null && c.peakDb !== -Infinity
}).length
const surroundSilent = surroundIdx.length > 0 && surroundIdx.every(i => silent.includes(i))
```

**A channel counts as silent only when its whole-track `Peak level dB` is literally `-inf`.** Justification, measured on this machine: the only genuine near-miss (Animals ch3–6) reads `-90.308734` over the whole track; the only measured fake reads `-inf`. Any finite peak is alive. A −80 dB threshold — proposed in review — would condemn that genuine Blu-Ray release, so it is rejected.

**LFE is excluded from every liveness tally.** A genuine mix can hold a digitally silent LFE for a whole track (`In Rainbows Disk 2/04 MK2.flac`: ch3 and ch4 both `-inf`, rears alive at −9.6 dB).

### Ordered rules, first match wins

1. **`unknown`** — `!Number.isFinite(ch) || ch <= 0`. Severity `unknown`. Nothing else is computed. *Six FLACs here report `channels=0` and exit 0; when `sample_rate` is also 0 the handler fails before reaching this, but a 0-channel read with a valid rate must not become a confident answer.*

2. **`claim-unverified`** — `claim !== null && ch <= 2 && siblingHint`. Severity `plain`. *The folder demonstrably holds files large enough to be the surround mix; the sampled track being stereo says nothing about the album.*

3. **`claim-mismatch`** — `claim !== null && ch <= 2`. Severity `warn`. *This is the user's scar and it fires on the ffprobe integer alone, immune to every astats trap. The Tipper "Virtual Surround" album reads `channels=2, channel_layout=stereo` with the folder and tags both saying surround.*

4. **`stereo`** — `ch === 2`. Severity `plain`.

5. **`mono`** — `ch === 1`. Severity `plain`.

6. **`padded-channels`** — all of:
   `ch >= 4` **and** `read` **and** `frontAlive >= 1` **and** `surroundIdx.length > 0` **and** `surroundSilent` **and** `durationSec !== null && durationSec >= 90`.
   Severity `warn`.
   *Every guard is load-bearing. `read` — if astats and ffprobe disagree or any peak line is missing, we are not looking at what we think we are. `frontAlive >= 1` — if the fronts are dead too we measured silence, not a fake. `surroundSilent` requires **every** non-LFE surround to be digitally silent; one or two dead surrounds deliberately produce no verdict. The 90 s floor exists because short tracks on surround albums are disproportionately interludes and acoustic pieces — Animals "Pigs On The Wing (Part One)" is 86.665 s and is exactly that class of near-miss.*

7. **`claim-short`** — `ch >= 3 && claim !== null && expectedCh(claim) !== null && expectedCh(claim) > ch && !atmos && isPcmFamily(codec)`. Severity `warn`.
   *The `ch >= 3` bound (not 4) closes the hole where a 3-channel `2.1` or `3.0(back)` file under a 5.1 claim produced no verdict at all. The codec and atmos guards exist because ffprobe's count understates two measured classes: 112 files here are `profile=Dolby Digital Plus + Dolby Atmos` reporting a 6-channel bed while being object-based, and `DTS-HD MA` reports a 6-channel core that may carry 7.1.*

8. **`surround-unverified`** — `ch >= 4 && !read`. Severity `plain`. **This is the explicit "cannot tell."** It fires whenever astats and ffprobe disagree on the count, a channel block carried no parsable `Peak level dB`, or astats returned no blocks at all (a truncated sample, or a decode that produced nothing). The block then prints only the channel fact and says nothing about fakery. *It is the default whenever the per-channel data cannot carry an opinion, not an error path.*

9. **`surround`** — `ch >= 4 && claim !== null`. Severity `good`. Reached only after 6, 7 and 8 declined.

10. **`bonus-surround`** — `ch >= 4 && claim === null`. Severity `good`. *slskd never reports channel count (`src/download-spread.js:43`) and every other surround surface in this app is name-matching, so an unlabelled multichannel rip is otherwise invisible.*

11. **`other`** — anything left (`ch === 3` with no claim, or a count `layoutLabel` cannot name). Severity `plain`.

### Corruption gate (in `main.js`, right after `parseProbe`, before anything else)

```js
if (declared.channels === 0 && declared.sampleRate === 0)
  return { ok: false, reason: "This file wouldn't open properly — it looks damaged or incomplete." }
```

Six FLACs on this machine report `channels=0`, `sample_rate=0`, `channel_layout=unknown` **and exit 0**; the shipped `if (probe.err)` does not catch them. If `channels` is 0 but `sampleRate > 0`, do not fail — let rule 1 answer `unknown`.

### Scope fence

`channelCheck` is **not** written back onto `album.surround`, does not change `tierOf()`'s purple dot, does not change Gate 0 of `upgradeReason` (`src/slsk-shelves.js:869`), and does not change Surround-shelf membership or the header ring. One track is not an album; silently overriding Gate 0 puts the 5.1 scar back from the other side. The rip block states what it measured; every other surface keeps saying what the names claim.

---

## Claim comparison

**Which function supplies the claim:** `detectSurround(text)` from `src/slsk-filters.js:39` — the module `src/source-fingerprint.js:17` already names the single source of truth. **Not** `album.surround`, which `src/slsk-shelves.js:778` sets from folded-child evidence only and is false for most albums actually sitting in the Surround shelf.

**Where it is computed:** entirely in `main.js`, inside the handler. No renderer or preload change. The handler already destructures `folderPath` at `main.js:11247` and never uses it; this puts it to work.

**What text it is run over — the last path segment plus the sampled file's own name, nothing else:**

```js
const seg  = String(folderPath || '').split('/').filter(Boolean).pop() || ''
const base = path.basename(String(filename || ''))
const claimText = seg + ' ' + base
const raw   = (slskFilters.detectSurround(claimText) || {}).label || null
const claim = ripCheck.accusableClaim(raw, claimText)
```

Ancestor path segments are excluded because a share path like `@@user/5.1 Surround Collection/Artist - Album/` would otherwise stamp a 5.1 claim on every album beneath it. Sibling file names are excluded because one file named `… (5.1 mix).flac` among eleven stereo tracks would otherwise make the whole album claim 5.1, and sampling any of the other eleven would then accuse it.

**Validation:** only `'5.1'`, `'7.1'`, `'ATMOS'`, `'QUAD'`, `'MCH'` can survive. `'SACD'` and `'DVD-A'` are unreachable from `detectSurround` — the pattern list is ordered and returns on first match, so reaching a `HINT_ONLY` entry proves nothing stronger matched, and the guard then always continues. `accusableClaim` then drops date-like, version-like and size-like numerals, and bare `quad`. Anything else collapses to `null`.

**Comparison is never string equality between the two vocabularies.** The claim side speaks `ATMOS|7.1|5.1|QUAD|MCH`; the measured side speaks ffprobe layout names (`5.1(side)`, `5.1.2`, `quad(side)`, …). The only overlap is `5.1` and `7.1`. So the comparison is done on two integers: `expectedCh(claim)` against ffprobe's `channels`. A `null` expectation (`ATMOS`, `MCH`) means the claim carries no number, and only the surround/not-surround distinction is checked. **`channel_layout` is never compared against anything** — it is carried through as `layoutRaw` and used only to build the display label and the LFE index.

**Direction:** a claim that promises **more** than the file delivers is reported; a file that delivers **more** than the claim promised is reported as a bonus; a match is confirmed; an equal-or-better result never produces a warning.

**No claim (`claim === null`) is a first-class case, not an error.** Rules 2, 3 and 7 cannot fire. A stereo file with no claim reports `stereo` and prints one quiet fragment. A multichannel file with no claim reports `bonus-surround` and says so.

A folder named "Virtual Surround" still produces a claim (`MCH`) and is still reported. It is the user's own scar case; nulling the claim on words like *virtual* or *binaural* — proposed in review — would hide exactly what he asked to see. The wording is neutral ("Listed as surround, but…"), which is truthful about an honest binaural fold-down without calling the label a lie.

---

## Output shape

```js
// main.js, inside ipcMain.handle('slsk-verify-rip'), replacing lines 11254-11287.
//
//   const slskFilters = require('./src/slsk-filters')   // top of file, with the other requires
//
//   const pick = ripCheck.pickTrackInfo(files || [])
//   if (!pick) return { ok: false, reason: 'No audio file in this folder to test.' }
//   const track = pick.file
//   const filename = track.fullPath || track.filename || track.name
//   ...
//   const declared = ripCheck.parseProbe(probe.stdout)
//   if (declared.channels === 0 && declared.sampleRate === 0)
//     return { ok: false, reason: "This file wouldn't open properly — it looks damaged or incomplete." }
//   const stats    = await _run('ffmpeg', ripCheck.astatsArgs(local), 60000)
//   const measured = ripCheck.parseAstats(stats.stderr)
//   const chans    = ripCheck.parseChannels(stats.stderr)
//   const ceilingHz = ripCheck.parseCeiling(bandText, ripCheck.floorFor(declared.channels))
//   const seg   = String(folderPath || '').split('/').filter(Boolean).pop() || ''
//   const ctext = seg + ' ' + path.basename(String(filename))
//   const claim = ripCheck.accusableClaim((slskFilters.detectSurround(ctext) || {}).label || null, ctext)
//   const chan  = ripCheck.channelVerdict({
//     channels: declared.channels, channelLayout: declared.channelLayout, claim,
//     perChannel: chans.perChannel, complete: chans.complete, measuredChannels: chans.channels,
//     codec: declared.codec, atmos: declared.atmos, durationSec: declared.duration,
//     siblingHint: ripCheck.siblingSurroundHint(files || [], track) })

return {
  ok: true,
  verdict,                                   // UNCHANGED { kind, text } — closed kind set, four tests pinned
  ceilingHz,
  measuredBits: measured.measuredBits,
  dynamicRange: measured.dynamicRange === null || measured.dynamicRange === undefined ? null : measured.dynamicRange,
  declaredBits: declared.bitDepth,
  declaredRate: declared.sampleRate,
  track: path.basename(filename),
  at: Date.now(),

  // --- new; every field absent-tolerant, never defaulted on the renderer side ---
  channels: declared.channels,               // number|null — ffprobe integer, the authoritative figure
  channelLayout: declared.channelLayout,     // string|null — ffprobe's spelling, e.g. '5.1(side)'
  atmos: declared.atmos,                     // boolean
  durationSec: declared.duration,            // number|null — null for raw .ac3/.dts
  sampledBytes: Number(track.size) || null,  // number|null
  sampledSmallest: pick.fallback,            // boolean — true when every file exceeded the 80 MB cap
  claimLabel: claim,                         // '5.1'|'7.1'|'ATMOS'|'QUAD'|'MCH'|null
  channelCheck: chan                         // object below, or null when channels is null
}

// chan === ripCheck.channelVerdict(...) ===
// {
//   kind: 'surround' | 'bonus-surround' | 'surround-unverified' | 'padded-channels'
//       | 'claim-mismatch' | 'claim-unverified' | 'claim-short'
//       | 'stereo' | 'mono' | 'other' | 'unknown',
//   severity: 'good' | 'warn' | 'plain' | 'unknown',
//   channels: 6,                  // number      — echoed from ffprobe
//   label: '5.1',                 // string|null — ffprobe's layout with '(…)' stripped, else classify()
//   layoutRaw: '5.1(side)',       // string|null — ffprobe's spelling, verbatim
//   claim: '5.1',                 // string|null — the narrowed, accusable claim
//   expected: 6,                  // number|null — expectedCh(claim)
//   measuredChannels: 6,          // number|null — astats 'Channel: N' block count, excluding Overall
//   aliveChannels: 6,             // number|null — channels - silentChannels.length; null when !read
//   silentChannels: [],           // number[]|null — 1-based indices whose whole-track peak is -inf
//   lfeChannel: 4,                // number|null — from the full layout string; null when unknown
//   complete: true,               // boolean     — astats and ffprobe agreed and every peak parsed
//   fact: '6 channels (5.1)',     // string      — short fragment for the facts row; '' when unknown
//   text: 'All 6 channels carry sound — nothing is padded with silence. I only checked one track of 12.'
// }
```

**No raw dB value crosses the IPC boundary.** `peakDb` is `-Infinity` for a silent channel, and the renderer writes this object straight into `localStorage` with `JSON.stringify` (`src/slsk-dossier.js:199`), where `-Infinity` becomes `null`. Only derived integers and index arrays are returned.

`text` is built in `channelVerdict` and therefore cannot know the album track count. The handler leaves the `{tracks}` slot as the literal token `{tracks}` in the two sentences that need it; `ripHtml` substitutes `m.tracks.length` and, when that is unavailable, rewrites `I only checked one track of {tracks}.` to `I only checked one track.` before escaping.

---

## User-facing copy

Claim words are mapped to English before interpolation: `'5.1'`→`5.1`, `'7.1'`→`7.1`, `'ATMOS'`→`Atmos`, `'QUAD'`→`quadraphonic`, `'MCH'`→`surround`.

**Facts-row fragments** (`fact`, printed first in the grey run):

| case | fragment |
|---|---|
| 6 ch, layout 5.1 | `6 channels (5.1)` |
| 8 ch, layout 7.1 | `8 channels (7.1)` |
| 8 ch, layout 5.1.2 | `8 channels (5.1.2)` |
| 3 ch, layout 2.1 | `3 channels (2.1)` |
| 3 ch, no layout | `3 channels` |
| 2 ch | `stereo` |
| 1 ch | `mono` |
| unreadable | `` (nothing printed) |

**Sentences**, one per state:

* `claim-mismatch`, stereo — *"Listed as 5.1, but the track I checked is plain stereo — 2 channels, not 6. I only checked one track of 12."*
* `claim-mismatch`, mono — *"Listed as 5.1, but the track I checked is mono — 1 channel, not 6. I only checked one track of 12."*
* `claim-mismatch`, claim with no number (`ATMOS`/`MCH`) — *"Listed as Atmos, but the track I checked is plain stereo — 2 channels. I only checked one track of 12."*
* `claim-mismatch` where the sample came from the fallback branch (`sampledSmallest`) — append *" This was the smallest file in the folder, which on a surround album is often a stereo bonus track."*
* `claim-unverified` — *"The track I checked is plain stereo. Bigger files in this folder look like they could be the surround mix, so this doesn't mean the album isn't 5.1."*
* `padded-channels` — *"6 channels, but 4 of them are completely silent for the whole track. That is what a stereo file padded out to 5.1 looks like. I only checked one track of 12."* (The count is `channels - aliveChannels`, printed — never the phrase "only the front two", which can contradict `silentChannels`. At 8 channels the tail reads *"padded out to 7.1"*. With no claim the sentence is identical; the claim is not mentioned.)
* `claim-short` — *"Listed as 7.1, but the track I checked has 6 channels (5.1), not 8."*
* `surround`, full clean read (`complete && silentChannels.length === 0`) — *"All 6 channels carry sound — nothing is padded with silence. I only checked one track of 12."*
* `surround`, any other case — `""` (nothing beyond the fragment).
* `bonus-surround` — *"Not listed as surround, but the track I checked has 6 channels (5.1)."*
* `surround-unverified` — `""` (the fragment already says the count).
* `stereo`, `mono`, `other` — `""`.
* `unknown` — *"Couldn't tell how many channels this track has."*

**Handler failure reason, corrupt file ffprobe accepted with a zero exit** — *"This file wouldn't open properly — it looks damaged or incomplete."*

**Tail, replacing `'verified from 04.flac'`** — always printed, never conditional:
`checked one track of 12 (04.flac)`, falling back to `checked one track (04.flac)` when the count is unknown. The verb *verified* is dropped; it is the wrong word above a warning.

**Ceiling fragment** — `reaches 22 kHz`, with ` (all channels together)` appended when `channels >= 3`. It is never worded "across all channels": `volumedetect` reports one number for the summed mix and cannot support a per-channel claim.

**Warning pill** in the facts row above the fold, only when `severity === 'warn'`:
`listed 5.1 · checked track is stereo`, or `listed 5.1 · surround channels are silent` for `padded-channels`.

**Idle button helper text** (`src/slsk-dossier.js:62`) — *"Downloads one track, measures it, deletes it. Tells you the real bit depth and whether it's really surround. A minute or two."*

**Re-check button** on an ok result that predates this feature — *"Check again"*.

No sentence names a tool. There is no `title=` tooltip: it is invisible on touch and on keyboard focus.

---

## Where it appears

| file:line | change |
|---|---|
| `src/rip-check.js:17` | `parseProbe` returns four new keys. |
| `src/rip-check.js:36` | `parseAstats` scoped to the text after the `Overall` line, both regexes anchored on `^\[[^\]]*\]`. |
| `src/rip-check.js:45` | `parseCeiling(text, floorDb = FLOOR_DB)`. |
| `src/rip-check.js:78` | `pickTrack` sorts the under-cap list by `size` DESC then `length` DESC; new `pickTrackInfo` returns `{ file, fallback }`. |
| `src/rip-check.js:89` | `ceilingArgs` drops `-t 60`, gains `-map 0:a:0`. |
| `src/rip-check.js:96` | `astatsArgs` drops `-t 60`, gains `-map 0:a:0`, flips to `measure_perchannel=all`. |
| `src/rip-check.js:101` | `probeArgs` adds `channels,channel_layout,profile` and `:format=duration`. |
| `src/rip-check.js:106` | exports gain `parseChannels`, `channelVerdict`, `floorFor`, `layoutLabel`, `lfeIndex`, `accusableClaim`, `expectedCh`, `siblingSurroundHint`, `pickTrackInfo`, `dbNum`. |
| `main.js:11254` | `pickTrackInfo` replaces `pickTrack`; `pick.fallback` recorded. |
| `main.js:11266` | corruption gate after `parseProbe`. |
| `main.js:11269` | `parseChannels(stats.stderr)` alongside `parseAstats`. |
| `main.js:11281` | `parseCeiling(bandText, floorFor(declared.channels))`. |
| `main.js:11285` | the extended return object above. |
| `src/slsk-dossier.js:67` | channel fragment goes **first**: `if (r.channelCheck && r.channelCheck.fact) facts.unshift(r.channelCheck.fact)`. Ceiling fragment gains ` (all channels together)` when `r.channels >= 3`. |
| `src/slsk-dossier.js:72` | tail becomes `checked one track of N (04.flac)`; `ago(r.at)` unchanged. |
| `src/slsk-dossier.js:74` | **the render rule.** When `r.channelCheck && r.channelCheck.severity === 'warn'`: the wrapper class is `slr-rip slr-rip-chan-warn` **instead of** `slr-rip-${verdict.kind}` (never alongside it, so no CSS source-order tie can leave the line green), the bold line is `⚠ ${esc(r.channelCheck.text)}`, and `verdict.text` demotes into the facts run. Otherwise the bold line is unchanged and, when `r.channelCheck.text` is non-empty, a second line `<span class="slr-rip-chan">…</span>` follows it — never inside the `' · '` tail. |
| `src/slsk-dossier.js:65` / ok branch | add `<button class="slr-btn slr-btn-quiet" data-act="verify">Check again</button>` to the ok branch whenever `!r.channelCheck`, so the up-to-30-days of cached verdicts can be refreshed. Without it the feature does not exist for any album already verified. |
| `src/slsk-dossier.js:91` | one extra pill in the `.slr-facts` row when `severity === 'warn'` — the only place the contradiction sits near the header's Download button. |
| `src/slsk-dossier.js:62` | new idle helper text. |
| `src/slsk-room.css:190` | add `.slr-rip-chan-warn .slr-rip-verdict{color:var(--slr-hires)}` and `.slr-rip-chan{color:var(--slr-muted);flex-basis:100%}` and `.slr-pill-warn{border-color:var(--slr-hires);color:var(--slr-hires)}`. `.slr-rip` is already `flex-wrap:wrap` (`:187`), so a second line wraps with no layout work. |
| `src/slsk-room.css:16` | no new token is needed — `--slr-hires` is already restated for `body.theme-light`. |

`preload.js:344` and the renderer's `slskVerifyRip` call are unchanged: the claim is derived in main from the `folderPath` it already receives.

---

## Tests

House style, read off the existing files: `node:test` + `node:assert` only, flat top-level `test()` calls, three-line preamble, 2-space indent, no semicolons, single quotes. Run with `node --test test/rip-check.test.js`.

**Existing tests that must go red and be updated in the same commit — do not loosen the assertions:**

* `test/rip-check.test.js:7` — `assert.deepEqual` on the whole `parseProbe` object. Add `channels: null, channelLayout: null, atmos: false, duration: null` to the expectation, and add a second case with all keys present.
* `test/rip-check.test.js:10` and `:20` — both astats fixtures are hand-written and one puts `Dynamic range: 13.4` inside an `Overall` block, which real ffmpeg never emits. Replace both with output captured verbatim from `ffmpeg -hide_banner -nostats -i FILE -map 0:a:0 -af astats=measure_perchannel=all -f null - 2> fixture.txt`, and assert `dynamicRange === null` with a comment recording that ffmpeg 8.1.2's Overall block carries no `Dynamic range` line.
* `test/rip-check-ipc.test.js:33` — add `includes('channels')` and `includes('channel_layout')` for `probeArgs`, and `includes('measure_perchannel=all')` plus `includes('-map')` for `astatsArgs`.

**New cases to pin:**

1. `parseChannels` counts six channel blocks and stops at `Overall` — fixture is the real 6-channel capture; assert `channels === 6`, `perChannel.length === 6`, and that no block carries Overall's numbers.
2. `parseChannels` on a mono capture returns `channels === 1`, not 2 — astats prints a `Channel: 1` block and an `Overall` block holding identical numbers.
3. `parseChannels` reads `-inf` as `-Infinity`, not `NaN` — assert `perChannel[2].peakDb === -Infinity`.
4. `parseChannels` ignores peer tag text — fixture includes the reproduced lines `    comment         : Dynamic range: 99.9` and `                    : Bit depth: 24/24`; assert they contribute nothing. **Mutation target:** drop the `^\[[^\]]*\]` anchor from the channel-header regex and assert the injected lines get picked up.
5. `parseAstats` reads `Bit depth` from Overall and reports `dynamicRange` as `null` on a real `measure_perchannel=all` capture. **Mutation target:** remove the Overall scoping and assert `dynamicRange` becomes channel 6's figure.
6. `channelVerdict` on the **Animals** capture (6 ch, `5.1(side)`, whole-track peaks −9.86/−11.34/−90.31 ×4, `durationSec: 86.665`, claim `'5.1'`) returns kind `'surround'`, **not** `'padded-channels'`. This is the single most important test in the file. **Mutation target:** raise the dead threshold from `-Infinity` to `-80` and assert the verdict flips to `padded-channels` — proving the threshold is load-bearing.
7. `channelVerdict` on the fake control (6 ch, ch1 finite, ch2–6 all `-inf`, `durationSec: 300`) returns `'padded-channels'` with `severity: 'warn'` and `aliveChannels === 1`.
8. `channelVerdict` on the In Rainbows shape (ch3 and ch4 `-inf`, rears alive) returns `'surround'` or `'bonus-surround'`, never `'padded-channels'` — partial silence produces no accusation.
9. `channelVerdict` with `durationSec: 86` and an otherwise firing padded shape returns `'surround'`, not `'padded-channels'` — the 90 s floor.
10. `channelVerdict` with `complete: false` (one channel missing its peak line) and `ch >= 4` returns `'surround-unverified'` with `text === ''` — the explicit cannot-tell. **Mutation target:** drop `complete` from the rule-6 guard list and assert a truncated capture now produces `padded-channels`.
11. `channelVerdict` with `channels: 2, claim: '5.1'` returns `'claim-mismatch'`, `severity: 'warn'` — the Tipper case.
12. Same input with `siblingHint: true` returns `'claim-unverified'`, `severity: 'plain'`.
13. `channelVerdict` with `channels: 3, channelLayout: '2.1', claim: '5.1'` returns `'claim-short'` and `lfeChannel === 3` — closes the old ch=3 hole and pins the 2.1 LFE position.
14. `channelVerdict` with `channels: 6, codec: 'eac3', atmos: true, claim: '7.1'` returns `'surround'`, not `'claim-short'` — the Atmos bed understates the stream.
15. `layoutLabel(8, '5.1.2')` is `'5.1.2'`, not `'7.1'`; `layoutLabel(6, '5.1(side)')` is `'5.1'`; `layoutLabel(2, null)` is `'stereo'`; `layoutLabel(3, null)` is `null`. **Mutation target:** make it call `classify()` first and assert the 5.1.2 case reports 7.1.
16. `lfeIndex(7, '6.1(front)')` is `3`; `lfeIndex(6, '5.1(side)')` is `4`; `lfeIndex(3, '2.1')` is `3`; `lfeIndex(6, null)` is `null`; `lfeIndex(3, '3.1')` is `null` (clamped, index > channels).
17. `accusableClaim` table test over the nine verified strings in the measured-facts section, both directions.
18. `floorFor(2) === -85`; `floorFor(6)` within 0.01 of `-89.77`; `floorFor(8)` within 0.01 of `-91.02`.
19. `pickTrackInfo` is deterministic when every `length` is absent — two files sized 8.1 MB and 11.4 MB with no `length` field returns the 11.4 MB one and `fallback === false`. **Mutation target:** revert the comparator to `length` DESC and assert the result flips to input order.
20. `pickTrackInfo` sets `fallback: true` when every file exceeds 80 MB.
21. `siblingSurroundHint` returns `false` when no sibling has both `size` and `length`, and `true` for a 250 MB / 359 s sibling beside an 8 MB / 90 s sample.
22. `test/slsk-dossier.test.js` — positive: a warn-severity `channelCheck` renders the channel sentence as the bold line, the wrapper class is `slr-rip-chan-warn`, and `slr-rip-genuine` is **absent**. Negative: a result object with **no** `channelCheck` (a 30-day-old cached verdict) renders with no channel text at all and does not print `stereo` — i.e. no truthy default.

**Test-harness debt to pay in the same commit**, because the additions push the handler toward the window:

* Replace `MAIN.slice(idx, idx + 6000)` in both tests in `test/rip-check-ipc.test.js` with `callSource(MAIN, 'slsk-verify-rip')` from `test/helpers/lift-ipc.js:26`, which does real paren balancing. The current window already bleeds 3,231 characters of unrelated `main.js` containing another `slskdFetch(` call, so the dry-run ordering assertion can pass vacuously.
* Add `'slsk-verify-rip'` to `GATED_CHANNELS` (`test/helpers/lift-ipc.js:174`) with args `{ username: 'u', folderPath: 'p', files: [{ name: 'a.flac', size: 1e6, length: 300 }] }`, so the dry-run refusal is proven by execution rather than by string index.

---

## Deliberately out of scope

* **A per-album answer.** One track is sampled, so every statement is about that track and is worded that way. The album-level answer already exists as `verify-surround-folder` / `auditAlbum` (`main.js:11091`) and needs the files on disk, which for a Soulseek listing they are not.
* **Raising the 80 MB `MAX_SAMPLE_BYTES` cap.** Genuine 24/96 5.1 tracks run 139–448 MB here, so on real surround albums selection falls to the smallest file. The spec reports that (`sampledSmallest`) and words the warning accordingly, but changing the cap changes what gets downloaded and has its own bandwidth and deadline consequences.
* **Catching a matrix or HRTF upmix that writes real derived signal into the rear channels.** Only the silent-pad class is detected. A residual test (`pan=mono|c0=c0-c4` then astats — on the genuine Division Bell 5.1 the residual is real at Peak −6.41 / RMS −28.11 / Bit depth 22/24/24/24, while a literal copy collapses to `-inf` / `0/0/0/0`) would catch it at one extra ffmpeg pass per channel pair. The `surround` sentence is therefore worded as "nothing is padded with silence", never "really is 5.1".
* **Per-channel ceiling figures.** `floorFor` removes the bias against multichannel, but `ceilingHz` stays one whole-mix number and the copy says so. A per-channel ceiling multiplies the band loop by the channel count.
* **Surfacing astats' per-channel `Dynamic range`.** Flipping to `measure_perchannel=all` makes it readable for the first time (86.47 dB on the Animals fronts), but that figure is not the DR a listener reads as "dynamic range" — printing "dynamic range 86.5" would invent a new misleading number in a fact line that already exists. `dynamicRange` stays `null` on this build until someone designs that fact properly.
* **Detecting an encoded multichannel stream that reports 2 channels** — HE-AAC parametric stereo, or DTS hidden in a 16/44 WAV (DTS-CD). Neither is reproducible here: this ffmpeg build rejects the HE profiles outright, and all 35 WAVs in the library were scanned for the DTS sync words `7ffe8001` / `fe7f0180` / `1fffe800` with zero hits. Such a file in a 5.1-named folder would be reported as `claim-mismatch`. A sync-word sniff for WAVs is a follow-up, not part of this.
* **Auto-running the check when a surround dossier opens.** That starts a download from a peer without the user pressing anything. The check stays a button.
* **Changing any other surround surface.** The purple tier dot, the Surround shelf, the header ring, Gate 0 of `upgradeReason`, the Hunt "surround you lack" row and the sibling chips all keep saying what the names claim. A measured contradiction lives in the rip block and nowhere else — the scope fence exists because one track is not an album, and because silently overriding Gate 0 recreates the 5.1 scar from the other direction.
* **A bit-depth-aware dead threshold.** A 16-bit dithered pad would sit around −84 dBFS peak and pass as alive, so it would be reported as `surround` rather than `padded-channels`. No dithered fake was available to measure, and the one genuine file that sits in that corridor (Animals, −90.31 dB) proves the cost of guessing wrong. Missing a fake is the acceptable error here; accusing a genuine Blu-Ray release is not.
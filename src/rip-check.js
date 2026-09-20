'use strict'
// Rip verification: turns ffprobe/ffmpeg text into one honest verdict about a
// file the peer claims is lossless. Pure — nothing here spawns anything, so
// every verdict rule is testable without audio. main.js owns the download,
// the ffmpeg calls and the cleanup (slsk-verify-rip).

const { classify } = require('./surround-verify')

const AUDIO_RE = /\.(flac|wav|aiff?|aif|ape|wv|alac|dsf|dff|mp3|m4a|aac|ogg|opus)$/i
const MAX_SAMPLE_BYTES = 80 * 1024 * 1024
// Bands the ceiling probe measures (Hz). main runs one highpass+volumedetect
// per band; parseCeiling reads the highest band still carrying real signal.
const BANDS = [16000, 18000, 20000, 22000, 24000, 30000, 40000]
// Below this the band is silence as far as a rip is concerned.
const FLOOR_DB = -85

// Absent is null, never 0. Number(null) is 0 and Number('') is 0, so without
// the first line an ffprobe key that simply was not printed would read as a
// confident zero — and `channels=0` with `sample_rate=0` is exactly the shape
// main.js treats as a damaged file.
function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ffprobe's channel_layout is decoration with an open vocabulary. 'unknown' is
// a real value it prints, and 'N/A' turns up for fields it cannot fill; absent,
// empty, 'unknown' and 'N/A' are all one null case.
function layoutOf(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s || s === 'unknown' || s === 'N/A') return null
  return s                       // verbatim, e.g. '5.1(side)'
}

function parseProbe(text) {
  const s = String(text || '')
  // ffprobe emits its own field order, not the order requested, so every key is
  // read by name and never by line position.
  const get = k => { const m = s.match(new RegExp('^' + k + '=(.+)$', 'm')); return m ? m[1].trim() : null }
  return {
    sampleRate: num(get('sample_rate')),
    bitDepth: num(get('bits_per_raw_sample')) || num(get('bits_per_sample')),
    codec: get('codec_name'),
    channels: num(get('channels')),
    channelLayout: layoutOf(get('channel_layout')),
    atmos: /atmos/i.test(get('profile') || ''),
    duration: num(get('duration')),
  }
}

// astats writes '-inf' as a literal token in every dB field. Number('-inf') is
// NaN, not -Infinity, and NaN loses every comparison silently, so a silent
// channel would read as dead by accident rather than by rule.
function dbNum(tok) {
  const t = String(tok == null ? '' : tok).trim()
  if (!t) return null
  if (t === '-inf' || t === '-Infinity') return -Infinity
  if (t === 'inf' || t === '+inf' || t === 'Infinity') return Infinity
  const n = Number(t)
  return Number.isFinite(n) ? n : null      // 'nan', '-nan', '' -> null
}

// The astats line prefix is '[Parsed_astats_0 @ 0x7ff72c004880] '. The pointer
// changes every run and the ordinal changes with chain position, so anchor on
// the bracket, never on the label text. This anchor is also a security control:
// astats must run at ffmpeg's info level, which puts peer-supplied tag text on
// the same stderr, and a peer can write 'Dynamic range: 99.9' into a comment
// tag. Those lines do not start with '[', so the anchor rejects them.
const RE_OVERALL = /^\[[^\]]*\]\s+Overall\s*$/
const RE_CHANNEL = /^\[[^\]]*\]\s+Channel:\s+(\d+)\s*$/
const RE_PEAK_DB = /^\[[^\]]*\]\s+Peak level dB:\s*(\S+)\s*$/
const RE_RMS_DB = /^\[[^\]]*\]\s+RMS level dB:\s*(\S+)\s*$/

// One 'Channel: N' block per channel, 1-based, in layout order, then exactly
// one 'Overall' block. Overall has no colon and no value, so a parser that
// requires a colon skips it and merges Overall's numbers into the last channel.
function parseChannels(text) {
  const s = String(text || '')
  const perChannel = []
  let open = null
  for (const line of s.split('\n')) {
    if (RE_OVERALL.test(line)) break               // everything after is ignored
    const ch = line.match(RE_CHANNEL)              // must be tested before any
    if (ch) {                                      // generic key: value rule
      open = { index: Number(ch[1]), peakDb: null, rmsDb: null }
      perChannel.push(open)
      continue
    }
    if (!open) continue
    const pk = line.match(RE_PEAK_DB)
    if (pk) { open.peakDb = dbNum(pk[1]); continue }
    const rm = line.match(RE_RMS_DB)
    if (rm) { open.rmsDb = dbNum(rm[1]) }
  }
  return {
    channels: perChannel.length ? perChannel.length : null,
    perChannel,
    complete: perChannel.length > 0 && perChannel.every(c => c.peakDb != null),
  }
}

function parseAstats(text) {
  const s = String(text || '')
  // measure_perchannel=all makes every channel carry 'Bit depth' and 'Dynamic
  // range' too, so an unscoped last-match would report channel 6's numbers.
  // Read only the text after the Overall line; with no Overall line, fall back
  // to the whole text so an empty or odd stream behaves as it did before.
  const m = s.match(new RegExp(RE_OVERALL.source, 'm'))
  const tail = m ? s.slice(m.index + m[0].length) : s
  const bits = (tail.match(/^\[[^\]]*\]\s+Bit depth:\s*(\d+)\/\d+/m) || [])[1]
  const dr = (tail.match(/^\[[^\]]*\]\s+Dynamic range:\s*([\d.]+)/m) || [])[1]
  // Absent is not zero: ffmpeg builds that print no "Dynamic range:" line must
  // read as unmeasured (null), never as a measured 0 dB. On ffmpeg 8.1.2 the
  // Overall block never carries that line, so this stays null in practice.
  return { measuredBits: num(bits), dynamicRange: dr === undefined ? null : num(dr) }
}

// One band's mean_volume, out of a raw `highpass+volumedetect` stderr capture.
//
// This MUST carry the same '^\[[^\]]*\]' anchor every astats regex carries, and
// for the same reason: volumedetect also logs at ffmpeg's info level, so the
// input's tag dump shares the stream and is printed BEFORE the filter output. A
// non-global .match() returns the FIRST hit, so an unanchored pattern reads the
// peer's tag rather than the measurement. Reproduced on 2026-09-20 with
//   ffmpeg -i in.flac -t 30 -metadata comment='mean_volume: -999.0 dB' forged.flac
// the unanchored form returns '-999.0' and the anchored one '-84.3'. A peer
// controls those tags, and -999 in every band flips the verdict to
// 'transcoded'. The tag dump indents its lines, so a bracket at column zero is
// out of a peer's reach.
const RE_MEAN_VOLUME = /^\[[^\]]*\]\s+mean_volume:\s*(\S+)\s*dB\s*$/m

function parseBandVolume(text) {
  const m = String(text || '').match(RE_MEAN_VOLUME)
  return m ? dbNum(m[1]) : null
}

// How many samples astats actually decoded, from the Overall block. Used to
// catch a truncated download: ffmpeg exits 0 on a FLAC cut mid-stream, and the
// container header still reports the full duration, so nothing else notices.
function parseSampleCount(text) {
  const s = String(text || '')
  const m = s.match(new RegExp(RE_OVERALL.source, 'm'))
  if (!m) return null
  const n = s.slice(m.index + m[0].length)
    .match(/^\[[^\]]*\]\s+Number of samples:\s*([\d.]+)\s*$/m)
  return n ? num(n[1]) : null
}

function parseCeiling(text, floorDb = FLOOR_DB) {
  const s = String(text || '')
  const floor = num(floorDb) === null ? FLOOR_DB : Number(floorDb)
  let ceiling = null
  const re = /band=(\d+)[^\n]*mean_volume: (-?[\d.]+) dB/g
  let m
  while ((m = re.exec(s)) !== null) {
    const band = Number(m[1]), db = Number(m[2])
    if (db > floor && (ceiling === null || band > ceiling)) ceiling = band
  }
  return ceiling
}

// volumedetect histograms every sample across all channels, so mean_volume is a
// power mean over channels: the same high-frequency content living in 2 of 6
// channels reads 10*log10(2/6) = 4.77 dB lower than it does as stereo. Without
// this a genuine 5.1 rip gets pushed toward the 'transcoded' branch. The
// compensation only ever lowers the floor, so it can only accuse less.
function floorFor(channels) {
  const c = Number(channels) || 0
  if (c <= 2) return FLOOR_DB
  return FLOOR_DB - 10 * Math.log10(c / 2)     // 6ch -> -89.77, 8ch -> -91.02
}

// How many channels each of classify()'s labels actually describes. A guessed
// label is only honest when it accounts for every channel measured, so this is
// the check that stops a 16-channel file being announced as 7.1.
const LABEL_CHANNELS = { mono: 1, stereo: 2, '4.0': 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 }

// ffprobe's own name wins, with the parenthesised qualifier stripped for
// display. classify() is the fallback only: it returns '7.1' for any count >= 8,
// which would announce a measured 5.1.2 bed as 7.1. Do not write a third
// channel->label mapping — format-badges and library-manage already disagree.
//
// ffprobe prints channel_layout=unknown for any mask it has no name for, so the
// fallback is the ordinary path on a 9.1.4 bed or an object bed, not a rare one.
// Measured 2026-09-20: a real 16-channel WAV reports channel_layout=unknown, and
// classify() then called it '7.1' — the fact line read '16 channels (7.1)'. A
// guessed label is therefore used only when its own channel count matches what
// was measured; otherwise the bare count is printed with no label at all.
function layoutLabel(channels, channelLayout) {
  const base = String(channelLayout || '').replace(/\(.*$/, '').trim()
  if (base && base.toLowerCase() !== 'unknown') return base
  const c = classify(channels)
  if (c === 'unknown') return null
  return LABEL_CHANNELS[c] === (Number(channels) || 0) ? c : null
}

// astats never prints a channel name, so LFE position comes from ffmpeg's own
// layout table. 6.1(front) puts LFE at index 3, so the lookup uses the full,
// unstripped layout string — stripping the parenthetical would be wrong.
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

// The narrowed claim, used only by the rules that accuse. Every unpadded
// date-named taper folder ("Grateful Dead 1977-5-1") reads as 5.1 to
// detectSurround, so the accusing path gets a stricter claim of its own.
const CLAIM_NUM = { '5.1': /5[._-]1/, '7.1': /7[._-]1/ }

// Vocabulary that only ever sits beside a real surround claim. Deliberately
// narrow: 'mix' and 'audio' are left out because a taper folder can carry them
// next to a show date, and a word list that over-fires turns the date guard off
// for exactly the names it exists to protect.
const SURROUND_NEAR =
  /^[._\- ]*(surround|surr|multichannel|multich|mch|blu[._\- ]?ray|dts|atmos|sacd|dvd[._\- ]?a|dvda|quad)\b/i

// Does a date component run into this number through the number's own
// separator? '1977-5-1', 'gd77-5-1' and '1995 12-5-1' all do; each puts a 2- or
// 4-digit component immediately in front, joined by the same character the
// token uses internally. A year that merely PRECEDES a separate surround token
// does not: real surround names spell the year off with a different separator
// ('..._2011_5.1_Surround_Mix...') or follow the token with a surround word
// ('Artist.Album.2011.5.1.BluRay.FLAC').
function dateComponentBefore(before, sep) {
  // Any run of 1-4 digits immediately in front counts, joined either by the
  // token's own separator or by a space. Three measured misses drove each part:
  //   'gd77 3-5-1 Fillmore East'       one-digit component  -> was claimed 5.1
  //   'Grateful Dead 1977 5-1 Cornell' space-separated year -> was claimed 5.1
  //   'Grateful Dead 1977-5-1'         the original case    -> already caught
  // Widening this can only ever DROP a claim, never invent one, so it cannot
  // turn a genuine rip into an accusation. A surround word after the token
  // still overrides it at the call site, which is what keeps the real
  // '..._2011_5.1_Surround_Mix...' and '...2011.5.1.BluRay...' names claimed.
  if (/(?:^|\D)\d{1,4}\/$/.test(before)) return true               // 1977/5-1
  if (/(?:^|\D)\d{1,4}[ ]$/.test(before)) return true               // 1977 5-1
  const esc = /[.\-]/.test(sep) ? '\\' + sep : sep
  return new RegExp('(?:^|\\D)\\d{1,4}' + esc + '$').test(before)
}

function accusableClaim(label, text) {
  const s = String(text || '')
  if (label === 'ATMOS' || label === 'MCH') return label
  if (label === 'QUAD') return /\bquadr[ao]phonic\b/i.test(s) ? 'QUAD' : null
  const re = CLAIM_NUM[label]
  if (!re) return null
  const g = new RegExp(re.source, 'gi')
  let m
  while ((m = g.exec(s)) !== null) {
    const tok = m[0]                                                            // '5.1', '5-1', '5_1'
    const before = s.slice(Math.max(0, m.index - 12), m.index)
    const after = s.slice(m.index + tok.length, m.index + tok.length + 24)
    if (/[vV]$/.test(before)) continue                                          // v5.1
    if (/\b(disc|disk|cd|vol|volume|part|pt|track|tr)[._\- ]*$/i.test(before)) continue
    if (/^[._\-/]\d/.test(after)) continue                                      // 5-1-77
    if (/^[._\- ]?(gb|mb|kb|tb)\b/i.test(after)) continue                       // 5.1GB
    // The date guard is last, and a surround word right after the token
    // overrides it. The old guard was a bare `\d[._\-/]$` on `before`, which
    // dropped the claim whenever ANY digit preceded — the dominant real
    // surround naming style. Measured on this disk 2026-09-20:
    // 'Pink_Floyd.Wish_You_Were_Here_50_2011_5.1_Surround_Mix.BLURAY.FLAC.2025.401'
    // returned null, so a stereo file inside a folder named for a 5.1 release
    // produced no warning at all — the exact case this check exists to catch.
    if (dateComponentBefore(before, tok[1]) && !SURROUND_NEAR.test(after)) continue
    return label
  }
  return null
}

// The bytes-per-second floor at which a sibling is big enough to be the
// surround mix the sampled track isn't.
//
// Re-derived from measurement on 2026-09-20 (ffprobe duration against file size
// over every multichannel FLAC in /mnt/data/MUSIC — 754 files). The old floor of
// 400,000 cleared only 54% of them and NONE of the 16-bit Blu-Ray class the
// user actually owns: Meddle "San Tropez" 220,498 B/s, Animals "Sheep" 224,830,
// Animals "Pigs (Three Different Ones)" 235,088, Animals "Dogs" 244,239, Sgt.
// Pepper "Lucy In The Sky With Diamonds" 294,729. The hint was therefore dead
// for the commonest genuine surround format, so the gentle 'claim-unverified'
// outcome never fired and the app accused instead. 180,000 is the 5th
// percentile of those 754 files (95.6% clear it), sits 18% below the lowest of
// the five named tracks, and still sits well above 16/44 stereo FLAC, which
// measured 52-115 kB/s across 390 stereo files here.
const SURROUND_BPS = 180000

// slskd very often omits `length`, and with no duration there is no rate to
// compute — which killed the hint no matter how decisive the sizes were. Size
// alone still carries the signal, because size is the one field slskd always
// supplies. Measured over 182 real album folders on this disk: in stereo-only
// folders the largest file is at most 2.4x the file this code would sample
// (95th percentile), and only 3 of 124 reached 4x; in folders that do hold a
// surround mix, 13 of 58 reached it. A sibling four times the sampled file is
// therefore big enough to be the mix, while the user's actual scar — a wholly
// stereo folder named for a 5.1 release — still gets its warning.
const SURROUND_SIZE_RATIO = 4

// This only ever SUPPRESSES an accusation; it never creates one. Every arm
// below is therefore allowed to be generous.
function siblingSurroundHint(files, sampled) {
  const bps = f => {
    const s = Number(f && f.size), l = Number(f && f.length)
    return (Number.isFinite(s) && Number.isFinite(l) && l > 30) ? s / l : null
  }
  const size = f => {
    const s = Number(f && f.size)
    return Number.isFinite(s) && s > 0 ? s : null
  }
  const mine = bps(sampled)
  const mySize = size(sampled)
  return (files || []).some(f => {
    if (f === sampled) return false
    if (!AUDIO_RE.test(f.name || f.filename || '')) return false
    const b = bps(f)
    // Rate is the sharper test, so it wins whenever the sibling carries one.
    if (b !== null) return b >= SURROUND_BPS && (mine === null || b >= mine * 2)
    // No duration: fall back to relative size, which is always supplied.
    const s = size(f)
    return s !== null && mySize !== null && s >= mySize * SURROUND_SIZE_RATIO
  })
}

// Under-cap files sort by size DESC, tie-broken by length DESC. slskd often
// omits `length`; when every entry is 0 a length-only comparator is a no-op and
// selection falls to input order, so whether the app accuses a genuine Blu-Ray
// release would depend on whether a stranger's client filled in an optional
// field. `size` is always supplied, so selection is deterministic.
function pickTrackInfo(files) {
  const audio = (files || []).filter(f => AUDIO_RE.test(f.name || f.filename || ''))
  if (!audio.length) return null
  const small = audio.filter(f => (Number(f.size) || 0) <= MAX_SAMPLE_BYTES)
  if (small.length) {
    const sorted = small.slice().sort((a, b) =>
      ((Number(b.size) || 0) - (Number(a.size) || 0)) ||
      ((Number(b.length) || 0) - (Number(a.length) || 0)))
    return { file: sorted[0], fallback: false }
  }
  // Every audio file is over the cap: take the smallest. On a genuine 24/96
  // surround album that is often a stereo bonus track, so say so.
  return { file: audio.slice().sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0))[0], fallback: true }
}

function pickTrack(files) {
  const p = pickTrackInfo(files)
  return p ? p.file : null
}

// How many channels a claim promises. ATMOS and MCH carry no number, so only
// the surround/not-surround distinction can be checked for them.
function expectedCh(claim) {
  if (claim === '7.1') return 8
  if (claim === '5.1') return 6
  if (claim === 'QUAD') return 4
  return null
}

function isPcmFamily(codec) {
  return /^(flac|alac|wav|pcm_|ape|wavpack|aiff?)/i.test(String(codec || ''))
}

function fmt(bits, rate) {
  return (bits || '?') + '/' + (rate ? Math.round(rate / 1000) : '?')
}

function verdict({ declaredRate, declaredBits, measuredBits, ceilingHz, ext }) {
  const lossless = /^(flac|wav|aiff?|aif|ape|wv|alac|dsf|dff)$/i.test(String(ext || ''))
  const rate = num(declaredRate), bits = num(declaredBits), mbits = num(measuredBits), ceil = num(ceilingHz)
  // `rate <= 0` is its own case, not a missing one. num() maps the literal '0'
  // to 0 rather than null, so a file ffprobe read as sample_rate=0 used to sail
  // past this gate: measured 2026-09-20, declaredRate 0 with declaredBits 24
  // returned { kind: 'genuine', text: 'genuine 24/?' } and the dossier painted a
  // green tick on it. Insufficient data must answer 'unknown'.
  if (ceil === null || rate === null || rate <= 0) return { kind: 'unknown', text: 'could not measure this file' }
  // Declared hi-res but nothing above the CD band: an upsample.
  if (rate >= 88200 && ceil <= 22000) {
    return { kind: 'upsampled', text: 'upsampled, really ~' + fmt(mbits && mbits <= 16 ? 16 : bits, 44100) }
  }
  if (bits !== null && bits >= 24 && mbits !== null && mbits <= 16) {
    return { kind: 'padded', text: 'padded 16-bit, labelled ' + bits + '-bit' }
  }
  if (lossless && ceil <= 16000) {
    return { kind: 'transcoded', text: 'likely transcoded from lossy (nothing above ' + Math.round(ceil / 1000) + ' kHz)' }
  }
  return { kind: 'genuine', text: 'genuine ' + fmt(bits, rate) }
}

// Claim words become English before they reach a sentence.
const CLAIM_WORD = { '5.1': '5.1', '7.1': '7.1', ATMOS: 'Atmos', QUAD: 'quadraphonic', MCH: 'surround' }

// The short fragment for the grey facts run.
function factOf(ch, label) {
  if (!Number.isFinite(ch) || ch <= 0) return ''
  if (ch === 1) return 'mono'
  if (ch === 2) return 'stereo'
  return label ? ch + ' channels (' + label + ')' : ch + ' channels'
}

const SMALLEST_TAIL = ' This was the smallest file in the folder, which on a surround album is often a stereo bonus track.'

// The channel answer. Separate from verdict() on purpose: verdict()'s five
// kinds map straight onto the CSS class slr-rip-${kind} and drive the tick/warn
// glyph, so a new kind there would paint a warning triangle on a good 5.1 rip.
// A decoded run shorter than this fraction of the header duration means the
// file was cut off, so the per-channel read describes only its opening. An
// intact file matches exactly — measured 2026-09-20 on a 120.000 s 6-channel
// FLAC, astats reported 'Number of samples: 5760000' against 48000 Hz, i.e.
// 120.000 s — so 2% is pure slack, not a working tolerance.
const DECODE_SHORTFALL = 0.98

// How far above the digital noise floor every non-LFE channel must peak before
// the app will say out loud that the channels carry sound. The 16-bit one-LSB
// floor measures -90.308734 dBFS (Animals "Pigs On The Wing (Part One)",
// channels 3-6, whole track). -60 dBFS is 30 dB above that and 45 dB below the
// quietest non-LFE channel measured on a genuine full-band Blu-Ray 5.1 track
// here (Animals "Dogs", channel 3, Peak -14.913804). Failing this margin costs
// only the confirming sentence; it never produces an accusation.
const CONFIRM_FLOOR_DB = -60

function channelVerdict({ channels, channelLayout, claim, perChannel, complete,
  measuredChannels, codec, atmos, durationSec, siblingHint, sampledSmallest,
  decodedSec } = {}) {
  const ch = Number(channels)
  const layoutRaw = layoutOf(channelLayout)
  const claimLabel = claim == null ? null : String(claim)
  const word = CLAIM_WORD[claimLabel] || claimLabel
  const expected = expectedCh(claimLabel)
  const measured = num(measuredChannels)
  const out = (kind, severity, extra) => Object.assign({
    kind,
    severity,
    channels: num(channels),
    label: null,
    layoutRaw,
    claim: claimLabel,
    expected,
    measuredChannels: measured,
    aliveChannels: null,
    silentChannels: null,
    lfeChannel: null,
    complete: false,
    fact: '',
    text: '',
  }, extra || {})

  // 1. Six FLACs on this machine report channels=0 and exit 0. A 0-channel read
  // with a valid sample rate must not become a confident answer.
  if (!Number.isFinite(ch) || ch <= 0) {
    return out('unknown', 'unknown', { text: "Couldn't tell how many channels this track has." })
  }

  const label = layoutLabel(ch, layoutRaw)
  const lfe = lfeIndex(ch, layoutRaw)
  const blocks = Array.isArray(perChannel) ? perChannel : []
  const agreed = measured === ch && ch > 0
  // A truncated download decodes clean: ffmpeg exits 0 on a FLAC cut mid-stream
  // and the container header still reports the full duration, so `stats.err` in
  // main.js never fires. Reproduced 2026-09-20 on a genuine 120 s 5.1 file whose
  // surrounds enter at t=30 s, cut to 19.3 s of audio: ffprobe still said
  // duration=120.000000, astats still returned six complete channel blocks, and
  // the rules below returned kind='padded-channels' severity='warn' — a
  // confident false accusation against a genuine surround release. Comparing the
  // duration astats actually decoded against the header's answer is what catches
  // it, and a disagreement demotes the read to the explicit cannot-tell.
  const headerSec = num(durationSec)
  const playedSec = num(decodedSec)
  const truncated = headerSec !== null && headerSec > 0 && playedSec !== null &&
    playedSec < headerSec * DECODE_SHORTFALL
  const read = agreed && blocks.length === ch && !!complete && !truncated
  // A channel counts as silent ONLY when its whole-track Peak level dB is
  // literally -inf. The one genuine near-miss measured here (Animals ch3-6, an
  // official Blu-Ray 5.1 remix) sits at -90.308734 over the whole track; the
  // one measured fake sits at -inf. A -80 or -90 dB threshold would condemn the
  // genuine release, so any finite peak is alive.
  const silent = blocks.filter(c => c && c.peakDb === -Infinity).map(c => c.index)
  // LFE is excluded from every liveness tally: a genuine mix can hold a
  // digitally silent LFE for a whole track.
  const surroundIdx = []
  for (let i = 3; i <= ch; i++) if (i !== lfe) surroundIdx.push(i)
  const frontAlive = [1, 2].filter(i => {
    const c = blocks.find(x => x && x.index === i)
    return !!c && c.peakDb != null && c.peakDb !== -Infinity
  }).length
  const surroundSilent = surroundIdx.length > 0 && surroundIdx.every(i => silent.includes(i))
  // Every channel the confirming sentence would speak for. LFE is left out for
  // the same reason it is left out of the liveness tally: a genuine mix may hold
  // it at digital zero all track.
  const spokenFor = []
  for (let i = 1; i <= ch; i++) if (i !== lfe) spokenFor.push(i)
  const wellAboveFloor = spokenFor.length > 0 && spokenFor.every(i => {
    const c = blocks.find(x => x && x.index === i)
    return !!c && typeof c.peakDb === 'number' && Number.isFinite(c.peakDb) &&
      c.peakDb > CONFIRM_FLOOR_DB
  })
  const dur = headerSec
  const fact = factOf(ch, label)
  const base = {
    label,
    lfeChannel: lfe,
    complete: read,
    fact,
    silentChannels: read ? silent : null,
    aliveChannels: read ? ch - silent.length : null,
  }
  const tracks = ' I only checked one track of {tracks}.'

  // 2. The folder demonstrably holds files big enough to be the surround mix,
  // so the sampled track being stereo says nothing about the album.
  if (claimLabel !== null && ch <= 2 && siblingHint) {
    return out('claim-unverified', 'plain', Object.assign({}, base, {
      text: 'The track I checked is plain stereo. Bigger files in this folder look like they could be the surround mix, so this doesn\'t mean the album isn\'t ' + word + '.',
    }))
  }

  // 3. The user's scar. Fires on the ffprobe integer alone, immune to every
  // astats trap.
  if (claimLabel !== null && ch <= 2) {
    const shape = ch === 1 ? 'mono — 1 channel' : 'plain stereo — ' + ch + ' channels'
    const not = expected === null ? '' : ', not ' + expected
    return out('claim-mismatch', 'warn', Object.assign({}, base, {
      text: 'Listed as ' + word + ', but the track I checked is ' + shape + not + '.' + tracks +
        (sampledSmallest ? SMALLEST_TAIL : ''),
    }))
  }

  if (ch === 2) return out('stereo', 'plain', base)        // 4
  if (ch === 1) return out('mono', 'plain', base)          // 5

  // 6. Every guard is load-bearing. `read` — if astats and ffprobe disagree or
  // a peak line is missing we are not looking at what we think we are.
  // `frontAlive >= 1` — if the fronts are dead too we measured silence, not a
  // fake. `surroundSilent` needs EVERY non-LFE surround silent; one or two dead
  // surrounds deliberately produce no verdict. The 90 s floor exists because
  // short tracks on surround albums are disproportionately interludes and
  // acoustic pieces — Animals "Pigs On The Wing (Part One)" is 86.665 s.
  if (ch >= 4 && read && frontAlive >= 1 && surroundIdx.length > 0 && surroundSilent &&
    dur !== null && dur >= 90) {
    return out('padded-channels', 'warn', Object.assign({}, base, {
      text: ch + ' channels, but ' + silent.length + ' of them are completely silent for the whole track. ' +
        'That is what a stereo file padded out to ' + label + ' looks like.' + tracks,
    }))
  }

  // 7. The ch >= 3 bound closes the hole where a 3-channel 2.1 or 3.0(back)
  // file under a 5.1 claim produced no verdict at all. The codec and atmos
  // guards exist because ffprobe's count understates two measured classes:
  // Dolby Atmos reports a 6-channel bed while being object-based, and DTS-HD MA
  // reports a 6-channel core that may carry 7.1.
  if (ch >= 3 && claimLabel !== null && expected !== null && expected > ch && !atmos && isPcmFamily(codec)) {
    return out('claim-short', 'warn', Object.assign({}, base, {
      text: 'Listed as ' + word + ', but the track I checked has ' + fact + ', not ' + expected + '.',
    }))
  }

  // 8. The explicit cannot-tell. Not an error path: it is the default whenever
  // the per-channel data cannot carry an opinion.
  if (ch >= 4 && !read) return out('surround-unverified', 'plain', base)

  // 9. The confirming sentence needs more than "not literally -inf". On the
  // genuine Animals "Pigs On The Wing (Part One)" channels 3-6 sit at Peak
  // -90.308734 / RMS -108 dB — one LSB of dither, inaudible — and the old rule
  // called that "carry sound". The ACCUSING rule above is untouched and stays as
  // conservative as it was (it still must not accuse that track); only the claim
  // made out loud is gated, and failing the gate falls back to the neutral empty
  // text, never to a warning.
  if (ch >= 4 && claimLabel !== null) {
    // `silent` counts EVERY -inf channel, LFE included, but the comment above
    // its definition — and surroundIdx, and wellAboveFloor — all exclude the
    // LFE, because a genuine mix can hold a digitally silent LFE for a whole
    // track. Measured: Animals '1-05 - Pigs On The Wing (Part Two).flac' has
    // ch4 (LFE) at -inf while all five other channels clear the floor, and the
    // confirming sentence was being withheld from a demonstrably clean rip.
    const silentNonLfe = silent.filter(i => i !== lfe)
    const clean = read && silentNonLfe.length === 0 && wellAboveFloor
    return out('surround', 'good', Object.assign({}, base, {
      text: clean ? 'All ' + ch + ' channels carry sound — nothing is padded with silence.' + tracks : '',
    }))
  }

  // 10. slskd never reports channel count and every other surround surface in
  // this app is name-matching, so an unlabelled multichannel rip is invisible.
  if (ch >= 4) {
    return out('bonus-surround', 'good', Object.assign({}, base, {
      text: 'Not listed as surround, but the track I checked has ' + fact + '.',
    }))
  }

  // 11. ch === 3 with no claim, or a count layoutLabel cannot name.
  return out('other', 'plain', base)
}

// Why the download request failed, in one plain sentence.
//
// Every failure used to be reported as the peer's refusal and every one of them
// printed the internal endpoint, so a dead local daemon, an expired token and a
// rate-limit all read as "The peer did not accept the download: slskd 500 on
// POST /transfers/downloads/<user>". Three of those four facts were wrong and
// the fourth was a path the user has no use for. slskdFetch tags what it
// throws, so the cases can be told apart: `throttled` on a 429, `status` on any
// other non-2xx, `dryRun` on a refused twin write, and nothing at all when
// fetch itself failed — which is what a daemon that is not running looks like.
function slskdFailureReason(err) {
  const e = err || {}
  const status = Number(e.status)
  if (e.dryRun || e.code === 'DRY_RUN') return 'This is a test copy of the app, so nothing was downloaded.'
  if (e.throttled || e.code === 'SLSKD_THROTTLED' || status === 429) {
    return 'Soulseek is handling too many requests right now. Give it a minute and try again.'
  }
  if (status === 401 || status === 403) {
    return 'Papa could not sign in to Soulseek. Check the Soulseek settings.'
  }
  if (status === 404) return 'The peer is not online any more, or no longer has that file.'
  if (status >= 500) return 'Soulseek had a problem on this machine and could not start the download.'
  if (status >= 400) return 'The peer did not accept the download.'
  return 'Papa could not reach Soulseek on this machine. Check that it is running.'
}

// ffmpeg argv for one ceiling band: everything below `hz` removed, then how
// loud what is left is. main runs one per BANDS entry and tags the stderr with
// "band=<hz>" so parseCeiling can read them all from one string. Whole-track
// and stream-pinned, so the ceiling and the channel read describe the same
// audio.
function ceilingArgs(file, hz) {
  return ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', `highpass=f=${hz}:poles=2,volumedetect`, '-f', 'null', '-']
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

// What the file claims to be, in the key=value form parseProbe expects.
function probeArgs(file) {
  return ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,channels,channel_layout,profile' +
    ':format=duration',
    '-of', 'default=noprint_wrappers=1', file]
}

module.exports = {
  parseProbe, parseAstats, parseCeiling, verdict, pickTrack, ceilingArgs, astatsArgs, probeArgs,
  BANDS, FLOOR_DB, MAX_SAMPLE_BYTES,
  parseChannels, channelVerdict, floorFor, layoutLabel, lfeIndex, accusableClaim, expectedCh,
  siblingSurroundHint, pickTrackInfo, dbNum, isPcmFamily,
  parseBandVolume, parseSampleCount, slskdFailureReason,
  SURROUND_BPS, SURROUND_SIZE_RATIO, CONFIRM_FLOOR_DB, DECODE_SHORTFALL,
}

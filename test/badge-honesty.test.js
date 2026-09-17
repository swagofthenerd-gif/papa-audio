'use strict'
// The 2026-09 badge-honesty pass: five ways the quality/"bit-perfect" surface
// claimed things that were not true. Every test here requires and RUNS the
// production modules — none of it reads source as text.
//
//   C1  the badge was blind to replaygainApply and to mpv's real volume
//   C2  mpv-replaygain-mode bypassed the bit-perfect gate entirely
//   C3  two different controls were both called "bit-perfect"
//   C4  gapless resamples mixed-rate queues — disclose, do not change
//   C5  DSD is decoded to PCM but was badged lossless / bit-perfect
const test = require('node:test')
const assert = require('node:assert')
const Q = require('../src/quality-badge')
const BP = require('../src/bit-perfect')
const G = require('../src/gain-policy')
const F = require('../src/format-badges')
const { linearToMpv, MPV_MAX } = require('../volume-map')

const pure = { outputMode: 'exclusive', replaygain: 'no', mode: 'gapless', eq: { enabled: false } }
const flac = { filePath: '/m/a.flac', codec: 'FLAC', sampleRate: 44100, bitsPerSample: 16 }

// ── C1: replaygainApply and mpv's real volume ────────────────────────────────

test('C1 loudness-scan leveling is gain, so BIT-PERFECT cannot be claimed over it', () => {
  const on = Q.classify({
    track: flac,
    settings: { ...pure, replaygainApply: true },
    speed: 1, volume: 100,
  })
  assert.strictEqual(on.label, 'LOSSLESS')
  assert.ok(on.processing.some(p => /leveling/i.test(p)),
    'the leveling must be named in the processing list, got ' + JSON.stringify(on.processing))
  assert.match(on.reason, /leveling/i)
  // The same chain without it is still allowed to say BIT-PERFECT.
  assert.strictEqual(Q.classify({ track: flac, settings: pure, speed: 1, volume: 100 }).label, 'BIT-PERFECT')
})

test("C1 mpv's real volume is ground truth and overrides the slider", () => {
  // The slider says 100 % (unity) but mpv is sitting at 87 because the current
  // track's ReplayGain was folded in. The old badge saw only the slider.
  const v = Q.classify({ track: flac, settings: pure, speed: 1, volume: 100, engineVolume: 87 })
  assert.strictEqual(v.label, 'LOSSLESS', 'mpv is not at unity, so nothing is bit-perfect')
  assert.ok(v.processing.some(p => /Output gain/.test(p)), JSON.stringify(v.processing))
  assert.match(v.reason, /mpv volume 87/)
  // An engine volume of exactly unity is not processing.
  assert.strictEqual(
    Q.classify({ track: flac, settings: pure, speed: 1, volume: 40, engineVolume: 100 }).label,
    'BIT-PERFECT', 'the relayed engine volume wins over a stale slider reading')
})

test('C1 the engine-volume dB is mpv\'s CUBIC scale, not a linear one', () => {
  // amplitude = (v/100)^3, so dB = 60*log10(v/100).
  assert.strictEqual(Q.mpvVolumeToDb(100), 0)
  assert.strictEqual(Q.mpvVolumeToDb(130), 6.8)   // the boost ceiling
  assert.strictEqual(Q.mpvVolumeToDb(50), -18.1)  // NOT -6: that is the linear answer
  assert.strictEqual(Q.mpvVolumeToDb(0), -Infinity)
  assert.strictEqual(Q.mpvVolumeToDb('nonsense'), null)
})

test('C1 the cubic identity agrees with volume-map.js in both directions', () => {
  // linearToMpv cube-ROOTS on the way in; mpvVolumeToDb must cube on the way
  // out, so a linear slider fraction round-trips to its own linear dB.
  for (const linear of [0.1, 0.25, 0.5, 0.75, 1]) {
    const mpv = linearToMpv(linear, false)
    const back = Q.mpvVolumeToDb(mpv)
    const expected = 20 * Math.log10(linear)
    assert.ok(Math.abs(back - expected) < 0.15,
      `linear ${linear} -> mpv ${mpv} -> ${back} dB, expected ~${expected.toFixed(2)} dB`)
    // gain-policy must hold the identical formula.
    assert.strictEqual(G.mpvVolumeToDb(mpv), back, 'gain-policy and quality-badge disagree at mpv ' + mpv)
  }
  assert.strictEqual(linearToMpv(1, true), MPV_MAX, 'full slider with boost lands on the ceiling')
})

test('C1 the gain policy stops ignoring the boost it was handed', () => {
  // The old assess() accepted `boost` and never read it: slider at 100 % with
  // boost on is mpv 130, about +6.8 dB, and it reported "nothing can clip".
  const boosted = G.assess({ boost: true, volumePct: 100, eq: { enabled: false }, replaygain: 'no' })
  assert.strictEqual(boosted.totalDb, 6.8)
  assert.strictEqual(boosted.risk, 'likely')
  assert.match(boosted.text, /Volume boost/)
  assert.doesNotMatch(boosted.text, /nothing can clip/)
  // Bit-perfect caps mpv at 100, so the boost can lift nothing while it is on.
  const capped = G.assess({ boost: true, bitPerfect: true, volumePct: 100 })
  assert.strictEqual(capped.totalDb, 0)
  // boostGainDb mirrors volume-map exactly.
  assert.strictEqual(G.boostGainDb(100), G.mpvVolumeToDb(linearToMpv(1, true)))
  assert.strictEqual(G.boostGainDb(50), G.mpvVolumeToDb(linearToMpv(0.5, true)))
})

test("C1 the gain policy prefers mpv's relayed volume over the slider", () => {
  const r = G.assess({ mpvVolume: 130, boost: true, volumePct: 100 })
  assert.strictEqual(r.totalDb, 6.8)
  assert.match(r.text, /mpv 130/)
  assert.strictEqual(r.parts.filter(p => p.db > 0).length, 1, 'the boost is not double-counted')
  // Leveling is a gain path the policy has to mention.
  assert.match(G.assess({ replaygainApply: true }).text, /leveling/i)
})

// ── C2: the runtime ReplayGain bypass ────────────────────────────────────────

test('C2 a runtime ReplayGain request is gated by bit-perfect, and says so', () => {
  const blocked = BP.effectiveReplaygain({ replaygain: 'track', bitPerfect: true })
  assert.strictEqual(blocked.mode, 'no', 'the engine must not be given ReplayGain in bit-perfect mode')
  assert.strictEqual(blocked.requested, 'track')
  assert.strictEqual(blocked.suppressed, true)
  assert.match(blocked.reason, /bit-perfect/i)

  const allowed = BP.effectiveReplaygain({ replaygain: 'album', bitPerfect: false })
  assert.deepStrictEqual(
    { mode: allowed.mode, requested: allowed.requested, suppressed: allowed.suppressed },
    { mode: 'album', requested: 'album', suppressed: false })

  // Anything that is not track/album normalises to mpv's 'no', including the
  // UI's 'off' — the value mpv would reject.
  for (const m of ['off', 'no', undefined, null, 'garbage']) {
    assert.strictEqual(BP.effectiveReplaygain({ replaygain: m, bitPerfect: true }).mode, 'no', String(m))
    assert.strictEqual(BP.effectiveReplaygain({ replaygain: m }).suppressed, false, String(m))
  }
})

test('C2 the spawn config and the runtime gate are the same rule, not two', () => {
  // resolveEngineConfig must produce exactly what effectiveReplaygain decides,
  // for every combination — that is what stops them drifting apart again.
  for (const bitPerfect of [true, false]) {
    for (const replaygain of ['no', 'track', 'album', 'off', undefined]) {
      const cfg = { bitPerfect, replaygain, mode: 'gapless', eq: { enabled: true } }
      const engine = BP.resolveEngineConfig(cfg)
      const gate = BP.effectiveReplaygain(cfg)
      if (bitPerfect) {
        assert.strictEqual(engine.replaygain, gate.mode, JSON.stringify(cfg))
        assert.strictEqual(engine.replaygain, 'no', JSON.stringify(cfg))
      } else {
        assert.strictEqual(engine.replaygain, replaygain, JSON.stringify(cfg))
      }
    }
  }
})

test('C2 the badge names the ReplayGain the ENGINE got, not the stored choice', () => {
  // The store can hold 'album' while bit-perfect suppressed it at spawn. Naming
  // the stored choice is the lie in the other direction — the badge saying
  // something is processing the audio when nothing is.
  const suppressed = {
    ...pure,
    replaygain: 'album',
    replaygainEffective: BP.effectiveReplaygain({ replaygain: 'album', bitPerfect: true }).mode,
    bitPerfect: true,
  }
  const v = Q.classify({ track: flac, settings: suppressed, speed: 1, volume: 100 })
  assert.ok(!v.processing.some(p => /ReplayGain/.test(p)),
    'a suppressed ReplayGain must not be listed: ' + JSON.stringify(v.processing))
  assert.strictEqual(v.label, 'BIT-PERFECT')
  assert.doesNotMatch(G.assess(suppressed).text, /ReplayGain may raise/)

  // And when it is genuinely in force it is still named, from the same field.
  const live = { ...pure, replaygain: 'no', replaygainEffective: 'track' }
  assert.ok(Q.classify({ track: flac, settings: live, speed: 1, volume: 100 })
    .processing.some(p => /ReplayGain \(track\)/.test(p)))
  assert.match(G.assess(live).text, /ReplayGain may raise/)

  // With no effective field relayed, the stored choice is still used.
  assert.ok(Q.classify({ track: flac, settings: { ...pure, replaygain: 'track' }, speed: 1, volume: 100 })
    .processing.some(p => /ReplayGain \(track\)/.test(p)))
})

// ── C3: two controls, one name ───────────────────────────────────────────────

test('C3 exactly one of the two controls is allowed to claim bit-perfectness', () => {
  const exclusive = BP.controlLabel('output-mode-exclusive')
  const toggle = BP.controlLabel('bit-perfect-toggle')

  assert.strictEqual(BP.claimsBitPerfect(exclusive.label), false,
    'the output-mode option must not be called bit-perfect: it only opens the device alone')
  assert.strictEqual(BP.claimsBitPerfect(toggle.label), true,
    'the mode that actually strips the processing keeps the name')
  assert.notStrictEqual(exclusive.label, toggle.label)

  // And the exclusive hint must say what it does NOT do, by name.
  for (const thing of [/EQ/, /ReplayGain/i, /leveling/i, /boost/i, /crossfade/i]) {
    assert.match(exclusive.hint, thing, String(thing))
  }
  assert.match(exclusive.hint, /not bit-perfect on its own/i)
  assert.throws(() => BP.controlLabel('no-such-control'), /unknown bit-perfect control id/)
})

test('C3 the badge can tell the two output modes apart', () => {
  assert.strictEqual(Q.outputMode({ bitPerfect: true }), 'bit-perfect')
  assert.strictEqual(Q.outputMode({ outputMode: 'exclusive' }), 'exclusive')
  assert.strictEqual(Q.outputMode({ outputMode: 'shared' }), 'shared')
  assert.strictEqual(Q.outputMode(), 'shared')
  // Exclusive-only leaves every sample-altering comfort running, and the badge
  // must catch them rather than trusting the option's old name.
  const v = Q.classify({
    track: flac,
    settings: { outputMode: 'exclusive', mode: 'gapless', eq: { enabled: true, gains: [6] }, boost: true },
    speed: 1, volume: 100,
  })
  assert.strictEqual(v.label, 'LOSSLESS')
  assert.ok(v.processing.some(p => /EQ/.test(p)))
  assert.ok(v.processing.some(p => /boost/i.test(p)), JSON.stringify(v.processing))
})

// ── C4: gapless resampling, disclosed not changed ────────────────────────────

test('C4 a gapless handoff between two sample rates resamples THIS track', () => {
  const v = Q.classify({
    track: { filePath: '/m/b.flac', codec: 'FLAC', sampleRate: 44100 },
    prevTrack: { filePath: '/m/a.flac', codec: 'FLAC', sampleRate: 48000 },
    settings: pure, speed: 1, volume: 100,
  })
  assert.strictEqual(v.label, 'LOSSLESS', 'a resampled track is not bit-perfect')
  assert.ok(v.processing.some(p => /Gapless resample/.test(p)), JSON.stringify(v.processing))
  assert.match(v.reason, /44\.1 kHz → 48 kHz/)
})

test('C4 a matching neighbour is not reported as a resample', () => {
  const v = Q.classify({
    track: { filePath: '/m/b.flac', codec: 'FLAC', sampleRate: 44100 },
    prevTrack: { filePath: '/m/a.flac', codec: 'FLAC', sampleRate: 44100 },
    nextTrack: { filePath: '/m/c.flac', codec: 'FLAC', sampleRate: 44100 },
    settings: pure, speed: 1, volume: 100,
  })
  assert.strictEqual(v.label, 'BIT-PERFECT')
  assert.deepStrictEqual(v.processing, [])
  // An unknown neighbour is never guessed at either.
  assert.strictEqual(Q.gaplessResampling({ settings: pure, track: flac }).current, null)
  assert.strictEqual(Q.gaplessResampling({ settings: pure, track: flac }).upcoming, null)
})

test('C4 the upcoming rate change is disclosed without touching this track', () => {
  const v = Q.classify({
    track: { filePath: '/m/b.flac', codec: 'FLAC', sampleRate: 44100 },
    nextTrack: { filePath: '/m/c.flac', codec: 'FLAC', sampleRate: 96000 },
    settings: pure, speed: 1, volume: 100,
  })
  assert.strictEqual(v.label, 'BIT-PERFECT', 'the next track does not change these samples')
  assert.deepStrictEqual(v.processing, [])
  assert.match(v.reason, /Next track is 96 kHz and will be resampled to 44\.1 kHz/)
})

test('C4 every BIT-PERFECT claim carries the standing gapless disclosure', () => {
  const v = Q.classify({ track: flac, settings: pure, speed: 1, volume: 100 })
  assert.strictEqual(v.label, 'BIT-PERFECT')
  assert.match(v.reason, /resamples/i)
  assert.strictEqual(v.gapless.gapless, true)
  // Crossfade is not gapless, so the gapless note does not apply there.
  assert.strictEqual(Q.gaplessResampling({ settings: { mode: 'crossfade' }, track: flac }).gapless, false)
  // ...and the bit-perfect settings note says it too.
  assert.match(BP.EXCLUSIVITY_NOTE, /gapless/i)
  assert.match(BP.EXCLUSIVITY_NOTE, /resamples/i)
})

// ── C5: DSD is decoded to PCM ────────────────────────────────────────────────

test('C5 DSD is never LOSSLESS or BIT-PERFECT — it is decoded to PCM', () => {
  for (const t of [
    { filePath: '/m/a.dsf', codec: 'DSD' },
    { filePath: '/m/a.dff' },
    { filePath: '/m/a.dsf' },
    { filePath: '/m/a.bin', codec: 'dsd_lsbf_planar' },
  ]) {
    assert.strictEqual(Q.codecClass(t), 'dsd', JSON.stringify(t))
    const v = Q.classify({ track: t, settings: pure, speed: 1, volume: 100 })
    assert.strictEqual(v.label, 'DSD → PCM', JSON.stringify(t))
    assert.notStrictEqual(v.label, 'BIT-PERFECT')
    assert.match(v.reason, /decoded to PCM/i)
  }
})

test('C5 the DSD verdict still names whatever else is processing it', () => {
  const v = Q.classify({
    track: { filePath: '/m/a.dsf', codec: 'DSD' },
    settings: { ...pure, eq: { enabled: true, gains: [3] }, replaygainApply: true },
    speed: 1, volume: 100,
  })
  assert.strictEqual(v.label, 'DSD → PCM')
  assert.match(v.reason, /EQ/)
  assert.match(v.reason, /leveling/i)
})

test('C5 ordinary lossless codecs are untouched by the DSD class', () => {
  for (const c of ['FLAC', 'ALAC', 'pcm_s24le', 'truehd', 'WavPack', 'dts_hd_ma']) {
    assert.strictEqual(Q.codecClass({ filePath: '/m/x.bin', codec: c }), 'lossless', c)
  }
  // DTS is lossy and must not be dragged into the DSD class by the 'dst' arm.
  assert.strictEqual(Q.codecClass({ filePath: '/m/x.bin', codec: 'dts' }), 'lossy')
})

test('C5 the DSD format badge says it is decoded to PCM', () => {
  const badges = F.formatBadges({ codec: 'dsd', channels: 2, sampleRate: 2822400 })
  const dsd = badges.find(b => b.kind === 'dsd')
  assert.ok(dsd, 'a DSD file still gets a DSD badge')
  assert.strictEqual(dsd.title, F.DSD_TITLE)
  assert.match(dsd.title, /decoded to PCM/i)
})

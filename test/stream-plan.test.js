'use strict'
// V1: the smooth player's decision table, checked against the three real
// files measured on the user's machine.
const test = require('node:test')
const assert = require('node:assert')
const P = require('../src/stream-plan')

const mononoke = [
  { index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', width: 1920, height: 804, color_transfer: 'bt709' },
  { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 6, tags: { language: 'jpn' } },
  { index: 2, codec_type: 'audio', codec_name: 'aac', channels: 6, tags: { language: 'eng' } },
  { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'English' } },
]
const clockwork = [
  { index: 0, codec_type: 'video', codec_name: 'av1', pix_fmt: 'yuv420p10le', width: 1788, height: 1080 },
  { index: 1, codec_type: 'audio', codec_name: 'opus', channels: 6 },
  { index: 2, codec_type: 'audio', codec_name: 'opus', channels: 1 },
  { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
]
const f4 = [
  { index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 3840, height: 1608, color_transfer: 'smpte2084', color_primaries: 'bt2020' },
  { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8 },
  { index: 2, codec_type: 'audio', codec_name: 'eac3', channels: 8 },
  { index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
]

test('AV1 + Opus is a pure remux: nothing re-encoded, no pre-roll', () => {
  const p = P.plan(clockwork)
  assert.equal(p.mode, 'remux')
  assert.deepEqual(p.videoArgs, ['-c:v', 'copy'])
  assert.deepEqual(p.audioArgs, ['-c:a', 'copy'])
  assert.equal(p.audio.index, 1, 'the 5.1 track wins over the mono commentary')
  assert.equal(p.prerollSec, 0)
  assert.deepEqual(p.badges, [])
  assert.equal(p.subtitles.sidecars.length, 0)
  assert.equal(p.subtitles.burnable.length, 1, 'PGS can only be burned in')
})

test('1080p HEVC 10-bit + AAC 5.1 re-encodes the video on the GPU and copies the audio', () => {
  const p = P.plan(mononoke)
  assert.equal(p.mode, 'transcode')
  assert.equal(p.reason, 'video re-encoded')
  assert.deepEqual(p.inputArgs, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'])
  assert.ok(p.videoArgs.includes('h264_nvenc') && p.videoArgs.includes('scale_cuda=format=nv12'))
  assert.deepEqual(p.audioArgs, ['-c:a', 'copy'])
  assert.equal(p.prerollSec, 2)
  assert.deepEqual(p.badges, ['converted'])
  assert.deepEqual(p.subtitles.sidecars, [{ index: 3, lang: 'eng', title: 'English' }])
  assert.equal(p.audios.length, 2)
})

test('a language preference picks the audio track; an explicit index wins over it', () => {
  assert.equal(P.plan(mononoke, { prefs: { lang: 'eng' } }).audio.index, 2)
  assert.equal(P.plan(mononoke, { prefs: { lang: 'eng', audioIndex: 1 } }).audio.index, 1)
})

test('4K HDR TrueHD: tone-mapped to SDR, H.264 at 4K bitrate, Opus 5.1, an 8 s pre-roll, and it says so', () => {
  const p = P.plan(f4)
  assert.equal(p.mode, 'transcode')
  assert.ok(p.video.hdr)
  assert.match(p.reason, /HDR tone-mapped/)
  assert.deepEqual(p.inputArgs, ['-hwaccel', 'cuda'], 'frames must reach system memory for the tone-map')
  assert.ok(p.videoArgs.join(' ').includes('tonemap=hable'))
  assert.ok(p.videoArgs.includes('45M'))
  assert.deepEqual(p.audioArgs, ['-c:a', 'libopus', '-b:a', '512k', '-ac', '6'], '7.1 folds to 5.1 Opus')
  assert.equal(p.prerollSec, 8)
  assert.deepEqual(p.badges, ['HDR shown as SDR', 'converted'])
})

test('no GPU falls back to libx264; a browser that could decode HEVC would copy it', () => {
  const cpu = P.plan(mononoke, { caps: { gpu: false } })
  assert.ok(cpu.videoArgs.includes('libx264'))
  assert.deepEqual(cpu.inputArgs, [])
  const hevcOk = P.plan(mononoke, { caps: { video: new Set(['h264', 'av1', 'hevc']) } })
  assert.equal(hevcOk.mode, 'remux')
})

test('no video stream is refused (the caller falls back to mpv)', () => {
  assert.equal(P.plan([{ index: 0, codec_type: 'audio', codec_name: 'aac' }]).mode, 'refuse')
  assert.equal(P.plan(null).mode, 'refuse')
})

test('ffmpegArgs writes fragmented MP4 to stdout from the requested second, with the chosen maps', () => {
  const p = P.plan(clockwork)
  const a = P.ffmpegArgs(p, '/x/film.mkv', 600)
  assert.deepEqual(a.slice(0, 4), ['-hide_banner', '-loglevel', 'error', '-nostdin'])
  assert.ok(a.includes('-ss') && a[a.indexOf('-ss') + 1] === '600')
  assert.ok(a.indexOf('-ss') < a.indexOf('-i'), 'input seeking, so the seek is fast')
  assert.deepEqual(a.slice(a.indexOf('-map'), a.indexOf('-map') + 4), ['-map', '0:0', '-map', '0:1'])
  assert.ok(a.includes('frag_keyframe+empty_moov+default_base_moof'))
  assert.equal(a[a.length - 1], 'pipe:1')
  assert.ok(!a.includes('-ss') || P.ffmpegArgs(p, '/x/film.mkv', 0).indexOf('-ss') === -1, 'no -ss at zero')
})

test('ffmpegArgs merges a tone-map filter with a burned subtitle, and burning into a copied stream forces a software encode', () => {
  const hdr = P.ffmpegArgs(P.plan(f4), '/x/f4.mkv', 0, { burnIndex: 5, burnSubOrdinal: 0 })
  const vf = hdr[hdr.indexOf('-vf') + 1]
  assert.ok(vf.startsWith('zscale=') && /,subtitles='\/x\/f4\.mkv':si=0$/.test(vf))
  assert.equal(hdr.filter(x => x === '-vf').length, 1, 'one -vf, filters joined')
  const burned = P.ffmpegArgs(P.plan(clockwork), '/x/a.mkv', 0, { burnIndex: 4, burnSubOrdinal: 0 })
  assert.equal(burned[burned.indexOf('-c:v') + 1], 'libx264', 'the video is decoded and re-encoded to draw the text')
  assert.equal(burned[burned.indexOf('-c:a') + 1], 'copy', 'the audio still copies')
})

test('subtitleArgs extracts one text stream as WebVTT', () => {
  assert.deepEqual(P.subtitleArgs('/x/a.mkv', 3).slice(-7), ['-i', '/x/a.mkv', '-map', '0:3', '-f', 'webvtt', 'pipe:1'])
})

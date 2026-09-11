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

test('4K HDR TrueHD: tone-mapped on the GPU through OpenCL, H.264 at 4K bitrate, Opus 5.1, a 4 s pre-roll, and it says so', () => {
  const p = P.plan(f4)
  assert.equal(p.mode, 'transcode')
  assert.ok(p.video.hdr)
  assert.match(p.reason, /HDR tone-mapped/)
  assert.deepEqual(p.inputArgs, ['-init_hw_device', 'opencl=ocl', '-filter_hw_device', 'ocl', '-hwaccel', 'cuda'])
  assert.ok(p.videoArgs.join(' ').includes('tonemap_opencl=tonemap=hable'))
  assert.ok(p.videoArgs.includes('45M'))
  assert.deepEqual(p.audioArgs, ['-c:a', 'libopus', '-b:a', '512k', '-ac', '6'], '7.1 folds to 5.1 Opus')
  assert.equal(p.prerollSec, 4)
  assert.deepEqual(p.badges, ['HDR shown as SDR', 'converted'])
  // No OpenCL on the machine: the CPU tone-map, and the long pre-roll.
  const cpu = P.plan(f4, { caps: { opencl: false } })
  assert.deepEqual(cpu.inputArgs, ['-hwaccel', 'cuda'], 'frames must reach system memory for the CPU tone-map')
  assert.ok(cpu.videoArgs.join(' ').includes('zscale=t=linear'))
  assert.equal(cpu.prerollSec, 8)
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
  assert.ok(a.indexOf('-ss') < a.indexOf('-i'), 'a copied video keeps the input seek: it cannot be cut inside a GOP')
  assert.equal(a.filter(x => x === '-ss').length, 1)
  assert.deepEqual(a.slice(a.indexOf('-map'), a.indexOf('-map') + 4), ['-map', '0:0', '-map', '0:1'])
  assert.ok(a.includes('frag_keyframe+empty_moov+default_base_moof'))
  assert.equal(a[a.length - 1], 'pipe:1')
  assert.ok(!a.includes('-ss') || P.ffmpegArgs(p, '/x/film.mkv', 0).indexOf('-ss') === -1, 'no -ss at zero')
})

test('a re-encode seeks in two parts so picture and sound share one clock (the 2.3 s lip-sync bug)', () => {
  const a = P.ffmpegArgs(P.plan(mononoke), '/x/film.mkv', 600)
  const ss = a.reduce((o, x, i) => (x === '-ss' ? o.concat([[i, a[i + 1]]]) : o), [])
  assert.equal(ss.length, 2)
  assert.equal(ss[0][1], '598'); assert.ok(ss[0][0] < a.indexOf('-i'), 'most of the way on the input')
  assert.equal(ss[1][1], '2'); assert.ok(ss[1][0] > a.indexOf('-i') && ss[1][0] < a.indexOf('-map'), 'the last two seconds on the output')
  const near = P.ffmpegArgs(P.plan(mononoke), '/x/film.mkv', 1.5)
  assert.deepEqual(near.filter((x, i) => near[i - 1] === '-ss'), ['1.5'], 'inside the first two seconds: output seek only')
  assert.ok(!P.ffmpegArgs(P.plan(mononoke), '/x/film.mkv', 0).includes('-ss'))
})

test('ffmpegArgs merges a tone-map filter with a burned subtitle, and burning into a copied stream forces a software encode', () => {
  const hdr = P.ffmpegArgs(P.plan(f4, { caps: { opencl: false } }), '/x/f4.mkv', 0, { burnIndex: 5, burnSubOrdinal: 0 })
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

test('every plan carries the MIME string Media Source Extensions need; copied streams describe the source', () => {
  assert.equal(P.plan(mononoke).mime, 'video/mp4; codecs="avc1.640028,mp4a.40.2"', 'HEVC re-encoded to H.264 High, AAC copied')
  assert.equal(P.plan(clockwork).mime, 'video/mp4; codecs="av01.0.08M.10,opus"', 'AV1 10-bit copied, level index 8')
  assert.equal(P.plan(f4).mime, 'video/mp4; codecs="avc1.640028,opus"', 'HDR re-encoded, TrueHD to Opus')
  const h264 = [{ index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 41, pix_fmt: 'yuv420p', width: 1920, height: 1080 }, { index: 1, codec_type: 'audio', codec_name: 'flac', channels: 2 }]
  assert.equal(P.plan(h264).mime, 'video/mp4; codecs="avc1.640029,flac"')
  const vp9 = [{ index: 0, codec_type: 'video', codec_name: 'vp9', profile: 'Profile 0', pix_fmt: 'yuv420p', width: 1280, height: 720 }, { index: 1, codec_type: 'audio', codec_name: 'vorbis', channels: 2 }]
  const p = P.plan(vp9)
  assert.equal(p.mime, 'video/mp4; codecs="vp09.00.28.08,opus"')
  assert.deepEqual(p.audioArgs.slice(0, 2), ['-c:a', 'libopus'], 'vorbis is re-encoded: MP4 cannot carry it for MSE')
})

test('subtitle outputs ride along the run; VTT cues parse, shift by the run start, and merge with later runs winning', () => {
  const p = P.plan(mononoke)
  const a = P.ffmpegArgs(p, 'http://127.0.0.1:1/film.mkv', 600, { subOutputs: [{ index: 3, file: '/c/run-1-sub-3.vtt' }] })
  const at = a.indexOf('/c/run-1-sub-3.vtt')
  assert.ok(at > a.indexOf('pipe:1'), 'after the main output')
  assert.deepEqual(a.slice(at - 9, at), ['-map', '0:3', '-c:s', 'webvtt', '-f', 'webvtt', '-flush_packets', '1', '-y'])
  const cues = P.parseVtt('WEBVTT\n\n00:00:01.500 --> 00:00:03.000 line:90%\nHello\nthere\n\n01:02:03.250 --> 01:02:04.000\nLater\n', 600)
  assert.deepEqual(cues, [{ start: 601.5, end: 603, settings: 'line:90%', text: 'Hello\nthere' }, { start: 4323.25, end: 4324, settings: '', text: 'Later' }])
  const merged = P.mergeVtt([P.parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA\n', 0), P.parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA2\n\n00:00:05.000 --> 00:00:06.000\nB\n', 0)])
  assert.equal(merged, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA2\n\n00:00:05.000 --> 00:00:06.000\nB\n')
  assert.equal(P.mergeVtt([]), 'WEBVTT\n\n')
})

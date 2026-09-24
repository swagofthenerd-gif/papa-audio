'use strict'
// The instant HTTP source is only as good as its wiring: it has to lead the
// merged list, reach mpv with the arguments the CDN was measured to need, and
// wear the instant badge. Each was verified against the live stream first
// (mpv decoded 1080p frames before any of this was written); these pin the
// plumbing.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { rankStreams } = require('../providers/index.js')
const { VideoEngine } = require('../video-engine.js')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(src, name, file) {
  const at = src.indexOf('\nfunction ' + name + '(')
  assert.ok(at > -1, name + ' must be a top-level function in ' + file)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// ── Ranking ────────────────────────────────────────────────────────────────

const torrent = (seeds, over) => Object.assign({
  kind: 'torrent', infoHash: 'a'.repeat(40), magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
  title: 'Show - 05 (1080p)', quality: '1080p', seeds, source: 'Nyaa',
}, over)
const instant = over => Object.assign({
  kind: 'http', url: 'https://hls.example/master.m3u8', title: 'Show - 05',
  quality: null, source: 'KickAssAnime', instant: true, sub: true, dub: false,
}, over)

test('an instant stream leads torrents, whatever their seeds', () => {
  const out = rankStreams([torrent(500), instant(), torrent(90)], {})
  assert.strictEqual(out[0].instant, true,
    '"plays now" must not sink beneath "might play after finding peers"')
})

test('a dub that was asked for still beats an instant sub', () => {
  const out = rankStreams([instant(), torrent(40, { dub: true, title: 'Show - 05 Dub' })], { preferDub: true })
  assert.strictEqual(out[0].dub, true,
    'the dub tier sits above the instant tier on purpose — he asked for the dub')
})

test('an instant DUB with the dub asked for beats everything', () => {
  const out = rankStreams([torrent(40, { dub: true }), instant({ dub: true, sub: false })], { preferDub: true })
  assert.strictEqual(out[0].instant, true)
})

// ── The mpv arguments (main.js) ────────────────────────────────────────────

function httpArgs() {
  const ctx = { Object, Array, Number, String }
  vm.createContext(ctx)
  vm.runInContext(lift(MAIN, '_httpStreamArgs', 'main.js'), ctx)
  return ctx._httpStreamArgs
}

test('an http entry yields the demuxer allowance and its measured headers', () => {
  const args = httpArgs()({
    kind: 'http', url: 'https://x/master.m3u8',
    headers: { Origin: 'https://krussdomi.com' },
    subtitles: [{ url: 'https://subs.x/eng.vtt', label: 'English' }],
  })
  assert.ok(args.some(a => /allowed_extensions=ALL/.test(a)),
    'the CDN names its video segments .jpg; ffmpeg refuses them SILENTLY without this — mpv just hangs')
  assert.ok(args.includes('--http-header-fields-append=Origin: https://krussdomi.com'),
    'the segment host answers 403 to everything without its Origin header — measured, not guessed')
  assert.ok(args.includes('--sub-files-append=https://subs.x/eng.vtt'))
})

test('subtitles are capped so a dozen languages do not stack downloads', () => {
  const subs = Array.from({ length: 9 }, (_, i) => ({ url: 'https://s.x/' + i + '.vtt' }))
  const args = httpArgs()({ kind: 'http', url: 'https://x', subtitles: subs })
  assert.ok(args.filter(a => a.startsWith('--sub-files-append=')).length <= 4)
})

test('a torrent, a debrid link and a local file get no extra arguments', () => {
  // Length, not deepStrictEqual: the array is built inside the vm and carries
  // the vm's own Array.prototype.
  const f = httpArgs()
  assert.strictEqual(f({ kind: 'torrent', magnet: 'magnet:?x' }).length, 0)
  assert.strictEqual(f(null).length, 0)
  assert.strictEqual(f({ url: '/home/x/film.mkv' }).length, 0)
})

// ── The engine carries them to mpv ─────────────────────────────────────────

test('extraArgs reach the spawned mpv, and only long-form flags do', () => {
  let seen = null
  const engine = new VideoEngine({
    binary: 'mpv',
    spawnFn: (bin, args) => { seen = args; throw new Error('spawn intercepted — args captured') },
    socketPath: '/nonexistent.sock',
    inputConf: null,
  })
  try {
    engine._spawnFn('mpv', engine._args('/tmp/s.sock', {
      wid: null,
      extraArgs: ['--http-header-fields-append=Origin: https://a', 'rm -rf /', '--sub-files-append=https://s/x.vtt'],
    }))
  } catch (_) { /* the spawn itself is not the subject */ }
  assert.ok(seen.includes('--http-header-fields-append=Origin: https://a'))
  assert.ok(seen.includes('--sub-files-append=https://s/x.vtt'))
  assert.ok(!seen.includes('rm -rf /'),
    'anything that is not a --flag is dropped — these args come from provider data')
})

// ── The badge (renderer) ───────────────────────────────────────────────────

test('an instant http entry wears the instant badge', () => {
  const ctx = {}
  vm.createContext(ctx)
  ctx._debridPick = null
  ctx._debridHeld = []
  vm.runInContext(lift(RENDERER, '_isInstantSource', 'renderer.js'), ctx)
  assert.strictEqual(ctx._isInstantSource(instant()), true)
  assert.strictEqual(ctx._isInstantSource({ kind: 'http', instant: false }), false)
  assert.strictEqual(ctx._isInstantSource(torrent(5)), false,
    'a plain torrent is not instant just because http entries exist now')
})

// ── The lineup ─────────────────────────────────────────────────────────────

test('anime searches include the http source, torrents on or off', () => {
  const at = MAIN.indexOf("if (type === 'anime') return torrents")
  assert.ok(at > -1)
  const line = MAIN.slice(at, MAIN.indexOf('\n', at))
  assert.ok(/kickassanime\(\).*nyaa\(\)/.test(line), 'first in the lineup: it answers in a second or not at all')
  assert.ok(/: \[kickassanime\(\)\]/.test(line),
    'with torrent sources off it is the one way anime can play at all')
})

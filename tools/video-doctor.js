'use strict'
// Papa Video doctor — runs the whole playback chain outside Electron and says
// exactly which stage fails.
//
//   node tools/video-doctor.js            # movie path
//   node tools/video-doctor.js anime      # anime path
//
// Each stage prints PASS or FAIL with the reason. The first FAIL is the bug.

const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const MODE = (process.argv[2] || 'movie').toLowerCase()
const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6) + 'ms'
const pass = (s, extra) => console.log(`${ms()}  PASS  ${s}${extra ? ' — ' + extra : ''}`)
const fail = (s, extra) => console.log(`${ms()}  FAIL  ${s}${extra ? ' — ' + extra : ''}`)
const info = (s) => console.log(`${ms()}  ....  ${s}`)

const fetchFn = (u, o) => fetch(u, { ...(o || {}), signal: AbortSignal.timeout(25000) })

// The streamer rejects with plain objects ({code, message}); everything else
// throws real Errors. JSON.stringify flattens an Error to "{}", which is how a
// TypeError in this file once masqueraded as a dead torrent.
const errText = (e) => {
  if (!e) return String(e)
  if (e instanceof Error) return e.stack || e.message
  if (typeof e === 'object') return JSON.stringify(e)
  return String(e)
}

async function main () {
  // ── 1. Do the modules load at all? ───────────────────────────────────────
  let mods
  try {
    mods = {
      torrent: require(path.join(ROOT, 'torrent-stream.js')),
      nyaa: require(path.join(ROOT, 'providers/nyaa.js')),
      yts: require(path.join(ROOT, 'providers/yts.js')),
      apibay: require(path.join(ROOT, 'providers/apibay.js')),
      router: require(path.join(ROOT, 'providers/index.js')),
      engine: require(path.join(ROOT, 'video-engine.js')),
    }
    pass('modules load')
  } catch (e) {
    fail('modules load', e.message)
    console.log('\n>>> A file has a syntax error. That alone breaks playback.')
    return
  }

  // ── 2. Does mpv accept the arguments the engine builds? ──────────────────
  try {
    const eng = new mods.engine.VideoEngine({ config: {} })
    const args = eng._args('/tmp/papa-doctor.sock')
    await new Promise((resolve, reject) => {
      const p = spawn('mpv', args.concat(['--version']), { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', d => { err += d })
      p.on('error', reject)
      p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.slice(0, 200) || 'exit ' + code))))
    })
    pass('mpv accepts the engine arguments')
  } catch (e) {
    fail('mpv accepts the engine arguments', e.message)
    console.log('\n>>> mpv rejects an argument, so it exits the moment it is spawned.')
    return
  }

  // ── 3. Do sources resolve? ───────────────────────────────────────────────
  let sources = []
  try {
    const req = MODE === 'anime'
      ? { type: 'anime', title: 'Frieren', titles: { romaji: 'Sousou no Frieren', english: 'Frieren' }, episode: 1, sub: true, dub: false }
      : { type: 'movie', title: 'Interstellar', year: 2014 }
    const backends = MODE === 'anime'
      ? [mods.nyaa.createNyaaProvider({ fetchFn }), mods.apibay.createApibayProvider({ fetchFn })]
      : [mods.yts.createYtsProvider({ fetchFn }), mods.apibay.createApibayProvider({ fetchFn })]
    sources = await mods.router.resolveStream(req, backends, { timeoutMs: 25000 })
    if (!sources.length) throw new Error('no sources returned')
    pass('sources resolve', `${sources.length} found, top: ${sources[0].label}`)
  } catch (e) {
    fail('sources resolve', e.message)
    console.log('\n>>> No sources, so there is nothing to play. Network or indexer problem.')
    return
  }

  // ── 4. Does the torrent actually stream? ─────────────────────────────────
  const pick = sources.find(s => s.kind === 'torrent' && s.magnet)
  if (!pick) {
    fail('a torrent source exists', 'every source is a direct URL')
    return
  }
  info(`streaming: ${pick.label}`)
  info(`peers reported by indexer: ${pick.seeds != null ? pick.seeds : 'unknown'}`)

  let WebTorrent
  try {
    WebTorrent = require(path.join(ROOT, 'node_modules/webtorrent'))
    pass('webtorrent loads')
  } catch (e) {
    fail('webtorrent loads', e.message)
    return
  }

  const client = new WebTorrent({ maxConns: 150 })
  client.on('error', e => info('client error: ' + (e && e.message)))

  const streamer = new mods.torrent.TorrentStreamer({
    client,
    timeoutMs: 45000,
    prebufferBytes: 0,
    stallMs: 25000,
  })

  let lastLine = ''
  streamer.on('progress', p => {
    const line = `peers ${p.peers || 0}  downloaded ${(((p.fileDownloaded || p.downloaded) || 0) / 1048576).toFixed(1)} MB  ${((p.speed || 0) / 125000).toFixed(1)} Mb/s`
    if (line !== lastLine) { lastLine = line; info(line) }
  })
  streamer.on('error', e => info('streamer error: ' + JSON.stringify(e)))

  const finish = (ok) => {
    try { streamer.stop() } catch (_) {}
    try { client.destroy(() => process.exit(ok ? 0 : 1)) } catch (_) { process.exit(ok ? 0 : 1) }
    setTimeout(() => process.exit(ok ? 0 : 1), 3000).unref()
  }

  // Only the start() call belongs in this try. Anything after it that throws is
  // a different failure and must not be reported as "the torrent never
  // delivered" — that mislabelling is what hid the real bug.
  let url
  try {
    const started = Date.now()
    const res = await streamer.start({
      magnet: pick.magnet,
      fileIndex: pick.fileIndex || 0,
      episode: MODE === 'anime' ? 1 : null,
    })
    url = res.url
    pass('torrent ready', `${Date.now() - started}ms — ${url}`)
  } catch (e) {
    fail('torrent ready', errText(e))
    console.log('\n>>> The torrent never delivered. Check peers above: 0 peers means the source is dead,')
    console.log('    peers with no data means the connection is being blocked (firewall / VPN / ISP).')
    finish(false)
    return
  }

  try {
    // files() exists only on the newer TorrentStreamer. Report what this build
    // actually has rather than throwing.
    const files = typeof streamer.files === 'function'
      ? streamer.files()
      : ((streamer._torrent && streamer._torrent.files) || [])
    const playing = streamer._file ? streamer._file.name : (files.find(f => f.current) || {}).name
    info(`files in torrent: ${files.length}${playing ? ' (playing: ' + playing + ')' : ''}`)

    // ── 5. Can mpv actually open that URL? ─────────────────────────────────
    info('asking mpv to open the stream for 12s…')
    await new Promise(resolve => {
      const p = spawn('mpv', ['--no-terminal', '--no-video', '--length=5', '--cache=yes', url],
        { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', d => { err += d })
      const kill = setTimeout(() => { try { p.kill() } catch (_) {} }, 12000)
      p.on('close', code => {
        clearTimeout(kill)
        if (err.trim()) info('mpv stderr: ' + err.trim().slice(0, 300))
        if (code === 0 || code === null) pass('mpv opened the stream')
        else fail('mpv opened the stream', 'exit ' + code)
        resolve()
      })
      p.on('error', e => { clearTimeout(kill); fail('mpv spawn', e.message); resolve() })
    })
    console.log('\n>>> The chain works end to end. If the app still fails, the bug is in the UI layer.')
    finish(true)
  } catch (e) {
    fail('after torrent ready', errText(e))
    console.log('\n>>> The torrent delivered a URL. The failure is downstream of streaming.')
    finish(false)
  }
}

main().catch(e => { fail('doctor crashed', e && e.stack); process.exit(1) })

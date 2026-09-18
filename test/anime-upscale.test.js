'use strict'
const test = require('node:test')
const assert = require('node:assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const net = require('net')
const { EventEmitter } = require('events')
const up = require('../src/anime-upscale')
const { VideoEngine } = require('../video-engine')

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }

// ---------------------------------------------------------------- presets

test('the four presets are off plus the three Anime4K modes', () => {
  assert.deepStrictEqual(up.presetIds(), ['off', 'standard', 'soft', 'denoise'])
  assert.strictEqual(up.DEFAULT_PRESET, 'off')
  assert.deepStrictEqual(up.shaderFilesFor('off'), [])
})

test('an unrecognised preset reads as off rather than throwing or guessing', () => {
  for (const bad of ['mode-a', '', null, undefined, 0, {}, 'OFF', '__proto__', 'constructor']) {
    assert.strictEqual(up.normalizePreset(bad), 'off', `${String(bad)} should normalise to off`)
    assert.deepStrictEqual(up.shaderArgs(bad, '/D'), [], `${String(bad)} should apply no shaders`)
  }
})

test('every preset names a restore or upscale stage and ends with an upscale', () => {
  for (const id of up.presetIds()) {
    if (id === 'off') continue
    const files = up.shaderFilesFor(id)
    assert.ok(files.length >= 4, `${id} should be a real chain`)
    assert.ok(files.some(f => /Upscale/.test(f)), `${id} must upscale`)
    // Clamp_Highlights has to lead: it records the highlights before any CNN
    // touches them, so a later stage can restore them. Placed after, it clamps
    // values the network has already changed.
    assert.strictEqual(files[0], 'Anime4K_Clamp_Highlights.glsl', `${id} must clamp first`)
  }
})

// ------------------------------------------------------------ mpv arguments

test('shaderArgs emits one --glsl-shaders-append per file, in chain order', () => {
  const args = up.shaderArgs('standard', '/D')
  const files = up.shaderFilesFor('standard')
  assert.strictEqual(args.length, files.length)
  args.forEach((a, i) => {
    assert.strictEqual(a, `--glsl-shaders-append=${path.join('/D', files[i])}`)
  })
})

// The bug this pins cost a full debugging round: mpv's documented %n% escape is
// NOT unescaped for --glsl-shaders, so a quoted path is stored verbatim and
// every shader silently fails to open — no error, no log, just an ordinary
// picture and a user who thinks the feature does nothing. Raw paths only.
test('shader paths are passed raw, never %n%-quoted', () => {
  for (const a of up.shaderArgs('standard', '/D')) {
    assert.ok(!/%\d+%/.test(a), `must not carry mpv %n% quoting: ${a}`)
    assert.ok(a.includes('/D/Anime4K_'), `must carry a real path: ${a}`)
  }
})

// The append form is the whole reason a separator cannot break the chain.
test('a directory containing : or , still yields one intact path per argument', () => {
  const weird = '/home/od:d,dir/shaders'
  const args = up.shaderArgs('standard', weird)
  assert.strictEqual(args.length, up.shaderFilesFor('standard').length)
  for (const a of args) {
    const value = a.slice('--glsl-shaders-append='.length)
    assert.ok(value.startsWith(weird + path.sep), `path kept whole: ${value}`)
  }
})

test('no shaders without a directory to read them from', () => {
  assert.deepStrictEqual(up.shaderArgs('standard', null), [])
  assert.deepStrictEqual(up.shaderArgs('standard', ''), [])
  assert.deepStrictEqual(up.shaderPaths('standard', undefined), [])
})

// ------------------------------------------------------------ shipped files

test('every shader a preset can ask for is actually shipped in the repo', () => {
  const dir = up.bundledShaderDir()
  const missing = up.requiredShaderFiles().filter(f => !fs.existsSync(path.join(dir, f)))
  assert.deepStrictEqual(missing, [], `these presets reference files that are not in the repo: ${missing}`)
})

test('requiredShaderFiles is the deduplicated union of every preset', () => {
  const union = new Set()
  for (const id of up.presetIds()) for (const f of up.shaderFilesFor(id)) union.add(f)
  assert.deepStrictEqual(up.requiredShaderFiles(), Array.from(union).sort())
  // Deduplicated: the three chains overlap heavily, so the union must be
  // smaller than the naive concatenation.
  const flat = up.presetIds().reduce((n, id) => n + up.shaderFilesFor(id).length, 0)
  assert.ok(up.requiredShaderFiles().length < flat)
})

// ----------------------------------------------------------- ensureShaders

test('ensureShaders copies the whole set and stamps a version', () => {
  const dest = tmp('papa-shaders-')
  const out = up.ensureShaders(dest)
  assert.strictEqual(out, path.join(dest, 'anime4k'))
  for (const f of up.requiredShaderFiles()) {
    assert.ok(fs.existsSync(path.join(out, f)), `${f} copied`)
    assert.ok(fs.statSync(path.join(out, f)).size > 0, `${f} is not empty`)
  }
  assert.strictEqual(fs.readFileSync(path.join(out, '.version'), 'utf8').trim(), up.SHADER_SET_VERSION)
})

test('ensureShaders is idempotent and does not rewrite an up-to-date set', () => {
  const dest = tmp('papa-shaders-')
  const out = up.ensureShaders(dest)
  const probe = path.join(out, up.requiredShaderFiles()[0])
  fs.writeFileSync(probe, 'TOUCHED')
  // Same version and every file present, so the second call must leave it be.
  assert.strictEqual(up.ensureShaders(dest), out)
  assert.strictEqual(fs.readFileSync(probe, 'utf8'), 'TOUCHED')
})

test('a stale version stamp forces the set to be rewritten', () => {
  const dest = tmp('papa-shaders-')
  const out = up.ensureShaders(dest)
  const probe = path.join(out, up.requiredShaderFiles()[0])
  fs.writeFileSync(probe, 'OLD')
  fs.writeFileSync(path.join(out, '.version'), 'ancient')
  up.ensureShaders(dest)
  assert.notStrictEqual(fs.readFileSync(probe, 'utf8'), 'OLD')
})

// mpv fails a missing shader silently, so a file deleted by hand would never
// come back if the stamp alone were trusted.
test('a deleted shader is restored even when the version stamp still matches', () => {
  const dest = tmp('papa-shaders-')
  const out = up.ensureShaders(dest)
  const victim = path.join(out, up.requiredShaderFiles()[1])
  fs.unlinkSync(victim)
  up.ensureShaders(dest)
  assert.ok(fs.existsSync(victim), 'the missing shader was copied again')
})

test('an unreadable source yields null instead of throwing', () => {
  const dest = tmp('papa-shaders-')
  assert.strictEqual(up.ensureShaders(dest, { srcDir: '/nonexistent/anime4k' }), null)
  assert.strictEqual(up.ensureShaders(null), null)
})

// ------------------------------------------------------------- the engine

test('_args carries the preset shaders, and nothing at all when off', () => {
  const on = new VideoEngine({ config: { upscale: 'standard' }, shaderDir: '/S' })._args('/tmp/x.sock')
  const glsl = on.filter(a => a.startsWith('--glsl-shaders'))
  assert.strictEqual(glsl.length, up.shaderFilesFor('standard').length)
  assert.ok(glsl.every(a => a.startsWith('--glsl-shaders-append=')))

  for (const cfg of [{ upscale: 'off' }, {}, { upscale: 'nonsense' }]) {
    const args = new VideoEngine({ config: cfg, shaderDir: '/S' })._args('/tmp/x.sock')
    assert.deepStrictEqual(args.filter(a => a.includes('glsl')), [],
      `${JSON.stringify(cfg)} must add no shader arguments`)
  }
})

test('the engine never touches disk for shaders when the upscaler is off', () => {
  // Resolving the directory is what copies 632KB of shaders out of the asar.
  // Off is the default, so doing that on every start would make almost every
  // run pay for a feature it is not using.
  for (const cfg of [{ upscale: 'off' }, {}, { upscale: 'nonsense' }]) {
    const eng = new VideoEngine({ config: cfg })
    let asked = false
    eng._resolveShaderDir = function () { asked = true; return '/S' }
    const args = eng._args('/tmp/x.sock')
    assert.deepStrictEqual(args.filter(a => a.includes('glsl')), [])
    assert.strictEqual(asked, false,
      `${JSON.stringify(cfg)} must not resolve (and so must not write) the shader directory`)
  }
  // A real preset still resolves it, or the feature could never work.
  const on = new VideoEngine({ config: { upscale: 'standard' } })
  let resolved = false
  on._resolveShaderDir = function () { resolved = true; return '/S' }
  on._args('/tmp/x.sock')
  assert.strictEqual(resolved, true)
})

test('setUpscale records the choice for the next start even when nothing is playing', async () => {
  const eng = new VideoEngine({ config: { upscale: 'off' }, shaderDir: '/S' })
  assert.strictEqual(await eng.setUpscale('denoise'), 'denoise')
  assert.strictEqual(eng.config.upscale, 'denoise')
  const glsl = eng._args('/tmp/x.sock').filter(a => a.includes('glsl'))
  assert.strictEqual(glsl.length, up.shaderFilesFor('denoise').length)
  // Junk is normalised on the way in, so config can never hold a value that
  // _args would then have to defend against.
  assert.strictEqual(await eng.setUpscale('bogus'), 'off')
  assert.strictEqual(eng.config.upscale, 'off')
})

function fakeMpv() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-up-')), 'mpv.sock')
  const conns = []
  const commands = []
  const server = net.createServer(c => {
    conns.push(c)
    c.on('error', () => {})   // a dead peer is not a test failure
    c.on('close', () => { const i = conns.indexOf(c); if (i >= 0) conns.splice(i, 1) })
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        commands.push(msg.command)
        c.write(JSON.stringify({ error: 'success', data: null, request_id: msg.request_id }) + '\n')
      }
    })
  })
  const proc = new EventEmitter()
  proc.kill = () => proc.emit('exit', 0)
  return new Promise(res => server.listen(sock, () => res({
    sock, proc, commands,
    spawnFn: () => proc,
    close: () => { conns.forEach(c => c.destroy()); server.close() },
  })))
}

test('switching preset mid-playback clears the chain before appending the new one', async () => {
  const mpv = await fakeMpv()
  const eng = new VideoEngine({
    config: { upscale: 'off' }, shaderDir: '/S',
    spawnFn: mpv.spawnFn, socketPath: mpv.sock,
  })
  try {
    await eng.start()
    mpv.commands.length = 0
    await eng.setUpscale('standard')
    const sent = mpv.commands.filter(c => c[0] === 'change-list' && c[1] === 'glsl-shaders')
    assert.ok(sent.length > 0, 'the live mpv was told about the change')
    // Clear first: the list is additive, so without this a second preset would
    // stack on top of the first and run both chains.
    assert.strictEqual(sent[0][2], 'clr')
    const appended = sent.slice(1)
    assert.deepStrictEqual(
      appended.map(c => c[3]),
      up.shaderPaths('standard', '/S'),
      'every shader appended once, in chain order',
    )
    // And switching to Off clears without appending anything.
    mpv.commands.length = 0
    await eng.setUpscale('off')
    const off = mpv.commands.filter(c => c[0] === 'change-list' && c[1] === 'glsl-shaders')
    assert.strictEqual(off.length, 1)
    assert.strictEqual(off[0][2], 'clr')
  } finally {
    try { eng.stop() } catch (_) {}
    mpv.close()
  }
})

// ---------------------------------------------------- main-process wiring

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// A key missing from this whitelist is not an error — the write is silently
// dropped and the setting simply never sticks, which is exactly how the W5
// surfaces were lost once already. Sliced to the real end of the Set rather
// than a fixed character count, so the assertion cannot drift out of range as
// the list grows.
test('videoUpscale is whitelisted for the renderer to write', () => {
  const start = MAIN.indexOf('const VIDEO_SETTING_KEYS = new Set([')
  assert.ok(start > 0, 'the whitelist still exists')
  const end = MAIN.indexOf('])', start)
  assert.ok(end > start, 'the whitelist is closed')
  assert.match(MAIN.slice(start, end), /'videoUpscale'/)
})

test('the stored default is off, so no upgrade silently changes the picture', () => {
  assert.match(MAIN, /videoUpscale: 'off',/)
})

test('a preset change is pushed to the mpv that is already playing', () => {
  assert.match(MAIN, /next\.videoUpscale !== current\.videoUpscale/)
  assert.match(MAIN, /videoEngine\(\)\.setUpscale\(next\.videoUpscale\)/)
})

// The debrid path plays an HTTP link and builds no TorrentStreamer at all, and
// that is the path most anime actually takes. If the live-apply were nested in
// the `if (streamer)` block above it, switching preset would appear to do
// nothing for exactly the sources the feature is aimed at.
test('the live apply is not nested inside the streamer-only block', () => {
  const set = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-settings-set'"))
  const body = set.slice(0, set.indexOf('\n})'))
  const streamerBlock = body.indexOf('const streamer = _videoSession.streamer')
  const closeOfStreamerBlock = body.indexOf('\n    }\n', streamerBlock)
  const apply = body.indexOf('setUpscale')
  assert.ok(streamerBlock > 0 && apply > 0, 'both blocks found')
  assert.ok(apply > closeOfStreamerBlock,
    'setUpscale must run after the streamer-only block closes')
})

test('the shaders are shipped in the packaged app', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('shaders/**'),
    'mpv is a separate process and cannot read shaders out of the asar')
})

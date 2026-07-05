'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('child_process')
const { spawn } = require('child_process')
const { MpvEngine } = require('../mpv-engine')

let hasMpv = true
try { execFileSync('mpv', ['--version'], { stdio: 'ignore' }) } catch { hasMpv = false }

// Generate a 2-second test tone wav with ffmpeg if available, else skip.
const fs = require('fs')
const os = require('os')
const path = require('path')
function makeTone(file, seconds) {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    `sine=frequency=440:duration=${seconds}`, file], { stdio: 'ignore' })
}
let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

test('real mpv: load/play/seek/eof and gapless enqueue', { skip: !hasMpv || !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-int-'))
  const a = path.join(dir, 'a.wav'); const b = path.join(dir, 'b.wav')
  makeTone(a, 2); makeTone(b, 2)

  // --ao=null → no sound card needed
  const eng = new MpvEngine({
    spawnFn: (bin, args, o) => spawn(bin, [...args, '--ao=null'], o),
  })
  try {
    await eng.start()

    const gotDuration = new Promise(r => eng.once('duration', r))
    await eng.load(a)
    assert.ok(Math.abs(await gotDuration - 2) < 0.5, 'duration ~2s')

    await eng.setNext(b)
    const adv = new Promise(r => eng.once('autoAdvanced', r))
    await eng.seek(1.8)
    assert.strictEqual(await adv, b, 'gapless auto-advance to b')

    const ended = new Promise(r => eng.once('ended', r))
    await eng.seek(1.8)
    await ended
  } finally {
    eng.stop()
  }
})

test('real mpv: survives kill -9 via respawn', { skip: !hasMpv || !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-int2-'))
  const a = path.join(dir, 'a.wav'); makeTone(a, 30)
  const eng = new MpvEngine({
    spawnFn: (bin, args, o) => spawn(bin, [...args, '--ao=null'], o),
  })
  try {
    await eng.start()
    await eng.load(a)
    const down = new Promise(r => eng.once('engineDown', r))
    const ready = new Promise(r => eng.once('ready', r))
    process.kill(eng.proc.pid, 'SIGKILL')
    await down
    await ready
    assert.strictEqual(eng.getState().path, a, 'track reloaded after respawn')
  } finally {
    eng.stop()
  }
})

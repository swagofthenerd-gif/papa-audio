const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('slsk-verify-rip exists, is exposed, and cleans up on every exit', () => {
  assert.ok(MAIN.includes("ipcMain.handle('slsk-verify-rip'"))
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(pre.includes("'slsk-verify-rip'"))
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('slsk-verify-rip'"), MAIN.indexOf("ipcMain.handle('slsk-verify-rip'") + 6000)
  assert.ok(body.includes('finally {'), 'cleanup runs in finally')
  assert.ok(body.includes('_ripCleanup('), 'cleanup helper is called')
})

test('slsk-verify-rip refuses to download in dry-run mode', () => {
  const body = MAIN.slice(MAIN.indexOf("ipcMain.handle('slsk-verify-rip'"), MAIN.indexOf("ipcMain.handle('slsk-verify-rip'") + 6000)
  const guard = body.indexOf('if (DRY_RUN) return _dryRunRefusal')
  const call = body.indexOf('slskdFetch(')
  assert.ok(guard > 0 && guard < call, 'the dry-run refusal comes before the download request')
})

test('the ceiling probe builds one highpass+volumedetect pass per band', () => {
  const args = require('../src/rip-check').ceilingArgs('/x/a.flac', 20000)
  assert.deepEqual(args.slice(0, 2), ['-hide_banner', '-nostats'])
  assert.ok(args.join(' ').includes('highpass=f=20000'))
  assert.ok(args.join(' ').includes('volumedetect'))
})

test('astatsArgs and probeArgs name the file and ask for the fields the parsers read', () => {
  const R = require('../src/rip-check')
  assert.ok(R.astatsArgs('/x/a.flac').includes('/x/a.flac'))
  assert.ok(R.astatsArgs('/x/a.flac').join(' ').includes('astats'))
  const p = R.probeArgs('/x/a.flac')
  assert.ok(p.includes('/x/a.flac'))
  assert.ok(p.join(' ').includes('sample_rate'))
  assert.ok(p.join(' ').includes('bits_per_raw_sample'))
})

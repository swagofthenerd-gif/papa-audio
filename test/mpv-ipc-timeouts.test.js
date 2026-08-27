'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { MpvIpcClient, TIMEOUTS, MAX_BUFFER_BYTES } = require('../mpv-ipc')

// A server that can be told to swallow specific commands, or answer them late.
function server(opts = {}) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papa-ipc-')), 'mpv.sock')
  const seen = []
  const conns = []
  const cfg = { ...opts, swallow: new Set(opts.swallow || []), lateMs: opts.lateMs || 0 }
  const srv = net.createServer(c => {
    conns.push(c)
    let buf = ''
    c.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        seen.push(msg.command)
        const reply = () => {
          try { c.write(JSON.stringify({ error: 'success', data: null, request_id: msg.request_id }) + '\n') } catch (_) {}
        }
        // First N occurrences of a swallowed command get no reply at all.
        if (cfg.swallow.has(msg.command[0])) {
          const count = seen.filter(x => x[0] === msg.command[0]).length
          if (count <= (cfg.swallowTimes ?? 1)) {
            if (cfg.lateMs) setTimeout(reply, cfg.lateMs).unref?.()
            continue
          }
        }
        reply()
      }
    })
  })
  return new Promise(res => srv.listen(sock, () => res({
    sock, seen,
    raw: text => conns.forEach(c => c.write(text)),
    close: () => { conns.forEach(c => c.destroy()); srv.close() },
  })))
}

async function client(s, timeouts) {
  const c = new MpvIpcClient(s.sock, timeouts ? { timeouts } : undefined)
  await c.connect()
  return c
}

// ── Item 4: per-operation budgets ────────────────────────────────────────────

test('loadfile gets a far longer budget than get_property', () => {
  // One 2 s budget for everything rejected a legitimate loadfile of a large
  // 5.1 FLAC on a cold cache, and waited 2 s to decide a wedged mpv was wedged.
  assert.ok(TIMEOUTS.loadfile >= 15000, 'a big FLAC on a cold cache needs room')
  assert.ok(TIMEOUTS.get_property <= 2000, 'a slow property read means mpv is wedged, not busy')
  assert.ok(TIMEOUTS.loadfile > TIMEOUTS.get_property * 5)
})

test('a timeout says which command and how long it waited', async () => {
  const s = await server({ swallow: ['get_property'], swallowTimes: 99 })
  const c = await client(s, { get_property: 40 })
  await assert.rejects(() => c.command('get_property', 'pause'), e => {
    assert.strictEqual(e.code, 'MPV_TIMEOUT')
    assert.match(e.message, /timeout after 40ms/)
    assert.match(e.message, /get_property/)
    return true
  })
  c.close(); s.close()
})

test('an idempotent command retries once before giving up', async () => {
  // The first get_property is swallowed; the retry is answered.
  const s = await server({ swallow: ['get_property'], swallowTimes: 1 })
  const c = await client(s, { get_property: 40 })
  const retries = []
  c.on('retry', d => retries.push(d))
  const v = await c.command('get_property', 'pause')
  assert.strictEqual(v, null)
  assert.strictEqual(retries.length, 1)
  assert.strictEqual(s.seen.filter(x => x[0] === 'get_property').length, 2)
  c.close(); s.close()
})

test('a retried command that fails twice rejects rather than retrying forever', async () => {
  const s = await server({ swallow: ['get_property'], swallowTimes: 99 })
  const c = await client(s, { get_property: 30 })
  await assert.rejects(() => c.command('get_property', 'pause'), e => e.code === 'MPV_TIMEOUT')
  assert.strictEqual(s.seen.filter(x => x[0] === 'get_property').length, 2, 'exactly one retry')
  c.close(); s.close()
})

test('loadfile is NOT retried, because a second one restarts the track', async () => {
  const s = await server({ swallow: ['loadfile'], swallowTimes: 99 })
  const c = await client(s, { loadfile: 40 })
  await assert.rejects(() => c.command('loadfile', '/music/a.flac', 'replace'), e => e.code === 'MPV_TIMEOUT')
  assert.strictEqual(s.seen.filter(x => x[0] === 'loadfile').length, 1,
    'a late reply plus a retry would double-apply something audible')
  c.close(); s.close()
})

// ── Item 24: a late reply is evidence, not noise ─────────────────────────────

test('a reply that arrives after the timeout is reported, not silently dropped', async () => {
  // mpv was slow, not broken. The command DID run, so the app's idea of state
  // is wrong — a slow loadfile looked like a failure while mpv was playing.
  const s = await server({ swallow: ['loadfile'], swallowTimes: 99, lateMs: 80 })
  const c = await client(s, { loadfile: 30 })
  const late = new Promise(r => c.once('lateReply', r))
  await assert.rejects(() => c.command('loadfile', '/music/a.flac', 'replace'))
  const d = await late
  assert.deepStrictEqual(d.args, ['loadfile', '/music/a.flac', 'replace'])
  assert.strictEqual(d.ok, true)
  assert.ok(d.afterMs >= 30)
  c.close(); s.close()
})

// ── Item 25: the read buffer is bounded ──────────────────────────────────────

test('a line with no newline cannot grow the buffer without limit', async () => {
  const s = await server()
  const c = await client(s)
  const overflowed = new Promise(r => c.once('overflow', r))
  // No newline anywhere: the old code accumulated this forever.
  s.raw('x'.repeat(MAX_BUFFER_BYTES + 1024))
  const d = await overflowed
  assert.ok(d.dropped > MAX_BUFFER_BYTES)
  assert.strictEqual(c.buffer, '', 'the buffer must be dropped, not kept')
  // And it resyncs: a well-formed message after the garbage still works.
  const v = await c.command('get_property', 'pause')
  assert.strictEqual(v, null)
  c.close(); s.close()
})

// ── Item 23: connect says why it failed ──────────────────────────────────────

test('a connect that never succeeds reports the underlying error', async () => {
  const missing = path.join(os.tmpdir(), 'papa-does-not-exist', 'mpv.sock')
  const c = new MpvIpcClient(missing)
  await assert.rejects(() => c.connect(120), e => {
    assert.match(e.message, /mpv socket not ready/)
    // ENOENT (mpv never made it) and ECONNREFUSED (nothing listening) are
    // completely different faults, and the old message told you neither.
    assert.match(e.message, /last error: ENOENT/)
    return true
  })
})

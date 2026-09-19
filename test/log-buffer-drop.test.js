'use strict'
// The log buffer's cap is documented "past this the oldest are dropped" and did
// the opposite: on a full buffer it incremented the counter and RETURNED,
// discarding the line it had just been handed. So once the buffer filled, the
// log stopped recording — and a buffer fills exactly when something is going
// wrong, which is the stretch worth having.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function liftQueueLog(cap) {
  const start = MAIN.indexOf('function _queueLog(level, args) {')
  assert.ok(start > 0)
  const end = MAIN.indexOf('\n}\n', start)
  const ctx = {
    LOG_MAX_BUFFER: cap,
    LOG_LEVELS: { debug: 10, info: 20, warn: 30, error: 40 },
    LOG_MIN_LEVEL: 0,
    SESSION_ID: 'test',
    _logBuf: [],
    _logDropped: 0,
    _logTimer: null,
    _flushLog() {},
    LOG_FLUSH_MS: 1000,
    _redact: { redactText: t => t },
    Date, JSON, String,
    setTimeout: () => ({ unref() {} }),
    console: { log() {}, error() {} },
  }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(start, end + 2), ctx)
  return {
    log: vm.runInContext('_queueLog', ctx),
    read: () => vm.runInContext('({ buf: _logBuf.slice(), dropped: _logDropped })', ctx),
  }
}

test('a full buffer keeps the newest lines, not the oldest', () => {
  const q = liftQueueLog(10)
  for (let i = 0; i < 25; i++) q.log('info', ['line ' + i])
  const { buf, dropped } = q.read()
  assert.strictEqual(buf.length, 10, 'the cap still holds')
  assert.match(buf[buf.length - 1], /line 24/,
    'the most recent line — the one nearest whatever went wrong — must survive')
  assert.match(buf[0], /line 15/, 'and the window is the newest ten')
  assert.strictEqual(dropped, 15, 'the loss is still counted')
})

test('an unfilled buffer loses nothing', () => {
  const q = liftQueueLog(10)
  for (let i = 0; i < 5; i++) q.log('info', ['line ' + i])
  const { buf, dropped } = q.read()
  assert.strictEqual(buf.length, 5)
  assert.strictEqual(dropped, 0)
})

test('the comment on the cap matches what it does', () => {
  const at = MAIN.indexOf('const LOG_MAX_BUFFER')
  assert.match(MAIN.slice(at, MAIN.indexOf('\n', at)), /oldest are dropped/)
})

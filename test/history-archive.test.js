'use strict'
// History that falls past the cap must reach the archive file or come back.
//
// The old inline version was fire-and-forget while the truncation committed
// immediately, so a failed write lost the entries from both places — and the
// catch logged "entries kept in memory only", which was the one thing that was
// definitely untrue. It also did an unlocked read-modify-write per month file,
// so two overlapping calls discarded one another's entries.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createHistoryArchive } = require('../src/history-archive')
const history = require('../history.js')

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'papa-hist-')) }

function entriesIn(month) {
  // Two entries in a known month, in the shape the real grouper expects.
  const ts = Date.UTC(2026, month - 1, 5, 12, 0, 0)
  return [
    { filePath: '/m/a.flac', ts },
    { filePath: '/m/b.flac', ts: ts + 1000 },
  ]
}

test('overflow actually reaches the month file', async () => {
  const dir = tmpdir()
  const a = createHistoryArchive({ fs, path, dir, groupForArchive: history.groupForArchive })
  const res = await a.archive(entriesIn(3))
  assert.strictEqual(res.written, 2)
  const written = JSON.parse(fs.readFileSync(path.join(dir, res.months[0] + '.json'), 'utf8'))
  assert.strictEqual(written.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a failing write REJECTS, so the caller can put the entries back', async () => {
  // This is the whole point. The old version swallowed it and the entries were
  // gone from the live list as well.
  const dir = tmpdir()
  const badFs = {
    promises: {
      mkdir: fs.promises.mkdir,
      readFile: fs.promises.readFile,
      writeFile: () => Promise.reject(new Error('ENOSPC')),
      rename: fs.promises.rename,
    },
  }
  const a = createHistoryArchive({ fs: badFs, path, dir, groupForArchive: history.groupForArchive })
  await assert.rejects(() => a.archive(entriesIn(4)), /ENOSPC/,
    'a failure the caller cannot see is a failure that loses data')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('one failure does not wedge every later archive', async () => {
  const dir = tmpdir()
  let fail = true
  const flakyFs = {
    promises: {
      mkdir: fs.promises.mkdir,
      readFile: fs.promises.readFile,
      writeFile: (...args) => (fail ? Promise.reject(new Error('EIO')) : fs.promises.writeFile(...args)),
      rename: fs.promises.rename,
    },
  }
  const a = createHistoryArchive({ fs: flakyFs, path, dir, groupForArchive: history.groupForArchive })
  await assert.rejects(() => a.archive(entriesIn(5)))
  fail = false
  const res = await a.archive(entriesIn(6))
  assert.strictEqual(res.written, 2, 'the chain must survive a rejection')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('two overlapping archives of the same month keep BOTH sets', async () => {
  // The unlocked read-modify-write: both calls read the same `existing`, and
  // the second rename discarded the first one's entries.
  const dir = tmpdir()
  const a = createHistoryArchive({ fs, path, dir, groupForArchive: history.groupForArchive })
  const first = entriesIn(7)
  const second = entriesIn(7).map(e => ({ ...e, filePath: e.filePath + '.2', ts: e.ts + 5000 }))
  const [r1] = await Promise.all([a.archive(first), a.archive(second)])
  const file = path.join(dir, r1.months[0] + '.json')
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.strictEqual(written.length, 4,
    'both bursts must survive; an unlocked read-modify-write keeps only one')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an empty overflow is a no-op, not a file', async () => {
  const dir = tmpdir()
  const a = createHistoryArchive({ fs, path, dir, groupForArchive: history.groupForArchive })
  const res = await a.archive([])
  assert.strictEqual(res.written, 0)
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing to archive means nothing written')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('existing entries in the month file are preserved, not replaced', async () => {
  const dir = tmpdir()
  const a = createHistoryArchive({ fs, path, dir, groupForArchive: history.groupForArchive })
  const r1 = await a.archive(entriesIn(8))
  const r2 = await a.archive(entriesIn(8).map(e => ({ ...e, filePath: e.filePath + '.later' })))
  const written = JSON.parse(fs.readFileSync(path.join(dir, r2.months[0] + '.json'), 'utf8'))
  assert.strictEqual(written.length, 4)
  assert.strictEqual(r1.months[0], r2.months[0])
  fs.rmSync(dir, { recursive: true, force: true })
})

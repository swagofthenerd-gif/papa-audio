'use strict'
// What the shop says when a library will not load.
//
// Two live faults. A 500 from slskd fell through every branch and printed the
// raw "slskd 500 on GET /users/X/browse" after 10.8 seconds, with no Retry. And
// an offline FRIEND got the 404 wording — "slskd has no record of X" — because
// the branch that knows how to say "X is offline" could never run: the lookup
// feeding it called window.api.slskUserStatus, and preload only ever bridged
// the plural slskUserStatuses, so `online` was permanently null.
//
// So this covers both halves: the wording per branch, and the bridge that makes
// the offline branch reachable at all.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const P = require('../src/slsk-presence')

const UI = require('../src/slsk-shop-ui')
const text = (err, online) => UI.browseFailureText('sherrybaaz', err, online)

// ── Per branch ───────────────────────────────────────────────────────────────
test('a 5xx says slskd failed and invites a retry', () => {
  for (const e of ['slskd 500 on GET /users/sherrybaaz/browse',
    'slskd 502 on GET /users/x/browse', 'slskd 503 on GET /users/x/browse']) {
    assert.strictEqual(text(e, null), 'slskd could not fetch this library — try again.')
    assert.strictEqual(UI.browseFailureRetryable(e, null), true)
  }
})

test('an offline peer is told they are offline, ahead of any status code', () => {
  // The same 404 the peer's absence produces — with `online: false` known, the
  // sentence is about the person, not about slskd's bookkeeping.
  const msg = text('slskd 404 on GET /users/sherrybaaz/browse', false)
  assert.match(msg, /sherrybaaz is offline/)
  assert.doesNotMatch(msg, /404|no record/)
  assert.strictEqual(UI.browseFailureRetryable('slskd 404 on …', false), false,
    'Retry on an offline peer just fails again')
})

test('unknown presence is not offline', () => {
  // null means the lookup could not answer. Saying "offline" there is a guess
  // dressed as a fact.
  const msg = text('slskd 404 on GET /users/sherrybaaz/browse', null)
  assert.doesNotMatch(msg, /is offline/)
  assert.match(msg, /no record of sherrybaaz/)
})

test('online peers still get the underlying reason', () => {
  assert.match(text('slskd 500 on GET /x', true), /slskd could not fetch/)
  assert.match(text('Browse timed out', true), /did not answer in time/)
})

test('the other branches are unchanged', () => {
  assert.match(text('slskd 401 on GET /x', null), /rejected our login/)
  assert.match(text('fetch failed', null), /Could not reach the slskd daemon/)
  assert.match(text('', null), /unknown error/)
  assert.strictEqual(UI.browseFailureRetryable('slskd 401 on GET /x', null), false)
  assert.strictEqual(UI.browseFailureRetryable('fetch failed', null), true)
})

// ── The bridge that makes the offline branch reachable ───────────────────────
test('preload actually exposes slskUserStatus', () => {
  // The whole defect was that it did not. A substring search finds the plural
  // and reads as a pass, so anchor on the key itself.
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.match(src, /^\s*slskUserStatus\s*:/m,
    'window.api.slskUserStatus is unbridged again; the offline branch is dead code')
})

test('the shop reads the presence snapshot the same way the bridge does', () => {
  // onlineOf is the shared rule: Online and Away are reachable, Offline is not,
  // and anything else — including a peer nobody has looked up — is unknown.
  const snap = [
    { username: 'sherrybaaz', presence: 'Offline' },
    { username: 'awayfriend', presence: 'Away' },
    { username: 'onfriend', presence: 'Online' },
    { username: 'lostfriend', presence: 'Unknown' },
  ]
  assert.strictEqual(P.onlineOf(snap, 'sherrybaaz'), false)
  assert.strictEqual(P.onlineOf(snap, 'SHERRYBAAZ'), false, 'usernames match loosely')
  assert.strictEqual(P.onlineOf(snap, 'awayfriend'), true)
  assert.strictEqual(P.onlineOf(snap, 'onfriend'), true)
  assert.strictEqual(P.onlineOf(snap, 'lostfriend'), null)
  assert.strictEqual(P.onlineOf(snap, 'nobody'), null)
  assert.strictEqual(P.onlineOf(null, 'sherrybaaz'), null)

  // End to end: an offline friend in the snapshot reaches the offline sentence.
  assert.match(
    text('slskd 404 on GET /users/sherrybaaz/browse', P.onlineOf(snap, 'sherrybaaz')),
    /sherrybaaz is offline/)
  // And an unknown one does not.
  assert.doesNotMatch(
    UI.browseFailureText('lostfriend', 'slskd 404 on GET /x', P.onlineOf(snap, 'lostfriend')),
    /is offline/)
})

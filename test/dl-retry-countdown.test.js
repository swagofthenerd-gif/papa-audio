'use strict'
// The Downloads page counted down to a retry that was not going to happen then,
// and pinned the attempt counter at "4/4" while the app was still working.
//
// Two separate lies, both from the same place:
//
//  1. The real gate on re-asking a peer doubles with every attempt already
//     spent — 60s, 2m, 4m, 8m, up to half an hour. The countdown shown to him
//     used the flat 60s base instead, even though its own comment claimed to
//     mirror the gate. So the number ran to zero, nothing happened, and it
//     started again: the app looked broken while behaving correctly.
//
//  2. The row showed "attempt X/4". The 4 is the cap on how many DIFFERENT
//     peers a file may be tried against; X is the total number of dispatches,
//     which is allowed to run to 24 because re-asking one peer does not use up
//     a source. Two different things either side of the slash, so the display
//     stuck at 4/4 and read as "given up".
//
// And it said "Retrying via another source" for a file that has exactly one
// source, which is not another anything.
//
// The countdown is checked against the scheduler's real dispatcher rather than
// against a copy of the formula: the number is right only if the retry actually
// becomes possible when it reaches zero.

const test = require('node:test')
const assert = require('node:assert')

const sched = require('../src/download-scheduler.js')
const dlExplain = require('../src/dl-explain.js')

const MINUTE = 60 * 1000
const FILE = '/dl/Wish You Were Here/02 - Have a Cigar.flac'

// A pending file whose only peer has already been tried `attempts` times, the
// last of them `sinceLastTry` ago. This is the state the countdown is for.
function waitingOnOnePeer({ attempts, sinceLastTry, now, sources }) {
	const peers = sources || ['onlypeer']
	const triedAt = {}
	for (const p of peers) triedAt[p] = now - sinceLastTry
	const state = sched.createState()
	state.pending.push({
		key: FILE,
		filename: FILE,
		size: 30000000,
		addedAt: now - 10 * MINUTE,
		attempts,
		tried: peers.slice(),
		triedAt,
		sources: peers.map(u => ({ username: u, filename: FILE, size: 30000000, queueLength: 0, uploadSpeed: 100 })),
	})
	return state
}

function countdown(state, now) {
	return sched.explainState(state, {}, now)[FILE].nextRetryInMs
}

function dispatches(state, now) {
	return sched.planDispatch(state, {}, now).length
}

test('the countdown reaches zero exactly when the retry becomes possible', () => {
	// Four dispatches already spent against the one peer: the real gate is
	// 60s doubled three times = 8 minutes, not the 60s that used to be shown.
	for (const attempts of [1, 2, 3, 4, 5]) {
		const now = 1700000000000
		const state = waitingOnOnePeer({ attempts, sinceLastTry: 1000, now })
		const ms = countdown(state, now)
		assert.ok(ms != null && ms > 0, 'a waiting file must carry a countdown (attempts=' + attempts + ')')

		assert.strictEqual(dispatches(state, now + ms - 1), 0,
			'one millisecond early the scheduler still will not re-ask (attempts=' + attempts + ')')
		assert.strictEqual(dispatches(state, now + ms), 1,
			'and at zero it does — the number on screen must mean this (attempts=' + attempts + ')')
	}
})

test('the countdown grows with each attempt, the way the real backoff does', () => {
	const now = 1700000000000
	const seen = [1, 2, 3, 4].map(attempts =>
		countdown(waitingOnOnePeer({ attempts, sinceLastTry: 0, now }), now))

	assert.deepStrictEqual(seen, [1 * MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE],
		'this used to read 60s, 60s, 60s, 60s — up to sixteen times too soon')
})

test('the countdown is capped where the backoff is capped', () => {
	const now = 1700000000000
	const ms = countdown(waitingOnOnePeer({ attempts: 12, sinceLastTry: 0, now }), now)
	assert.strictEqual(ms, 30 * MINUTE, 'the backoff ceiling, not an ever-doubling fantasy')
})

test('a file with an untried source is not counting down at all', () => {
	const now = 1700000000000
	const state = waitingOnOnePeer({ attempts: 2, sinceLastTry: 0, now, sources: ['triedpeer'] })
	state.pending[0].sources.push({ username: 'freshpeer', filename: FILE, size: 30000000 })

	assert.strictEqual(countdown(state, now), null, 'it goes out on the next tick, it is not waiting')
	assert.strictEqual(dispatches(state, now), 1)
})

test('a file the scheduler has finished with shows no countdown', () => {
	const now = 1700000000000
	// Four distinct peers tried is the source cap: the scheduler will not dispatch
	// this file again at all, so counting down to a retry is a promise it cannot keep.
	const state = waitingOnOnePeer({
		attempts: 4, sinceLastTry: 0, now, sources: ['p1', 'p2', 'p3', 'p4'],
	})

	assert.strictEqual(dispatches(state, now + 60 * MINUTE), 0, 'no retry is coming')
	assert.strictEqual(countdown(state, now), null, 'so nothing may be counted down to')
})

test('a file out of total attempts shows no countdown either', () => {
	const now = 1700000000000
	const state = waitingOnOnePeer({ attempts: 24, sinceLastTry: 0, now })

	assert.strictEqual(dispatches(state, now + 60 * MINUTE), 0, 'the total-dispatch ceiling is reached')
	assert.strictEqual(countdown(state, now), null)
})

// ── what the row actually says ──────────────────────────────────────────────

const queuedFile = { state: 'Queued, Remotely', username: 'onlypeer', bytesTransferred: 0 }

test('the attempt counter counts the same thing on both sides of the slash', () => {
	const now = 1700000000000
	const state = waitingOnOnePeer({ attempts: 6, sinceLastTry: 0, now })
	const view = sched.explainState(state, {}, now)[FILE]

	const line = dlExplain.waitingReason(queuedFile, view, now)
	assert.match(line, /attempt 7\/24/,
		'seven dispatches of a possible twenty-four — it used to pin at "4/4" and read as given up')
	assert.doesNotMatch(line, /\/4\b/)
})

test('it does not offer "another source" when there is only the one', () => {
	const now = 1700000000000
	const state = waitingOnOnePeer({ attempts: 2, sinceLastTry: 0, now })
	const view = sched.explainState(state, {}, now)[FILE]

	const line = dlExplain.waitingReason(queuedFile, view, now)
	assert.doesNotMatch(line, /another source/, 'there is no other source to retry via')
	assert.match(line, /^Retrying in \d+s \(attempt \d+\/\d+\)$/)
})

test('it still says "another source" when there really is one', () => {
	const now = 1700000000000
	const state = waitingOnOnePeer({ attempts: 2, sinceLastTry: 0, now, sources: ['peerA', 'peerB'] })
	const view = sched.explainState(state, {}, now)[FILE]

	const line = dlExplain.waitingReason(queuedFile, view, now)
	assert.match(line, /Retrying via another source in \d+s/)
})

test('the countdown the row prints is the real wait, in seconds', () => {
	const now = 1700000000000
	const state = waitingOnOnePeer({ attempts: 3, sinceLastTry: 0, now })
	const view = sched.explainState(state, {}, now)[FILE]

	const line = dlExplain.waitingReason(queuedFile, view, now)
	assert.match(line, /in 240s/, 'four minutes at the third attempt, not sixty seconds')
})

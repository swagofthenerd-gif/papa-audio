'use strict'
// The console carried three of these on every session:
//
//   [papa][ipc] missed 3 event(s) on slsk-progress (expected 5, got 8)
//
// Nothing was missed. The shop, the downloads view and the album view each
// subscribe to slsk-progress when they open and unsubscribe when they close,
// so the channel routinely has a stretch with no listener at all. The
// per-channel counter survived that stretch and measured the first event after
// it against a sequence recorded before it -- reporting a deliberate
// unsubscription as data loss, which buries the gaps that are real.
//
// reportSeq and the subscribe/unsubscribe bookkeeping are lifted from
// preload.js and driven directly.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const P = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

// Everything from the counter maps down to the end of reportSeq.
const BLOCK = (() => {
	const start = P.indexOf('const _seqSeen = new Map()')
	assert.ok(start > -1)
	const at = P.indexOf('function reportSeq(channel, meta) {')
	assert.ok(at > -1)
	let i = P.indexOf('{', at) + 1
	let depth = 1
	while (depth > 0 && i < P.length) {
		const c = P[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return P.slice(start, i)
})()

function harness() {
	const said = []
	const env = { said }
	return new Function('env', `
		const { said } = env
		const console = { error(m) { said.push(String(m)) } }
		${BLOCK}
		return {
			said,
			subscribe: c => noteSubscribe(c),
			unsubscribe: (c, all) => noteUnsubscribe(c, all),
			deliver: (c, seq) => reportSeq(c, { seq }),
			gaps: () => _seqGaps.slice(),
		}
	`)(env)
}

test('a genuine gap while subscribed is still reported', () => {
	const h = harness()
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 1)
	h.deliver('slsk-progress', 2)
	h.deliver('slsk-progress', 6)
	assert.strictEqual(h.said.length, 1, JSON.stringify(h.said))
	assert.ok(/missed 3 event\(s\)/.test(h.said[0]), h.said[0])
})

test('events emitted while nothing was listening are not reported as missed', () => {
	const h = harness()
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 1)
	h.deliver('slsk-progress', 2)
	// The shop closes: the only listener goes.
	h.unsubscribe('slsk-progress')
	// Downloads keep running and main keeps stamping sequences 3..7.
	// The shop is reopened.
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 8)
	assert.deepStrictEqual(h.said, [], 'nothing was missed -- nobody had asked for those events')
	assert.deepStrictEqual(h.gaps(), [], 'and the diagnostics gap list must stay clean too')
})

test('after a resubscribe the channel is measured normally again', () => {
	const h = harness()
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 1)
	h.unsubscribe('slsk-progress')
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 8)   // re-baseline, silent
	h.deliver('slsk-progress', 12)  // a real gap, now that we are listening
	assert.strictEqual(h.said.length, 1, JSON.stringify(h.said))
	assert.ok(/expected 9, got 12/.test(h.said[0]), h.said[0])
})

test('a second subscriber does not re-baseline a live channel', () => {
	const h = harness()
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 1)
	h.subscribe('slsk-progress')   // the album view opens alongside the shop
	h.deliver('slsk-progress', 5)
	assert.strictEqual(h.said.length, 1, 'a real gap with listeners present must still be reported')
})

test('the channel must lose every listener before the next event re-baselines', () => {
	const h = harness()
	h.subscribe('slsk-progress')
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 1)
	h.unsubscribe('slsk-progress')   // one of two closes
	h.deliver('slsk-progress', 5)
	assert.strictEqual(h.said.length, 1, 'someone was still listening, so this really was missed')
})

test('removeAllListeners drops the count to zero in one go', () => {
	const h = harness()
	h.subscribe('slsk-progress')
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 1)
	h.unsubscribe('slsk-progress', true)
	h.subscribe('slsk-progress')
	h.deliver('slsk-progress', 9)
	assert.deepStrictEqual(h.said, [], JSON.stringify(h.said))
})

test('the same event delivered to two listeners is still not a gap', () => {
	const h = harness()
	h.subscribe('player-event')
	h.subscribe('player-event')
	h.deliver('player-event', 1)
	h.deliver('player-event', 1)
	h.deliver('player-event', 2)
	h.deliver('player-event', 2)
	assert.deepStrictEqual(h.said, [])
})

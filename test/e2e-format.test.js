'use strict'

// Unit tests for the PURE helpers in tools/e2e-smoke.js — arg-building and
// result formatting only. No app is launched here; the live launch is the job
// of `npm run e2e`, not the unit suite.

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const smoke = require(path.join(__dirname, '..', 'tools', 'e2e-smoke.js'))

test('buildElectronArgs: entry first, debug port + allow-origins + no-sandbox', () => {
	const args = smoke.buildElectronArgs(9333, '/repo')
	assert.strictEqual(args[0], '/repo', 'entry point must come first')
	assert.ok(args.includes('--remote-debugging-port=9333'), 'debug port flag present')
	assert.ok(args.includes('--remote-allow-origins=*'), 'allow-origins present for CDP WS attach')
	assert.ok(args.includes('--no-sandbox'), 'no-sandbox present')
})

test('buildElectronArgs: port is interpolated exactly', () => {
	const args = smoke.buildElectronArgs(41000, '.')
	assert.ok(args.includes('--remote-debugging-port=41000'))
	assert.ok(!args.includes('--remote-debugging-port=9333'))
})

test('buildChildEnv: forces PAPA_USER_DATA, keeps base env', () => {
	const base = { PATH: '/usr/bin', FOO: 'bar' }
	const env = smoke.buildChildEnv(base, '/tmp/papa-e2e-xyz')
	assert.strictEqual(env.PAPA_USER_DATA, '/tmp/papa-e2e-xyz', 'profile dir forced')
	assert.strictEqual(env.PAPA_E2E, '1', 'the smoke profile flags itself so maintenance schedulers no-op')
	assert.strictEqual(env.PATH, '/usr/bin', 'inherited PATH preserved')
	assert.strictEqual(env.FOO, 'bar', 'other inherited vars preserved')
})

test('buildChildEnv: does not mutate the base env object', () => {
	const base = { PATH: '/usr/bin' }
	smoke.buildChildEnv(base, '/tmp/x')
	assert.strictEqual(base.PAPA_USER_DATA, undefined, 'base env untouched')
})

test('formatResultLine: PASS on ok===true, FAIL otherwise', () => {
	assert.strictEqual(smoke.formatResultLine('home', true), '[PASS] home')
	assert.strictEqual(smoke.formatResultLine('home', false), '[FAIL] home')
	assert.strictEqual(smoke.formatResultLine('home', undefined), '[FAIL] home')
})

test('formatResultLine: appends detail in parens when present', () => {
	assert.strictEqual(
		smoke.formatResultLine('errors', false, 'boom'),
		'[FAIL] errors  (boom)',
	)
	assert.strictEqual(smoke.formatResultLine('errors', true, ''), '[PASS] errors')
})

test('exitCodeFor: 0 only when every check passed', () => {
	assert.strictEqual(smoke.exitCodeFor([{ ok: true }, { ok: true }]), 0)
	assert.strictEqual(smoke.exitCodeFor([{ ok: true }, { ok: false }]), 1)
	assert.strictEqual(smoke.exitCodeFor([]), 0, 'empty set is vacuously green')
	assert.strictEqual(smoke.exitCodeFor([{ ok: 'truthy-but-not-true' }]), 1, 'strict === true only')
})

test('isFatalConsoleEntry: fails on real error / exception, ignores log & warn', () => {
	assert.strictEqual(smoke.isFatalConsoleEntry({ type: 'error', text: 'ReferenceError: x' }), true)
	assert.strictEqual(smoke.isFatalConsoleEntry({ type: 'exception', text: 'TypeError: y' }), true)
	assert.strictEqual(smoke.isFatalConsoleEntry({ type: 'warning', text: 'deprecated' }), false)
	assert.strictEqual(smoke.isFatalConsoleEntry({ type: 'log', text: 'hi' }), false)
	assert.strictEqual(smoke.isFatalConsoleEntry(null), false)
	assert.strictEqual(smoke.isFatalConsoleEntry({}), false)
})

test('isFatalConsoleEntry: benign offline/no-key noise does not count as fatal', () => {
	assert.strictEqual(
		smoke.isFatalConsoleEntry({ type: 'error', text: 'GET https://x net::ERR_INTERNET_DISCONNECTED' }),
		false,
	)
	assert.strictEqual(
		smoke.isFatalConsoleEntry({ type: 'error', text: 'TMDB key missing' }),
		false,
	)
	assert.strictEqual(
		smoke.isFatalConsoleEntry({ type: 'error', text: 'connect ECONNREFUSED 127.0.0.1:5030' }),
		false,
	)
})

test('isBenignErrorText: matches known-noise substrings, rejects real bugs', () => {
	assert.strictEqual(smoke.isBenignErrorText('Failed to load resource'), true)
	assert.strictEqual(smoke.isBenignErrorText('net::ERR_NAME_NOT_RESOLVED'), true)
	assert.strictEqual(smoke.isBenignErrorText('Uncaught ReferenceError: navigate is not defined'), false)
	assert.strictEqual(smoke.isBenignErrorText(''), false)
})

test('BENIGN_ERROR_PATTERNS is a non-empty list of strings', () => {
	assert.ok(Array.isArray(smoke.BENIGN_ERROR_PATTERNS))
	assert.ok(smoke.BENIGN_ERROR_PATTERNS.length > 0)
	assert.ok(smoke.BENIGN_ERROR_PATTERNS.every(p => typeof p === 'string'))
})

test('pickPageTarget: returns first page target ws url, null when none', () => {
	const targets = [
		{ type: 'service_worker', webSocketDebuggerUrl: 'ws://sw' },
		{ type: 'page', webSocketDebuggerUrl: 'ws://page-1' },
		{ type: 'page', webSocketDebuggerUrl: 'ws://page-2' },
	]
	assert.strictEqual(smoke.pickPageTarget(targets), 'ws://page-1')
	assert.strictEqual(smoke.pickPageTarget([]), null)
	assert.strictEqual(smoke.pickPageTarget(null), null)
	assert.strictEqual(smoke.pickPageTarget([{ type: 'page' }]), null, 'page without ws url is skipped')
})

test('RUN_TIMEOUT_MS is the documented 90s cap', () => {
	assert.strictEqual(smoke.RUN_TIMEOUT_MS, 90000)
})

'use strict'
// The startup banner and the early-startup log buffer.
//
// The lead ran a dry-run twin and grepped both <profile>/logs/papa-*.log and
// stdout for "[papa] DRY RUN". Neither had it. Two separate faults:
//
//   1. The banner was printed at the top of main.js, hundreds of lines before
//      console.log is patched, so it only ever reached the real stdout.
//   2. _queueLog began with `if (!_logDir) return`, so nothing could be
//      buffered before the log directory was known — which made
//      installFileLogging's flush, commented "anything buffered before the
//      directory was known", a no-op over an always-empty buffer. Every line
//      written during early startup was discarded.
//
// These tests lift the real logging bootstrap out of main.js and run it in a vm
// with a temp directory, so they exercise the shipped code rather than a copy.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const MAIN_PATH = path.join(__dirname, '..', 'main.js')
const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')

// The logging bootstrap as one contiguous slice: the level constants, the
// buffer, _flushLog, _queueLog, installFileLogging, the console patch and the
// banner call. Taken as text so a change to any of it is a change to what these
// tests run.
function liftLoggingBootstrap({ dryRun, logLevel }) {
	const start = MAIN.indexOf('const LOG_LEVELS = {')
	assert.ok(start > -1, 'LOG_LEVELS not found in main.js')
	const endMark = '\n_emitStartupBanner()'
	const end = MAIN.indexOf(endMark, start)
	assert.ok(end > -1, '_emitStartupBanner() call not found after LOG_LEVELS')
	const src = MAIN.slice(start, end + endMark.length)

	const stdout = []
	const stderr = []
	const ctx = {
		fs,
		path,
		crypto: require('crypto'),
		require: id => (id === './src/redact' ? require('../src/redact') : require(id)),
		DRY_RUN: !!dryRun,
		process: {
			pid: 4242,
			env: logLevel ? { PAPA_LOG_LEVEL: logLevel } : {},
			stderr: { write: s => { stderr.push(s); return true } },
		},
		setTimeout: (fn, ms) => {
			const t = setTimeout(fn, ms)
			if (t.unref) t.unref()
			return t
		},
		clearTimeout,
		Date,
		JSON,
		String,
		Error,
		console: {
			// The ORIGINAL console the patch wraps: this is "stdout" for the test.
			log: (...a) => stdout.push(a.join(' ')),
			error: (...a) => stdout.push(a.join(' ')),
			warn: (...a) => stdout.push(a.join(' ')),
		},
	}
	vm.createContext(ctx)
	vm.runInContext(src, ctx)
	return { ctx, stdout, stderr }
}

function tmpLogDir(name) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-log-' + name + '-'))
	return d
}

function todaysLogFile(dir) {
	const d = new Date()
	const p = n => String(n).padStart(2, '0')
	return path.join(dir, `papa-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`)
}

// _flushLog appends through fs.promises; give it a moment to land.
async function settle() {
	for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 10))
}

test('a line logged before the log directory is known still reaches the daily log', async () => {
	const { ctx } = liftLoggingBootstrap({ dryRun: false })
	// The banner has already been logged by the lifted code, with no _logDir.
	ctx.console.log('[papa] an early line')
	const dir = tmpLogDir('early')
	try {
		assert.strictEqual(fs.existsSync(todaysLogFile(dir)), false, 'nothing written yet')

		ctx.installFileLogging(dir)
		await settle()

		const text = fs.readFileSync(todaysLogFile(dir), 'utf8')
		assert.match(text, /\[papa\] start pid=4242/,
			'the banner logged before the directory was known must be flushed once it is')
		assert.match(text, /\[papa\] an early line/)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('the first [papa] line carries dryRun, and the dry-run banner follows it', async () => {
	const { ctx, stdout, stderr } = liftLoggingBootstrap({ dryRun: true })
	const dir = tmpLogDir('dry')
	try {
		// stdout: the unpatched console the patch delegates to.
		assert.match(stdout[0], /^\[papa\] start pid=4242 session=[0-9a-f]+ dryRun=true$/)
		assert.ok(stdout.some(l => l.includes('[papa] DRY RUN: nothing will be downloaded')),
			'the dry-run banner must be printed: ' + stdout.join(' | '))

		// stderr: written directly, because nothing in main.js patches stderr —
		// this line survives even if the log file never happens.
		assert.ok(stderr.some(l => l.includes('dryRun=true')),
			'the first line must reach stderr: ' + stderr.join(' | '))
		assert.ok(stderr.some(l => l.includes('[papa] DRY RUN:')),
			'the dry-run banner must reach stderr: ' + stderr.join(' | '))

		// ...and the daily log, once the directory is known.
		ctx.installFileLogging(dir)
		await settle()
		const text = fs.readFileSync(todaysLogFile(dir), 'utf8')
		assert.match(text, /dryRun=true/)
		assert.match(text, /\[papa\] DRY RUN: nothing will be downloaded/)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('a non-dry run says dryRun=false and prints no dry-run banner', () => {
	const { stdout, stderr } = liftLoggingBootstrap({ dryRun: false })
	assert.match(stdout[0], /dryRun=false$/)
	assert.ok(!stdout.some(l => l.includes('[papa] DRY RUN:')))
	assert.ok(!stderr.some(l => l.includes('[papa] DRY RUN:')))
})

test('main.js does not patch process.stderr.write, so the banner cannot be captured by the logger', () => {
	// The banner is deliberately written straight to stderr. That is only worth
	// anything while stderr stays unpatched; if someone wraps it later this test
	// says so rather than the guarantee quietly evaporating.
	assert.ok(!/process\.stderr\.write\s*=/.test(MAIN),
		'something now reassigns process.stderr.write — the banner is no longer a raw stderr write')
})

test('the early buffer is bounded, so a run that never finds a log dir cannot grow forever', async () => {
	// Buffering before the directory is known is only safe because LOG_MAX_BUFFER
	// still applies. Proved through what actually lands: 2600 early lines must
	// flush as ~2000, with the drop counted, not as 2600.
	const { ctx } = liftLoggingBootstrap({ dryRun: false })
	for (let i = 0; i < 2600; i++) ctx.console.log('line ' + i)
	const dir = tmpLogDir('cap')
	try {
		ctx.installFileLogging(dir)
		await settle()
		const lines = fs.readFileSync(todaysLogFile(dir), 'utf8').split('\n').filter(Boolean)
		assert.ok(lines.length <= 2010, 'buffer grew past the cap: ' + lines.length)
		assert.ok(lines.some(l => /log lines dropped/.test(l)),
			'the drop must be recorded, not silent')
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

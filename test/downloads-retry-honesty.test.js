'use strict'
// Downloads → Failed → Retry: the row vanished, the view snapped to an empty
// Downloading tab, and nothing was said. Both IPC calls were `.catch(() => {})`
// and neither result was read, so a refusal looked exactly like a success.
// Remove had the same shape: "Removed from the download list" whatever came
// back, and the group Clear counted a resolved-but-refused cancel as cleared.
//
// The three handler bodies are lifted out of renderer.js and run here.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function braceBody(src, openIdx) {
	let depth = 1
	let i = openIdx + 1
	while (depth > 0 && i < src.length) {
		const c = src[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return src.slice(openIdx + 1, i - 1)
}

// The `_dlBtnAction(btn, async () => { ... })` body that follows `marker`.
// `from` disambiguates the several wirings that share a selector (the Done
// list and the Failed list each have their own Remove button, for instance).
function liftDlAction(marker, from) {
	const at = R.indexOf(marker, from || 0)
	assert.ok(at > -1, 'anchor must still exist: ' + marker)
	const act = R.indexOf('_dlBtnAction(btn, async () => {', at)
	assert.ok(act > -1 && act - at < 400, 'the action body must still follow ' + marker)
	return braceBody(R, R.indexOf('{', act + '_dlBtnAction(btn, async () => '.length))
}

// The Failed-tab wirings, which are the ones that sit under
// `_bindDlFailedBtns` — identified by the retry that calls slskDownload.
const FAILED_AT = R.indexOf("// Retry single file\n  container.querySelectorAll('.dl2-retry-btn')")
assert.ok(FAILED_AT > -1, 'the Failed-tab retry wiring must still exist')

const RETRY = liftDlAction("container.querySelectorAll('.dl2-retry-btn')", FAILED_AT)
const REMOVE_FAILED = liftDlAction("container.querySelectorAll('.dl2-remove-btn')", FAILED_AT)
const REMOVE_DONE = liftDlAction("container.querySelectorAll('.dl2-remove-btn')", 0)
const RETRY_GROUP = liftDlAction("container.querySelectorAll('.dl2-retry-group-btn')", 0)
const CLEAR_GROUP = (() => {
	const at = R.indexOf('var pairs = []')
	assert.ok(at > -1)
	const start = R.lastIndexOf('_dlBtnAction(btn, async () => {', at)
	return braceBody(R, R.indexOf('{', start + '_dlBtnAction(btn, async () => '.length))
})()

function run(body, { downloadRes, cancelRes }) {
	const log = []
	const env = {
		log,
		downloadRes, cancelRes,
	}
	return new Function('env', `
		const { log } = env
		let _dlTab = 'failed'
		let _dlLastSig = 'sig'
		const btn = { dataset: { user: 'AnYeluX', id: '7', filename: 'a.flac', size: '10',
			pairs: '[["AnYeluX","7"],["AnYeluX","8"]]',
			retry: '[{"username":"AnYeluX","id":"7"},{"username":"AnYeluX","id":"8"}]' } }
		const window = { api: {
			slskDownload() { log.push('download'); return Promise.resolve(env.downloadRes) },
			slskCancelTransfer() { log.push('cancel'); return Promise.resolve(env.cancelRes) },
			slskRetryTransfer() { log.push('retry'); return Promise.resolve(env.downloadRes) },
		} }
		const document = { querySelector() { return { dataset: { tab: 'active' } } } }
		function _setActiveTab() { log.push('switch-tab') }
		function _pollAndRenderDownloads() { log.push('repaint'); return Promise.resolve() }
		function showSnackbar(m) { log.push('say:' + String(m)) }
		function showToast(m) { log.push('say:' + String(m)) }
		return (async () => {${body}})().then(() => ({ tab: _dlTab }))
	`)(env).then(r => ({ log, tab: r.tab }))
}

test('a refused retry says so and leaves you on the Failed tab', async () => {
	const { log, tab } = await run(RETRY, {
		cancelRes: { ok: true },
		downloadRes: { ok: false, error: 'Dry run — starting a Soulseek download was not performed' },
	})
	assert.strictEqual(tab, 'failed', 'the view must not snap to an empty Downloading tab')
	assert.ok(!log.includes('switch-tab'), JSON.stringify(log))
	assert.ok(log.some(l => l === 'say:Dry run — starting a Soulseek download was not performed'),
		'the person must be told why the row did not come back: ' + JSON.stringify(log))
})

test('an accepted retry moves you to Downloading, as it always did', async () => {
	const { log, tab } = await run(RETRY, { cancelRes: { ok: true }, downloadRes: { ok: true } })
	assert.strictEqual(tab, 'active')
	assert.ok(log.includes('switch-tab'))
	assert.ok(!log.some(l => l.startsWith('say:')), JSON.stringify(log))
})

for (const [where, body] of [['Failed', REMOVE_FAILED], ['Done', REMOVE_DONE]]) {
	test(`a refused remove in the ${where} list does not claim the item was removed`, async () => {
		const { log } = await run(body, { cancelRes: { ok: false, error: 'Dry run — cancelling this download was not performed' } })
		assert.ok(!log.includes('say:Removed from the download list'), JSON.stringify(log))
		assert.ok(log.some(l => /^say:Dry run/.test(l)), JSON.stringify(log))
	})

	test(`an accepted remove in the ${where} list still reports the removal`, async () => {
		const { log } = await run(body, { cancelRes: { ok: true } })
		assert.ok(log.includes('say:Removed from the download list'), JSON.stringify(log))
	})
}

test('clearing a group counts a refused cancel as not cleared', async () => {
	const { log } = await run(CLEAR_GROUP, { cancelRes: { ok: false, error: 'nope' } })
	assert.ok(log.some(l => l === "say:2 of 2 couldn't be cleared"), JSON.stringify(log))
})

test('clearing a group that succeeded says nothing', async () => {
	const { log } = await run(CLEAR_GROUP, { cancelRes: { ok: true } })
	assert.ok(!log.some(l => l.startsWith('say:')), JSON.stringify(log))
})

test('retrying a whole stuck group does not say "Retrying 2 files" when both were refused', async () => {
	const { log } = await run(RETRY_GROUP, { downloadRes: { ok: false, error: 'Dry run — x' } })
	assert.ok(!log.some(l => /^say:Retrying/.test(l)), JSON.stringify(log))
	assert.ok(log.includes('say:Could not retry those files'), JSON.stringify(log))
})

test('retrying a whole stuck group counts only what was accepted', async () => {
	const { log } = await run(RETRY_GROUP, { downloadRes: { ok: true } })
	assert.ok(log.includes('say:Retrying 2 files…'), JSON.stringify(log))
})

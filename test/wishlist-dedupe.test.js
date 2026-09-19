'use strict'
// The wishlist is added to from five places and every one of them pushed
// without looking, so right-clicking the same album twice left two identical
// entries -- and the wishlist then ran the same search twice. "Run all now"
// under a refusal said the generic "Wishlist run failed" and threw away the
// sentence the handler had sent explaining why.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(decl) {
	const at = R.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist in renderer.js')
	let i = R.indexOf('{', at) + 1
	let depth = 1
	while (depth > 0 && i < R.length) {
		const c = R[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return R.slice(at, i)
}

const KEY = liftFn('function _wishlistKey(q) {')
const ADD = liftFn('function _wishlistAdd(query) {')
const RUN_ALL = liftFn('function _slskRunWishlistAll() {')

function makeAdd(initial) {
	const saved = []
	const env = { state: { downloadWishlist: initial ? initial.slice() : [] }, saved }
	const add = new Function('env', `
		const { state, saved } = env
		const window = { api: { saveDownloadWishlist(l) { saved.push(l.length) } } }
		${KEY}
		${ADD}
		return _wishlistAdd
	`)(env)
	return { add, state: env.state, saved }
}

test('wishlisting the same album twice leaves one entry', () => {
	const { add, state } = makeAdd()
	assert.strictEqual(add('Miles Davis Kind of Blue').added, true)
	assert.strictEqual(add('Miles Davis Kind of Blue').added, false)
	assert.strictEqual(state.downloadWishlist.length, 1)
})

test('the same album written differently is still the same album', () => {
	const { add, state } = makeAdd()
	add('Miles Davis — Kind of Blue')
	add('miles davis  kind of blue')
	add('MILES DAVIS: KIND OF BLUE!')
	assert.strictEqual(state.downloadWishlist.length, 1)
})

test('a different album is still added', () => {
	const { add, state } = makeAdd()
	add('Miles Davis Kind of Blue')
	add('John Coltrane A Love Supreme')
	assert.strictEqual(state.downloadWishlist.length, 2)
})

test('a duplicate is not written back to disk either', () => {
	const { add, saved } = makeAdd()
	add('Kind of Blue')
	add('kind of blue')
	assert.strictEqual(saved.length, 1, 'the second add must not re-save an unchanged list')
})

test('an empty query is not added at all', () => {
	const { add, state } = makeAdd()
	assert.strictEqual(add('   ').added, false)
	assert.strictEqual(state.downloadWishlist.length, 0)
})

test('a list already carrying the album refuses the add', () => {
	const { add, state } = makeAdd([{ query: 'Kind of Blue', addedAt: 1 }])
	assert.strictEqual(add('kind  of  blue').added, false)
	assert.strictEqual(state.downloadWishlist.length, 1)
})

// ── "Run all now" ──────────────────────────────────────────────────────────
function runAll(res, { thrown } = {}) {
	const said = []
	const env = { said, res, thrown }
	return new Function('env', `
		const { said } = env
		const state = { downloadWishlist: [{ query: 'Kind of Blue' }] }
		const btn = { disabled: false, textContent: 'Run all now' }
		const document = { getElementById() { return btn } }
		const window = { api: { slskWishlistRun() {
			return env.thrown ? Promise.reject(new Error(env.thrown)) : Promise.resolve(env.res)
		} } }
		function showSnackbar(m) { said.push(String(m)) }
		function _renderHubWishlist() {}
		function runSlskSearch() {}
		${RUN_ALL}
		_slskRunWishlistAll()
		return new Promise(r => setTimeout(r, 0))
	`)(env).then(() => said)
}

test('a refused wishlist run says why, not just "failed"', async () => {
	const said = await runAll({ ok: false, error: 'Dry run — running the wishlist was not performed' })
	assert.deepStrictEqual(said, ['Dry run — running the wishlist was not performed'])
})

test('a refusal with no message still falls back to something', async () => {
	assert.deepStrictEqual(await runAll({ ok: false }), ['Wishlist run failed'])
})

test('a thrown wishlist run surfaces the reason too', async () => {
	const said = await runAll(null, { thrown: 'slskd is not running' })
	assert.deepStrictEqual(said, ['slskd is not running'])
})

test('a successful run still reports its matches', async () => {
	const said = await runAll({ ok: true, results: [{ found: 2 }, { found: 1 }] })
	assert.deepStrictEqual(said, ['Wishlist run complete — 3 matches found'])
})

'use strict'
// A video handler must not report success when it failed.
//
// This is a POLICY test over main.js's source, not a behaviour test, and it is
// labelled as such deliberately — ipcMain handlers cannot be executed without
// Electron, and a test that pretended otherwise would be the fake-test problem
// this repo already has too much of. What it enforces is a codebase invariant,
// the same way test/main-guards.js enforces "every store key that is written is
// also read".
//
// The invariant matters because of what it cost. video-anime-episodes returned
// `{ ok: true, episodes: [] }` from its catch, so a failed fetch was
// indistinguishable from a show that genuinely has no episodes — and the
// renderer's `if (!eps.length) return` then bailed silently. Titles never
// arrived and nothing on screen explained it. That is the user's report that
// some tabs "dont even open the saved anime".

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// Handlers where an empty answer is a real answer, not a hidden failure.
// Each needs a reason, so adding to this list is a decision rather than a
// convenience.
const DEGRADES_ON_PURPOSE = {
  'video-thumb':
    'a missing thumbnail is not an error — the card shows its fallback art, and ' +
    'failing the call would make a cosmetic miss look like a broken title',
  'video-debrid-pick':
    'a failed instant-availability check must fall through to peers and keep ' +
    'playing; returning a failure here would stop the fallback and break playback',
}

// Every `catch` block in a handler, not just the last one. The bug this test
// was written for can hide in any of them: an inner catch that swallows a
// failed fetch and answers `{ ok: true, ... }` is exactly as dishonest as the
// outer one, and the old lastIndexOf-plus-250-characters check could not see
// it. Blocks are extracted by balanced braces, so a long catch is read whole
// instead of through a fixed window.
function catchBlocks(body) {
	const out = []
	const re = /\bcatch\b/g
	let m
	while ((m = re.exec(body))) {
		let i = body.indexOf('{', m.index)
		if (i < 0) continue
		let depth = 0
		let quote = null
		let end = -1
		for (let j = i; j < body.length; j++) {
			const ch = body[j]
			if (quote) {
				if (ch === '\\') { j++; continue }
				if (ch === quote) quote = null
				continue
			}
			if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
			if (ch === '{') depth++
			else if (ch === '}') { depth--; if (depth === 0) { end = j; break } }
		}
		if (end < 0) end = body.length
		out.push(body.slice(i, end + 1))
	}
	return out
}

function videoHandlers() {
  const out = []
  const re = /ipcMain\.handle\('(video-[^']+)'/g
  let m
  while ((m = re.exec(MAIN))) {
    const at = m.index
    const end = MAIN.indexOf('\n})', at)
    const raw = MAIN.slice(at, end === -1 ? at + 4000 : end)
    // Comments are stripped before any matching. A long explanatory comment
    // inside a catch pushed the actual `return` outside the inspection window
    // and failed this test for the wrong reason — and equally, a comment that
    // merely mentions ok:true must not read as code that returns it.
    out.push({ name: m[1], body: raw.replace(/^[ \t]*\/\/.*$/gm, '') })
  }
  return out
}

test('there are video handlers to check at all', () => {
  // A floor: if the regex ever stops matching, every assertion below passes
  // while measuring nothing.
  assert.ok(videoHandlers().length > 40, 'expected the video handlers, found ' + videoHandlers().length)
})

test('no video handler returns ok:true from any of its catches', () => {
  const liars = []
  let blocks = 0
  for (const { name, body } of videoHandlers()) {
    if (name in DEGRADES_ON_PURPOSE) continue
    for (const block of catchBlocks(body)) {
      blocks++
      // Only a RETURN of ok:true is a lie. Assigning ok:true to a variable the
      // handler later overwrites, or mentioning it, is not — the thing that
      // reaches the renderer is what is returned.
      if (/return\s*\{[^{}]*ok:\s*true/.test(block)) liars.push(name)
    }
  }
  assert.ok(blocks > 60, 'expected to inspect every catch, inspected ' + blocks)
  assert.deepStrictEqual([...new Set(liars)], [],
    'these answer "it worked" after it did not, which the UI cannot tell from ' +
    'an empty result:\n  ' + liars.join('\n  '))
})

test('the catch-block reader sees inner catches, not just the last one', () => {
  // A floor on the reader itself: without this, a broken extractor would make
  // the test above pass on nothing.
  const sample = "x\ntry { a() } catch (e) { if (1) { b() } return { ok: false } }\n" +
    'try { c() } catch (e2) { return { ok: true } }'
  const found = catchBlocks(sample)
  assert.strictEqual(found.length, 2, 'both catches are found')
  assert.match(found[0], /ok: false/)
  assert.ok(found[0].includes('b()'), 'a nested brace does not end the block early')
  assert.match(found[1], /ok: true/)
})

test('a handler that fails says so in a way the UI can act on', () => {
  // ok:false alone is easy to miss in a truthy check; `failed` and `error` give
  // the renderer something to say out loud.
  for (const name of ['video-anime-episodes', 'video-instant-list', 'video-cache-get']) {
    const h = videoHandlers().find(x => x.name === name)
    assert.ok(h, name + ' must still exist')
    const c = h.body.lastIndexOf('catch')
    const tail = h.body.slice(c, c + 400)
    assert.match(tail, /ok:\s*false/, name + ' must report failure')
    assert.match(tail, /failed:\s*true/, name + ' must be distinguishable from an empty result')
    assert.match(tail, /error:/, name + ' must carry the reason')
  }
})

// ── The hole this test had ──────────────────────────────────────────────────
// `video-search` passed every assertion above and was still the worst instance
// of the bug they exist to catch. Its catch was not a `catch` BLOCK — it was an
// inline `.catch` on a promise inside the handler, discarding the error and
// substituting an empty list, followed by a plain `ok: true` return. An empty
// catalogue answer and a dead catalogue then produced the same reply, and the
// renderer told the user to check the spelling of "Oppenheimer". A live audit
// hit that on five of twenty searches for famous films.
//
// What makes the pattern detectable is that the arrow takes NO argument and its
// body is a bare literal: there is nowhere for the reason to have gone. A catch
// with a body that records the failure — which is the fix — reads differently
// and is allowed.
//
// Note which arrow bodies count. `() => []`, `() => null`, `() => ({})` and
// `() => undefined` all SUBSTITUTE A VALUE that the handler then reads and
// reports on — that is the bug. A bare `() => {}` is an empty BLOCK: it returns
// nothing and the promise's result is discarded entirely, which is the
// fire-and-forget idiom used for side effects like `player.pause()`. Nothing is
// read out of those, so there is nothing for them to lie about, and the rule
// deliberately does not cover them.
const SWALLOW = /\.catch\(\s*\(\s*\)\s*=>\s*(\[\s*\]|null|undefined|\(\s*\{\s*\}\s*\))\s*\)/g

// Handlers where discarding the reason is the documented, intended behaviour.
// Same rule as DEGRADES_ON_PURPOSE: a reason, or it does not go in the list.
const SWALLOWS_ON_PURPOSE = {}

test('no video handler discards a failure and then reports success', () => {
  const liars = []
  for (const { name, body } of videoHandlers()) {
    if (name in DEGRADES_ON_PURPOSE || name in SWALLOWS_ON_PURPOSE) continue
    if (!new RegExp(SWALLOW.source).test(body)) continue
    // The swallow only matters if the handler goes on to call the whole thing a
    // success. A handler that swallows and then returns ok:false is already
    // telling the truth.
    if (!/ok:\s*true/.test(body)) continue
    // ...unless the answer carries a per-source verdict naming which lane is
    // missing. That is the fix, and it must not be flagged.
    if (!/sources[,:]/.test(body) || !/failed[,:]/.test(body)) liars.push(name)
  }
  assert.deepEqual([...new Set(liars)], [],
    'these throw a failure away and then answer "it worked", which is what made\n' +
    'a rate-limited catalogue look like a film that does not exist:\n  ' + liars.join('\n  '))
})

test('the swallow pattern matches what it is meant to match', () => {
  // A floor on the detector. Without this a typo in the regex would make the
  // test above pass on every file forever.
  const caught = [
    'x.search(q).catch(() => [])',
    'x.search(q).catch(()=>[])',
    'x.search(q).catch( () => null )',
    'x.search(q).catch(() => ({}))',
    'x.search(q).catch(() => undefined)',
  ]
  for (const src of caught) {
    assert.match(src, new RegExp(SWALLOW.source), src + ' should be flagged')
  }
  const allowed = [
    // The fix: the reason is recorded before the empty value is substituted.
    "x.search(q).catch(e => { _lost('tmdb', e); return [] })",
    // An argument at all means the error was at least looked at.
    'x.search(q).catch(e => [])',
    // Not a literal — a real fallback value.
    'x.search(q).catch(() => cached)',
    // An empty BLOCK, not an empty value: fire-and-forget on a side effect,
    // whose result nobody reads. `player.pause()` and `setUpscale()` are this.
    'player.pause().catch(() => {})',
  ]
  for (const src of allowed) {
    assert.doesNotMatch(src, new RegExp(SWALLOW.source), src + ' should not be flagged')
  }
})

test('the guard can still see a handler that swallows', () => {
  // The mutation check, kept in the file: a handler shaped the way video-search
  // used to be shaped must be flagged. Run against a synthetic body so the
  // check survives main.js being fixed.
  const bad = "ipcMain.handle('video-fake', async () => {\n" +
    '  const [a, b] = await Promise.all([\n' +
    '    tmdb().search(query).catch(() => []),\n' +
    '    _animeSearch(query).catch(() => []),\n' +
    '  ])\n' +
    '  return { ok: true, results: a.concat(b) }\n'
  assert.ok(new RegExp(SWALLOW.source).test(bad), 'the swallow is seen')
  assert.ok(/ok:\s*true/.test(bad), 'and the success claim is seen')
  assert.ok(!/sources[,:]/.test(bad), 'and there is no per-source verdict to excuse it')
})

test('every deliberate exception carries a stated reason', () => {
  // Stops the allowlist quietly becoming the place bugs go to hide.
  for (const [name, why] of Object.entries(SWALLOWS_ON_PURPOSE)) {
    assert.ok(videoHandlers().some(h => h.name === name),
      name + ' is exempted from the swallow check but no longer exists')
    assert.ok(why && why.length > 40, name + ' needs a real reason, not a placeholder')
  }
  for (const [name, why] of Object.entries(DEGRADES_ON_PURPOSE)) {
    assert.ok(videoHandlers().some(h => h.name === name),
      name + ' is exempted but no longer exists — remove it from the list')
    assert.ok(why && why.length > 40, name + ' needs a real reason, not a placeholder')
  }
})

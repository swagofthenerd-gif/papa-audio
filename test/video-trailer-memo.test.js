'use strict'
// Hovering the hero converted the same trailer over and over (audit N15: ten
// conversions of one URL in the log).
//
// Every hover that survived the dwell timer called videoTrailerUrl, which on
// main resolves the YouTube stream with yt-dlp and — when the direct format is
// gone — opens a paired converter session. Nothing cached the answer, and
// mouseleave only bumped the ticket the RESULT would have been painted under:
// the conversion itself carried on and was thrown away, and the next hover
// started another one.
//
// The memo is lifted from the shipped renderer and driven with a counting fake
// of window.api, so the "ten hovers, one conversion" claim is measured rather
// than asserted about the source text.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const RENDERER = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')

function liftBody(name) {
  const open = RENDERER.indexOf('function ' + name + '(')
  assert.ok(open > -1, name + ' must still exist in renderer.js')
  let depth = 0
  let i = RENDERER.indexOf('{', open)
  const start = i
  do {
    if (RENDERER[i] === '{') depth++
    else if (RENDERER[i] === '}') depth--
    i++
  } while (depth > 0 && i < RENDERER.length)
  return RENDERER.slice(start + 1, i - 1)
}

// The three pieces, evaluated together over one shared Map so they are the
// same memo the app uses.
function makeMemo(api) {
  const memo = new Map()
  const keyFn = new Function('p', liftBody('_trailerMemoKey'))
  // eslint-disable-next-line no-new-func
  const once = new Function('window', '_trailerUrlMemo', '_trailerMemoKey', 'p', liftBody('_trailerUrlOnce'))
  // eslint-disable-next-line no-new-func
  const forget = new Function('_trailerUrlMemo', '_trailerMemoKey', 'p', liftBody('_forgetTrailerUrl'))
  return {
    once: (p) => once({ api }, memo, keyFn, p),
    forget: (p) => forget(memo, keyFn, p),
    size: () => memo.size,
  }
}

// A converter that counts how many times it was asked, and can be made slow so
// the in-flight case is real rather than instantaneous.
function countingApi(answer, { delay = 0 } = {}) {
  const calls = []
  return {
    calls,
    videoTrailerUrl(p) {
      calls.push(p)
      const res = typeof answer === 'function' ? answer(p, calls.length) : answer
      return delay
        ? new Promise(r => setTimeout(() => r(res), delay))
        : Promise.resolve(res)
    },
  }
}

const INCEPTION = { type: 'movie', id: '27205' }

test('ten hovers over one hero convert it once', async () => {
  const api = countingApi({ ok: true, url: 'http://127.0.0.1:1/trailer.mp4' })
  const memo = makeMemo(api)
  const seen = []
  for (let i = 0; i < 10; i++) seen.push(await memo.once({ ...INCEPTION }))
  assert.strictEqual(api.calls.length, 1, 'one conversion, not ten')
  for (const r of seen) assert.strictEqual(r.url, 'http://127.0.0.1:1/trailer.mp4')
})

test('hovers that overlap share the one conversion in flight', async () => {
  // The real case: the pointer goes on, off and on again faster than yt-dlp
  // answers. All three hovers must ride the same request.
  const api = countingApi({ ok: true, url: 'u' }, { delay: 20 })
  const memo = makeMemo(api)
  const all = await Promise.all([memo.once({ ...INCEPTION }), memo.once({ ...INCEPTION }), memo.once({ ...INCEPTION })])
  assert.strictEqual(api.calls.length, 1)
  assert.deepStrictEqual(all.map(r => r.url), ['u', 'u', 'u'])
})

test('a different title is still its own conversion', async () => {
  const api = countingApi((p) => ({ ok: true, url: 'u-' + p.id }))
  const memo = makeMemo(api)
  await memo.once({ type: 'movie', id: '27205' })
  await memo.once({ type: 'tv', id: '1396' })
  await memo.once({ type: 'movie', id: '27205' })
  assert.strictEqual(api.calls.length, 2)
})

test('"this title has no trailer" is remembered too', async () => {
  // A real answer, and an expensive one to get — it costs the same TMDB lookup.
  const api = countingApi({ ok: true, url: null })
  const memo = makeMemo(api)
  for (let i = 0; i < 5; i++) assert.strictEqual((await memo.once({ ...INCEPTION })).url, null)
  assert.strictEqual(api.calls.length, 1)
})

test('a refusal is NOT remembered — the next hover tries again', async () => {
  const api = countingApi((p, n) => (n === 1 ? { ok: false, error: 'busy' } : { ok: true, url: 'u' }))
  const memo = makeMemo(api)
  assert.strictEqual((await memo.once({ ...INCEPTION })).ok, false)
  assert.strictEqual((await memo.once({ ...INCEPTION })).url, 'u', 'the retry gets a real answer')
  assert.strictEqual(api.calls.length, 2)
})

test('a thrown request is caught and not remembered', async () => {
  let n = 0
  const api = { calls: [], videoTrailerUrl(p) { api.calls.push(p); n++; return n === 1 ? Promise.reject(new Error('yt-dlp died')) : Promise.resolve({ ok: true, url: 'u' }) } }
  const memo = makeMemo(api)
  const first = await memo.once({ ...INCEPTION })
  assert.strictEqual(first.ok, false, 'a throw becomes an honest refusal, never an unhandled rejection')
  assert.strictEqual((await memo.once({ ...INCEPTION })).url, 'u')
})

test('a URL that will not play is forgotten, so the next hover re-resolves it', async () => {
  const api = countingApi((p, n) => ({ ok: true, url: 'u' + n }))
  const memo = makeMemo(api)
  assert.strictEqual((await memo.once({ ...INCEPTION })).url, 'u1')
  memo.forget({ ...INCEPTION })
  assert.strictEqual((await memo.once({ ...INCEPTION })).url, 'u2')
  assert.strictEqual(api.calls.length, 2)
})

// ── Wiring: nothing may go round the memo ─────────────────────────────────────

test('every trailer request in the renderer goes through the one door', () => {
  const direct = (RENDERER.match(/window\.api\.videoTrailerUrl\(/g) || []).length
  assert.strictEqual(direct, 1,
    'videoTrailerUrl must be called in exactly one place — _trailerUrlOnce — got ' + direct)
  const inMemo = liftBody('_trailerUrlOnce')
  assert.match(inMemo, /window\.api\.videoTrailerUrl\(p\)/, 'and that place is the memo')
  // The three surfaces that ask for a trailer.
  const through = (RENDERER.match(/_trailerUrlOnce\(/g) || []).length
  assert.ok(through >= 4, 'the hero, the hover cards and the detail page all use it, got ' + through)
})

test('the hero forgets a URL its <video> could not play', () => {
  const start = RENDERER.indexOf('async function _startHeroTrailer(')
  const body = RENDERER.slice(start, RENDERER.indexOf('function _stopVideoHero(', start))
  assert.match(body, /addEventListener\('error', function \(\) \{ _forgetTrailerUrl\(trailerFor\) \}/,
    'a load error must drop the memo entry')
  assert.match(body, /_forgetTrailerUrl\(trailerFor\)\n\s*if \(_heroTrailerTicket === ticket\) _stopHeroTrailer\(\)/,
    'and so must a rejected play()')
})

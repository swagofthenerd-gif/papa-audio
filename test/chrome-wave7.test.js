'use strict'
// Wave-7 app-chrome helpers, run the same way video-render.test.js runs the
// card builders: the renderer is one giant file that cannot be required outside
// Electron, so each pure function is lifted out by brace-matching and executed
// in a vm context with only the globals it needs. Covers toast eviction, the
// greeting, the changelog md→html escaper, and the Continue-Watching staleness
// logic — plus a few regex-wiring assertions over the source, because some of
// this feature is glue that has no return value to test.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
const KEYMAP = fs.readFileSync(path.join(__dirname, '..', 'src', 'video-keymap.js'), 'utf8')

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found in the renderer')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// A context carrying the app's esc() (the changelog helper leans on it) plus any
// helper functions asked for.
function sandbox(fns) {
  const ctx = {
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    console,
  }
  vm.createContext(ctx)
  for (const fn of fns) vm.runInContext(extract(fn), ctx)
  return ctx
}

// ── Toast stacking / eviction (App §82) ──────────────────────────────────────

test('toast eviction keeps at most the cap, dropping the oldest first', () => {
  const { _toastEvictCount } = sandbox(['_toastEvictCount'])
  // Room to spare: nothing evicted.
  assert.strictEqual(_toastEvictCount(0, 3), 0)
  assert.strictEqual(_toastEvictCount(1, 3), 0)
  assert.strictEqual(_toastEvictCount(2, 3), 0)
  // At the cap: one must go before appending the new one.
  assert.strictEqual(_toastEvictCount(3, 3), 1)
  // Over the cap (shouldn't happen, but the maths must not go negative or
  // under-evict): drop enough to leave cap-1 standing.
  assert.strictEqual(_toastEvictCount(5, 3), 3)
})

test('the eviction cap is clamped to at least one and never negative', () => {
  const { _toastEvictCount } = sandbox(['_toastEvictCount'])
  assert.strictEqual(_toastEvictCount(0, 0), 0)   // cap floored to 1
  assert.strictEqual(_toastEvictCount(2, 0), 2)   // with cap 1, keep 0 old, drop 2
  assert.strictEqual(_toastEvictCount(-4, 3), 0)  // garbage count clamps to 0
})

test('showToast and showActionToast both route through the stack', () => {
  // The API signatures survive: showToast(msg), showActionToast(msg,label,cb,ms).
  const show = extract('showToast')
  assert.match(show, /_pushToast\(msg, null\)/)
  const action = extract('showActionToast')
  assert.match(action, /function showActionToast\(msg, actionLabel, onAction, ms\)/)
  assert.match(action, /_pushToast\(msg,/)
  assert.match(action, /actionLabel: actionLabel/)
})

test('the toast text is set as textContent, never innerHTML', () => {
  // Track and show titles land in toasts; a title with markup must not run.
  const push = extract('_pushToast')
  assert.match(push, /span\.textContent =/)
  assert.ok(!/\.innerHTML\s*=/.test(push), 'a toast must never set innerHTML')
})

test('the aria-live toast stack exists and the old single toast is inert', () => {
  assert.match(HTML, /id="toast-stack"[^>]*aria-live="polite"/)
  assert.match(HTML, /role="status"/)
  // The legacy element is kept as an alias but hidden, so nothing renders twice.
  assert.match(HTML, /id="toast-notification"[^>]*hidden/)
})

// ── Greeting (App §100) ──────────────────────────────────────────────────────

test('the greeting is time-aware across the day boundaries', () => {
  const { _homeGreeting } = sandbox(['_homeGreeting'])
  assert.strictEqual(_homeGreeting(0, 'Shaharyar'), 'Good morning, Shaharyar')
  assert.strictEqual(_homeGreeting(11, 'Shaharyar'), 'Good morning, Shaharyar')
  assert.strictEqual(_homeGreeting(12, 'Shaharyar'), 'Good afternoon, Shaharyar')
  assert.strictEqual(_homeGreeting(17, 'Shaharyar'), 'Good afternoon, Shaharyar')
  assert.strictEqual(_homeGreeting(18, 'Shaharyar'), 'Good evening, Shaharyar')
  assert.strictEqual(_homeGreeting(23, 'Shaharyar'), 'Good evening, Shaharyar')
})

test('a blank name degrades to a bare greeting, no dangling comma', () => {
  const { _homeGreeting } = sandbox(['_homeGreeting'])
  assert.strictEqual(_homeGreeting(9, ''), 'Good morning')
  assert.strictEqual(_homeGreeting(9, '   '), 'Good morning')
  assert.strictEqual(_homeGreeting(9, null), 'Good morning')
})

test('a nonsense hour falls back to a neutral hello', () => {
  const { _homeGreeting } = sandbox(['_homeGreeting'])
  assert.strictEqual(_homeGreeting(NaN, 'Shaharyar'), 'Hello, Shaharyar')
  assert.strictEqual(_homeGreeting(undefined, 'Shaharyar'), 'Hello, Shaharyar')
})

test('renderHome asks for the greeting with the name (App §100)', () => {
  const home = extract('renderHome')
  assert.match(home, /_homeGreeting\(hour, 'Shaharyar'\)/)
})

// ── Changelog md → html (App §7) ─────────────────────────────────────────────

test('headings and bullets render; nothing else becomes markup', () => {
  const { _changelogToHtml } = sandbox(['_changelogToHtml'])
  const html = _changelogToHtml('# 1.0.0\n\n- Added toasts\n- Fixed greeting\n\nJust a line.')
  assert.match(html, /<h2 class="mcs-cl-h">1\.0\.0<\/h2>/)
  assert.match(html, /<ul class="mcs-cl-list">/)
  assert.match(html, /<li>Added toasts<\/li>/)
  assert.match(html, /<li>Fixed greeting<\/li>/)
  assert.match(html, /<p class="mcs-cl-p">Just a line\.<\/p>/)
})

test('heading depth maps # → h2, ## → h3, ### → h4', () => {
  const { _changelogToHtml } = sandbox(['_changelogToHtml'])
  const html = _changelogToHtml('# A\n## B\n### C')
  assert.match(html, /<h2 class="mcs-cl-h">A<\/h2>/)
  assert.match(html, /<h3 class="mcs-cl-h">B<\/h3>/)
  assert.match(html, /<h4 class="mcs-cl-h">C<\/h4>/)
})

test('EVERY line is html-escaped — a changelog is data, not markup', () => {
  const { _changelogToHtml } = sandbox(['_changelogToHtml'])
  // A script tag in a heading, a bullet and a paragraph — none may survive.
  const html = _changelogToHtml(
    '# <script>alert(1)</script>\n' +
    '- <img src=x onerror=alert(2)>\n' +
    '<b>plain</b> & "quoted"'
  )
  assert.ok(!/<script>/.test(html), 'script in heading escaped')
  assert.ok(!/<img /.test(html), 'img in bullet escaped')
  assert.ok(!/<b>plain<\/b>/.test(html), 'inline html in paragraph escaped')
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&amp; &quot;quoted&quot;/)
})

test('an empty or null changelog renders nothing rather than throwing', () => {
  const { _changelogToHtml } = sandbox(['_changelogToHtml'])
  assert.strictEqual(_changelogToHtml(''), '')
  assert.strictEqual(_changelogToHtml(null), '')
  assert.strictEqual(_changelogToHtml(undefined), '')
})

test('a bullet list is closed before a following paragraph or heading', () => {
  const { _changelogToHtml } = sandbox(['_changelogToHtml'])
  const html = _changelogToHtml('- one\n- two\nafter\n# H')
  // Exactly one <ul> opened and one </ul> closed — no dangling list.
  assert.strictEqual((html.match(/<ul/g) || []).length, 1)
  assert.strictEqual((html.match(/<\/ul>/g) || []).length, 1)
  // The list closes before the paragraph and the heading.
  assert.ok(html.indexOf('</ul>') < html.indexOf('<p'), 'list closed before paragraph')
})

test('the changelog init and About group are wired defensively', () => {
  const init = extract('_initAboutGroup')
  // api.appChangelog may be absent (main adds it) — must be feature-detected.
  assert.match(init, /typeof window\.api\.appChangelog === 'function'/)
  // A missing/failed fetch shows a placeholder, not a broken box.
  assert.match(init, /Release notes will appear here/)
  // The version line uses the already-captured _appVersion.
  assert.match(init, /_appVersion/)
  // The settings init actually calls it.
  assert.match(SRC, /_initAboutGroup\(\)/)
  assert.match(HTML, /id="about-changelog"/)
})

// ── Continue-Watching staleness nudge (App §18) ──────────────────────────────

const DAY = 24 * 60 * 60 * 1000

test('an item is stale only once it crosses the day threshold', () => {
  const { _cwIsStale } = sandbox(['_cwIsStale'])
  const now = 1_000_000 * DAY
  assert.strictEqual(_cwIsStale(now - 29 * DAY, now, 30), false)
  assert.strictEqual(_cwIsStale(now - 30 * DAY, now, 30), true)
  assert.strictEqual(_cwIsStale(now - 31 * DAY, now, 30), true)
})

test('a missing or garbage timestamp is never stale', () => {
  const { _cwIsStale } = sandbox(['_cwIsStale'])
  const now = 1_000_000 * DAY
  assert.strictEqual(_cwIsStale(undefined, now, 30), false)
  assert.strictEqual(_cwIsStale(null, now, 30), false)
  assert.strictEqual(_cwIsStale(0, now, 30), false)
  assert.strictEqual(_cwIsStale('not a number', now, 30), false)
})

test('the nudge fires when ANY item is stale and reports the total backlog', () => {
  const { _cwStaleNudge } = sandbox(['_cwStaleNudge', '_cwIsStale'])
  const now = 1_000_000 * DAY
  const items = [
    { title: 'Fresh', updatedAt: now - 2 * DAY },
    { title: 'Cold', updatedAt: now - 61 * DAY },
    { title: 'Warm', updatedAt: now - 10 * DAY },
  ]
  // Count is the whole CW backlog (3), not just the stale ones.
  assert.strictEqual(_cwStaleNudge(items, now, 60), 'You have shows waiting — 3 titles in Continue Watching')
})

test('the nudge stays silent when nothing is stale, or the list is empty', () => {
  const { _cwStaleNudge } = sandbox(['_cwStaleNudge', '_cwIsStale'])
  const now = 1_000_000 * DAY
  assert.strictEqual(_cwStaleNudge([{ updatedAt: now - 5 * DAY }], now, 60), null)
  assert.strictEqual(_cwStaleNudge([], now, 60), null)
  assert.strictEqual(_cwStaleNudge(null, now, 60), null)
})

test('the nudge singularises for a single title', () => {
  const { _cwStaleNudge } = sandbox(['_cwStaleNudge', '_cwIsStale'])
  const now = 1_000_000 * DAY
  const msg = _cwStaleNudge([{ updatedAt: now - 61 * DAY }], now, 60)
  assert.strictEqual(msg, 'You have shows waiting — 1 title in Continue Watching')
})

test('the once-per-session nudge is gated and uses a 60-day threshold', () => {
  const guard = extract('_maybeNudgeStaleCw')
  assert.match(guard, /if \(_cwNudgeShown\) return/)
  assert.match(guard, /_cwNudgeShown = true/)
  assert.match(guard, /_cwStaleNudge\(items, Date\.now\(\), 60\)/)
  // _personalRows fires it from the Continue Watching branch.
  assert.match(extract('_personalRows'), /_maybeNudgeStaleCw\(cont\)/)
})

test('the resume badge appears on cards left 30+ days (App §18)', () => {
  const card = extract('_videoCard')
  assert.match(card, /_cwIsStale\(item\.updatedAt, Date\.now\(\), 30\)/)
  assert.match(card, /vbadge-resume/)
  assert.match(card, /resume\?/)
  assert.match(CSS, /\.vbadge-resume/)
})

// ── Offline banner (App §11) ─────────────────────────────────────────────────

test('the offline banner subscribes to the main-process feed defensively', () => {
  const init = extract('_initOnlineBanner')
  assert.match(init, /typeof window\.api\.onAppOnlineState === 'function'/)
  // Run-once guard so the subscription cannot stack per navigation.
  assert.match(init, /if \(_onlineBannerInit\) return/)
  assert.match(init, /_onlineBannerInit = true/)
})

test('going offline shows the banner; reconnecting hides it and toasts', () => {
  const apply = extract('_applyOnlineState')
  assert.match(apply, /banner\.hidden = on/)
  // "Back online" only on a real offline→online transition, not every online call.
  assert.match(apply, /if \(on && _wasOffline\) showToast\('Back online'\)/)
  assert.match(HTML, /id="offline-banner"/)
  assert.match(HTML, /browsing and playback of downloaded content still work/)
})

test('the banner reuses the existing online/offline listeners, adding none', () => {
  // Item §82/§11 must not touch the soak listener budget: the module-scope
  // online/offline handlers were repointed at _applyOnlineState rather than
  // duplicated, and no new document/window listener was introduced for either
  // the banner or the help overlay.
  const online = (SRC.match(/window\.addEventListener\('online'/g) || []).length
  const offline = (SRC.match(/window\.addEventListener\('offline'/g) || []).length
  assert.strictEqual(online, 1, 'exactly one window online listener')
  assert.strictEqual(offline, 1, 'exactly one window offline listener')
  // The handler also forces a fresh connectivity probe now: main's own probe
  // runs only once a minute, so without that its stale "offline" repainted the
  // banner straight back on after the browser said the link was up. Still the
  // same single listener — see test/connectivity-asymmetric.test.js.
  const body = SRC.slice(SRC.indexOf("window.addEventListener('online'"))
    .slice(0, 500)
  assert.match(body, /_applyOnlineState\(true\)/)
  assert.match(body, /connectivityRecheck/)
})

// ── Keyboard help overlay (App §84) ──────────────────────────────────────────

test('"?" only opens the shortcuts overlay outside inputs', () => {
  // The guard is the whole point: a "?" typed into search must not pop the sheet.
  assert.match(SRC, /e\.key === '\?' && !inInput/)
})

test('the help overlay enumerates the real theatre keys from the keymap', () => {
  const rows = extract('_videoShortcutRows')
  // It reads the keymap's ACTIONS rather than a second hand-typed list.
  assert.match(rows, /km\.ACTIONS/)
  assert.match(rows, /Video \/ Theatre/)
  // And the fold-in happens once, guarded against duplication.
  assert.match(SRC, /Video \/ Theatre'\)\) \{\s*\n\s*ALL_SHORTCUTS\.push/)
})

test('every theatre action the keymap exposes gets a help row', () => {
  // Run the real _videoShortcutRows against the real keymap module, so a new
  // ACTION added to the keymap without a help row is caught here.
  const kmCtx = { module: { exports: {} }, globalThis: {} }
  vm.createContext(kmCtx)
  vm.runInContext(KEYMAP, kmCtx)
  const keymap = kmCtx.module.exports
  const ctx = { PapaVideoKeymap: keymap, console }
  vm.createContext(ctx)
  vm.runInContext(extract('_videoShortcutRows'), ctx)
  const rows = ctx._videoShortcutRows(keymap)
  // One row per distinct action the keymap defines.
  const actionCount = Object.keys(keymap.ACTIONS).length
  assert.strictEqual(rows.length, actionCount,
    'the help overlay lists ' + rows.length + ' of ' + actionCount + ' theatre actions')
  for (const r of rows) {
    assert.strictEqual(r.category, 'Video / Theatre')
    assert.ok(Array.isArray(r.keys) && r.keys.length, 'each row names its keys')
    assert.ok(r.desc, 'each row has a description')
  }
})

test('_videoShortcutRows degrades to empty when the keymap is absent', () => {
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext(extract('_videoShortcutRows'), ctx)
  const rows = ctx._videoShortcutRows(null)
  assert.ok(Array.isArray(rows) && rows.length === 0, 'no keymap → empty row list')
})

'use strict'
// Lift one real ipcMain.handle() registration out of main.js and run it.
//
// main.js cannot be require()d in a plain node test — it is an Electron main
// process and boots an app on load. But a test that only reads main.js as text
// cannot see behaviour, and the whole point of the dry-run gate is behaviour:
// the effectful call must NOT happen. So this helper takes the real source
// text of a single `ipcMain.handle('<channel>', fn)` call, evaluates that one
// expression in a sandbox, captures the handler function, and calls it.
//
// Everything the handler body reaches for that the sandbox does not define
// resolves to a recording stub, so "did it reach slskdFetch / shell.trashItem /
// fetch" is answerable, and nothing real is touched.

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const MAIN_PATH = path.join(__dirname, '..', '..', 'main.js')
const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')

// The function-slicer already exists next door, comments, strings, regexes and
// destructured parameter lists and all. One copy, not two.
const { fnSource } = require('./lift-main-fn.js')

// ── Finding the call ────────────────────────────────────────────────────────
// A paren-balancing scan that knows about comments, the three string forms and
// regex literals, so a `/(a|b)/` or a `// )` inside a handler body cannot end
// the slice early.
function callSource(source, channel) {
  const needle = "ipcMain.handle('" + channel + "'"
  const start = source.indexOf(needle)
  if (start < 0) throw new Error('no ipcMain.handle for ' + channel)
  let i = source.indexOf('(', start)
  let depth = 0
  let prev = ''
  while (i < source.length) {
    const c = source[i]
    const two = c + source[i + 1]
    if (two === '//') { i = source.indexOf('\n', i); continue }
    if (two === '/*') { i = source.indexOf('*/', i) + 2; continue }
    if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); continue }
    if (c === '/' && regexCanStart(prev)) { i = skipRegex(source, i); continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return source.slice(start, i + 1) }
    if (!/\s/.test(c)) prev = c
    i++
  }
  throw new Error('unbalanced ipcMain.handle for ' + channel)
}

function skipString(s, i) {
  const quote = s[i]
  i++
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue }
    if (quote === '`' && s[i] === '$' && s[i + 1] === '{') {
      // A template hole can hold anything, parens included. Balance braces.
      let d = 1
      i += 2
      while (i < s.length && d > 0) {
        if (s[i] === '{') d++
        else if (s[i] === '}') d--
        else if (s[i] === '"' || s[i] === "'" || s[i] === '`') { i = skipString(s, i); continue }
        i++
      }
      continue
    }
    if (s[i] === quote) return i + 1
    i++
  }
  return i
}

// A `/` opens a regex only where a value is expected, not after one.
function regexCanStart(prev) {
  return prev === '' || '(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0
}

function skipRegex(s, i) {
  i++
  let inClass = false
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue }
    if (s[i] === '[') inClass = true
    else if (s[i] === ']') inClass = false
    else if (s[i] === '/' && !inClass) { i++; break }
    else if (s[i] === '\n') break
    i++
  }
  while (i < s.length && /[a-z]/.test(s[i])) i++
  return i
}

// ── The recording stub ──────────────────────────────────────────────────────
// Any identifier or property the handler reaches for becomes one of these. It
// is callable, it is truthy, and every call is recorded under its dotted name
// so a test can ask "was shell.trashItem reached".
//
// `then` is deliberately undefined: an awaited stub must resolve to itself
// immediately rather than being treated as a thenable that never settles.
function makeStub(name, calls) {
  const fn = function () { calls.push(name); return makeStub(name + '()', calls) }
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'then') return undefined
      if (typeof prop === 'symbol') return Reflect.get(target, prop)
      if (prop === 'name') return name
      return makeStub(name + '.' + String(prop), calls)
    },
    has() { return true },
  })
}

// ── Running one handler ─────────────────────────────────────────────────────
// Returns { result, calls, error }. `calls` is every stubbed function the body
// actually reached, in order.
// `opts.alsoLift` names top-level functions in main.js to evaluate alongside
// the handler. Without it a handler that delegates its real work to a helper —
// building the candidate list, reading the share selection — runs against a
// recording stub, and the test then asserts against a Proxy instead of against
// the code. Named explicitly rather than lifted automatically, so a test still
// says which real code it is running.
async function runHandler(channel, opts = {}) {
  const src = callSource(MAIN, channel)
  const refusalSrc = MAIN.slice(
    MAIN.indexOf('function _dryRunRefusal(what) {'),
    MAIN.indexOf('\n}', MAIN.indexOf('function _dryRunRefusal(what) {')) + 2)
  const helperSrc = (opts.alsoLift || []).map(n => fnSource(n)).join('\n')

  const calls = []
  let captured = null
  const defined = Object.assign(Object.create(null), {
    console: { log() {}, warn() {}, error() {} },
    Promise, Date, Math, JSON, Number, String, Boolean, Array, Object,
    Set, Map, Error, isFinite, parseInt, parseFloat, encodeURIComponent,
    Symbol, RegExp, setTimeout, clearTimeout, AbortController,
    DRY_RUN: opts.dryRun === true,
    ipcMain: { handle(_ch, fn) { captured = fn } },
  }, opts.globals || {})

  const sandbox = new Proxy(defined, {
    has() { return true },
    get(target, prop) {
      if (prop === Symbol.unscopables) return undefined
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      return makeStub(String(prop), calls)
    },
    set(target, prop, value) { target[prop] = value; return true },
  })

  const ctx = vm.createContext(sandbox)
  vm.runInContext(refusalSrc + '\n' + helperSrc + '\n' + src, ctx, { filename: 'main.js:' + channel })
  if (typeof captured !== 'function') throw new Error('handler not captured: ' + channel)

  // A live body walking into stubs can hang for good (library-set-artwork
  // awaits a Promise that only ffmpeg's 'close' event would settle). The
  // question this helper answers is "what did it reach", and the calls are
  // already recorded by then, so an unsettled body is a result like any other.
  let result = null
  let error = null
  let timedOut = false
  let timer = null
  try {
    result = await Promise.race([
      Promise.resolve().then(() => captured({}, opts.args === undefined ? {} : opts.args)),
      new Promise(resolve => {
        // Deliberately NOT unref'd: a body that hangs leaves the loop empty,
        // and an unref'd timer would let node exit before the race settled.
        timer = setTimeout(() => { timedOut = true; resolve(null) }, opts.timeoutMs || 300)
      }),
    ])
  } catch (e) {
    error = e
  } finally {
    clearTimeout(timer)
  }
  // `globals` is the sandbox's backing object, so a test can read what the
  // handler assigned to a module-level variable (e.g. _debridReady).
  return { result, calls, error, timedOut, globals: defined }
}

// Every channel the dry run is expected to refuse outright.
const GATED_CHANNELS = [
  'video-play', 'video-switch-stream', 'video-warm', 'video-download-start',
  'video-keep-file', 'video-debrid-pick', 'video-predownload',
  'video-cache-delete', 'video-keep-delete', 'video-cache-sweep-watched',
  'slsk-enqueue-downloads', 'slsk-retry-transfer', 'slsk-cancel-transfer',
  'slsk-respread-backlog', 'slsk-configure', 'slsk-set-download-dir',
  'yt-download',
  // The four slskd write paths found ungated on 2026-09-19. slskdFetch refuses
  // them all at the choke point now, but a twin's user should be told what did
  // not happen rather than shown a thrown error, so each one carries its own
  // refusal as well.
  'slsk-download', 'slsk-chat-send', 'slsk-wishlist-run', 'slsk-setup',
  'library-trash-paths', 'library-restore-trashed', 'library-empty-trash',
  'library-move-path',
  'library-write-tags', 'tag-write-batch', 'library-set-artwork',
  'papa-import-all',
  // Pulls a track off a peer to measure it. Its refusal carries `reason` as well
  // as `error`, because {ok, reason} is the shape the dossier reads on every
  // other exit this handler has.
  'slsk-verify-rip',
  // The folder list, the off switch and the upload cap. Without these a dry-run
  // QA twin rewrites the real slskd.yml and disconnects his real daemon — the
  // twin shares port 5030 with the live app.
  'slsk-share-folders-set', 'slsk-enabled-set', 'slsk-upload-limit-set',
  // Answering a pending replacement moves his OLD copy to the Trash. A twin
  // must never answer one on his behalf.
  'slsk-replace-resolve',
]

module.exports = { runHandler, callSource, GATED_CHANNELS, MAIN_PATH }

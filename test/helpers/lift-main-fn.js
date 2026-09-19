'use strict'
// Lift one named top-level function out of main.js and run it for real.
//
// lift-ipc.js does this for `ipcMain.handle('channel', fn)` calls. Plenty of
// main.js's decisions live in plain named functions instead, and a test that
// only reads main.js as text cannot see what one decides — it can only check
// that some string is still present, which stays green through any behaviour
// change that keeps the string.
//
// So: find `function <name>(`, slice to its matching closing brace with a scan
// that knows about comments, the three string forms and regex literals, and
// evaluate that one declaration in a sandbox. Anything the body reaches for
// that the caller did not supply resolves to a recording stub, so "did it call
// slskdFetch" is answerable and nothing real is touched.

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const MAIN_PATH = path.join(__dirname, '..', '..', 'main.js')
const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')

function skipString(s, i) {
  const quote = s[i]
  i++
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue }
    if (quote === '`' && s[i] === '$' && s[i + 1] === '{') {
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

// The source text of one top-level `function name(...) { ... }` declaration.
function fnSource(name, source = MAIN) {
  const re = new RegExp('^(?:async )?function ' + name + '\\s*\\(', 'm')
  const m = re.exec(source)
  if (!m) throw new Error('no top-level function ' + name + ' in main.js')
  const start = m.index
  let i = source.indexOf('{', source.indexOf('(', start))
  let depth = 0
  let prev = ''
  while (i < source.length) {
    const c = source[i]
    const two = c + source[i + 1]
    if (two === '//') { i = source.indexOf('\n', i); continue }
    if (two === '/*') { i = source.indexOf('*/', i) + 2; continue }
    if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); continue }
    if (c === '/' && regexCanStart(prev)) { i = skipRegex(source, i); continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
    if (!/\s/.test(c)) prev = c
    i++
  }
  throw new Error('unbalanced function body for ' + name)
}

function makeStub(name, calls) {
  const fn = function (...args) { calls.push({ name, args }); return makeStub(name + '()', calls) }
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

// Lift one or more named functions and return them, callable.
//
//   const { fns, calls, globals } = liftFns(['dlReconcileMissing'], { dlSched })
//
// `globals` is the sandbox's backing object, so a test can read (and pre-seed)
// anything the body assigns at module level. `calls` records every stubbed call
// as { name, args }.
function liftFns(names, provided = {}) {
  const calls = []
  const defined = Object.assign(Object.create(null), {
    console: { log() {}, warn() {}, error() {} },
    Promise, Date, Math, JSON, Number, String, Boolean, Array, Object,
    Set, Map, Error, isFinite, parseInt, parseFloat, encodeURIComponent,
    Symbol, RegExp, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
  }, provided)

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
  const list = Array.isArray(names) ? names : [names]
  const src = list.map(n => fnSource(n)).join('\n')
  vm.runInContext(src + '\nvar __lifted = {' +
    list.map(n => n + ': ' + n).join(', ') + '}', ctx, { filename: 'main.js' })
  const fns = defined.__lifted
  for (const n of list) {
    if (typeof fns[n] !== 'function') throw new Error('did not capture ' + n)
  }
  return { fns, calls, globals: defined }
}

module.exports = { liftFns, fnSource, MAIN, MAIN_PATH }

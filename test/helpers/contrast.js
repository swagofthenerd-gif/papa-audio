'use strict'
// WCAG 2.1 contrast over the shipped stylesheet's own token values.
//
// The QA sweep of 2026-09-19 found a whole class of light-theme defects that
// no existing test could see: a rule whose colour is hardcoded (or whose token
// was picked for the dark ground) reads fine in dark mode and collapses to
// 1.1:1 on paper. Asserting "this selector uses a var()" is not enough — the
// token it uses has to actually be legible against the surface it sits on.
//
// So: read the two token blocks (:root = dark, body.theme-light = light),
// resolve a colour expression to RGB, flatten alpha over a known backdrop, and
// return the ratio. Everything here is pure arithmetic on the real stylesheet,
// so a regression in either the token VALUES or the rule that picks them goes
// red.

const fs = require('fs')
const path = require('path')

const CSS_PATH = path.join(__dirname, '..', '..', 'src', 'styles.css')

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

// The declarations of one block, as a map.
function blockProps(css, header) {
  const i = css.indexOf(header)
  if (i < 0) throw new Error('block not found: ' + header)
  const open = css.indexOf('{', i)
  const close = css.indexOf('\n}', open)
  const out = {}
  for (const decl of css.slice(open + 1, close).split(';')) {
    const c = decl.indexOf(':')
    if (c < 0) continue
    out[decl.slice(0, c).trim()] = decl.slice(c + 1).trim()
  }
  return out
}

// theme === 'light' layers body.theme-light over :root, exactly as the cascade
// does; 'dark' is :root alone.
function tokens(theme) {
  const css = readCss()
  const dark = blockProps(css, ':root {')
  if (theme !== 'light') return dark
  return Object.assign({}, dark, blockProps(css, 'body.theme-light {'))
}

const NAMED = { white: [255, 255, 255], black: [0, 0, 0], transparent: [0, 0, 0, 0] }

// '#abc' | '#aabbcc' | 'rgba(r,g,b,a)' | 'var(--tok)' | a named colour
// → [r, g, b, a]. `toks` supplies the var() values.
function parseColor(expr, toks) {
  let v = String(expr || '').trim()
  const seen = new Set()
  while (/^var\(/.test(v)) {
    const name = v.slice(4, v.indexOf(')')).split(',')[0].trim()
    if (seen.has(name)) throw new Error('var() cycle at ' + name)
    seen.add(name)
    if (!(name in (toks || {}))) throw new Error('no value for token ' + name)
    v = String(toks[name]).trim()
  }
  if (NAMED[v]) return NAMED[v].length === 4 ? NAMED[v] : NAMED[v].concat([1])
  let m = v.match(/^#([0-9a-f]{3})$/i)
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16)).concat([1])
  m = v.match(/^#([0-9a-f]{6})$/i)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat([1])
  m = v.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s.trim()))
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  throw new Error('cannot parse colour: ' + expr)
}

// Alpha-composite `fg` over the opaque `bg`.
function over(fg, bg) {
  const a = fg[3] == null ? 1 : fg[3]
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat([1])
}

function relLum(rgb) {
  const c = [0, 1, 2].map((i) => {
    const s = rgb[i] / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

// Contrast of `fgExpr` painted on `bgExprs` (outermost surface last — the
// stack is flattened back-to-front so translucent layers compose correctly).
function contrast(fgExpr, bgExprs, theme) {
  const toks = tokens(theme)
  const stack = Array.isArray(bgExprs) ? bgExprs.slice() : [bgExprs]
  let ground = parseColor(stack.pop(), toks)
  if (ground[3] !== 1) throw new Error('the outermost backdrop must be opaque')
  while (stack.length) ground = over(parseColor(stack.pop(), toks), ground)
  const fg = over(parseColor(fgExpr, toks), ground)
  const a = relLum(fg)
  const b = relLum(ground)
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

module.exports = { contrast, tokens, parseColor, relLum, blockProps, readCss }

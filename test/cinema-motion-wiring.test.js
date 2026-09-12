'use strict'
// V3 motion wiring: rail edge fades follow the scroll, posters blur up, the
// hero drifts and cross-fades, the detail hero parallaxes and takes the
// poster's tint. Motion tokens are one vocabulary.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
function fn(name) {
  const at = RENDERER.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = RENDERER.indexOf('\nfunction ', at + 1)
  return RENDERER.slice(at, next === -1 ? undefined : next)
}

test('one motion vocabulary: micro 150, travel 250, scene 400, one easing', () => {
  assert.match(CSS, /--cin-micro:\s+150ms;/); assert.match(CSS, /--cin-travel:\s+250ms;/); assert.match(CSS, /--cin-scene:\s+400ms;/)
  const section = CSS.slice(CSS.indexOf('/* ── Motion (V3)'))
  assert.doesNotMatch(section, /\d+ms var\(--cin-ease\)/, 'no hand-typed durations in the motion block')
})

test('rails: the edge fades follow the scroll position and vanish at a hard edge', () => {
  assert.match(fn('_bindRail'), /wrap\.classList\.toggle\('at-start', m\.left <= START_SLACK\)/)
  assert.match(fn('_bindRail'), /wrap\.classList\.toggle\('at-end', m\.left >= m\.max - 4\)/)
  assert.match(CSS, /\.cinema \.vrail-wrap\.at-start::before,\n\.cinema \.vrail-wrap\.at-end::after \{ opacity: 0; \}/)
})

test('posters blur up only when they carry the marker, so nothing else can vanish', () => {
  assert.match(fn('_videoCard'), /data-blurup="1" onload="this\.classList\.add\(\\'is-loaded\\'\)"/)
  assert.match(CSS, /\.cinema \.vcard-poster\[data-blurup\] \{\n\s+opacity: 0;/)
  assert.match(CSS, /\.cinema \.vcard-poster\[data-blurup\]\.is-loaded \{ opacity: 1; filter: none; transform: none; \}/)
  assert.match(CSS, /prefers-reduced-motion[\s\S]*\.cinema \.vcard-poster\[data-blurup\] \{ transition: none; opacity: 1;/, 'reduced motion shows posters at once')
})

test('the hero drifts and cross-fades on rotation; the card art tilts on hover', () => {
  const paint = fn('_paintVideoHero')
  assert.match(paint, /const prevSrc = prevBg && prevBg\.classList\.contains\('ready'\)/)
  assert.match(paint, /ghost\.className = 'vhero-bg vhero-bg-prev ready'/)
  assert.match(paint, /!_prefersReducedMotion\(\)/)
  assert.match(CSS, /@keyframes cin-drift/); assert.match(CSS, /\.cinema \.vhero-bg\.ready \{ animation: cin-drift 10s linear forwards; \}/)
  assert.match(CSS, /transform: perspective\(700px\) rotateX\(2deg\) translateY\(-6px\);/)
})

test('the detail hero parallaxes with the content scroll and takes the poster tint', () => {
  const m = fn('_bindDetailMotion')
  assert.match(m, /content\.addEventListener\('scroll', onScroll, \{ passive: true \}\)/)
  assert.match(m, /hero\.style\.setProperty\('--vdet-shift', Math\.round\(content\.scrollTop \* 0\.25\) \+ 'px'\)/)
  assert.match(m, /window\.PapaPalette\.extractPalette\(poster,/)
  assert.match(m, /hero\.style\.setProperty\('--vdet-tint', pal\.accent\)/)
  assert.match(RENDERER, /_bindTrailerButton\(\)\n\s+_bindDetailMotion\(d\)/)
  assert.match(CSS, /color-mix\(in srgb, var\(--vdet-tint, #080808\) 30%, rgba\(8,8,8,\.55\)\)/)
  assert.match(CSS, /\.video-detail-hero \{ background-position:center calc\(50% \+ var\(--vdet-shift, 0px\)\); \}/)
})

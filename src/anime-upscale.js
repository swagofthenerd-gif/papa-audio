'use strict'

// Anime4K — real-time anime upscaling for the mpv path.
//
// Anime is mastered at 1080p (often 720p); the screen it lands on is usually
// bigger. Something always upscales that picture. Without this the job falls to
// a general-purpose scaler that treats a cel-shaded frame like a photograph:
// it stretches the flat colour fields fine and turns every hard ink line into a
// soft ramp with a halo beside it. Anime4K is a small convolutional network,
// compiled as GLSL and run by mpv on the GPU, trained on exactly that kind of
// line art — so the lines stay lines.
//
// It does not invent detail. Nothing here is a generative model; it is a
// sharpener that understands what an outline is, and it runs inside the frame
// budget (measured on this machine: 7.26 ms of the 41.7 ms a 24 fps frame has,
// 1080p -> 2160p, heaviest preset).
//
// Every export below is pure except ensureShaders(), so the preset tables can
// be tested without a GPU, without mpv, and without touching disk.

const fs = require('fs')
const path = require('path')

// Bumped whenever the shipped shader set changes. The copies that live in the
// user's config directory carry this stamp, so an app update refreshes them
// instead of leaving an older set in place forever.
const SHADER_SET_VERSION = '4.0.1-1'

// The three chains below are Anime4K v4.0's own Mode A / Mode B / Mode C,
// at the VL (largest) model size. VL rather than M or S because the measured
// cost of VL is a sixth of the frame budget on this machine — there is no
// reason to ship the compromise version by default.
//
// AutoDownscalePre_x2/_x4 are not upscalers. They sit between the two CNN
// stages and skip the second one when the display is already close enough to
// the intermediate size, which is what stops a 1080p source being pushed to
// 4320p for a 2160p screen. Dropping them does not change the picture on a
// matched display; it just burns GPU for nothing.
const PRESETS = Object.freeze({
  off: Object.freeze({
    id: 'off',
    label: 'Off',
    // What the Settings row says under the name. Deliberately about what the
    // viewer sees, not about convolution.
    hint: 'The picture is stretched to fit the screen, as now.',
    shaders: Object.freeze([]),
  }),
  standard: Object.freeze({
    id: 'standard',
    label: 'Standard',
    hint: 'Best for most anime. Sharpens the lines without changing colours.',
    shaders: Object.freeze([
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ]),
  }),
  soft: Object.freeze({
    id: 'soft',
    label: 'Soft or blurry episodes',
    hint: 'For older shows and soft transfers, where Standard looks harsh.',
    shaders: Object.freeze([
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ]),
  }),
  denoise: Object.freeze({
    id: 'denoise',
    label: 'Noisy or low-quality rips',
    hint: 'For grainy, blocky or heavily compressed sources.',
    shaders: Object.freeze([
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ]),
  }),
})

const DEFAULT_PRESET = 'off'

function presetIds() { return Object.keys(PRESETS) }

// Anything unrecognised — a hand-edited settings file, a preset removed in a
// later version, null — reads as off. A bad value must never mean "guess", and
// must never throw on the playback path.
function normalizePreset(id) {
  return Object.prototype.hasOwnProperty.call(PRESETS, id) ? id : DEFAULT_PRESET
}

function presetInfo(id) { return PRESETS[normalizePreset(id)] }

function shaderFilesFor(id) { return presetInfo(id).shaders.slice() }

// Every file any preset can ask for, deduplicated — what ensureShaders copies
// and what the packaged build has to contain.
function requiredShaderFiles() {
  const seen = new Set()
  for (const id of presetIds()) for (const f of PRESETS[id].shaders) seen.add(f)
  return Array.from(seen).sort()
}

// mpv splits a list option on ':' and ',', so a path containing either would
// be read as two paths. mpv's documented %n% escape does NOT help here: passed
// through --glsl-shaders it is stored verbatim, so every path silently becomes
// an unopenable filename and the upscaler does nothing at all — no error, no
// log, just a normal-looking picture. Verified against mpv 0.41 before relying
// on it.
//
// The append form takes exactly one value and never splits it, so it sidesteps
// the separator entirely. One --glsl-shaders-append per file, in order.
function shaderPaths(id, dir) {
  const files = shaderFilesFor(id)
  if (!files.length || !dir) return []
  return files.map(f => path.join(dir, f))
}

// The mpv arguments for a preset, or [] when nothing should be applied.
function shaderArgs(id, dir) {
  return shaderPaths(id, dir).map(p => `--glsl-shaders-append=${p}`)
}

// Where the shaders ship inside the app.
function bundledShaderDir() { return path.join(__dirname, '..', 'shaders', 'anime4k') }

// mpv is a separate process and cannot read out of an asar archive, so the
// shaders are copied to a real directory the first time they are needed. This
// is the same move writeInputConf() already makes for the key bindings, for the
// same reason.
//
// Returns the directory mpv should read, or null. Null is not an error worth
// surfacing: it means this run plays without the upscaler, which is exactly
// what the app did before it existed.
function ensureShaders(destRoot, opts = {}) {
  const srcDir = opts.srcDir || bundledShaderDir()
  if (!destRoot) return null
  const dest = path.join(destRoot, 'anime4k')
  const want = requiredShaderFiles()
  const stamp = path.join(dest, '.version')
  try {
    let current = null
    try { current = fs.readFileSync(stamp, 'utf8').trim() } catch (_) {}
    // The stamp alone is not trusted: a file deleted by hand would otherwise
    // never come back, and mpv's failure for a missing shader is a silent
    // no-op rather than an error.
    if (current === SHADER_SET_VERSION && want.every(f => fs.existsSync(path.join(dest, f)))) {
      return dest
    }
    fs.mkdirSync(dest, { recursive: true })
    for (const f of want) fs.copyFileSync(path.join(srcDir, f), path.join(dest, f))
    fs.writeFileSync(stamp, SHADER_SET_VERSION, 'utf8')
    return dest
  } catch (_) {
    // A half-copied set is worse than none, but only if it is used. If every
    // required file happens to be there from an earlier run, use it anyway.
    try {
      if (want.every(f => fs.existsSync(path.join(dest, f)))) return dest
    } catch (_) {}
    return null
  }
}

module.exports = {
  SHADER_SET_VERSION,
  DEFAULT_PRESET,
  PRESETS,
  presetIds,
  normalizePreset,
  presetInfo,
  shaderFilesFor,
  requiredShaderFiles,
  shaderPaths,
  shaderArgs,
  bundledShaderDir,
  ensureShaders,
}

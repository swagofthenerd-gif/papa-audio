'use strict'
// Downloads YouTube audio via yt-dlp in the NATIVE codec (.opus/.m4a).
// No transcode: -x without --audio-format only remuxes out of the container.
const { spawn } = require('child_process')
const path = require('path')

function parseProgress(line) {
  const m = /^\[download\]\s+([\d.]+)%/.exec(line.trim())
  return m ? parseFloat(m[1]) : null
}

function sanitizeFilename(s) {
  return String(s || '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
}

function buildArgs({ videoId, base, outDir }) {
  return [
    '-f', 'bestaudio',
    '-x',
    '--embed-metadata',
    '--embed-thumbnail',
    '--no-playlist',
    '--newline',
    '-o', path.join(outDir, `${base}.%(ext)s`),
    '--', videoId,
  ]
}

function downloadAudio({ videoId, title, artist, outDir, onProgress, spawnFn = spawn }) {
  const base = sanitizeFilename(artist ? `${artist} - ${title}` : title) || videoId
  const args = buildArgs({ videoId, base, outDir })
  return new Promise(resolve => {
    let stderrTail = ''
    let proc
    try {
      proc = spawnFn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: `yt-dlp spawn failed: ${e.message}` })
      return
    }
    let buf = ''
    proc.stdout.on('data', d => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const pct = parseProgress(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (pct != null) onProgress(pct)
      }
    })
    proc.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-500) })
    proc.on('error', e => resolve({ ok: false, error: `yt-dlp error: ${e.message}` }))
    proc.on('close', code => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: stderrTail.trim() || `yt-dlp exited ${code}` })
    })
  })
}

module.exports = { parseProgress, sanitizeFilename, buildArgs, downloadAudio }

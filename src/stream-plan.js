'use strict'
// The smooth player's decision table (video plan V0/V1): given what ffprobe
// says a source contains and what this Electron's <video> can decode, decide
// how ffmpeg turns it into a browser-playable fragmented MP4.
//
//   remux      copy the streams — nothing is re-encoded (AV1/H.264/VP9 video,
//              AAC/Opus/FLAC audio). Instant and lossless.
//   transcode  the video, the audio, or both are re-encoded (HEVC → H.264 on
//              the GPU; AC-3/E-AC-3/TrueHD/DTS → Opus 5.1). HDR is tone-mapped
//              to SDR and SAID so.
//   refuse     nothing sensible can be done; the caller falls back to mpv.
//
// Measured on the user's machine (RTX 3070, ffmpeg 8.1): 1080p HEVC → H.264
// runs at ~5.5× real time; 4K HDR with CPU tone-mapping at ~1×, which is why
// that case asks for a pre-roll. Pure and DOM-free; tested in
// test/stream-plan.test.js. Loaded by main via require.

const BROWSER_VIDEO = new Set(['h264', 'av1', 'vp9', 'vp8'])
const BROWSER_AUDIO = new Set(['aac', 'opus', 'flac', 'vorbis', 'mp3'])
// Text subtitles ffmpeg can turn into WebVTT sidecars; everything else is
// image-based or styled and is burned in on a transcode.
const TEXT_SUBS = new Set(['subrip', 'srt', 'webvtt', 'mov_text', 'text'])
const STYLED_SUBS = new Set(['ass', 'ssa'])

function _s(v) { return typeof v === 'string' ? v.toLowerCase() : '' }
function _n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0 }

function isHdr(v) {
  if (!v) return false
  const t = _s(v.color_transfer)
  const p = _s(v.color_primaries)
  if (t === 'smpte2084' || t === 'arib-std-b67') return true
  if (p === 'bt2020' && /10le|12le/.test(_s(v.pix_fmt))) return true
  return false
}

function _bitDepth(v) { return /10le|10be|p010/.test(_s(v && v.pix_fmt)) ? 10 : /12le/.test(_s(v && v.pix_fmt)) ? 12 : 8 }

// Choose the streams: the first video, the preferred audio (most channels,
// then the requested language), text subtitles as sidecars.
function pickStreams(streams, prefs) {
  prefs = prefs || {}
  const list = Array.isArray(streams) ? streams : []
  const video = list.find(s => _s(s.codec_type) === 'video' && !(s.disposition && s.disposition.attached_pic)) || null
  const audios = list.filter(s => _s(s.codec_type) === 'audio')
  const subs = list.filter(s => _s(s.codec_type) === 'subtitle')
  let audio = null
  if (prefs.audioIndex != null) audio = audios.find(a => a.index === prefs.audioIndex) || null
  if (!audio && prefs.lang) audio = audios.find(a => a.tags && _s(a.tags.language) === _s(prefs.lang)) || null
  if (!audio) audio = audios.slice().sort((a, b) => _n(b.channels) - _n(a.channels))[0] || null
  return { video, audio, audios, subs }
}

// The plan. `caps` overrides the browser capability table (tests, or a future
// build that can do HEVC). `opts.gpu` says NVENC/NVDEC are available.
function plan(streams, opts) {
  opts = opts || {}
  const caps = Object.assign({ video: BROWSER_VIDEO, audio: BROWSER_AUDIO, gpu: true }, opts.caps || {})
  const { video, audio, audios, subs } = pickStreams(streams, opts.prefs)
  if (!video) return { mode: 'refuse', reason: 'no video stream' }

  const vcodec = _s(video.codec_name)
  const acodec = audio ? _s(audio.codec_name) : null
  const hdr = isHdr(video)
  const depth = _bitDepth(video)
  const width = _n(video.width), height = _n(video.height)
  const channels = audio ? _n(audio.channels) : 0

  // Video: copy when the browser decodes it AND it is not HDR (the browser
  // would show HDR as washed-out SDR); otherwise re-encode to H.264 8-bit.
  // AV1 10-bit SDR plays natively (measured), so it copies.
  const videoCopy = caps.video.has(vcodec) && !hdr
  const videoArgs = videoCopy
    ? ['-c:v', 'copy']
    : (caps.gpu
      ? (hdr
        // GPU decode, CPU tone-map (ffmpeg here has no tonemap_cuda), GPU encode.
        ? ['-vf', 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p',
           '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate', width > 2000 ? '45M' : '25M', '-bufsize', width > 2000 ? '90M' : '50M', '-profile:v', 'high']
        : ['-vf', 'scale_cuda=format=nv12', '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-maxrate', width > 2000 ? '45M' : '25M', '-bufsize', width > 2000 ? '90M' : '50M', '-profile:v', 'high'])
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'])
  // Input-side flags: hardware decode only when the frames stay on the GPU
  // (no tone-map) — the tone-map filter chain needs them in system memory.
  const inputArgs = (!videoCopy && caps.gpu) ? (hdr ? ['-hwaccel', 'cuda'] : ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']) : []

  // Audio: copy when the browser decodes it; else Opus at a bitrate that
  // keeps 5.1/7.1 honest (512k for surround, 192k stereo). Layouts above 5.1
  // fold down to 5.1 — Opus in MP4 stops there in the browser.
  let audioArgs = []
  if (!audio) audioArgs = ['-an']
  else if (caps.audio.has(acodec)) audioArgs = ['-c:a', 'copy']
  else audioArgs = ['-c:a', 'libopus', '-b:a', channels > 2 ? '512k' : '192k', '-ac', String(Math.min(channels || 2, 6))]

  // Subtitles: text ones become WebVTT sidecars; styled or image ones can only
  // be burned in, which forces a transcode when one is selected.
  const sidecars = subs.filter(s => TEXT_SUBS.has(_s(s.codec_name))).map(s => ({ index: s.index, lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '' }))
  const burnable = subs.filter(s => STYLED_SUBS.has(_s(s.codec_name)) || /pgs|dvd_subtitle|dvb/.test(_s(s.codec_name))).map(s => ({ index: s.index, lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '', styled: STYLED_SUBS.has(_s(s.codec_name)) }))

  const mode = (videoCopy && (!audio || caps.audio.has(acodec))) ? 'remux' : 'transcode'
  // 4K HDR converts at about real time on this machine: buffer before playing.
  const prerollSec = (!videoCopy && width > 2000) ? 8 : (!videoCopy ? 2 : 0)

  return {
    mode,
    reason: mode === 'remux' ? 'browser decodes it' : (videoCopy ? 'audio re-encoded' : (hdr ? 'HDR tone-mapped to SDR, re-encoded' : 'video re-encoded')),
    video: { index: video.index, codec: vcodec, copy: videoCopy, hdr, depth, width, height },
    audio: audio ? { index: audio.index, codec: acodec, copy: caps.audio.has(acodec), channels, lang: (audio.tags && audio.tags.language) || '' } : null,
    audios: audios.map(a => ({ index: a.index, codec: _s(a.codec_name), channels: _n(a.channels), lang: (a.tags && a.tags.language) || '', title: (a.tags && a.tags.title) || '' })),
    subtitles: { sidecars, burnable },
    inputArgs, videoArgs, audioArgs,
    prerollSec,
    badges: [hdr ? 'HDR shown as SDR' : null, !videoCopy ? 'converted' : null].filter(Boolean),
  }
}

// The ffmpeg argv for one stream session from `startSec`, writing fragmented
// MP4 to stdout. `burnIndex` selects a burnable subtitle stream to draw into
// the picture (forces a re-encode even for a remux-able video).
function ffmpegArgs(p, input, startSec, extra) {
  extra = extra || {}
  const start = Math.max(0, _n(startSec))
  let videoArgs = p.videoArgs
  let inputArgs = p.inputArgs
  if (extra.burnIndex != null && p.video.copy) {
    // Burning text into a copied stream needs decoding: software H.264 path.
    videoArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']
    inputArgs = []
  }
  const filters = []
  const vfIdx = videoArgs.indexOf('-vf')
  if (vfIdx !== -1) filters.push(videoArgs[vfIdx + 1])
  if (extra.burnIndex != null) filters.push("subtitles='" + String(input).replace(/'/g, "'\\''") + "':si=" + extra.burnSubOrdinal)
  const vArgs = vfIdx !== -1 ? videoArgs.filter((_, i) => i !== vfIdx && i !== vfIdx + 1) : videoArgs.slice()
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
    .concat(inputArgs)
    .concat(start > 0 ? ['-ss', String(start)] : [])
    .concat(['-i', input])
    .concat(['-map', '0:' + p.video.index])
    .concat(p.audio ? ['-map', '0:' + p.audio.index] : [])
    .concat(filters.length ? ['-vf', filters.join(',')] : [])
    .concat(vArgs)
    .concat(p.audioArgs)
    .concat(['-sn', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1'])
  return args
}

// WebVTT sidecar extraction for one text subtitle stream.
function subtitleArgs(input, streamIndex) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map', '0:' + streamIndex, '-f', 'webvtt', 'pipe:1']
}

module.exports = { plan, pickStreams, isHdr, ffmpegArgs, subtitleArgs, BROWSER_VIDEO, BROWSER_AUDIO }

'use strict'
// Preload for the overlay controls window (roadmap #26). A deliberately slim
// bridge: it exposes only what the on-picture control bar needs — the live
// video-state stream (read), the same playback verbs the deck uses (write,
// replayed through main's shared handler), and the pass-through toggle that lets
// clicks fall through the transparent regions to the picture while still letting
// the control surfaces be pressed. It adds NO new engine channels; every verb
// lands in the same _invokeVideoControl path the theatre deck already uses.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlay', {
  // Subscribe to the throttled §4.2 state stream (~4/s). Returns an unsubscribe.
  onState (cb) {
    const h = (_, s) => { try { cb(s) } catch (_) {} }
    ipcRenderer.on('video-state', h)
    return () => ipcRenderer.removeListener('video-state', h)
  },
  // Replay a playback verb through main's shared video-control body.
  control (verb, args) {
    return ipcRenderer.invoke('overlay-control', { verb, args })
      .catch(() => ({ ok: false }))
  },
  // The film's title for the top gradient. Returns an unsubscribe.
  onTitle (cb) {
    const h = (_, d) => { try { cb((d && d.title) || '') } catch (_) {} }
    ipcRenderer.on('overlay-title', h)
    return () => ipcRenderer.removeListener('overlay-title', h)
  },
  // Pass-through control: ignore=true → clicks fall through to the picture;
  // ignore=false → the overlay itself receives them so a button can be pressed.
  setIgnore (ignore) {
    try { ipcRenderer.send('overlay-set-ignore', { ignore: ignore !== false }) } catch (_) {}
  },
})

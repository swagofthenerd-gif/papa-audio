# Handoff — mpv Audio Engine Migration (2026-07-05, ~09:15)

**Plan:** `docs/superpowers/plans/2026-07-04-mpv-audio-engine.md` (9 tasks) · **Spec:** `docs/superpowers/specs/2026-07-04-mpv-audio-engine-design.md`

## Context for next session

PC had a hard GPU lock (NVIDIA driver crashed during auto-suspend); user was told to hard-reset via power button. All work below is safe on disk. After reboot, advise: update nvidia driver / disable auto-suspend in KDE power settings if it recurs.

## Committed (git log --oneline)

- `0ba0f3b` Task 2: mpv-engine.js + tests — includes seek-deferral fix (see below)
- `a47faa2` Task 3: mpv-crossfade.js + tests
- `3100b5f` npm test glob fix, `379ca06` Task 1: mpv-ipc.js
- Plan checkboxes ticked through Task 3. Tests: 25/25 pass via `npm test`.

**Key learning:** mpv rejects `seek` between `start-file` and `playback-restart` events. `MpvEngine.seek()` now defers seeks until seekable, coalescing to latest target (`_seekable`/`_pendingSeek`/`_flushPendingSeek`). When debugging test failures, use `node --test --test-force-exit` — a failing test that skips `eng.stop()` leaves mpv holding the event loop and looks like a silent hang (worse when piped to `tail`/`grep`, which buffer).

## Task 4 IN PROGRESS — renderer purge, UNCOMMITTED, renderer.js is MID-SURGERY

Do NOT launch the app until Task 4 completes. `git status` shows modified `src/renderer.js` + this file.

### Already done in src/renderer.js (uncommitted edits)

1. state fields removed: `audioMode, eqEnabled, eqGains, eqPreamp, replayGainMode, vizMode, crossfadeSecs`
2. Removed: Web Audio vars, EQ consts (KEPT `SPEEDS`), `_cf*` vars, `ensureAudioGraph`, visualizer (vars, `startViz/stopViz/drawViz`), all EQ functions (`buildEqBandsUI/applyEqGain/applyAllEqGains/applyEqPreset/clearEqPresetHighlight/saveEqSettings/toggleEqPanel`), `applyReplayGain`, `applyPreamp`. `visibilitychange` listener kept but stripped of viz/audioCtx lines.
3. Channel-output feature removed entirely (deviation — it was Web-Audio-dependent): `CH_MODE_MAP/CH_MODE_LABEL/applyAudioMode/updateOutputModeBtn/syncChPanelOptions/toggleChPanel/chLabel`
4. `init()`: removed `getAudioSettings`+`getEqSettings` from Promise.all (destructuring updated), removed the eq/audioMode state assignments and `updateOutputModeBtn()` call
5. `closeNowPlayingModal`: removed np-modal-viz canvas clear
6. `playCurrentTrack()`: removed `cleanupCrossfade/ensureAudioGraph/applyReplayGain/audioCtx?.resume()/startViz()` lines
7. `updatePlayBtn()`: removed audioCtx suspend/resume lines

### REMAINING in src/renderer.js

- Delete whole `// ── Crossfade ──` section: `getNextTrackForCF`, `startCrossfade`, `computeReplayGainValue`, `cleanupCrossfade`
- Delete `case 'set_eq_preset':` block in the agent tool executor (search `set_eq_preset`)
- Delete EQ panel wiring block (search `// EQ panel`): `btn-eq` listener, `eq-enabled`, `.eq-preset-btn` loop, `rg-mode`, `eq-preamp`, `eq-crossfade` slider block
- Delete channel panel wiring (search `Audio output channel panel`): `btn-output-mode` listener, `.ch-option` loop, ch-panel outside-click closer
- Delete crossfade trigger in the `timeupdate` listener (search `Crossfade trigger`)
- Delete the `if (_cfActive && _cfNextTrack && _cfAudio)` branch at top of the `ended` listener (ends with `return`)
- Delete keyboard shortcut: `if (e.key === 'e' || e.key === 'E') { toggleEqPanel(); return }`
- Verify clean: `grep -n -iE "audioCtx|AudioContext|analyser|eqNodes|eqGains|eqPreamp|eq-panel|btn-eq|startViz|stopViz|_cf[A-Z]|cleanupCrossfade|getEqSettings|replayGainNode|preampNode|masterGainNode|crossfade" src/renderer.js` → expect no output

### REMAINING in other files

- `main.js`: delete `get-eq-settings`/`save-eq-settings` handlers (~line 616-620); delete `set_eq_preset` tool schema (~line 1407-1410); reword the `VOLUME & EQ:` line in the agent system prompt (~line 1217) to drop set_eq_preset
- `preload.js`: delete `getEqSettings`/`saveEqSettings` (~lines 57-58)
- Decide on `getAudioSettings`/`saveAudioSettings` (preload 53-54, main 608-612): renderer no longer calls them — CHECK first whether get-audio-settings returns anything else still needed (volume comes from getAppInfo, verify) before deleting
- `src/index.html`: delete viz canvas (~376), EQ button `btn-eq` (~394), `np-modal-viz` canvas (~432), whole `#eq-panel` block (~562-605), `btn-output-mode`/`ch-panel` markup (search), `<kbd>E</kbd>` equalizer row in shortcuts modal (~673)
- `src/styles.css`: delete `.eq-*`, `.viz-canvas`, `.np-modal-viz`, ch-panel/output-mode rules

### Then

```bash
node --check src/renderer.js && node --check main.js && node --check preload.js && npm test
npm start   # play a track: audio works via <audio> (mpv swap is Task 5-6), no console errors, EQ/viz/channel UI gone
git add -A && git commit -m "refactor: remove EQ, visualizer, Web Audio graph, and element crossfade (purist mode)"
```

Tick Task 4 boxes in the plan, then continue Task 5 (wire engine into main+preload), Task 6 (PapaPlayerShim), 7 (settings UI), 8 (mpv-missing screen), 9 (QA). Plan has verbatim code for 5.

### Recorded deviations from plan (mention in Task 4 commit body)

- Channel-output (stereo/5.1/7.1) picker removed entirely, not in the plan's list — it only worked through the Web Audio graph; mpv owns channel layout now
- Agent tool `set_eq_preset` removed (schema in main.js + case in renderer)
- Keyboard shortcut `E` and its shortcuts-modal row removed

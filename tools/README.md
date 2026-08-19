# Audio tooling

Scripts for calibrating this machine's speakers and applying the result, both
inside Papa Audio and system-wide. They are specific to this hardware — an
ALC892 feeding an F&D F6000X 5.1 system — but the method generalises.

## Calibration

    speakercal

Guided by-ear calibration. Plays stepped tones at identical amplitude and asks
which jump out or vanish **relative to their neighbours**. Neighbour comparison
matters: the ear is far less sensitive at 31 Hz than at 1 kHz (the
equal-loudness contours), so absolute loudness judgements would just
rediscover human hearing rather than measure the room.

Also finds the lowest note the system genuinely reproduces, which sets the
high-pass. Writes `~/.cache/speakercal.json`.

Needs a real terminal — it exits with instructions if stdin is not a TTY.

## Applying the calibration

| Script | Output |
|---|---|
| `build-pipewire-eq.js` | 6-channel PipeWire filter-chain (**current setup**) |
| `easyeffects-presets.js` | EasyEffects presets — stereo only, superseded |
| `build-corrected-presets.js` | Merges calibration into the EasyEffects suite |

`EQ_STAGE=1|2|3` on `build-pipewire-eq.js` builds the chain incrementally
(high-pass only / plus bass / everything), which is how to debug it — a bad
filter graph fails as silence, with no useful error.

## Why PipeWire and not EasyEffects

EasyEffects is a **stereo-only** processor. Routing 5.1 through it downmixes to
2 channels and folds the rear channels into the fronts, silently destroying
surround. PipeWire's native filter-chain handles arbitrary channel counts, so
correction and discrete 5.1 can coexist.

## eqmode

    eqmode [preset]

Switches the EasyEffects preset. Only relevant to the superseded stereo setup.

## Hard-won notes

- The ALC892 boots with `Channel Mode = 2ch`. **While it is 2ch, PipeWire's
  `analog-surround-51` profile does not exist at all** — no amount of clicking
  in the desktop settings will reveal it. Set the mixer control first.
- Restored at login by `~/.config/systemd/user/papa-audio-51.service`.
- `speaker-test -D pulse` can fail with `Unable to create stream: No such
  entity` and then play pure silence. Prefer `paplay` for channel tests, and
  check its exit status.
- EasyEffects silently ignores unknown keys and clamps out-of-range values, so
  a wrong key yields a preset that "loads fine" and sounds wrong. Verify by
  reading the flushed state — and note it only flushes on service exit.
- The F6000X's mode display is not trustworthy. The position that yields
  discrete 5.1 is the one it is in now, whatever it reads.

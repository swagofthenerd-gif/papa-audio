# Papa Audio 5.1 + EQ toolchain

## If sound breaks — do this first

    papa-audio-51-setup

Resets the codec to 6ch, reapplies the 5.1 profile, restores the default sink
and re-links the filter chains. Takes about 15 seconds and prints what it did.
Safe to run repeatedly. This is the same thing that runs at login and on every
PipeWire restart.

If that reports OK and the sound is still wrong, take the EQ out of the picture
to find out whether it is the EQ or the hardware:

    papa-eq-toggle off      # unload the chains entirely (~20 s)
    papa-eq-toggle on       # put them back

`eqmode off` is NOT the same thing — it only redirects the default sink, and
WirePlumber may quietly re-select an EQ sink from its stored preferences.

    papa-eq-relink          # chains loaded but audio reaches nothing
    audit-eq.py             # check the generated config is internally sane

## Which command do I want?

| I want to… | Command |
|---|---|
| Pick a different sound | `papa-eq` (GUI) or `eqmode <name>` |
| See what's active | `eqmode` |
| Turn the EQ off properly | `papa-eq-toggle off` |
| Get sound back after it broke | `papa-audio-51-setup` |
| Re-measure my speakers | `speakercal` |

Everything else is internal and the GUI calls it for you: `papa-eq-apply`
(pushes values into the running graph), `papa-eq-relink`, `audit-eq.py`,
`build-pipewire-presets.js`.

## Installing changes

`~/.local/bin/` holds COPIES, not symlinks. Editing a file in `tools/` changes
nothing until you copy it across:

    install -m755 tools/eqmode ~/.local/bin/eqmode

Installed names drop the extension: `papa-eq-gui.py` -> `papa-eq`,
`papa-eq-apply.py` -> `papa-eq-apply`, `papa-eq-relink.sh` -> `papa-eq-relink`.


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

## Realtime changes

Every filter control in the chain is a live PipeWire parameter, so changing a
gain does NOT require regenerating the config and restarting PipeWire — that
path costs 15-20 seconds of silence. `papa-eq-apply.py` pushes stored values
into the running graph in about 300 ms, inaudibly.

    papa-eq-apply music            # apply the stored curve live
    papa-eq-apply music --check    # report what is settable, change nothing

The generator emits `~/.config/papa-eq/controls.json` listing every settable
control, so the apply tool never re-derives naming and cannot drift from it.

Zero-gain bands are omitted from the graph, so a band moving OFF zero has no
node to set. `papa-eq-apply` exits 2 in that case and the caller rebuilds; the
GUI does this automatically. Everything else applies live.

Note `pw-dump` reports CONFIGURED values, not live ones. A control changed at
runtime still reads its old value there — verify by measuring the audio, not
by reading it back.

## Subwoofer high-pass precedence

`settings.subHighPass` (from the F&D manual: the sub is rated 25-85 Hz) takes
precedence over `speakercal`'s by-ear `low_limit`. The by-ear figure reflects
what was audible at the tested level, not the driver's limit, and was an octave
pessimistic here. Re-running `speakercal` will not change the sub's high-pass
unless you also clear `subHighPass`.

## Applying the calibration

| Script | Output |
|---|---|
| `build-pipewire-presets.js` | 6-channel PipeWire filter chains (**the generator**) |
| `papa-eq-apply.py` | Push values into the running graph, no restart |
| `audit-eq.py` | Verify the generated config's structural invariants |
| `papa-audio-51-setup` | Restore 6ch mode, profile, default sink and links |


## Why PipeWire and not EasyEffects

EasyEffects is a **stereo-only** processor. Routing 5.1 through it downmixes to
2 channels and folds the rear channels into the fronts, silently destroying
surround. PipeWire's native filter-chain handles arbitrary channel counts, so
correction and discrete 5.1 can coexist.

## GUI

    papa-eq

PyQt6 app (also in the KDE application menu). Switch presets, edit their
curves, create and delete presets. Switching is instant; saving or adding
rebuilds the filter graph and reloads PipeWire, about two seconds of silence.

Presets live in `~/.config/papa-eq/presets.json`, shared with the generator so
the two cannot drift.

## Bass management and the LFE boost

Satellites are high-passed at `SAT_CROSSOVER_HZ` (100) so they stop attempting
bass they reproduce badly, leaving it all to the subwoofer — what an AV
receiver does. Without it, the upmix COPIES low frequencies into LFE without
removing them from the fronts, so both play bass and it sounds diffuse.

A synthesised LFE arrives about 10 dB below where the standard puts it: real
5.1 records LFE 10 dB down and expects the decoder to add it back, and the
upmix does not. `LFE_BOOST_DB` restores it.

That boost must NOT apply to material that already has a real LFE, and the
filter chain cannot tell the two apart. The generator emits `51` variants only
when `settings.lfeBoost` is above zero; at zero they would be identical to the
plain sinks, so none exist and nothing refers to them.

## Player channel setting

Set the player to `auto`, not a fixed layout. mpv then passes the source
through unchanged: stereo stays 2ch so PipeWire upmixes it, and 5.1 stays 6ch
so the discrete channels survive. Forcing `stereo` downmixes real 5.1 and
destroys it; forcing `5.1` makes mpv pad stereo with silent centre/LFE/rears,
which suppresses the upmix entirely.

## Stereo upmixing

Stereo sources have nothing in the centre, rears or LFE. PipeWire can derive
them, but two things must both be true:

1. `channelmix.*` must be set as **client stream properties**
   (`~/.config/pipewire/client.conf.d/` and `pipewire-pulse.conf.d/`).
   Setting them on a sink node does nothing — a silent no-op that looks
   plausible and wastes a lot of time.
2. The player must output **stereo**, not 5.1. Given a 6-channel sink, mpv
   will happily expand a stereo track to 6 channels itself, padding centre,
   LFE and rears with silence. PipeWire then sees 6-in/6-out, concludes there
   is nothing to convert, and passes the silence through. So Papa Audio's
   `channels` must be `stereo` for surround to work on stereo music.

Note the F&D F6000X used to do this upmixing internally in 2.1 mode. Once it
is switched to true 5.1 it plays only what it is given, so the job moves to
the PC.

## eqmode

    eqmode              list presets, mark the active one
    eqmode music        switch to that preset (instant, no dropout)
    eqmode off          send audio straight to the 5.1 hardware sink

Changes the default sink, moves anything already playing, and records the
choice in ~/.config/papa-eq/active so login restores it.

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
- Filter-chain outputs are `node.passive`, and a passive output whose
  `target.object` cannot be resolved auto-connects to the CURRENT DEFAULT
  SINK. With several EQ chains, they daisy-chain into each other and audio
  never reaches the hardware. The 5.1 sink does not exist when the chains
  load (the card profile is applied seconds later), hence
  `node.autoconnect = false` plus `papa-eq-relink` asserting links afterwards.
- The F6000X's mode display is not trustworthy. The position that yields
  discrete 5.1 is the one it is in now, whatever it reads.

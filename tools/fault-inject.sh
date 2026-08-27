#!/usr/bin/env bash
# Fault injection for the playback engine.
#
# The mid-album stop was never reproduced by reading code, and it will not be.
# This breaks mpv in the four ways that produce that symptom and checks that
# each one now leaves a trace. Before Tier 1 all four were silent.
#
# Run it with Papa Audio open and a local album PLAYING, then follow the prompts.
#
#   tools/fault-inject.sh              # all cases
#   tools/fault-inject.sh sigkill      # one case
#   tools/fault-inject.sh --list
#
# Cases: sigkill sigstop pipewire device
#
# What this checks automatically:
#   - a new line in the daily log naming the cause
#   - mpv's own state over its IPC socket (ground truth, never the UI)
# What it cannot check, and prints for you to confirm by eye or over CDP:
#   - the visible UI state, and that playback actually resumed audibly
set -uo pipefail

LOG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/papa-audio/logs"
LOG="$LOG_DIR/papa-$(date +%F).log"
PROBE="$(dirname "$0")/mpv-probe.js"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"

pass=0; fail=0; manual=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=$((fail+1)); }
eye()  { printf '  \033[33mCONFIRM BY EYE\033[0m %s\n' "$*"; manual=$((manual+1)); }
info() { printf '       %s\n' "$*"; }

mpv_pids() {
  # Only mpv processes holding a papa socket -- never the user's own mpv.
  pgrep -af 'mpv .*papa-mpv-.*\.sock' 2>/dev/null | awk '{print $1}'
}

probe() { node "$PROBE" --json 2>/dev/null; }

probe_get() { node "$PROBE" --get "$1" 2>/dev/null; }

log_size() { [ -f "$LOG" ] && wc -c < "$LOG" | tr -d ' ' || echo 0; }

# Everything appended since a recorded byte offset.
log_since() { local from="$1"; [ -f "$LOG" ] && tail -c "+$((from+1))" "$LOG" || true; }

require_playing() {
  local idle pos
  idle=$(probe_get idle-active)
  pos=$(probe_get time-pos)
  if [ "$idle" = "true" ] || [ -z "${pos:-}" ] || [ "$pos" = "null" ]; then
    echo "This needs a local track actually playing. mpv says idle-active=$idle time-pos=$pos" >&2
    return 1
  fi
  info "playing, mpv time-pos=$pos"
}

preflight() {
  say "Preflight"
  if ! command -v node >/dev/null; then echo "node not found" >&2; exit 1; fi
  local pids; pids=$(mpv_pids)
  if [ -z "$pids" ]; then
    echo "No papa-audio mpv process found. Start the app and play a track first." >&2
    exit 1
  fi
  info "mpv pid(s): $(echo "$pids" | tr '\n' ' ')"
  info "log: $LOG"
  ls -1 "$RUNTIME"/papa-mpv-*.sock 2>/dev/null | sed 's/^/       socket: /'
  require_playing || exit 1
}

# ── Case 1: mpv is killed outright, mid-track ────────────────────────────────
case_sigkill() {
  say "SIGKILL mpv mid-track"
  require_playing || { bad "not playing; skipped"; return; }
  local before pos_before pids
  before=$(log_size)
  pos_before=$(probe_get time-pos)
  pids=$(mpv_pids)
  info "killing: $(echo "$pids" | tr '\n' ' ') at position $pos_before"
  # shellcheck disable=SC2086
  kill -9 $pids
  sleep 6

  local new; new=$(log_since "$before")
  if grep -q 'DIAGNOSTIC engine-recovered\|engine down\|proc-exit' <<<"$new"; then
    ok "the death is in the log"
    grep -o '\[papa\].*' <<<"$new" | head -6 | sed 's/^/       /'
  else
    bad "nothing in the log names the death — this is the Tier 1 regression"
    info "log tail: $(tail -3 "$LOG" 2>/dev/null | tr '\n' '|')"
  fi

  if grep -q 'signal=SIGKILL\|signal="SIGKILL"' <<<"$new"; then
    ok "the log says it was SIGKILL, not just 'it died'"
  else
    info "no SIGKILL attribution in the log (the flight recorder entry is proc-exit)"
  fi

  local pos_after idle
  sleep 2
  idle=$(probe_get idle-active)
  pos_after=$(probe_get time-pos)
  if [ "$idle" = "false" ] && [ -n "${pos_after:-}" ] && [ "$pos_after" != "null" ]; then
    ok "mpv is back and playing (position $pos_after, was $pos_before)"
    awk -v a="$pos_before" -v b="$pos_after" 'BEGIN{ if (b+0 >= a-10) exit 0; exit 1 }' \
      && ok "resumed at roughly the same position, not from the top" \
      || bad "resumed at $pos_after after dying at $pos_before — that is a restart, not a resume"
  else
    bad "mpv did not come back playing (idle-active=$idle time-pos=$pos_after)"
  fi
  eye "a brief non-blocking notice appeared saying the engine restarted and where it resumed"
  eye "no blocking dialog appeared at any point"
}

# ── Case 2: mpv is frozen, so IPC commands time out ─────────────────────────
case_sigstop() {
  say "SIGSTOP mpv past the command timeout"
  require_playing || { bad "not playing; skipped"; return; }
  local before pids; before=$(log_size); pids=$(mpv_pids)
  # shellcheck disable=SC2086
  kill -STOP $pids
  info "stopped: $(echo "$pids" | tr '\n' ' ') — waiting past the 2s IPC timeout"
  sleep 5
  info "probing a frozen mpv (this should itself time out):"
  node "$PROBE" --get pause 2>&1 | sed 's/^/       /'
  # shellcheck disable=SC2086
  kill -CONT $pids
  sleep 4
  local new; new=$(log_since "$before")
  if grep -qi 'timeout' <<<"$new"; then
    ok "the IPC timeout is in the log"
    grep -io '.*timeout.*' <<<"$new" | head -4 | sed 's/^/       /'
  else
    bad "a wedged mpv produced no log line"
    info "Tier 2 added per-operation IPC timeouts, so this should now name the command that"
    info "timed out. If it does not, check that the app is running the current mpv-ipc.js."
  fi
  eye "the UI did not freeze while mpv was stopped"
  eye "playback continued or recovered after SIGCONT"
}

# ── Case 3: the audio server goes away underneath mpv ───────────────────────
case_pipewire() {
  say "Restart PipeWire underneath mpv"
  require_playing || { bad "not playing; skipped"; return; }
  if ! systemctl --user list-unit-files 'pipewire*' >/dev/null 2>&1; then
    info "no user pipewire units here; skipping"
    return
  fi
  local before; before=$(log_size)
  info "restarting pipewire pipewire-pulse wireplumber"
  systemctl --user restart pipewire pipewire-pulse wireplumber 2>&1 | sed 's/^/       /'
  sleep 8
  local new; new=$(log_since "$before")
  if grep -qi 'audio device\|ao/\|device lost\|reopen' <<<"$new"; then
    ok "mpv's own report of the device loss reached the log"
    grep -io '.*\(device\|ao/\).*' <<<"$new" | head -6 | sed 's/^/       /'
  else
    bad "the device went away and mpv's diagnosis is not in the log"
    info "if mpv rode it out silently that is a pass for mpv, but check for a gap in the audio."
  fi
  local idle; idle=$(probe_get idle-active)
  [ "$idle" = "false" ] && ok "mpv still has a file loaded" || bad "mpv went idle (idle-active=$idle)"
  eye "audio actually resumed — a loaded file is not the same as a moving speaker"
}

# ── Case 4: the output device disappears ────────────────────────────────────
case_device() {
  say "Remove the output device underneath mpv"
  require_playing || { bad "not playing; skipped"; return; }
  if ! command -v pactl >/dev/null; then
    info "pactl not found; skipping"
    return
  fi
  local before sink; before=$(log_size)
  sink=$(pactl get-default-sink 2>/dev/null)
  info "default sink: $sink"
  # Suspending is reversible and does not need the sink's owning module unloaded,
  # which on this machine would take the EQ graph with it.
  pactl suspend-sink "$sink" 1 2>&1 | sed 's/^/       /'
  sleep 6
  pactl suspend-sink "$sink" 0 2>&1 | sed 's/^/       /'
  sleep 4
  local new; new=$(log_since "$before")
  if grep -qi 'audio device\|ao/\|underrun\|device lost' <<<"$new"; then
    ok "the device event is in the log"
    grep -io '.*\(device\|ao/\|underrun\).*' <<<"$new" | head -6 | sed 's/^/       /'
  else
    info "no log line — a suspend may be transparent to mpv. Escalate by hand if you"
    info "want the harder case: unload the sink's module, or unplug the interface."
  fi
  eye "audio came back without a restart"
}

main() {
  case "${1:-all}" in
    --list) echo "sigkill sigstop pipewire device"; exit 0 ;;
  esac
  preflight
  local cases=("${@:-all}")
  [ "${cases[0]}" = "all" ] && cases=(sigkill sigstop pipewire device)
  for c in "${cases[@]}"; do
    case "$c" in
      sigkill)  case_sigkill ;;
      sigstop)  case_sigstop ;;
      pipewire) case_pipewire ;;
      device)   case_device ;;
      *) echo "unknown case: $c (try --list)" >&2; exit 2 ;;
    esac
  done
  say "Result"
  printf '  %d automatic checks passed, %d failed, %d need your eyes\n' "$pass" "$fail" "$manual"
  printf '  Full evidence: %s\n' "$LOG"
  printf '  Ground truth:  node %s\n' "$PROBE"
  [ "$fail" -eq 0 ] || exit 1
}

main "$@"

#!/usr/bin/env bash
# Link every EQ filter-chain to the 5.1 hardware sink.
#
# The chains are loaded when PipeWire starts, but the analog-surround-51 sink
# only exists after the card profile is applied — which happens later. With an
# unresolvable target.object, a passive filter-chain output latches onto
# whatever sink does exist, and they daisy-chain into each other: audio flows
# between EQ presets and never reaches the speakers. So the links are asserted
# explicitly once the hardware sink is genuinely present.
set -uo pipefail
HW=alsa_output.pci-0000_2b_00.4.analog-surround-51
CHANNELS="FL FR FC LFE RL RR"

for _ in $(seq 1 30); do
  pw-link -i 2>/dev/null | grep -q "^${HW}:playback_FL$" && break
  sleep 1
done
pw-link -i 2>/dev/null | grep -q "^${HW}:playback_FL$" || { echo "hardware sink never appeared" >&2; exit 1; }

# Clear EVERY link out of every EQ chain first. Cleaning only the links we
# expect leaves the chains cross-linked into each other's inputs, which is how
# audio ends up flowing between presets and never reaching the speakers.
for out in $(pw-link -o 2>/dev/null | grep -oE '^papa_eq_[a-z0-9-]+_out' | sort -u); do
  for ch in $CHANNELS; do
    pw-link -l "${out}:output_${ch}" 2>/dev/null \
      | grep -oE '\|-> .*' | sed 's/|-> //' | while read -r dst; do
        [ -n "$dst" ] && pw-link -d "${out}:output_${ch}" "$dst" 2>/dev/null
      done
  done
done

# Now assert exactly one link per channel, to the hardware.
n=0
for out in $(pw-link -o 2>/dev/null | grep -oE '^papa_eq_[a-z0-9-]+_out' | sort -u); do
  for ch in $CHANNELS; do
    pw-link "${out}:output_${ch}" "${HW}:playback_${ch}" 2>/dev/null && n=$((n+1))
  done
done
echo "relinked $n channel links to ${HW}"

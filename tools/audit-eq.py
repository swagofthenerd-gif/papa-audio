#!/usr/bin/env python3
"""Structural audit of the generated Papa EQ PipeWire config.

Checks invariants that are cheap to get wrong and silent when they are:
crossover topology, which EQ bands reach which output, mixer wiring, gain
staging, and dangling port references. Run after any change to
build-pipewire-presets.js or the preset store.

Exits non-zero if any invariant fails.
"""
import json, os, re, math, cmath, sys
CONF = os.path.expanduser('~/.config/pipewire/pipewire.conf.d/60-papa-eq-51.conf')
STORE = os.path.expanduser('~/.config/papa-eq/presets.json')
conf = open(CONF).read()
store = json.load(open(STORE))
S = store['settings']; BANDS = store['bands']; X = S['crossover']
chunks = conf.split('{ name = libpipewire-module-filter-chain')
BLOCKS = {}
for c in chunks[1:]:
    m = re.search(r'node\.name\s+= "papa_eq_([a-z0-9-]+)"\n', c)
    if m: BLOCKS[m.group(1)] = c
fail = []

# Every preset must produce exactly one sink.
names = re.findall(r'node\.name\s+= "papa_eq_([a-z0-9-]+)"', conf)
sinks = [n for n in names if not n.endswith('_out')]
keys = [p['key'] for p in store['presets']]
if sorted(set(sinks)) != sorted(set(keys)):
    fail.append(f"sink/preset mismatch: conf={sorted(set(sinks))} store={sorted(set(keys))}")

for p in store['presets']:
    k = p['key']
    b = BLOCKS.get(k)
    if not b:
        fail.append(f"{k}: module block not found"); continue

    # 1. Crossover must be LR4: two cascaded sections per side, per satellite.
    for ch in ['FL','FR','FC','RL','RR']:
        for tag in ['hp1','hp2','lp1','lp2']:
            if f'name = {k}_{tag}_{ch} ' not in b:
                fail.append(f"{k}/{ch}: missing {tag}")
    # 2. Sub must NOT carry filters above the crossover.
    for band in BANDS:
        if band > X and (f'name = {k}_v{band}_LFE ' in b or f'name = {k}_c{band}_LFE ' in b):
            fail.append(f"{k}: sub carries out-of-band filter at {band} Hz (xover {X})")
    # 3. Satellites must NOT carry filters below the crossover.
    for band in BANDS:
        if band < X and f'name = {k}_v{band}_FC ' in b:
            fail.append(f"{k}: satellite carries below-crossover filter at {band} Hz")
    # 4. Mixer must have exactly 6 inputs (5 satellites + LFE).
    mx = re.search(r'name = %s_submix_LFE label = mixer control = \{ ([^}]*) \}' % k, b)
    if not mx: fail.append(f"{k}: no sub mixer")
    else:
        g = re.findall(r'"Gain (\d+)" = ([0-9.]+)', mx.group(1))
        if len(g) != 6: fail.append(f"{k}: mixer has {len(g)} gains, expected 6")
        links = len(re.findall(r'input = "%s_submix_LFE:In \d+"' % k, b))
        if links != 6: fail.append(f"{k}: {links} links into mixer, expected 6")
    # 5. Mixer gains must be UNITY (or subMixGain), never a per-path trim.
    #    A Linkwitz-Riley pair only sums flat when both halves are
    #    complementary; attenuating just the sub branch makes that branch gain
    #    the bass level outright. This is the invariant that was violated for
    #    most of this system's life, so it is checked explicitly.
    smg = S.get('subMixGain', 1.0)
    if mx:
        gd = dict(g)
        for i in range(1, 6):
            if abs(float(gd[str(i)]) - smg) > 0.002:
                fail.append(f"{k}: satellite mixer gain {gd[str(i)]} != {smg} "
                            f"(a per-path trim breaks crossover complementarity)")
        if abs(float(gd['6']) - 1.0) > 0.002:
            fail.append(f"{k}: LFE mixer gain {gd['6']} != 1.0")
    # 6. Sink attenuation covers the LARGER path peak plus summing headroom,
    #    applied before the split so both branches scale together.
    sat_peak = max([0]+[g for band,g in zip(BANDS,p['gains']) if band >= X])
    sub_peak = max([0]+[g for band,g in zip(BANDS,p['gains']) if band <= X])
    head = S.get('subHeadroom', 6)
    want = round(10 ** (-(round(max(sat_peak, sub_peak)) + head)/20), 4)
    vol = re.search(r'volume = ([0-9.]+)', b)
    got = float(vol.group(1)) if vol else None
    if got is None or abs(got-want) > 0.001:
        fail.append(f"{k}: volume {got} != expected {want} "
                    f"(peak +{max(sat_peak, sub_peak)}, headroom {head} dB)")
    # 7. Every input/output port must exist as a node.
    io = re.search(r'inputs\s+= \[([^\]]*)\].*?outputs = \[([^\]]*)\]', b, re.S)
    if io:
        for port in re.findall(r'"([^"]+)"', io.group(1)+io.group(2)):
            node = port.split(':')[0]
            if f'name = {node} ' not in b:
                fail.append(f"{k}: port {port} references missing node")
    else:
        fail.append(f"{k}: no inputs/outputs arrays")

# Live checks: the config is only half the story if the graph disagrees.
import subprocess
try:
    live = subprocess.run(['pactl','list','sinks','short'], capture_output=True, text=True, timeout=5).stdout
    live_sinks = {l.split('\t')[1] for l in live.strip().split('\n') if '\t' in l}
    for k in keys:
        if f'papa_eq_{k}' not in live_sinks:
            fail.append(f"{k}: sink declared in config but not loaded")
    links = subprocess.run(['pw-link','-l'], capture_output=True, text=True, timeout=5).stdout
    for k in keys:
        n = links.count(f'papa_eq_{k}_out:output_')
        # `if n and n < 6` silently passed the WORST case: zero links, which is
        # exactly what a failed relink produces.
        if n < 6:
            fail.append(f"{k}: {n}/6 outputs linked to hardware")
except Exception as e:
    print(f"  (live checks skipped: {e})")

print(f"checked {len(store['presets'])} presets")
if fail:
    print(f"\n{len(fail)} PROBLEM(S):")
    for f in fail: print("  -", f)
    sys.exit(1)
print("\nAll structural invariants hold.")
